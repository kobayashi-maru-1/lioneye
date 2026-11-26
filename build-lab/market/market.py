"""Prices, build cost and popularity for build-lab.

  market.py prices [--league L]                     poe.ninja: the league, divine price, cache state
  market.py cost BUILD.xml --main-skill GEM [--trade-check]
                                                    what the build costs (uniques, gems; rares with --trade-check)
  market.py popularity [--refresh] [--depth 3000] [--sample 80]
  market.py popularity --crawl-status              per-skill unique data: age, progress
  market.py popularity --crawl [--sample 900] [--fresh]   read ladder characters (hours; ask the user first)
  market.py popularity --skill GEM                 the uniques the skill's players wear, by slot
                                                    ascendancy, main-skill and unique shares (refresh: a few minutes)
  market.py novelty BUILD.xml --main-skill GEM      how unusual the build's archetype is (needs popularity data)

Common: [--league L] (default: poe.ninja's current challenge league), [--loadout TITLE] [--config TITLE].
Output is JSON. Sources: poe.ninja's economy API, GGG's trade site, ladder and public character data. Popularity
keeps counts only, no account or character names.
"""
import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "eval"))


def main():
    import evaluator as E
    ph = E.ph()
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    import buildcost
    import popularity as P
    from ninja import Prices
    from trade import Trade

    ap = argparse.ArgumentParser(description="build-lab market data")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("prices", "cost", "popularity", "novelty"):
        p = sub.add_parser(name)
        p.add_argument("--league")
        if name in ("cost", "novelty"):
            p.add_argument("build")
            p.add_argument("--main-skill", required=(name == "novelty"),
                           help="the main skill (cost: optional, only picks which group PoB calculates)")
            p.add_argument("--loadout")
            p.add_argument("--config")
        if name == "cost":
            p.add_argument("--trade-check", action="store_true", help="price rares on the trade site (slow)")
        if name == "popularity":
            p.add_argument("--refresh", action="store_true")
            p.add_argument("--depth", type=int, default=3000)
            p.add_argument("--sample", type=int, default=None)
            p.add_argument("--crawl", action="store_true", help="per-skill unique counts (hours; ask first)")
            p.add_argument("--fresh", action="store_true", help="with --crawl: start over instead of resuming")
            p.add_argument("--crawl-status", action="store_true")
            p.add_argument("--skill", help="candidate uniques for this main skill, from the crawl")
    args = ap.parse_args()

    if args.cmd in ("cost", "novelty") and ph._lj is None:  # these load the build in PoB: need lupa
        venv = getattr(ph, "VENV_PY", "")
        if venv and os.path.exists(venv) and os.path.abspath(sys.executable).lower() != os.path.abspath(venv).lower():
            sys.exit(subprocess.call([venv] + sys.argv))
        sys.exit("lupa isn't installed (pip install lupa)")

    prices = Prices(args.league)
    if args.cmd == "prices":
        out = {"league": prices.league, "divineInChaos": prices.divine,
               "exaltedInChaos": prices.currency_chaos("exalted"),
               "example": {"Mageblood": prices.unique("Mageblood", "Heavy Belt"),
                           "Spell Echo 20/20": prices.gem("Spell Echo", 20, 20)}}
    elif args.cmd == "popularity" and args.crawl:
        data = P.crawl(prices.league, sample=args.sample or P.CRAWL_SAMPLE, fresh=args.fresh)
        out = {**P.crawl_status(prices.league), "skills": len(data["skills"])}
    elif args.cmd == "popularity" and args.crawl_status:
        out = P.crawl_status(prices.league)
    elif args.cmd == "popularity" and args.skill:
        out = {**P.candidates(P.load_crawl(prices.league), args.skill), "data": P.crawl_status(prices.league)}
    elif args.cmd == "popularity":
        args.sample = args.sample or 80
        data = (P.refresh(prices.league, depth=args.depth, sample=args.sample) if args.refresh
                else P.load(prices.league, depth=args.depth, sample=args.sample))
        n, depth = data["sample"], data["ladderDepth"]
        top = lambda d, total, k=15: [(name, round(c / total, 4) if total else None)
                                      for name, c in sorted(d.items(), key=lambda x: -x[1])[:k]]
        out = {"league": data["league"], "basis": f"top {depth} ladder characters; {n} public ones read",
               "ascendancy": top(data["ascendancy"], depth), "skills": top(data["skills"], n),
               "uniques": top(data["uniques"], n)}
    else:
        with open(args.build, encoding="utf-8") as f:
            xml = f.read()
        with E.EvalPool(workers=0) as pool:
            start = pool.load(xml, args.main_skill, None, args.loadout, args.config)
            if args.cmd == "cost":
                out = buildcost.price_build(pool, prices, Trade(prices) if args.trade_check else None)
            else:
                data = P.load(prices.league, refresh_if_stale=False)
                if data is None:
                    raise RuntimeError("no popularity data yet: run market.py popularity first (a few minutes)")
                uniq = sorted({buildcost.parse_item(s["item"].get("text"))["name"] or s["item"]["name"].split(", ")[0]
                               for s in pool.slots() if s.get("item") and s["item"].get("rarity") in ("UNIQUE", "RELIC")})
                out = P.novelty(data, pool.points()["ascendancyName"], start["mainSkill"], uniq)
    print(json.dumps(out, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError) as e:
        sys.exit(f"error: {e}")
