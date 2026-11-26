"""Back-test the build lab on strong guide builds: how close does it get, and where does it fall short?

  backtest.py run [--dir BUILDS] [--only NAME] [--modes uniques-match,uniques-free,budget] [--seeds 1] [--force]
  backtest.py report                         the table of every saved result (markdown)

Builds: backtest/builds.json (file names, loadouts, main skills). The files aren't in the repo: --dir or the
POB_BUILDS environment variable points at the folder holding them.

Modes (all on the guide's own loadout and config):
  uniques-match  The guide's uniques, cluster jewels, flasks, anoints and other gem groups stay. Its rares, rare
                 jewels, main-group supports and passive tree go; the lab rebuilds them (tree from the class start
                 with the guide's point budget, supports to the guide's link count, crafted rares and jewels),
                 holding the guide's EHP and defence profile (max hits, suppression, block, regen, movement
                 speed) as floors. Its budget is what the guide's rares and main-group supports cost.
                 Tests the optimizers.
  uniques-free   The same with no EHP floor: the lab's damage ceiling with the guide's uniques and money.
  budget         Designed from a spec: the guide's class, ascendancy, level, main skill, weapon base, defence type
                 and other gem groups, no uniques, with a budget equal to the guide's whole cost and the guide's
                 EHP and defence profile as floors. Tests the whole design path.

Rares are priced with one yardstick on both sides: market/rarecost.py, by which mods they have and how those combine
(the guide's lines are read back to mod tiers from PoB's affix pools). Crafted rares start at T2, drop a tier where
the budget is short and move up to T1 where it allows. The guide's rares and the lab's final ones (uniques-match and
budget) are also checked on the trade site and reported beside the estimate (--no-trade skips it; guide checks
are cached for a day).

Each uniques run also records what the lab did differently: the guide's main-group supports against the lab's,
keystones, and the guide's notables and keystones the lab didn't take, ranked by what each adds to the lab's
build per point (calculator probes).
--seeds N runs each mode N times in different orders (gems before the tree, gear slots shuffled) and keeps the
best; the spread shows how much the greedy search depends on its path.

Results: %LOCALAPPDATA%\\poe-build-expert\\backtest\\<build>.json (and the lab's builds as XML beside it). A build
whose results exist is skipped unless --force.
"""
import argparse
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
LAB = os.path.dirname(HERE)
for sub in ("design", "eval", "opt", "market"):
    sys.path.insert(0, os.path.join(LAB, sub))

from ninja import MIN_LISTINGS  # noqa: E402  (fewer trade listings than this is one seller's ask, not a price)

MODES = ("uniques-match", "uniques-free", "budget")
UNIQUE = ("UNIQUE", "RELIC")
MISSED_TOP = 10
# The guide's defence profile, held as floors in the "match" runs (EHP alone lets the lab trade away suppression,
# block, max hits or recovery it doesn't see).
PROFILE = ("PhysicalMaximumHitTaken", "FireMaximumHitTaken", "ColdMaximumHitTaken", "LightningMaximumHitTaken",
           "ChaosMaximumHitTaken", "EffectiveSpellSuppressionChance", "EffectiveBlockChance",
           "EffectiveSpellBlockChance", "LifeRegenRecovery", "EnergyShieldRegenRecovery", "MovementSpeedMod")
TIER = 2            # crafted rares start at T2; the budget moves them a tier down or up (gear.upgrade_tiers)
TRADE_CACHE_HOURS = 24
FLOOR_SHARE = 0.95  # floors (EHP and the defence profile) at 95% of the guide's: a roll's difference isn't a miss
# Supports that decide how the skill is used (totems, traps, mines, triggers) stay with the main skill, like the
# main gem: without Ballista Totem, a totem guide's ascendancy and tree make no sense.
DELIVERY_TAGS = {"Totem", "Trap", "Mine"}
DELIVERY_NAMES = re.compile(r"^(Cast |Hextouch|Mark On Hit|Manaforged Arrows|Autoexertion)", re.I)


