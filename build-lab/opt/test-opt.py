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
import math
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


def bundle_tests(add):
    """Tree bundles on hand-made candidates: several refunds pay for one big addition; overlaps and anchors."""
    row = lambda c: (1.0, c, {})  # noqa: E731  (rate, candidate, result) as _rank returns them
    adds = [row({"key": "nFar", "id": 900, "points": 5, "masteries": None, "label": "Far"}),
            row({"key": "nNear", "id": 901, "points": 1, "masteries": None, "label": "Near"})]
    rems = [row({"id": 1, "frees": 2, "name": "a"}), row({"id": 2, "frees": 2, "name": "b"}),
            row({"id": 3, "frees": 1, "name": "c"}), row({"id": 4, "frees": 2, "name": "d"})]
    deps = {1: {1}, 2: {2, 3}, 3: {3}, 4: {4}}
    out = T._bundles(adds, rems, {"nFar": {50}, "nNear": {51}}, deps, 0, set())
    add("tree", "bundle pays for a far addition", len(out) == 1 and out[0][1]["key"] == "nFar"
        and out[0][0]["frees"] >= 5 and out[0][2]["deallocate"] == [1, 2, 4], detail=str(out and out[0][2]))
    add("tree", "bundle skips overlapping refunds", out and 3 not in out[0][2]["deallocate"])
    out = T._bundles(adds, rems, {"nFar": {1, 2, 4}, "nNear": set()}, deps, 0, set())
    add("tree", "bundle never takes every anchor of the path", all(
        not ({1, 2, 4} <= set(o[2]["deallocate"]) | {d for i in o[2]["deallocate"] for d in deps[i]}) for o in out))
    add("tree", "no bundle when one refund covers it",
        not T._bundles([row({"key": "nX", "id": 7, "points": 2, "masteries": None, "label": "X"})], rems,
                       {"nX": set()}, deps, 0, set()))
    r = Rules("CombinedDPS", fake(), floors={"EffectiveSpellSuppressionChance": 100})
    add("rules", "stat floor broken below it", "floor:EffectiveSpellSuppressionChance" in
        r.shortfalls(fake(EffectiveSpellSuppressionChance=60)))
    add("rules", "stat floor met at it", not r.shortfalls(fake(EffectiveSpellSuppressionChance=100)))
    # weighted floors: weight 2, hard below 70% of a floor
    sup = "EffectiveSpellSuppressionChance"
    w = Rules("CombinedDPS", fake(), floors={sup: 100}, ehp_floor=10000, start_breaks="repair",
              floor_weight=2, floor_hard=0.7)
    hard_floor = Rules("CombinedDPS", fake(), floors={sup: 100}, ehp_floor=10000, start_breaks="repair")
    met, short = fake(dps=100, **{sup: 100}), fake(dps=300, **{sup: 80})
    add("weighted floors", "a big damage gain outweighs a small floor miss", w.better(short, met)
        and not hard_floor.better(short, met))
    add("weighted floors", "a small damage gain doesn't", not w.better(fake(dps=120, **{sup: 80}), met))
    add("weighted floors", "below the hard minimum the floor outranks damage",
        not w.better(fake(dps=10000, **{sup: 60}), met) and w.better(fake(dps=50, **{sup: 75}), fake(dps=900, **{sup: 60})))
    add("weighted floors", "a missed floor is still reported", f"floor:{sup}" in w.shortfalls(short))
    add("weighted floors", "resists stay hard", not w.better(fake(dps=1e6, fire=70, **{sup: 100}), met))
    add("weighted floors", "the EHP floor is weighted too", w.better(fake(dps=300, ehp=9000, **{sup: 100}), met))
    rt = w.rate(met, short)
    add("weighted floors", "rate: same hard score, utility gain ranks the change",
        rt[0] == 1 and abs(rt[1] - (math.log(3) - 2 * 0.2)) < 1e-9, detail=str(rt))
    k = Rules("CombinedDPS", fake(**{sup: 80}), floors={sup: 100}, floor_weight=2, floor_hard=0.7)
    add("weighted floors", "keep: a soft miss at the start isn't a broken rule", not k.start_short)
    add("weighted floors", "a soft miss at the start is still reported", k.describe()["brokenAtStart"] == [f"floor:{sup}"])
    nf = Rules("CombinedDPS", fake(), ehp_floor=None, floor_weight=2, floor_hard=0.7)
    add("weighted floors", "no floors: ranking stays on the metric",
        nf.floor_weight is None and abs(nf.rate(fake(dps=100), fake(dps=160), 3)[1] - 0.2) < 1e-9)
    add("weighted floors", "weight 0 means unweighted",
        Rules("CombinedDPS", fake(), floors={sup: 100}, floor_weight=0).floor_weight is None)
    add("weighted floors", "no floor_hard given: 70%",
        Rules("CombinedDPS", fake(), floors={sup: 100}, floor_weight=2).floor_hard == 0.7)


