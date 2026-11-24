"""Market checks: unit tests (offline), then live checks against poe.ninja and the trade site's stat list, then
budgeted optimizer runs on real builds.

  python test-market.py [BUILD.xml::MAIN_SKILL ...] [--offline] [--workers 8]

Unit: budget ledger (keyed refunds, unavailable rare gems, vendor gems), rare-cost estimate (more/better affixes
cost more, premium groups, jewels cheaper), trade text matching (numbers to #, "Adds # to #" average), PoB item
parsing, main-skill detection (damage skill over aura), the novelty formula.
Live: poe.ninja league/divine/unique/gem prices; common mod lines map to trade stat ids.
Builds: gems and gear with a small budget: spend within the budget, never worse under the rules.
Exit code 1 when any check fails.
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "eval"))
sys.path.insert(0, os.path.join(HERE, "..", "opt"))
import buildcost  # noqa: E402
import popularity as P  # noqa: E402
import rarecost  # noqa: E402
import trade as T  # noqa: E402
from budget import Budget, VENDOR  # noqa: E402


class FakePrices:
    league = "Test"
    divine = 200.0

    def gem(self, name, level, quality, self_level=False):
        return {"Spell Echo": {"divine": 0.5, "chaos": 100}}.get(name)

    def to_divine(self, chaos):
        return chaos / self.divine


def gem_rows(add):
    """Self-levelled pricing on hand-made poe.ninja rows: price-fixed 20/20 listings lose to a level 1 copy."""
    from ninja import Prices
    p = Prices(league="Test")
    line = lambda lvl, q, chaos, n, corr=False: {"name": "Fireball", "gemLevel": lvl, "gemQuality": q,
                                                 "chaosValue": chaos, "divineValue": chaos / 200,
                                                 "listingCount": n, "corrupted": corr}
    p._stash["SkillGem"] = [line(1, None, 1, 400), line(1, 20, 2, 100), line(20, 20, 2000, 3),
                            line(21, 20, 20, 80, True)]
    add("gem: listed 20/20 without self-levelling", p.gem("Fireball", 20, 20)["chaos"] == 2000)
    r = p.gem("Fireball", 20, 20, self_level=True)
    add("gem: level 1 at quality when self-levelled", r["chaos"] == 2 and r["level"] == 1 and "levelled" in r["relaxed"])
    p._stash["SkillGem"] = [line(1, None, 1, 400), line(20, 20, 2000, 3)]
    r = p.gem("Fireball", 20, 20, self_level=True)
    add("gem: level 1 any quality as the fallback", r["chaos"] == 1 and "any quality" in r["relaxed"])
    p._stash["SkillGem"] = [line(20, 20, 0.5, 50), line(1, 20, 2, 100)]
    add("gem: a cheaper max-level listing still wins", p.gem("Fireball", 20, 20, self_level=True)["chaos"] == 0.5)
    from ninja import is_rare_gem
    add("gem: awakened and exceptional are rare", is_rare_gem("Awakened Spell Echo Support") and is_rare_gem("Empower")
        and not is_rare_gem("Spell Echo"))


def unit(add):
    gem_rows(add)
    b = Budget(1.0, FakePrices())
    add("budget: listed gem priced", b.gem_cost("Spell Echo", 20) == 0.5)
    add("budget: unlisted ordinary gem is a vendor gem", b.gem_cost("Faster Casting", 20) == VENDOR)
    add("budget: unlisted awakened/exceptional gem can't be bought", b.gem_cost("Awakened X", 5, rare=True) is None
        and not b.can(None))
    b.charge(0.6, "crafted Helmet", key="crafted Helmet")
    add("budget: can't overspend", not b.can(0.5) and b.can(0.4))
    add("budget: re-buying a slot counts the refund", b.can(0.9, "crafted Helmet"))
    b.charge(0.3, "crafted Helmet", key="crafted Helmet")
    add("budget: re-buying a slot refunds the earlier item", abs(b.spent - 0.3) < 1e-9)

    a = lambda tier, group="X", crafted=False: {"tier": tier, "group": group, "crafted": crafted}
    add("rarecost: better tiers cost more", rarecost.estimate([a(1)]) > rarecost.estimate([a(2)]) > rarecost.estimate([a(3)]))
    add("rarecost: more good affixes cost more than linearly",
        rarecost.estimate([a(1)] * 4) > 2 * rarecost.estimate([a(1)] * 2) - rarecost.BASE)
    add("rarecost: premium group costs more", rarecost.estimate([a(2, "GlobalSpellGemsLevel")]) > rarecost.estimate([a(2)]))
    add("rarecost: bench craft is cheap", rarecost.estimate([a(1, crafted=True)]) < 0.1)
    add("rarecost: jewels cost less", rarecost.estimate([a(1)], jewel=True) < rarecost.estimate([a(1)]))

    add("trade: numbers become #", T._norm("+107 to maximum Life") == "+# to maximum Life"
        and T._norm("12.5% increased Attack Speed") == "#% increased Attack Speed")
    add("trade: 'Adds # to #' uses the average", T._value("Adds 10 to 20 Fire Damage") == 15.0)

    item = buildcost.parse_item("Rarity: RARE\nTest Grip\nTitan Gauntlets\nItem Level: 84\nSockets: R-R-G B\n"
                                "Implicits: 1\n{enchant}x\n+107 to maximum Life\n{crafted}+28% to Chaos Resistance\n"
                                "Corrupted\nShaper Item")
    add("parse_item: rarity, name, base, links", (item["rarity"], item["name"], item["base"], item["links"])
        == ("RARE", "Test Grip", "Titan Gauntlets", 3))
    add("parse_item: explicit vs crafted; flag lines dropped", item["explicit"] == ["+107 to maximum Life"]
        and item["crafted"] == ["+28% to Chaos Resistance"])
    foil = buildcost.parse_item("Rarity: RELIC\nMageblood\nHeavy Belt\nImplicits: 1\n+30 to Strength\n"
                                "Leftmost 4 Magic Utility Flasks constantly apply their Flask Effects to you\nFoil Unique (Verdant)")
    add("parse_item: a foil unique's title", (foil["rarity"], foil["name"], foil["base"]) == ("RELIC", "Mageblood", "Heavy Belt"))
    add("local flags: weapons all local, armour only its defences, jewellery none",
        buildcost.local_flags("Wand", ["+1 to Level"]) == [True]
        and buildcost.local_flags("Gloves", ["86% increased Armour", "+107 to maximum Life"]) == [True, False]
        and buildcost.local_flags("Ring", ["+30 to Armour"]) == [False])

    from net import needed_wait
    hdr = lambda rules, state, policy_rules="Ip": {"X-Rate-Limit-Rules": policy_rules, "X-Rate-Limit-Ip": rules,
                                                   "X-Rate-Limit-Ip-State": state}
    add("throttle: no wait far from the limits", needed_wait(hdr("5:10:60,30:300:1800", "1:10:0,3:300:0")) == 0)
    add("throttle: waits a long window's whole period, not a capped two minutes",
        needed_wait(hdr("5:10:60,30:300:1800", "1:10:0,28:300:0")) == 301)
    add("throttle: honours a restricted state", needed_wait(hdr("5:10:60", "5:10:57")) == 58)
    add("throttle: reads the rules GGG lists (Account too)",
        needed_wait({"X-Rate-Limit-Rules": "Account", "X-Rate-Limit-Account": "3:5:60",
                     "X-Rate-Limit-Account-State": "2:5:0"}) == 6)

    gem = lambda name, sock, support=False, tags="Spell": {"typeLine": name, "socket": sock, "support": support,
                                                           "properties": [{"name": tags}]}
    chars = {"items": [
        {"inventoryId": "Helm", "sockets": [{"group": 0}] * 4,
         "socketedItems": [gem("Hatred", 0, tags="Aura, Spell, AoE, Cold")] + [gem(f"S{i}", i, True) for i in (1, 2, 3)]},
        {"inventoryId": "Gloves", "sockets": [{"group": 0}] * 3,
         "socketedItems": [gem("Fireball", 0, tags="Projectile, Spell, AoE, Fire")] + [gem(f"T{i}", i, True) for i in (1, 2)]},
        {"inventoryId": "Weapon2", "sockets": [{"group": 0}] * 6,
         "socketedItems": [gem("Swap Skill", 0)] + [gem(f"U{i}", i, True) for i in range(1, 6)]},
        {"inventoryId": "Belt", "frameType": 3, "name": "Mageblood"}]}
    add("popularity: damage skill beats a bigger aura group; weapon swap ignored", P.main_skill(chars) == "Fireball")
    add("popularity: uniques read", P.uniques(chars) == ["Mageblood"])
    auras_only = {"items": [chars["items"][0]]}
    add("popularity: only utility skills socketed -> unknown main skill", P.main_skill(auras_only) is None)
    data = {"sample": 100, "ladderDepth": 1000, "ascendancy": {"A": 100}, "skills": {"S": 10},
            "uniques": {"Mageblood": 25}, "archetypes": {"A|S": 5}}
    add("novelty: an archetype at 5% scores 0", P.novelty(data, "A", "S")["novelty"] == 0.0)
    add("novelty: an unplayed archetype scores near 1", P.novelty(data, "A", "Z")["novelty"] == 1.0)
    add("novelty: an ascendancy not on the ladder gives no score", P.novelty(data, "None", "S")["novelty"] is None)
    add("novelty: unique shares by title", P.novelty(data, "A", "S", ["Mageblood"])["uniques"]["Mageblood"] == 0.25)

    class NoStats(T.Trade):
        def _stats(self):
            return {}
    r = NoStats(FakePrices(), ggg=object()).price("Titan Gauntlets", ["Something PoB says"])
    add("trade: nothing matched -> no price (not the cheapest base)", r["divine"] is None and r.get("reason"))


def live(add):
    from ninja import Prices
    p = Prices()
    add(f"poe.ninja: league {p.league}, divine {p.divine:g} chaos", p.divine > 1)
    mb = p.unique("Mageblood", "Heavy Belt")
    add(f"poe.ninja: Mageblood {mb and mb['divine']} div", bool(mb) and mb["divine"] > 10)
    se = p.gem("Spell Echo", 20, 20)
    add(f"poe.ninja: Spell Echo 20/20 {se and se['divine']} div", bool(se) and 0 < se["divine"] < 50)
    emp = p.gem("Empower", 4, 0)
    add("poe.ninja: Empower 4 falls back to a corrupted copy", bool(emp) and emp.get("relaxed", "").startswith("corrupted"))
    hc = Prices("Hardcore " + p.league) if not p.league.startswith("Hardcore") else p
    add(f"poe.ninja: a league with a space ({hc.league}) works", hc.divine > 1)
    t = T.Trade(p)
    text = {sid: txt for (kind, txt), sid in t._stats().items() if kind == "explicit"}
    want = {"+107 to maximum Life": "+# to maximum Life", "+44% to Fire Resistance": "+#% to Fire Resistance",
            "+47 to Strength": "+# to Strength", "25% increased Movement Speed": "#% increased Movement Speed"}
    got = {l: text.get(t.stat_id(l)) for l in want}
    add("trade: global mod lines map to the right stat", got == want, got=got)
    local = {"86% increased Armour": True, "Adds 10 to 20 Physical Damage": True, "+84 to maximum Energy Shield": True}
    got_local = {l: text.get(t.stat_id(l, local=True)) for l in local}
    add("trade: local mod lines map to the (Local) stat", all((v or "").endswith("(Local)") for v in got_local.values()),
        got=got_local)
    neg = text.get(t.stat_id("-12% to Chaos Resistance"))
    add("trade: a negative mod maps to its stat", neg == "+#% to Chaos Resistance", got=neg)


def builds(add, specs, workers):
    import evaluator as E
    from budget import Budget
    from ninja import Prices
    from objective import Rules
    import gear as R
    import gems as G
    prices = Prices()
    with E.EvalPool(workers=workers) as pool:
        for spec in specs:
            path, _, skill = spec.partition("::")
            name = os.path.basename(path)
            xml = open(path, encoding="utf-8").read()
            for run, limit in (("gems", 1.0), ("gear", 3.0)):
                start = pool.load(xml, skill)
                rules = Rules(E.main_metric(start["stats"]), start["stats"])
                budget = Budget(limit, prices)
                log = []
                if run == "gems":
                    G.optimize_gems(pool, rules, budget=budget, log=log)
                else:
                    R.optimize_gear(pool, rules, budget=budget, main_skill=skill, log=log)
                final = pool.stats()
                rep = budget.report()
                add(f"{name} {run} with {limit:g} div: spent {rep['spent']}", rep["spent"] <= limit + 1e-9,
                    ledger=rep["ledger"])
                bought = [c for c in log if "divine" in c or "estimate" in c]
                live_entries = [e for e in rep["ledger"] if not e.get("replaced")]
                ledger_sum = round(sum(e["divine"] for e in live_entries), 2)
                add(f"{name} {run}: every purchase is in the ledger ({len(bought)} changes, {len(rep['ledger'])} entries)",
                    len(rep["ledger"]) == len(bought) and abs(ledger_sum - round(rep["spent"], 2)) <= 0.01)
                add(f"{name} {run}: {rules.value(start['stats']):,.0f} -> {rules.value(final):,.0f}, never worse",
                    rules.not_worse(final, start["stats"]) and rules.value(final) >= rules.value(start["stats"]) * (1 - 1e-9))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("builds", nargs="*")
    ap.add_argument("--offline", action="store_true")
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()
    report = []

    def add(test, ok, **extra):
        report.append({"test": test, "ok": bool(ok), **extra})

    unit(add)
    if not args.offline:
        live(add)
        if args.builds:
            builds(add, args.builds, args.workers)
    failed = [r for r in report if not r["ok"]]
    print(json.dumps({"passed": len(report) - len(failed), "failed": failed,
                      "tests": [f"{'ok  ' if r['ok'] else 'FAIL'} {r['test']}" for r in report]}, indent=1, default=str))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