def out_dir():
    import concept as C
    base = os.environ.get("LOCALAPPDATA") if os.name == "nt" else os.path.join(os.path.expanduser("~"), ".cache")
    d = os.path.join(base or os.path.expanduser("~"), "poe-build-expert", "backtest")
    os.makedirs(d, exist_ok=True)
    return d


def builds_list():
    with open(os.path.join(HERE, "builds.json"), encoding="utf-8") as f:
        return json.load(f)["builds"]


def value(stats, metric):
    import evaluator as E
    return E.value(stats, metric) or 0.0


def snapshot(stats, metric):
    p = stats.get("player") or {}
    return {"value": value(stats, metric), "EHP": p.get("TotalEHP"), "Life": p.get("Life"),
            "ES": p.get("EnergyShield"), "res": {k: p.get(k) for k in ("FireResist", "ColdResist", "LightningResist",
                                                                       "ChaosResist")},
            "profile": {k: p.get(k) for k in PROFILE if p.get(k) is not None}}


# ---------------- the guide ----------------

def read_guide(pool, b, xml, prices, db=None):
    """Load the guide and record what the runs compare against. With a GameDB, delivery supports are listed and
    left out of supportCost (the uniques runs keep them, so they aren't money to spend)."""
    import buildcost
    import evaluator as E
    start = pool.load(xml, b["main_skill"])
    stats = start["stats"]
    metric = E.main_metric(stats)
    pts = pool.points()
    groups = pool.groups()
    main = next(g for g in groups if g["main"])
    live = [g for g in main["gems"] if g.get("enabled", True)]   # a disabled gem is a spare, not a link
    nodes = pool.allocated_nodes()
    level = re.search(r'<Build[^>]*\blevel="(\d+)"', xml)
    guide = {"name": b["name"], "file": b.get("file") or (b.get("reference") or {}).get("file"), "loadout": b["loadout"], "mainSkill": start["mainSkill"],
             "metric": metric, "class": pts["class"], "ascendancy": pts["ascendancyName"],
             "level": int(level.group(1)) if level else 95, "points": pts["used"], "ascPoints": pts["ascendancy"],
             "links": len(live), "mainSlot": main.get("slot"),
             "supports": [g["name"] for g in live if g.get("support")],
             "keystones": sorted(n["name"] for n in nodes if n["type"] == "Keystone"),
             "notables": {n["id"]: n["name"] for n in nodes if n["type"] in ("Notable", "Keystone")},
             "stats": snapshot(stats, metric), "warnings": stats.get("warnings") or []}
    guide["deliverySupports"] = [g["name"] for g in live if g.get("support") and db is not None
                                 and is_delivery(db, g["name"])]
    guide["rares"] = guide_rares(pool)
    guide["rareCost"] = round(sum(r["estimate"] for r in guide["rares"]), 3)
    if prices is not None:
        try:
            cost = buildcost.price_build(pool, prices)
            guide["cost"] = cost["total"]   # uniques and gems (poe.ninja); rares are in rareCost
            guide["unpriced"] = cost["unpriced"]
            supports = set(guide["supports"]) - set(guide["deliverySupports"])
            guide["supportCost"] = round(sum(g["divine"] for g in cost["gems"] if g["gem"] in supports), 3)
        except (RuntimeError, OSError) as e:
            guide["costError"] = str(e)
    return guide, stats


def guide_rares(pool):
    """The guide's rare and magic gear (flasks aside) and rare jewels (cluster jewels aside), each priced with
    rarecost from its mod lines read back to tiers."""
    import buildcost
    import gear as R
    import rarecost
    out, cache = [], {}
    for s in pool.slots():
        item = s.get("item")
        if not item or item["rarity"] not in ("RARE", "MAGIC"):
            continue
        jewel = bool(s.get("socket"))
        if not (s["slot"] in R.GEAR_SLOTS or (jewel and not s.get("cluster") and not item.get("cluster"))):
            continue
        info = buildcost.parse_item(item.get("text"))
        key = (item["base"], jewel)
        if key not in cache:
            try:
                cache[key] = R.tier_pools(pool, item["base"], jewel=jewel)
            except ValueError:
                cache[key] = {}
        est, unmatched = rarecost.estimate_lines(info["explicit"], info["crafted"], cache[key], jewel=jewel)
        out.append({"slot": s["slot"], "base": item["base"], "type": item.get("type"), "jewel": jewel,
                    "estimate": est, "explicit": info["explicit"], "crafted": info["crafted"],
                    **({"unmatched": unmatched} if unmatched else {})})
    return out