class TierPool:
    """A one-slot stand-in for EvalPool: the helmet's '+N to maximum Life' line is the build's damage."""
    LIFE = {1: 100, 2: 80, 3: 60}

    def __init__(self, text):
        self.text = text

    def _stats(self, text):
        import re
        m = re.search(r"\+(\d+) to maximum Life", text)
        return fake(dps=100.0 + (int(m.group(1)) if m else 0))

    def slots(self):
        return [{"slot": "Helmet", "item": {"name": self.text.split("\n")[1], "base": "Hubris Circlet",
                                             "implicits": [], "enchants": [], "text": self.text, "rarity": "RARE"}}]

    def affix_pool(self, base, ilvl=84, tier=2, roll=0.5, domain="Explicit", bench=False):
        t = min(tier, 3)
        return {"base": base, "implicits": [], "affixes": [
            {"group": "IncreasedLife", "tier": t, "tiers": 3, "type": "Prefix", "crafted": False,
             "lines": [f"+{self.LIFE[t]} to maximum Life"]}]}

    def stats(self):
        return self._stats(self.text)

    def probe(self, specs):
        return [self._stats(s["item"]["text"]) for s in specs]

    def apply(self, ops):
        for op in ops:
            self.text = op["text"]
        return self.stats()

    def save_xml(self):
        return self.text

    def load(self, xml, main_skill=None):
        self.text = xml


def upgrade_tests(add):
    """gear.upgrade_tiers on a stand-in pool: affixes move up a tier while the budget allows."""
    sys.path.insert(0, os.path.join(HERE, "..", "market"))
    from budget import Budget
    affix = {"lines": ["+60 to maximum Life"], "crafted": False, "group": "IncreasedLife", "tier": 3, "type": "Prefix"}

    def setup(limit):
        pool = TierPool(R.item_text("Helmet", "Hubris Circlet", [], [], [affix]))
        budget = Budget(limit, None)
        log = [R._record({"step": "gear", "change": "Helmet: Hubris Circlet with +60 to maximum Life"},
                         "Hubris Circlet", [affix], budget, False, "crafted Helmet")]
        return pool, budget, log

    rules = Rules("CombinedDPS", fake())
    pool, budget, log = setup(10.0)
    R.upgrade_tiers(pool, rules, budget, log=log)
    add("gear", "tier upgrade climbs to T1 when the budget allows", "+100 to maximum Life" in pool.text,
        detail=pool.text)
    add("gear", "tier upgrade charges the budget for the final item only",
        abs(budget.spent - R.rarecost.estimate([{**affix, "tier": 1}])) < 1e-9, detail=str(budget.spent))
    t2 = R.rarecost.estimate([{**affix, "tier": 2}])
    pool, budget, log = setup(t2 + 1e-6)
    R.upgrade_tiers(pool, rules, budget, log=log)
    add("gear", "tier upgrade stops where the budget ends", "+80 to maximum Life" in pool.text, detail=pool.text)
    pool, budget, log = setup(10.0)
    pool.text = pool.text.replace("Build-lab Helmet", "Guide Helmet")
    add("gear", "only the lab's own crafted items are upgraded", not R.crafted_items(pool, log))


class AuraPool:
    """A stand-in pool for drop_side_skills: each aura reserves mana; Herald adds damage; Vitality adds life."""
    RESERVE = {"Grace": 300, "Herald of Ash": 200, "Vitality": 150}

    def __init__(self, mana=500, groups=None):
        self.mana = mana
        self.gl = groups or [
            {"index": 1, "main": True, "enabled": True, "slot": "Body Armour", "gems": [
                {"index": 1, "name": "Fireball", "enabled": True, "support": False}]},
            {"index": 2, "main": False, "enabled": True, "slot": "Helmet", "gems": [
                {"index": 1, "name": "Grace", "enabled": True, "support": False},
                {"index": 2, "name": "Enlighten", "enabled": True, "support": True}]},
            {"index": 3, "main": False, "enabled": True, "slot": "Gloves", "gems": [
                {"index": 1, "name": "Herald of Ash", "enabled": True, "support": False},
                {"index": 2, "name": "Vitality", "enabled": True, "support": False}]},
            {"index": 4, "main": False, "enabled": True, "slot": "Weapon 1 Swap", "gems": [
                {"index": 1, "name": "Vitality", "enabled": True, "support": False}]}]

    def groups(self):
        return self.gl

    def _on(self, name):
        return any(gm["name"] == name and gm["enabled"] for g in self.gl if "Swap" not in g["slot"]
                   for gm in g["gems"])

    def stats(self):
        left = self.mana - sum(v for k, v in self.RESERVE.items() if self._on(k))
        neg = ["Your unreserved Mana is negative"] if left < 0 else []
        return fake(dps=200 if self._on("Herald of Ash") else 100, life=1150 if self._on("Vitality") else 1000,
                    violations=neg, Mana=self.mana, ManaUnreserved=left)

    fail = ()  # gem names whose turning off makes PoB fail

    def apply(self, ops):
        for op in ops:
            g = next(g for g in self.gl if g["index"] == op["group"])
            gem = g["gems"][op["index"] - 1]
            gem["enabled"] = op["enabled"]
            if not op["enabled"] and gem["name"] in self.fail:
                raise ValueError("PoB calc failed")
        return self.stats()


