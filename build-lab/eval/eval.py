"""Evaluate a PoB build headless: current numbers, what-if probes, in-memory changes, node power, support swaps.

  eval.py stats BUILD.xml                          the build's numbers
  eval.py groups BUILD.xml                         skill groups and gems (indexes for ops)
  eval.py probe BUILD.xml --specs SPECS.json       calculator probes (see evaluator.py), with deltas
  eval.py apply BUILD.xml --ops OPS.json [--save OUT.xml]   apply changes, report numbers, optionally save
  eval.py node-power BUILD.xml [--metric M] [--defence D] [--max-dist N] [--top N]
                                                   every reachable passive, ranked by metric gain per point
  eval.py supports BUILD.xml [--slots 2,3] [--quality 20] [--top N]
                                                   for each support in the main group, the best replacements

Common options: --main-skill GEM [--main-group N] [--loadout TITLE] [--config TITLE] [--workers N].
Metric defaults to FullDPS when the build counts groups in Full DPS, else CombinedDPS; "minion.X" reads the
minion block. Output is JSON. Needs the poe-build-expert venv (lupa); it re-runs itself there when needed.
"""
import argparse
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def _rel(a, b):
    if not isinstance(a, (int, float)) or not isinstance(b, (int, float)):
        return None
    return round((b - a) / abs(a) * 100, 2) if a else None