def trade_cache_path():
    return os.path.join(out_dir(), "trade-cache.json")


def trade_guide_rares(prices, rares, say):
    """Trade-site prices for the guide's rares (cached for TRADE_CACHE_HOURS)."""
    import buildcost
    from net import RateLimited
    from trade import Trade
    try:
        with open(trade_cache_path(), encoding="utf-8") as f:
            cache = json.load(f)
    except (OSError, ValueError):
        cache = {}
    t = Trade(prices)
    now = time.time()
    for r in rares:
        key = json.dumps([prices.league, r["base"], r["explicit"], r["crafted"]])
        hit = cache.get(key)
        if hit and now - hit["at"] < TRADE_CACHE_HOURS * 3600:
            r["trade"] = hit["result"]
            continue
        try:
            res = t.price(r["base"], r["explicit"], r["crafted"],
                          buildcost.local_flags(r.get("type"), r["explicit"]))
        except RateLimited as e:
            say(f"trade checks stopped: {e}")
            break
        except RuntimeError as e:
            r["trade"] = {"error": str(e)}
            continue
        r["trade"] = {k: res.get(k) for k in ("divine", "listings", "need", "floor", "thin", "reason", "url")}
        cache[key] = {"at": now, "result": r["trade"]}
    with open(trade_cache_path(), "w", encoding="utf-8") as f:
        json.dump(cache, f)


def is_delivery(db, name):
    """A support that decides how the skill is used (DELIVERY_TAGS or DELIVERY_NAMES)."""
    if DELIVERY_NAMES.match(name or ""):
        return True
    row = db.con.execute("SELECT tag_string FROM gems WHERE is_support = 1 AND lower(name) IN (?, ?)",
                         ((name or "").lower(), re.sub(r" support$", "", (name or "").lower()))).fetchone()
    return bool(row) and bool(DELIVERY_TAGS & {t.strip() for t in (row[0] or "").split(",")})


def strip_ops(pool, db=None):
    """Ops that take the guide back to what the lab must rebuild: rares become blank items of the same base
    (sockets, quality and anoint kept), rare and magic jewels come out, main-group supports come out (delivery
    supports stay when a GameDB is given)."""
    import gear as R
    ops = []
    for s in pool.slots():
        item = s.get("item")
        if not item or item["rarity"] in UNIQUE:
            continue
        if s["slot"] in R.GEAR_SLOTS:
            text = R.item_text(s["slot"], item["base"], [], item.get("enchants") or [], [],
                               sockets=R._line(item.get("text"), "Sockets"),
                               quality=R._line(item.get("text"), "Quality"))
            ops.append({"op": "equip", "slot": s["slot"], "text": text})
        elif s.get("socket") and not s.get("cluster") and not item.get("cluster"):
            ops.append({"op": "unequip", "slot": s["slot"]})
    main = next(g for g in pool.groups() if g["main"])
    for g in sorted((g for g in main["gems"] if g.get("support")), key=lambda g: -g["index"]):
        if db is not None and g.get("enabled", True) and is_delivery(db, g.get("name")):
            continue
        ops.append({"op": "gem-remove", "group": "main", "index": g["index"]})
    return ops


