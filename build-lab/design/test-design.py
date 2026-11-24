"""Concept builder checks.

  python test-design.py            skeleton checks (about 20 s)
  python test-design.py --run      also one quick pipeline run with a budget (about 2 minutes; needs poe.ninja)

Skeleton: specs become builds PoB loads with the right main skill, class, gems (transfigured too), item bases by
defence type, offhand rules (shield for one-handers, quiver for bows, none for two-handers), flasks; uniques come
from PoB's own data; bad specs are refused with a reason; the PoB code decodes back to the same XML; points
available follow PoB's formula.
Run: the main skill survives, every gem is charged (a concept owns nothing), spend stays within the budget or is
flagged, points used fit what the level allows, and the saved XML reloads to the same numbers.
Exit code 1 when any check fails.
"""
import base64
import json
import os
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import concept as C  # noqa: E402
import evaluator as E  # noqa: E402

RESULTS = []


def add(name, ok, detail=""):
    RESULTS.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))


def refused(spec, db, words):
    try:
        C.skeleton_xml(spec, db)
    except ValueError as e:
        return words.lower() in str(e).lower()
    return False


BASE = {"name": "t", "class": "Witch", "ascendancy": "Necromancer", "main_skill": "Fireball",
        "weapon": "Imbued Wand", "defence": "es"}


def skeleton_checks(pool, db):
    xml, uniques = C.skeleton_xml({**BASE, "items": {"Gloves": {"unique": "Shaper's Touch"}},
                                   "supports": ["Spell Echo"], "groups": [{"slot": "Helmet", "gems": ["Zealotry"]}]},
                                  db)
    add("uniques left for the loaded build", [u["name"] for u in uniques] == ["Shaper's Touch"])
    r = pool.load(xml, "Fireball")
    add("skeleton loads with its main skill", r["mainSkill"] == "Fireball" and not r["issues"], r["issues"])
    slots = {s["slot"]: s.get("item") for s in pool.slots()}
    add("ES bases picked", slots["Body Armour"]["base"] == "Vaal Regalia" and slots["Helmet"]["base"] == "Hubris Circlet",
        {k: (v or {}).get("base") for k, v in slots.items()})
    add("shield for a one-handed weapon", (slots.get("Weapon 2") or {}).get("type") == "Shield")
    add("gloves empty until the unique is equipped", slots.get("Gloves") is None)
    info = pool.unique_text("Shaper's Touch")
    pool.apply([{"op": "equip", "slot": "Gloves", "text": info["text"]}])
    g = {s["slot"]: s.get("item") for s in pool.slots()}["Gloves"]
    add("unique from PoB's data equips", g and g["rarity"] == "UNIQUE" and g["name"].startswith("Shaper's Touch"), g)
    try:
        pool.unique_text("Not A Real Unique")
        add("unknown unique refused", False)
    except ValueError:
        add("unknown unique refused", True)
    groups = pool.groups()
    add("gem groups", [x["name"] for x in groups[0]["gems"]] == ["Fireball", "Spell Echo"]
        and groups[1]["gems"][0]["name"] == "Zealotry" and groups[0]["gems"][0]["level"] == 20, groups)
    flasks = [s for s in pool.slots() if s["slot"].startswith("Flask") and s.get("item")]
    add("five flasks", len(flasks) == 5)
    pts = pool.points()
    # Level 95: 94 from levels + 23 from quests, plus PoB's ExtraPoints (the bandit reward when all are killed).
    add("points as PoB counts them", 117 <= pts["available"] <= 119 and pts["ascendancyAvailable"] == 8, pts)

    xml2, _ = C.skeleton_xml({**BASE, "main_skill": "Frost Blades of Katabasis", "class": "Shadow",
                              "weapon": "Ambusher", "defence": "evasion"}, db)
    r = pool.load(xml2, "Frost Blades of Katabasis")
    add("transfigured gem as main skill", r["mainSkill"] == "Frost Blades of Katabasis", r["mainSkill"])
    xml3, _ = C.skeleton_xml({**BASE, "main_skill": "Lightning Arrow", "class": "Ranger", "weapon": "Thicket Bow",
                              "defence": "evasion"}, db)
    pool.load(xml3, "Lightning Arrow")
    s3 = {s["slot"]: s.get("item") for s in pool.slots()}
    add("quiver for a bow", (s3.get("Weapon 2") or {}).get("type") == "Quiver", (s3.get("Weapon 2") or {}))
    xml4, _ = C.skeleton_xml({**BASE, "main_skill": "Cyclone", "class": "Duelist", "weapon": "Reaver Sword",
                              "defence": "armour", "main_slot": "Weapon 1"}, db)
    pool.load(xml4, "Cyclone")
    s4 = {s["slot"]: s.get("item") for s in pool.slots()}
    add("no offhand for a two-hander", s4.get("Weapon 2") is None
        and "R-R-R-R-R-R" in s4["Weapon 1"]["text"], s4.get("Weapon 2"))

    xml5, u5 = C.skeleton_xml({**BASE, "weapon": {"unique": "Void Battery"}, "flasks": ["Divine Life Flask", "none"]},
                              db)
    pool.load(xml5, "Fireball")
    s5 = {s["slot"]: s.get("item") for s in pool.slots()}
    add("unique one-hander still gets a shield", (s5.get("Weapon 2") or {}).get("type") == "Shield"
        and [u["slot"] for u in u5] == ["Weapon 1"], s5.get("Weapon 2"))
    add("a 'none' flask leaves the slot empty", s5.get("Flask 1") and not s5.get("Flask 2"))
    add("weapon text with no known base needs an offhand",
        refused({**BASE, "weapon": {"text": "Rarity: RARE\nMade Up\nNo Such Base"}}, db, "offhand"))
    add("bad class refused", refused({**BASE, "class": "Paladin"}, db, "class"))
    add("support as main skill refused", refused({**BASE, "main_skill": "Spell Echo"}, db, "support"))
    add("unknown base refused", refused({**BASE, "weapon": "Plastic Wand"}, db, "base"))
    add("unknown gem refused", refused({**BASE, "supports": ["Not A Gem"]}, db, "gem"))
    add("bad defence refused", refused({**BASE, "defence": "ward"}, db, "defence"))
    add("too many flasks refused", refused({**BASE, "flasks": ["Divine Life Flask"] * 6}, db, "flasks"))
    code = C.pob_code(xml)
    add("PoB code decodes to the XML", zlib.decompress(base64.urlsafe_b64decode(code)).decode("utf-8") == xml)