def _read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def main():
    import evaluator as E
    ph = E.ph()
    if ph._lj is None:  # no lupa here: re-run in the skill's venv
        venv = getattr(ph, "VENV_PY", "")
        if venv and os.path.exists(venv) and os.path.abspath(sys.executable).lower() != os.path.abspath(venv).lower():
            sys.exit(subprocess.call([venv] + sys.argv))
        sys.exit("lupa isn't installed (pip install lupa)")
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass

    ap = argparse.ArgumentParser(description="Headless PoB evaluation")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("stats", "groups", "probe", "apply", "node-power", "supports"):
        p = sub.add_parser(name)
        p.add_argument("build")
        p.add_argument("--main-skill")
        p.add_argument("--main-group", type=int)
        p.add_argument("--loadout")
        p.add_argument("--config")
        p.add_argument("--workers", type=int,
                       help="worker processes (default: CPU-based for node-power/supports, 0 for the rest, "
                            "and for probe batches under 200 specs)")
        if name in ("probe", "node-power", "supports"):
            p.add_argument("--metric")
        if name == "probe":
            p.add_argument("--specs", required=True)
        if name == "apply":
            p.add_argument("--ops", required=True)
            p.add_argument("--save", help="write the changed build as PoB XML")
            p.add_argument("--allow-main-change", action="store_true",
                           help="keep the changes even when PoB ends up measuring a different main skill")
        if name == "node-power":
            p.add_argument("--defence", default="TotalEHP")
            p.add_argument("--max-dist", type=int, default=10)
            p.add_argument("--top", type=int, default=25)
        if name == "supports":
            p.add_argument("--slots", help="comma-separated gem indexes in the main group (default: every support)")
            p.add_argument("--quality", type=int, default=20)
            p.add_argument("--top", type=int, default=10)
    args = ap.parse_args()

    xml = _read(args.build)
    specs = None
    if args.cmd == "probe":
        specs = json.loads(_read(args.specs))
        if not isinstance(specs, list):
            raise ValueError("the specs file must hold a JSON list of probe specs")
    if args.workers is not None:
        workers = args.workers
    elif args.cmd in ("node-power", "supports"):
        workers = E.default_workers()
    elif args.cmd == "probe":  # ~5-20 ms a probe vs ~3-5 s to start a worker: only parallelise big batches
        workers = 0 if len(specs) < 200 else min(E.default_workers(), len(specs) // 200)
    else:
        workers = 0
    t0 = time.perf_counter()
    with E.EvalPool(workers=workers) as pool:
        base = pool.load(xml, args.main_skill, args.main_group, args.loadout, args.config)
        metric = getattr(args, "metric", None) or E.main_metric(base["stats"])
        out = {"pobVersion": base["pobVersion"], "mainSkill": base["mainSkill"], "workers": workers}
        if base["issues"]:
            out["loadIssues"] = base["issues"]

        if args.cmd == "stats":
            out["stats"] = base["stats"]
        elif args.cmd == "groups":
            out["groups"] = pool.groups()
        elif args.cmd == "probe":
            res = pool.probe(specs)
            b = E.value(base["stats"], metric)
            out["metric"], out["base"] = metric, b
            out["results"] = [{"spec": s, "value": E.value(r, metric), "changePct": _rel(b, E.value(r, metric)),
                               **({"error": r["error"]} if "error" in r else {"result": r})}
                              for s, r in zip(specs, res)]
        elif args.cmd == "apply":
            after = pool.apply(json.loads(_read(args.ops)), allow_main_change=args.allow_main_change)
            out["before"], out["after"] = base["stats"], after
            if args.save:
                with open(args.save, "w", encoding="utf-8") as f:
                    f.write(pool.save_xml())
                out["saved"] = args.save
        elif args.cmd == "node-power":
            out.update(node_power(pool, base, metric, args, E))
        elif args.cmd == "supports":
            out.update(supports(pool, base, metric, args, E))
        out["seconds"] = round(time.perf_counter() - t0, 1)
    print(json.dumps(out, indent=1, ensure_ascii=False))


def node_power(pool, base, metric, args, E):
    nodes = pool.reachable_nodes(args.max_dist)
    res = pool.probe([{"allocate": [n["id"]]} for n in nodes])
    b, bd = E.value(base["stats"], metric), E.value(base["stats"], args.defence)
    rows = []
    for n, r in zip(nodes, res):
        if "error" in r:
            continue
        v, d = E.value(r, metric), E.value(r, args.defence)
        pts = r.get("points") or n["dist"]
        gain = _rel(b, v)
        rows.append({"id": n["id"], "name": n["name"], "type": n["type"], "points": pts,
                     "metricPct": gain, "metricPctPerPoint": round(gain / pts, 3) if gain is not None and pts else None,
                     "defencePct": _rel(bd, d)})
    rows.sort(key=lambda x: x["metricPctPerPoint"] if x["metricPctPerPoint"] is not None else -1e9, reverse=True)
    return {"metric": metric, "defence": args.defence, "base": b, "baseDefence": bd,
            "evaluated": len(nodes), "top": rows[:args.top]}


def supports(pool, base, metric, args, E):
    main = next((g for g in pool.groups() if g["main"]), None)
    if main is None:
        raise SystemExit("error: no main skill group")
    slots = ([int(s) for s in args.slots.split(",")] if args.slots
             else [g["index"] for g in main["gems"] if g["support"]])
    candidates = pool.compatible_supports()
    # enabled: a disabled slot is scored as if its replacement were switched on (else every trial is a no-op)
    trials = [{"index": i, "name": s, "quality": args.quality, "enabled": True} for i in slots for s in candidates]
    res = pool.support_trials(trials)
    b = E.value(base["stats"], metric)
    by_slot = {}
    for t, r in zip(trials, res):
        if "error" in r:
            continue
        by_slot.setdefault(t["index"], []).append({"support": t["name"], "value": E.value(r, metric),
                                                   "changePct": _rel(b, E.value(r, metric))})
    gems = {g["index"]: g["name"] for g in main["gems"]}
    out = []
    for i in slots:
        rows = sorted(by_slot.get(i, []), key=lambda x: x["value"] or 0, reverse=True)
        out.append({"slot": i, "current": gems.get(i), "best": rows[:args.top]})
    return {"metric": metric, "base": b, "group": main["label"] or main["index"],
            "candidates": len(candidates), "trials": len(trials), "slots": out}


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError, EOFError) as e:  # PoolBroken is a RuntimeError
        sys.exit(f"error: {e}")