def missed_nodes(pool, guide, metric):
    """The guide's notables and keystones the lab didn't take, ranked by gain per point on the lab's build."""
    have = {n["id"] for n in pool.allocated_nodes()}
    missing = [(i, n) for i, n in guide["notables"].items() if int(i) not in have]
    if not missing:
        return []
    base = pool.stats()
    bv, be = value(base, metric), (base.get("player") or {}).get("TotalEHP") or 0
    results = pool.probe([{"allocate": [int(i)]} for i, _ in missing])
    out = []
    for (i, name), r in zip(missing, results):
        if "error" in r:
            continue
        cost = max(1, r.get("points") or 1)  # nodes the probe added, path included
        dv = value(r, metric) - bv
        de = ((r.get("player") or {}).get("TotalEHP") or 0) - be
        out.append({"node": name, "id": int(i), "points": cost, "dpsPct": round(dv / max(abs(bv), 1) * 100, 2),
                    "ehpPct": round(de / max(abs(be), 1) * 100, 2),
                    "dpsPctPerPoint": round(dv / max(abs(bv), 1) * 100 / cost, 3)})
    out.sort(key=lambda x: -x["dpsPctPerPoint"])
    return out[:MISSED_TOP]


def guide_floors(guide):
    """Floors for the guide's defence profile: every profile stat it has above zero (chaos max hit only when it
    isn't Chaos Inoculation, where PoB reports it as unlimited)."""
    out = {}
    for k, v in (guide["stats"].get("profile") or {}).items():
        if isinstance(v, (int, float)) and 0 < v < 1e9:
            out[k] = v * FLOOR_SHARE
    return out


def run_uniques(pool, b, xml, guide, guide_stats, floor, seed, say, db, prices=None, trade=False, match=False):
    """One uniques run. match: hold the guide's defence profile as floors (also when PoB gives the guide no EHP;
    floor is then None)."""
    import concept as C
    import gear as R
    import opt as O
    from budget import Budget
    budget = None
    if prices is not None:
        budget = Budget(max(guide["rareCost"] + (guide.get("supportCost") or 0), 0.05), prices)
    pool.load(xml, b["main_skill"])
    pool.apply(strip_ops(pool, db))
    stripped = pool.stats()
    chaos = (guide_stats.get("player") or {}).get("ChaosResist")
    chaos_min = min(0, chaos) if isinstance(chaos, (int, float)) else 0
    t0 = time.perf_counter()
    log = []
    rules = C.pipeline(pool, guide_stats, guide["metric"], guide["class"], guide["ascendancy"], guide["links"],
                       budget=budget, log=log, tier=TIER, ehp_floor=floor, owned=None, say=say,
                       points=guide["points"],
                       asc_points=guide["ascPoints"], seed=seed, chaos_min=chaos_min,
                       floors=guide_floors(guide) if match else None, keep_supports=guide["deliverySupports"])
    final = pool.stats()
    main = next(g for g in pool.groups() if g["main"])
    nodes = pool.allocated_nodes()
    extra = {}
    if budget is not None:
        extra["budget"] = round(budget.limit, 3)
        extra["spent"] = round(budget.spent, 3)
        extra["rareCost"] = round(sum(c.get("estimate") or 0 for c, _ in R.crafted_items(pool, log).values()), 3)
        if trade:
            extra["tradeChecks"] = O.trade_checks(prices, log)
    return {"seed": seed, "seconds": round(time.perf_counter() - t0, 1), "ehpFloor": floor, **extra,
            "stripped": snapshot(stripped, guide["metric"]), "stats": snapshot(final, guide["metric"]),
            "brokenRules": sorted(rules.shortfalls(final)), "hardBroken": sorted(rules.hard_shortfalls(final)),
            "utility": rules.utility(final),
            "warnings": final.get("warnings") or [],
            "points": pool.points(), "supports": [g["name"] for g in main["gems"] if g.get("support")],
            "keystones": sorted(n["name"] for n in nodes if n["type"] == "Keystone"),
            "missedGuideNodes": missed_nodes(pool, guide, guide["metric"]), "xml": pool.save_xml()}