def run_check(db):
    spec = {**BASE, "name": "test quick", "items": {"Gloves": {"unique": "Shaper's Touch"}},
            "groups": [{"slot": "Helmet", "gems": ["Zealotry"]}], "config": {"enemyIsBoss": "Pinnacle"}}
    budget = 3.0
    report, xml = C.complete(spec, budget_div=budget, quick=True, workers=4)
    add("main skill kept", report["mainSkill"] == "Fireball")
    ledger = report["spend"]["ledger"]
    whats = {e["what"] for e in ledger}
    add("every gem charged", {"gem Fireball", "gem Zealotry"} <= whats, sorted(whats))
    add("unique charged", any(w.startswith("unique Shaper") for w in whats))
    add("spend within budget or flagged", report["spend"]["spent"] <= budget + 1e-6 or report.get("overBudget"),
        report["spend"]["spent"])
    p = report["points"]
    add("points fit the level", p["used"] <= p["available"] and p["ascendancy"] <= 8, p)
    add("no unreliable trigger picked", not any(g in C_TRIGGERS for grp in report["gems"] for g in grp["gems"]))
    with E.EvalPool(workers=0) as pool:
        r = pool.load(xml, "Fireball")
    a, b = report["after"]["value"], E.value(r["stats"], report["metric"])
    add("saved build reloads to the same numbers", abs(a - b) <= 1e-6 * max(1, abs(a)), (a, b))


C_TRIGGERS = ("Cast when Stunned", "Cast when Damage Taken", "Cast on Death")


def main():
    db = C.GameDB()
    with E.EvalPool(workers=0) as pool:
        skeleton_checks(pool, db)
    if "--run" in sys.argv:
        run_check(db)
    print(f"\n{sum(RESULTS)}/{len(RESULTS)} passed")
    sys.exit(0 if all(RESULTS) else 1)


if __name__ == "__main__":
    main()
