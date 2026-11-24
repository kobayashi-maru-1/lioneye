"""Optimizer checks: rule unit tests, then real builds.

  python test-opt.py BUILD.xml::MAIN_SKILL [...] [--workers 8] [--build-class Marauder --build-asc Chieftain]

Rule unit tests (objective.py on hand-made results): an element is exempt only when none of its hits land as
itself; no exemption when the enemy deals none of that type; other mitigation never stands in for resistance;
in keep mode a fix earns nothing and a regression of a broken rule is rejected rule by rule; fix mode rewards a
full fix; repair mode rewards partial progress.

For each build, each optimizer (gems, tree, gear, jewels) runs from the loaded build, and checks:
  never worse   keep mode: the rules are no worse and the metric is not lower than at the start
  fidelity      the saved XML, loaded into a fresh PoB, gives the same numbers and rule breaks
  budget        tree: main points <= the starting count, ascendancy points unchanged
  gems          no awakened or exceptional support added
Jewels with no socket to work on are reported as SKIP, not as passed.
With --build-class, the first build also gets a tree-build from that class start, with the loaded build's point
budgets and EHP as the floor. Exit code 1 when any check fails. Builds aren't part of the repo: pass your own.
"""
import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "eval"))
import evaluator as E  # noqa: E402
from objective import Rules, summary  # noqa: E402
import gear as R  # noqa: E402
import gems as G  # noqa: E402
import tree as T  # noqa: E402

KEYS = ("FullDPS", "CombinedDPS", "Life", "EnergyShield", "TotalEHP", "FireResist", "ColdResist",
        "LightningResist", "ChaosResist", "Str", "Dex", "Int", "ManaUnreserved", "minion.CombinedDPS",
        "minion.TotalDPS", "minion.Life")


def same(a, b):
    if a is None or b is None:
        return a == b
    return abs(a - b) <= 1e-6 * max(1.0, abs(a), abs(b))


def fake(dps=100.0, life=1000, ehp=10000.0, fire=75, cold=75, light=75, chaos=0, violations=(), **extra):
    p = {"CombinedDPS": dps, "Life": life, "TotalEHP": ehp, "FireResist": fire, "ColdResist": cold,
         "LightningResist": light, "ChaosResist": chaos, "ManaCost": 50, "ManaUnreserved": 40}
    for el in ("Fire", "Cold", "Lightning", "Chaos"):
        p[f"{el}EnemyDamage"], p[f"{el}TakenDamage"] = 100.0, 100.0
    p.update(extra)
    return {"player": p, "violations": list(violations)}