def budget_spec(pool_slots, guide, db):
    import concept as C
    slots = {s["slot"]: s.get("item") for s in pool_slots}
    weapon = (slots.get("Weapon 1") or {}).get("base")
    off = (slots.get("Weapon 2") or {}).get("base")
    body = (slots.get("Body Armour") or {}).get("base")
    defence = "es"
    if body:
        kinds = {k[:-len("BaseMax")] for k, v in db.base(body)["armour"].items() if k.endswith("BaseMax") and v}
        defence = next((d for d, want in C.DEFENCES.items() if want == kinds), "es")
    return {"name": f"backtest {guide['name']}", "class": guide["class"], "ascendancy": guide["ascendancy"],
            "level": guide["level"], "main_skill": guide["mainSkill"], "links": max(1, min(6, guide["links"])),
            "main_slot": guide["mainSlot"] or "Body Armour", "weapon": weapon, "offhand": off or "none",
            "defence": defence, "groups": guide["otherGroups"], "supports": guide["deliverySupports"],
            "keep_supports": guide["deliverySupports"]}


def other_groups(pool):
    out = []
    for g in pool.groups():
        if g["main"] or not g["enabled"] or g.get("source") or "Swap" in (g.get("slot") or ""):
            continue
        gems = [x["name"] for x in g["gems"] if x.get("name") and x.get("enabled", True)]
        if gems and any(not x.get("support") for x in g["gems"] if x.get("name")):
            out.append({"slot": g.get("slot") or "", "gems": gems})
    return out


# ---------------- commands ----------------

def refs_list(skill, top, prices, say):
    """Back-test entries from the reference builds of `skill` (design/refs.py): the `top` by damage, each with
    its PoB XML (a ladder character through PoB's import, a web guide's loadout)."""
    import evaluator as E
    import refs as RF
    ev = E.Evaluator()
    measured = [m for m in RF.measure(prices.league, skill, ev=ev, say=say)
                if "error" not in m and isinstance(m.get("value"), (int, float))]
    out = []
    for i, m in enumerate(sorted(measured, key=lambda m: -m["value"])[:top], 1):
        xml = RF.ref_xml(prices.league, m["file"], ev)
        if m.get("loadout"):
            xml = E.ph().select_loadout(xml, m["loadout"])
        label = m.get("title") or f"ladder {m.get('class')}"
        # the content id keeps a new crawl's rank-1 character from reusing an older one's results
        out.append({"name": f"{skill} ref {i} ({m['source']}: {label}, {m['id'][:6]})", "main_skill": skill,
                    "loadout": None,
                    "xml": xml, "reference": {k: m.get(k) for k in ("file", "source", "title", "url")}})
    if not out:
        raise ValueError(f"no measured reference builds of {skill} (refs.py list)")
    return out


def run(args):
    import concept as C
    import evaluator as E
    folder = args.dir or os.environ.get("POB_BUILDS")
    if not args.refs and (not folder or not os.path.isdir(folder)):
        raise ValueError("give the PoB Builds folder: --dir or POB_BUILDS (or --refs SKILL)")
    modes = [m.strip() for m in args.modes.split(",")]
    for m in modes:
        if m not in MODES:
            raise ValueError(f"mode must be one of {', '.join(MODES)}")
    from ninja import Prices
    prices = Prices(args.league)
    db = C.GameDB()
    say = lambda m: print(m, file=sys.stderr, flush=True)  # noqa: E731
    source = refs_list(args.refs, args.top, prices, say) if args.refs else builds_list()
    todo = [b for b in source if not args.only or args.only.lower() in b["name"].lower()]
    for b in todo:
        path = os.path.join(out_dir(), C.slug(b["name"]) + ".json")
        result = {}
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                result = json.load(f)
        todo_modes = modes if args.force else [m for m in modes if m not in result.get("runs", {})]
        if not todo_modes:
            say(f"{b['name']}: done already (--force to redo)")
            continue
        if b.get("xml"):
            xml = b["xml"]
            result["reference"] = b["reference"]
        else:
            with open(os.path.join(folder, b["file"]), encoding="utf-8") as f:
                xml = E.ph().select_loadout(f.read(), b["loadout"])
        say(f"== {b['name']}")
        try:
            run_one(args, b, xml, result, todo_modes, prices, db, say)
        except Exception as e:  # one guide's failure shouldn't end the run
            result["error"] = f"{type(e).__name__}: {e}"
            say(f"{b['name']}: failed ({result['error']})")
        for mode, r in (result.get("runs") or {}).items():
            if r.get("xml"):
                with open(os.path.join(out_dir(), f"{C.slug(b['name'])}-{mode}.xml"), "w", encoding="utf-8") as f:
                    f.write(r.pop("xml"))
        with open(path, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=1, ensure_ascii=False)
        say(f"{b['name']}: saved {path}")


