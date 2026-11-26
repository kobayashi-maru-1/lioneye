"""Prices, build cost and popularity for build-lab.

  market.py prices [--league L]                     poe.ninja: the league, divine price, cache state
  market.py cost BUILD.xml --main-skill GEM [--trade-check]
                                                    what the build costs (uniques, gems; rares with --trade-check)
  market.py popularity [--refresh] [--depth 3000] [--sample 80]
  market.py popularity --crawl-status              per-skill unique data: age, progress
  market.py popularity --crawl [--sample 900] [--fresh]   read ladder characters (hours; ask the user first)
      [--until 04:00] pause at that local time (the next run resumes); [--only-unfinished] do nothing when the
      league's crawl is finished (a scheduled night run never starts a new one); [--log FILE] progress to a file;
      [--publish] push it to the repo's crawl-data branch afterwards (crawldata.py)
  market.py popularity --publish                   push the crawl and its reference builds to the crawl-data branch
  market.py popularity --fetch                     download the published crawl (a chat sandbox does it on its own)
  market.py popularity --skill GEM                 the uniques the skill's players wear, by slot
                                                    ascendancy, main-skill and unique shares (refresh: a few minutes)
  market.py novelty BUILD.xml --main-skill GEM      how unusual the build's archetype is (needs popularity data)

Common: [--league L] (default: poe.ninja's current challenge league), [--loadout TITLE] [--config TITLE].
Output is JSON. Sources: poe.ninja's economy API, GGG's trade site, ladder and public character data. Popularity
keeps counts only; the crawl's reference builds keep the account and character names the ladder shows.
"""
import argparse
import json
import time
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "eval"))


def window_end(until, start=None, now=None):
    """The epoch time `until` (HH:MM, local) next comes round, or False when `start` (HH:MM) is given and now is
    outside the start-until window (a crawl started by hand at 14:00 reads nothing, instead of reading until 04:00
    the next day)."""
    now = time.time() if now is None else now
    t = time.localtime(now)

    def at(hhmm, day_offset=0):
        hh, mm = (int(x) for x in hhmm.split(":"))
        return time.mktime((t.tm_year, t.tm_mon, t.tm_mday + day_offset, hh, mm, 0, 0, 0, -1))
    end = at(until)
    if end <= now:
        end = at(until, 1)
    if start is not None:
        begin = at(start)
        if begin >= end:
            begin = at(start, -1)
        while begin + 24 * 3600 < end:  # the most recent start before this end
            begin += 24 * 3600
        if not begin <= now < end:
            return False
    return end


def main():
    import evaluator as E
    ph = E.ph()
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    import buildcost
    import crawldata as CD
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
            p.add_argument("--until", help="with --crawl: pause at this local time (HH:MM)")
            p.add_argument("--from", dest="window_from",
                           help="with --crawl --until: the window's start (HH:MM); outside it nothing is read")
            p.add_argument("--only-unfinished", action="store_true",
                           help="with --crawl: only resume or start a crawl the league doesn't have finished")
            p.add_argument("--log", help="append progress and the result to this file")
            p.add_argument("--skill", help="candidate uniques for this main skill, from the crawl")
            p.add_argument("--publish", action="store_true",
                           help="push the crawl and its builds to the repo's crawl-data branch (with --crawl: "
                                "after a run that read something)")
            p.add_argument("--fetch", action="store_true",
                           help="download the published crawl (replaces the one on disk)")
    args = ap.parse_args()

    if args.cmd in ("cost", "novelty") and ph._lj is None:  # these load the build in PoB: need lupa
        venv = getattr(ph, "VENV_PY", "")
        if venv and os.path.exists(venv) and os.path.abspath(sys.executable).lower() != os.path.abspath(venv).lower():
            sys.exit(subprocess.call([venv] + sys.argv))
        sys.exit("lupa isn't installed (pip install lupa)")

    if getattr(args, "log", None):  # a scheduled run (pythonw) has no console: send stderr and stdout to the log
        log = open(args.log, "a", encoding="utf-8", buffering=1)
        sys.stderr = sys.stdout = log
        print(f"--- {time.strftime('%Y-%m-%d %H:%M:%S')} {' '.join(sys.argv[1:])}")
    prices = Prices(args.league)
    if args.cmd == "prices":
        out = {"league": prices.league, "divineInChaos": prices.divine,
               "exaltedInChaos": prices.currency_chaos("exalted"),
               "example": {"Mageblood": prices.unique("Mageblood", "Heavy Belt"),
                           "Spell Echo 20/20": prices.gem("Spell Echo", 20, 20)}}
    elif args.cmd == "popularity" and args.crawl:
        have = P.load_crawl(prices.league)
        def publish_if_needed():
            """Push the crawl when it moved on since the last good push (a failed one is tried again)."""
            if not (args.publish and CD.needs_publish(prices.league)):
                return None
            try:
                return CD.publish(prices.league)
            except Exception as e:  # noqa: BLE001 - the crawl's result matters more than the push
                print(f"publish failed: {e}", file=sys.stderr)
                return {"published": False, "error": str(e)}

        if args.only_unfinished and have and have.get("done"):
            published = publish_if_needed()  # the night it finished, the push may have failed
            out = {**P.crawl_status(prices.league), "note": "finished: nothing to do (a new crawl needs a yes)",
                   **({"publish": published} if published else {})}
        else:
            until = window_end(args.until, args.window_from) if args.until else None
            if until is False:
                out = {"note": f"outside the {args.window_from}-{args.until} window: nothing read"}
            else:
                published = None
                try:
                    data = P.crawl(prices.league, sample=args.sample or P.CRAWL_SAMPLE, fresh=args.fresh, until=until)
                finally:
                    published = publish_if_needed()  # what was read, even when the crawl stopped on an error
                out = {**P.crawl_status(prices.league), "skills": len(data.get("skills") or {}),
                       **({"publish": published} if published else {})}
    elif args.cmd == "popularity" and args.publish:
        out = CD.publish(prices.league)
    elif args.cmd == "popularity" and args.fetch:
        out = CD.fetch(prices.league, force=True)
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