def rule_tests(add):
    start = fake()
    r = Rules("CombinedDPS", start)
    add("rules", "uncapped element breaks the rule", "res:LightningResist" in r.shortfalls(fake(light=50)))
    add("rules", "element whose hits are all taken as another is exempt",
        "res:LightningResist" not in r.shortfalls(fake(light=-200, LightningTakenDamage=0.0)))
    add("rules", "no exemption when the enemy deals none of that type",
        "res:LightningResist" in r.shortfalls(fake(light=50, LightningEnemyDamage=0.0, LightningTakenDamage=0.0)))
    add("rules", "other mitigation doesn't stand in for resistance",
        "res:FireResist" in r.shortfalls(fake(fire=71, FireTakenHitMult=0.2)))
    add("rules", "more metric wins when the rules are equal", r.better(fake(dps=110), start))
    add("rules", "a newly broken rule loses to any metric gain", not r.better(fake(dps=999, fire=70), start))
    cost = "Not enough Mana for the main skill's cost"
    broken = fake(violations=[cost])
    k = Rules("CombinedDPS", broken)
    add("rules", "keep: fixing a broken rule earns nothing (the metric decides)", not k.better(fake(dps=50), broken))
    add("rules", "keep: a broken rule may not get worse",
        not k.better(fake(dps=200, violations=[cost], ManaUnreserved=10), broken))
    two = fake(fire=70, violations=[cost])
    k2 = Rules("CombinedDPS", two)
    add("rules", "keep: no trading a fix of one broken rule for a regression of another",
        not k2.better(fake(fire=60, dps=200), two))
    f = Rules("CombinedDPS", broken, start_breaks="fix")
    add("rules", "fix: a full fix outranks the metric", f.better(fake(dps=50), broken))
    add("rules", "fix: partial progress earns nothing", not f.better(fake(dps=50, violations=[cost], ManaUnreserved=45), broken))
    rp = Rules("CombinedDPS", fake(), start_breaks="repair")
    add("rules", "repair: partial progress counts",
        rp.better(fake(dps=50, violations=[cost], ManaUnreserved=45), fake(dps=50, violations=[cost])))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("builds", nargs="*")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--build-class")
    ap.add_argument("--build-asc")
    args = ap.parse_args()
    report = []

    def add(build, test, ok, **extra):
        report.append({"build": build, "test": test, "ok": bool(ok), **extra})

    def skip(build, test, why):
        report.append({"build": build, "test": test, "ok": True, "skip": why})

    rule_tests(add)
    if args.builds:
        fresh = E.Evaluator()
        with E.EvalPool(workers=args.workers) as pool:
            for i, spec in enumerate(args.builds):
                path, _, skill = spec.partition("::")
                name = os.path.basename(path)
                xml = open(path, encoding="utf-8").read()
                runs = ["gems", "tree", "gear", "jewels"] + (["tree-build"] if i == 0 and args.build_class else [])
                for run in runs:
                    t0 = time.perf_counter()
                    start = pool.load(xml, skill)
                    metric = E.main_metric(start["stats"])
                    mode = "repair" if run == "tree-build" else "keep"
                    rules = Rules(metric, start["stats"], start_breaks=mode)
                    pts0 = pool.points()
                    group0 = next(g for g in pool.groups() if g["main"])["gems"]
                    supports0 = {g["name"] for g in group0}
                    info0 = {s["name"]: s for s in pool.compatible_supports_info()}
                    if run == "jewels" and not R.jewel_sockets(pool):
                        skip(name, "jewels", "no allocated socket that is empty or holds a plain rare/magic jewel")
                        continue
                    log = []
                    try:
                        if run == "gems":
                            G.optimize_gems(pool, rules, log=log)
                        elif run == "tree":
                            T.improve(pool, rules, main_skill=skill, log=log, max_iters=25)
                        elif run == "gear":
                            R.optimize_gear(pool, rules, main_skill=skill, log=log)
                        elif run == "jewels":
                            R.optimize_jewels(pool, rules, main_skill=skill, log=log)
                        else:
                            T.build(pool, rules, args.build_class, args.build_asc, points=pts0["used"],
                                    asc_points=pts0["ascendancy"], main_skill=skill, log=log, improve_iters=20)
                    except Exception as e:  # noqa: BLE001 - report and go on
                        add(name, f"{run}: runs", False, error=f"{type(e).__name__}: {e}")
                        continue
                    final = pool.stats()
                    secs = round(time.perf_counter() - t0, 1)
                    before, after = summary(rules, start["stats"]), summary(rules, final)
                    label = (f"{run}: {metric} {before['value']:,.0f} -> {after['value']:,.0f}, "
                             f"{len([c for c in log if 'value' in c])} changes, {secs}s")
                    if mode == "keep":
                        ok = rules.not_worse(final, start["stats"]) and after["value"] >= before["value"] * (1 - 1e-9)
                        add(name, f"{label}: never worse (rules and metric)", ok, before=before, after=after)
                    else:
                        add(name, f"{label}: no rule broken", not rules.breaks(final), breaks=rules.breaks(final),
                            ehp=(before["TotalEHP"], after["TotalEHP"]))
                    saved = pool.save_xml()
                    re_stats = fresh.load(saved, skill)["stats"]
                    bad = {k: (E.value(final, k), E.value(re_stats, k)) for k in KEYS
                           if not same(E.value(final, k), E.value(re_stats, k))}
                    if sorted(final.get("violations") or []) != sorted(re_stats.get("violations") or []):
                        bad["violations"] = (final.get("violations"), re_stats.get("violations"))
                    add(name, f"{run}: saved XML reloads to the same numbers", not bad, **({"diff": bad} if bad else {}))
                    pts = pool.points()
                    if run == "tree":
                        add(name, f"tree: points {pts['used']}/{pts0['used']}, ascendancy {pts['ascendancy']}/{pts0['ascendancy']}",
                            pts["used"] <= pts0["used"] and pts["ascendancy"] == pts0["ascendancy"])
                    if run == "tree-build":
                        add(name, f"tree-build: points {pts['used']}/{pts0['used']}, ascendancy {pts['ascendancy']}/{pts0['ascendancy']}",
                            pts["used"] <= pts0["used"] and pts["ascendancy"] <= pts0["ascendancy"])
                    if run == "gems":
                        now = {g["name"] for g in next(g for g in pool.groups() if g["main"])["gems"]}
                        added = now - supports0
                        pricey = [n for n in added if (info0.get(n) or {}).get("awakened")
                                  or (info0.get(n) or {}).get("exceptional")]
                        unknown = [n for n in added if n not in info0]
                        add(name, f"gems: no awakened/exceptional added ({', '.join(sorted(added)) or 'none added'})",
                            not pricey and not unknown, **({"pricey": pricey} if pricey else {}),
                            **({"notInStartingCandidates": unknown} if unknown else {}))
    failed = [r for r in report if not r["ok"]]
    skipped = [r for r in report if r.get("skip")]
    print(json.dumps({"passed": len(report) - len(failed) - len(skipped), "skipped": len(skipped), "failed": failed,
                      "tests": [f"{'SKIP' if r.get('skip') else 'ok  ' if r['ok'] else 'FAIL'} {r['build']}: {r['test']}"
                                + (f" ({r['skip']})" if r.get("skip") else "") for r in report]},
                     indent=1, default=str))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