def run_one(args, b, xml, result, modes, prices, db, say):
    import concept as C
    import evaluator as E
    result.pop("error", None)
    with E.EvalPool(workers=E.default_workers() if args.workers is None else args.workers) as pool:
        guide, guide_stats = read_guide(pool, b, xml, prices, db)
        if not args.no_trade:
            trade_guide_rares(prices, guide["rares"], say)
        guide["otherGroups"] = other_groups(pool)
        slots = pool.slots()
        result["guide"] = guide
        runs = result.setdefault("runs", {})
        for mode in [m for m in modes if m.startswith("uniques")]:
            floor = (guide["stats"]["EHP"] or 0) * FLOOR_SHARE if mode == "uniques-match" else None
            tries = []
            for seed in range(args.seeds):
                say(f"{b['name']}: {mode}, seed {seed}")
                tries.append(run_uniques(pool, b, xml, guide, guide_stats, floor or None, seed, say, db, prices,
                                         trade=not args.no_trade and mode == "uniques-match",
                                         match=mode == "uniques-match"))
            runs[mode] = pick(tries, guide)
    if "budget" in modes:
        spec = budget_spec(slots, guide, db)
        budget = max((guide.get("cost") or 0) + guide["rareCost"], 1.0)
        tries = []
        for seed in range(args.seeds):
            say(f"{b['name']}: budget {budget:.1f} div, seed {seed}")
            t0 = time.perf_counter()
            ehp_floor = (guide["stats"]["EHP"] or 0) * FLOOR_SHARE or None
            rep, lab_xml = C.complete(spec, budget_div=budget, ehp_floor=ehp_floor, metric=guide["metric"],
                                      floors=guide_floors(guide), workers=args.workers, league=args.league,
                                      config_xml=xml, seed=seed, log_progress=say, trade_check=not args.no_trade,
                                      references=False)
            stats = {"player": {"TotalEHP": rep["after"]["TotalEHP"], "Life": rep["after"]["Life"],
                                "EnergyShield": rep["after"]["EnergyShield"], **rep["after"]["res"]}}
            snap = snapshot(stats, guide["metric"])
            snap["value"] = rep["after"]["value"] if rep["metric"] == guide["metric"] else None
            tries.append({"seed": seed, "seconds": round(time.perf_counter() - t0, 1), "spec": spec,
                          "budget": round(budget, 2), "metric": rep["metric"], "stats": snap,
                          "brokenRules": rep["brokenRules"], "hardBroken": rep.get("hardBroken", rep["brokenRules"]),
                          **({"utility": rep["utility"]} if "utility" in rep else {}),
                          "spent": (rep.get("spend") or {}).get("spent"),
                          **({"tradeChecks": rep["tradeChecks"]} if rep.get("tradeChecks") else {}),
                          "supports": next((g["gems"][1:] for g in rep["gems"]), []), "xml": lab_xml,
                          **({"uniques": rep["uniques"]} if rep.get("uniques") else {})})
        result.setdefault("runs", {})["budget"] = pick(tries, guide)


def pick(tries, guide):
    """The best try (hard rules first, then utility or the metric); the others' values give the spread."""
    def key(t):
        # fewest hard breaks, then what the run optimized: utility with weighted floors, else the metric
        return (-len(hard_broken(t)), t["utility"] if "utility" in t else (t["stats"]["value"] or 0))
    best = max(tries, key=key)
    if len(tries) > 1:
        best["seedValues"] = [round(t["stats"]["value"] or 0) for t in tries]
    for t in tries:
        if t is not best:
            t.pop("xml", None)
    return best


def pct(a, b):
    return f"{a / b * 100:.0f}%" if a and b else "-"