def side_skill_tests(add):
    rules = Rules("CombinedDPS", fake(), start_breaks="repair")
    pool, log = AuraPool(mana=400), []  # 650 reserved: only turning off Grace fixes it in one step
    G.drop_side_skills(pool, rules, log=log)
    off = sorted(gm["name"] for g in pool.gl for gm in g["gems"] if not gm["enabled"])
    add("gems", "the aura whose loss fixes the overdraw is turned off, and only that one", off == ["Grace"],
        detail=str(log))
    add("gems", "the fix is logged", log and log[0]["fixes"] == ["warn:Your unreserved Mana is negative"])
    pool = AuraPool(mana=1000)
    add("gems", "nothing is turned off while every rule holds", not G.drop_side_skills(pool, rules))
    add("gems", "main group, supports and weapon swap are never candidates",
        [n for _, _, n in G._side_skills(AuraPool())] == ["Grace", "Herald of Ash", "Vitality"])
    pool = AuraPool(mana=1000)
    pool.stats = lambda: fake(violations=["You do not meet the Strength requirement"], Str=100, ReqStr=150)
    add("gems", "an attribute shortfall alone never turns a skill off", not G.drop_side_skills(pool, rules))
    pool, log = AuraPool(mana=400), []
    pool.fail = ("Herald of Ash",)
    G.drop_side_skills(pool, rules, log=log)
    add("gems", "a failed trial is skipped and put back; the rest are still tried",
        [e["change"] for e in log] == ["turned off Grace (group 2)"]
        and all(gm["enabled"] for gm in pool.gl[2]["gems"]), detail=str(log))
    sys.path.insert(0, os.path.join(HERE, "..", "market"))
    from budget import Budget
    budget = Budget(10.0, None)
    budget.charge(1.0, "gem Grace", "group:2:gem:1")
    budget.charge(2.0, "gem Enlighten", "group:2:gem:2")
    budget.charge(0.5, "gem Vitality", "group:3:gem:2")
    pool, log = AuraPool(mana=400), []
    G.drop_side_skills(pool, rules, log=log, budget=budget)
    add("gems", "a turned-off aura and its idle supports are refunded",
        abs(budget.spent - 0.5) < 1e-9 and log and abs(log[0]["refund"] - 3.0) < 1e-9, detail=str(budget.spent))


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
    neg = "Your unreserved Mana is negative"
    add("rules", "repair: less mana overdraw counts as progress",
        rp.better(fake(dps=50, violations=[neg], Mana=1000, ManaUnreserved=-100),
                  fake(dps=90, violations=[neg], Mana=1000, ManaUnreserved=-400)))
    over = fake(violations=[neg], Mana=1000, ManaUnreserved=-100)
    km = Rules("CombinedDPS", over)
    add("rules", "keep: mana overdraw may not get worse",
        not km.better(fake(dps=200, violations=[neg], Mana=1000, ManaUnreserved=-300), over))
    add("rules", "repair: an overdraw past the whole pool still grades progress",
        rp.better(fake(violations=[neg], Mana=1000, ManaUnreserved=-1500),
                  fake(violations=[neg], Mana=1000, ManaUnreserved=-2500)))
    add("rules", "unreserved life below 1: graded by the life pool",
        abs(rp.shortfalls(fake(violations=["Your unreserved Life is below 1"], LifeUnreserved=-99))
            ["warn:Your unreserved Life is below 1"] - 0.11) < 1e-9)


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
    bundle_tests(add)
    upgrade_tests(add)
    side_skill_tests(add)
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
