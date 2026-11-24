"""Optimize a PoB build headless: gem links, passive tree, crafted-rare gear, jewels.

  opt.py gems BUILD.xml --main-skill GEM [--links N] [--allow-awakened] [--allow-exceptional]
  opt.py tree BUILD.xml --main-skill GEM [--points N] [--max-dist 6] [--iters 40] [--allow-keystone-removal]
  opt.py tree-build BUILD.xml --main-skill GEM --class CLASS [--ascendancy ASC] [--points N] [--asc-points N]
  opt.py gear BUILD.xml --main-skill GEM [--tier 2] [--ilvl 84] [--replace-uniques] [--base-implicits]
                                         [--slots "Helmet,Gloves"]
  opt.py jewels BUILD.xml --main-skill GEM [--tier 2]
  opt.py all BUILD.xml --main-skill GEM        gems, tree, gear, jewels, then gems and tree again

Rules (see objective.py): --res-cap 75, --chaos-min 0 (--no-chaos to drop), --ehp-floor start|none|N
("start" = the loaded build's EHP; for tree-build that's the old tree's, so the grown tree is held to it).
PoB's own warnings (attribute requirements, unreserved life/mana, the main skill's cost) always count.
Rules the loaded build already breaks may not get worse; fixing them earns nothing unless --fix-start-breaks
(then a full fix outranks the metric). tree-build repairs every rule as far as it can, since a bare tree breaks
most. tree-build's point budgets default to the loaded build's.
Common: [--loadout TITLE] [--config TITLE] [--metric M] [--workers N] [--out OUT.xml]
Output: JSON report (before, after, rules, every change); the optimized build is saved to --out (default:
Downloads\\<build>-<command>.xml). Needs the poe-build-expert venv (lupa); re-runs itself there when needed.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "eval"))


def default_out(build_path, cmd):
    stem = os.path.splitext(os.path.basename(build_path))[0]
    folder = os.path.join(os.path.expanduser("~"), "Downloads") if os.name == "nt" else os.getcwd()
    return os.path.join(folder, f"{stem}-{cmd}.xml")


def main():
    import evaluator as E
    ph = E.ph()
    if ph._lj is None:
        venv = getattr(ph, "VENV_PY", "")
        if venv and os.path.exists(venv) and os.path.abspath(sys.executable).lower() != os.path.abspath(venv).lower():
            sys.exit(subprocess.call([venv] + sys.argv))
        sys.exit("lupa isn't installed (pip install lupa)")
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    from objective import Rules, summary
    import gems as G
    import gear as R
    import tree as T

    ap = argparse.ArgumentParser(description="Headless PoB build optimizer")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("gems", "tree", "tree-build", "gear", "jewels", "all"):
        p = sub.add_parser(name)
        p.add_argument("build")
        p.add_argument("--main-skill", required=True)
        p.add_argument("--main-group", type=int)
        p.add_argument("--loadout")
        p.add_argument("--config")
        p.add_argument("--metric", help="FullDPS, CombinedDPS, minion.CombinedDPS, ... (default: chosen from the build)")
        p.add_argument("--workers", type=int)
        p.add_argument("--out")
        p.add_argument("--res-cap", type=float, default=75)
        p.add_argument("--chaos-min", type=float, default=0)
        p.add_argument("--no-chaos", action="store_true")
        p.add_argument("--ehp-floor", default=None,
                       help="start (default: the loaded build's EHP, for tree-build too), none, or a number")
        if name != "tree-build":
            p.add_argument("--fix-start-breaks", action="store_true",
                           help="let a complete fix of a rule the build already breaks outrank the metric")
        if name in ("gems", "all"):
            p.add_argument("--links", type=int)
            p.add_argument("--allow-awakened", action="store_true")
            p.add_argument("--allow-exceptional", action="store_true")
        if name in ("tree", "tree-build", "all"):
            p.add_argument("--points", type=int)
            p.add_argument("--max-dist", type=int, default=10 if name == "tree-build" else 6)
            p.add_argument("--iters", type=int, default=40)
        if name in ("tree", "all"):
            p.add_argument("--allow-keystone-removal", action="store_true",
                           help="let the tree optimizer refund keystones (PoB doesn't value some, e.g. leech/regen ones)")
        if name == "tree-build":
            p.add_argument("--class", dest="cls", required=True)
            p.add_argument("--ascendancy")
            p.add_argument("--asc-points", type=int)
        if name in ("gear", "jewels", "all"):
            p.add_argument("--tier", type=int, default=2)
            p.add_argument("--ilvl", type=int, default=84)
        if name in ("gear", "all"):
            p.add_argument("--replace-uniques", action="store_true")
            p.add_argument("--base-implicits", action="store_true",
                           help="use the base's own implicit instead of keeping the current item's")
            p.add_argument("--slots")
    args = ap.parse_args()

    if args.metric and not re.fullmatch(r"(minion\.)?[A-Za-z]+", args.metric):
        raise ValueError(f"bad metric '{args.metric}'")
    out = args.out or default_out(args.build, args.cmd)
    if not os.path.isdir(os.path.dirname(os.path.abspath(out))):
        raise ValueError(f"no folder for --out: {os.path.dirname(os.path.abspath(out))}")
    with open(args.build, encoding="utf-8") as f:
        xml = f.read()
    t0 = time.perf_counter()
    log = []
    with E.EvalPool(workers=E.default_workers() if args.workers is None else args.workers) as pool:
        start = pool.load(xml, args.main_skill, args.main_group, args.loadout, args.config)
        metric = args.metric or E.main_metric(start["stats"])
        if E.value(start["stats"], metric) is None:
            raise ValueError(f"PoB has no '{metric}' for this build")
        floor = args.ehp_floor if args.ehp_floor is not None else "start"
        mode = "repair" if args.cmd == "tree-build" else ("fix" if args.fix_start_breaks else "keep")
        rules = Rules(metric, start["stats"], res_cap=args.res_cap,
                      chaos_min=None if args.no_chaos else args.chaos_min, ehp_floor=floor, start_breaks=mode)
        main_skill = args.main_skill
        start_points = pool.points()
        slots = [s.strip() for s in args.slots.split(",")] if getattr(args, "slots", None) else None

        def gems():
            G.optimize_gems(pool, rules, links=args.links, allow_awakened=args.allow_awakened,
                            allow_exceptional=args.allow_exceptional, log=log)

        def tree():
            T.improve(pool, rules, budget=args.points, max_dist=args.max_dist, max_iters=args.iters,
                      main_skill=main_skill, log=log, keep_keystones=not args.allow_keystone_removal)

        def gear():
            R.optimize_gear(pool, rules, tier=args.tier, ilvl=args.ilvl, replace_uniques=args.replace_uniques,
                            slots=slots, keep_implicits=not args.base_implicits, main_skill=main_skill, log=log)

        def jewels():
            R.optimize_jewels(pool, rules, tier=args.tier, ilvl=args.ilvl, main_skill=main_skill, log=log)

        if args.cmd == "gems":
            gems()
        elif args.cmd == "tree":
            tree()
        elif args.cmd == "tree-build":
            T.build(pool, rules, args.cls, args.ascendancy, points=args.points or start_points["used"],
                    asc_points=args.asc_points if args.asc_points is not None else start_points["ascendancy"],
                    max_dist=args.max_dist, main_skill=main_skill, log=log, improve_iters=args.iters)
        elif args.cmd == "gear":
            gear()
        elif args.cmd == "jewels":
            jewels()
        elif args.cmd == "all":
            gems()
            tree()
            gear()
            jewels()
            gems()
            tree()

        final = pool.stats()
        with open(out, "w", encoding="utf-8") as f:
            f.write(pool.save_xml())
        sv, fv = rules.value(start["stats"]), rules.value(final)
        report = {
            "build": os.path.basename(args.build), "command": args.cmd, "pobVersion": start["pobVersion"],
            "mainSkill": start["mainSkill"], "rules": rules.describe(),
            "before": summary(rules, start["stats"]), "after": summary(rules, final),
            "changePct": round((fv - sv) / max(abs(sv), 1) * 100, 2),
            "pointsBefore": start_points, "pointsAfter": pool.points(),
            "changes": [{k: v for k, v in c.items() if k != "item"} for c in log],
            "saved": out, "seconds": round(time.perf_counter() - t0, 1),
        }
        if start.get("issues"):
            report["loadIssues"] = start["issues"]
    print(json.dumps(report, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError, EOFError) as e:
        sys.exit(f"error: {e}")