def hard_broken(run_):
    """The rules a run breaks outright; a floor missed within the weighted band isn't one (older results: all)."""
    return run_["hardBroken"] if "hardBroken" in run_ else (run_.get("brokenRules") or [])


def thin(t):
    """A trade price from fewer than MIN_LISTINGS listings (one seller's ask, not a market price)."""
    return t.get("thin") or (t.get("listings") or 0) < MIN_LISTINGS


def report(_args):
    rows = []
    for name in sorted(os.listdir(out_dir())):
        if not name.endswith(".json"):
            continue
        with open(os.path.join(out_dir(), name), encoding="utf-8") as f:
            r = json.load(f)
        if name == os.path.basename(trade_cache_path()):
            continue
        if "guide" not in r:
            rows.append([name[:-5], "failed: " + (r.get("error") or "no result")] + ["-"] * 9)
            continue
        g = r["guide"]
        gs = g["stats"]
        cells = [g["name"], f"{gs['value'] / 1e6:.2f}M", f"{(gs['EHP'] or 0) / 1e3:.0f}k"]
        for mode in MODES:
            run_ = r.get("runs", {}).get(mode)
            if not run_:
                cells += ["-", "-"]
                continue
            s = run_["stats"]
            broken = "*" if hard_broken(run_) else ("~" if run_.get("brokenRules") else "")
            cells += [pct(s["value"], gs["value"]) + broken, pct(s["EHP"], gs["EHP"])]
        rares = g.get("rares") or []
        priced = [x for x in rares if (x.get("trade") or {}).get("divine")]
        traded = [x for x in priced if not thin(x["trade"])]
        n_thin = len(priced) - len(traded)
        cells.append(f"{g.get('cost', 0):.0f}")
        cells.append(f"{g.get('rareCost', 0):.1f}"
                     + (f"; {len(traded)} of {len(rares)} priced: {sum(x['estimate'] for x in traded):.1f} / "
                        f"{sum(x['trade']['divine'] for x in traded):.1f}" if traded else "")
                     + (f"; {n_thin} thin" if n_thin else ""))
        rows.append(cells)
    head = ["Guide", "DPS", "EHP", "Uniques+floor DPS", "EHP", "Uniques, no floor DPS", "EHP", "Budget DPS", "EHP",
            "Uniques+gems (div)", "Rares (div): model; model / trade where priced"]
    lines = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    lines += ["| " + " | ".join(c) + " |" for c in rows]
    print("\n".join(lines))
    print("\nPercentages are the lab's result against the guide's; * = a hard rule broken (resists, chaos, PoB"
          " warnings, or a defence floor below 70% of the guide's); ~ = a defence floor missed within the weighted"
          " band. Rares: the rarecost model for all the guide's rares; then, for those the trade site could"
          f" price from at least {MIN_LISTINGS} listings, the model and trade totals side by side (\"thin\": fewer"
          " listings, left out).")


def main():
    import evaluator as E
    ph = E.ph()
    if ph._lj is None:
        import subprocess
        venv = getattr(ph, "VENV_PY", "")
        if venv and os.path.exists(venv) and os.path.abspath(sys.executable).lower() != os.path.abspath(venv).lower():
            sys.exit(subprocess.call([venv] + sys.argv))
        sys.exit("lupa isn't installed (pip install lupa)")
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    ap = argparse.ArgumentParser(description="Back-test the build lab on guide builds")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("run")
    p.add_argument("--dir")
    p.add_argument("--only")
    p.add_argument("--modes", default=",".join(MODES))
    p.add_argument("--seeds", type=int, default=1)
    p.add_argument("--workers", type=int)
    p.add_argument("--league")
    p.add_argument("--force", action="store_true")
    p.add_argument("--no-trade", action="store_true")
    p.add_argument("--refs", metavar="SKILL", help="back-test on the skill's reference builds (ladder and web) "
                   "instead of builds.json")
    p.add_argument("--top", type=int, default=3, help="with --refs: how many, strongest first")
    sub.add_parser("report")
    args = ap.parse_args()
    if args.cmd == "run":
        run(args)
    else:
        report(args)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError) as e:
        sys.exit(f"error: {e}")
