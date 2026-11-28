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
os.environ["BUILD_LAB_NO_FETCH"] = "1"  # never download the published crawl in tests
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
    add("unique_source that isn't text refused", refused({**BASE, "unique_source": ["poe.ninja"]}, db, "unique_source"))
    add("unique_source without a unique_candidates list refused",
        refused({**BASE, "unique_source": "poe.ninja"}, db, "unique_candidates")
        and refused({**BASE, "unique_source": "poe.ninja", "unique_candidates": "none"}, db, "unique_candidates"))
    src = "poe.ninja builds, test league, 120 characters"
    cands, info = C.unique_candidates({"unique_candidates": ["Shaper's Touch", "Not A Real Unique"],
                                       "unique_source": src}, db, "test league", "Fireball")
    add("listed uniques grouped by slot, with where they came from",
        cands == {"Gloves": ["Shaper's Touch"]} and info["source"] == "spec" and info["from"] == src
        and info["leftOut"] == ["Not A Real Unique"], info)
    _, plain = C.unique_candidates({"unique_candidates": ["Shaper's Touch"]}, db, "test league", "Fireball")
    add("no unique_source, no 'from'", "from" not in plain, plain)
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


def refs_checks():
    """design/refs.py without PoB or the network: codes, links, listing, cache keys, the comparison."""
    import shutil
    import urllib.request
    import refs as RF
    xml = '<?xml version="1.0"?><PathOfBuilding><Config><Input name="enemyIsBoss" string="Pinnacle"/></Config></PathOfBuilding>'
    add("refs: a PoB code decodes to its XML", RF.decode_code(C.pob_code(xml)) == xml)
    seen = []

    class Resp:
        def __init__(self, body):
            self.body = body

        def read(self):
            return self.body.encode()

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False
    real = urllib.request.urlopen
    urllib.request.urlopen = lambda req, timeout=30: (seen.append(req.full_url), Resp(" CODE "))[1]
    try:
        got = [RF.fetch_code("https://pobb.in/AbC-12_x"), RF.fetch_code("https://pastebin.com/XyZ123")]
    finally:
        urllib.request.urlopen = real
    add("refs: pobb.in and pastebin links read their raw code",
        seen == ["https://pobb.in/AbC-12_x/raw", "https://pastebin.com/raw/XyZ123"] and got == ["CODE", "CODE"],
        seen)
    urllib.request.urlopen = lambda *a, **k: seen.append("fetched") or (_ for _ in ()).throw(AssertionError())
    blocked = []
    try:
        for link in ("https://poe.ninja/poe1/builds/covens/character/A-1/B", "http://www.poe.ninja/x",
                     "https://pob.codes/abc"):
            try:
                RF.fetch_code(link)
            except ValueError:
                blocked.append(link)
    finally:
        urllib.request.urlopen = real
    add("refs: poe.ninja and pob.codes links are refused, never fetched", len(blocked) == 3 and "fetched" not in seen,
        blocked)
    league = f"Refs Check {os.getpid()}"
    try:
        RF.add(league, C.pob_code(xml), skill="Fireball", title="A guide", url="https://example.invalid/a")
        add("refs: a web build is listed under its skill", [r["title"] for r in RF.listing(league, "fireball")]
            == ["A guide"] and not RF.listing(league, "Spark"))
    finally:
        shutil.rmtree(RF.refs_dir(league), ignore_errors=True)
    other = xml.replace("<PathOfBuilding>", "<PathOfBuilding><Build level=\"90\"/>")
    add("refs: designs with the same config share cached results", RF._config_key(xml) == RF._config_key(other)
        and RF._config_key(xml) != RF._config_key(xml.replace("Pinnacle", "Uber")))
    measured = [{"source": "ladder", "value": v, "TotalEHP": e, "cost": {"total": c}, "class": "Witch", "level": 95}
                for v, e, c in ((100, 10, 5), (200, 20, 10), (300, 30, 20), (400, 40, 40))]
    measured.append({"source": "web", "error": "PoB couldn't load it"})
    out = RF.compare({"value": 250, "TotalEHP": 35, "cost": 8}, measured)
    add("refs: the comparison ranks the design", out["measured"] == 4 and out["failed"] == 1
        and out["design"]["beatsOnDamage"] == 0.5 and out["design"]["beatsOnEHP"] == 0.75
        and out["design"]["cheaperThan"] == 0.75 and out["best"][0]["value"] == 400
        and out["median"]["value"] == 250, out)


REF_XML = """<?xml version="1.0"?><PathOfBuilding>
<Build level="97" className="Marauder" ascendClassName="Chieftain" mainSocketGroup="2"/>
<Tree activeSpec="2"><Spec nodes="1,2" masteryEffects=""/><Spec nodes="10,20,30" masteryEffects="{30,77},{40,88}"/></Tree>
<Skills activeSkillSet="2"><SkillSet id="1"><Skill enabled="true"><Gem nameSpec="Righteous Fire" gemId="Metadata/Items/Gems/SkillGemRighteousFire"/><Gem nameSpec="Wrong Set" gemId="Metadata/Items/Gems/SupportGemX"/></Skill></SkillSet>
<SkillSet id="2">
<Skill enabled="false"><Gem nameSpec="Righteous Fire" gemId="Metadata/Items/Gems/SkillGemRighteousFire"/><Gem nameSpec="A" gemId="Metadata/Items/Gems/SupportGemA"/><Gem nameSpec="B" gemId="Metadata/Items/Gems/SupportGemB"/><Gem nameSpec="C" gemId="Metadata/Items/Gems/SupportGemC"/></Skill>
<Skill enabled="true"><Gem nameSpec="Righteous Fire" gemId="Metadata/Items/Gems/SkillGemRighteousFire"/><Gem nameSpec="Efficacy" gemId="Metadata/Items/Gems/SupportGemEfficacy"/><Gem nameSpec="Off" gemId="Metadata/Items/Gems/SupportGemOff" enabled="false"/></Skill>
<Skill enabled="true"><Gem nameSpec="Herald of Ash" gemId="Metadata/Items/Gems/SkillGemHeraldOfAsh"/><Gem nameSpec="Elemental Focus" gemId="Metadata/Items/Gems/SupportGemElementalFocus"/><Gem nameSpec="Lifetap" gemId="Metadata/Items/Gems/SupportGemLifetap"/></Skill>
</SkillSet></Skills></PathOfBuilding>"""


def learn_checks(pool, db):
    """design/learn.py: reading a reference, grouping and shares offline; seeding and explaining on PoB."""
    import learn as L
    import tree as T
    from objective import Rules
    p = L.parse(REF_XML, "Righteous Fire")
    add("learn: the active tree spec and skill set are read", p["nodes"] == [10, 20, 30]
        and p["masteries"] == {30: 77, 40: 88} and p["class"] == "Marauder" and p["ascendancy"] == "Chieftain", p)
    add("learn: supports from the enabled group holding the skill; disabled gems left out",
        p["supports"] == ["Efficacy"], p["supports"])
    add("learn: no group with the skill teaches only the tree", L.parse(REF_XML, "Fireball")["supports"] is None)

    q = lambda sql, *a: db.con.execute(sql, a).fetchone()  # noqa: E731
    key = q("SELECT id FROM nodes WHERE type = 'Keystone' AND ascendancy IS NULL ORDER BY id LIMIT 1")[0]
    nota = q("SELECT id FROM nodes WHERE type = 'Notable' AND ascendancy IS NULL ORDER BY id LIMIT 1")[0]
    norm = q("SELECT id FROM nodes WHERE type = 'Normal' AND ascendancy IS NULL ORDER BY id LIMIT 1")[0]
    sock = q("SELECT id FROM nodes WHERE type = 'Socket' ORDER BY id LIMIT 1")[0]
    mast = q("SELECT node_id FROM node_mastery_effects ORDER BY node_id LIMIT 1")[0]
    chief = q("SELECT id FROM nodes WHERE type = 'Notable' AND ascendancy = 'Chieftain' ORDER BY id LIMIT 1")[0]
    berserk = q("SELECT id FROM nodes WHERE type = 'Notable' AND ascendancy = 'Berserker' ORDER BY id LIMIT 1")[0]

    def ref(asc, nodes, sups=("Efficacy", "Elemental Focus"), mastery_eff=1):
        return {"file": f"f{len(nodes)}", "source": "ladder", "class": "Marauder", "ascendancy": asc,
                "nodes": nodes, "masteries": {mast: mastery_eff}, "supports": list(sups)}
    common = [key, nota, norm, sock, mast, chief, 70001]
    five = [ref("Chieftain", common, mastery_eff=e) for e in (1, 1, 2, 1, 2)]
    five[0]["supports"] = ["Efficacy", "Elemental Focus", "Rare Pick"]   # 1 of 5: not common
    five[4]["nodes"] = [key, sock, mast, chief]          # 4/5 share the notable and the normal node
    out = L.common(five, "Marauder", "Chieftain", db, links=3)
    ids = [n["id"] for n in out.get("nodes", [])]
    add("learn: 5 of the ascendancy: grouped by ascendancy, its nodes learned", out.get("basis") == "ascendancy"
        and chief in ids and out["refs"] == 5, out)
    add("learn: sockets and cluster-jewel nodes left out", sock not in ids and 70001 not in ids, ids)
    add("learn: a mastery with its most common effect", out["masteries"].get(mast) == 1, out.get("masteries"))
    add("learn: most common first", ids.index(key) < ids.index(nota), ids)
    add("learn: supports by share, up to links - 1", [s["name"] for s in out["supports"]]
        == ["Efficacy", "Elemental Focus"], out["supports"])
    add("learn: keystones lead the popular list", out["popular"][0]["kind"] == "keystone", out["popular"])
    mixed = [ref("Chieftain", common)] * 3 + [ref("Berserker", [key, berserk])] * 2
    out = L.common(mixed, "Marauder", "Chieftain", db)
    ids = [n["id"] for n in out.get("nodes", [])]
    add("learn: too few of the ascendancy: grouped by class, no ascendancy nodes", out.get("basis") == "class"
        and chief not in ids and berserk not in ids and key in ids and nota in ids, out)
    out = L.common(mixed[:4], "Marauder", "Chieftain", db)
    add("learn: fewer than 5: nothing learned, says why", "nodes" not in out and "fewer than 5" in out.get("note", ""),
        out)
    mast2 = q("SELECT node_id FROM node_mastery_effects WHERE node_id > ? ORDER BY node_id LIMIT 1", mast)[0]
    two = [{**ref("Chieftain", [mast, mast2]), "masteries": {mast: 5, mast2: m2}} for m2 in (5, 5, 5, 6, 6)]
    out = L.common(two, "Marauder", "Chieftain", db)
    add("learn: two masteries never get the same effect", out["masteries"] == {mast: 5, mast2: 6}, out["masteries"])
    lone = [ref("Chieftain", common)] + [{**ref("Chieftain", common), "supports": None}] * 4
    add("learn: supports need 5 references showing the skill's group",
        L.common(lone, "Marauder", "Chieftain", db)["supports"] == [])
    ex = [ref("Chieftain", common, sups=("Empower", "Awakened Enlighten", "Efficacy"))] * 5
    add("learn: with a budget exceptional supports are left out",
        [s["name"] for s in L.common(ex, "Marauder", "Chieftain", db, budget=True)["supports"]] == ["Efficacy"])
    aw = [ref("Chieftain", common, sups=("Awakened Elemental Focus",))] * 5
    add("learn: with a budget an awakened support starts plain",
        [s["name"] for s in L.common(aw, "Marauder", "Chieftain", db, budget=True)["supports"]] == ["Elemental Focus"]
        and [s["name"] for s in L.common(aw, "Marauder", "Chieftain", db)["supports"]] == ["Awakened Elemental Focus"])

    # seeding on a real tree
    xml, _ = C.skeleton_xml({**BASE, "supports": ["Spell Echo"]}, db)
    pool.load(xml, "Fireball")
    pool.apply([{"op": "tree-reset", "class": "Witch", "ascendancy": "Necromancer"}], allow_main_change=True)
    reach = pool.reachable_nodes(8)
    near = next(n for n in reach if n["dist"] == 1)
    far = next(n for n in sorted(reach, key=lambda n: -n["dist"]) if n["dist"] >= 5)
    used = pool.points()["used"]
    start = {"nodes": [{"id": far["id"], "type": "Notable", "ascendancy": None},
                       {"id": near["id"], "type": "Normal", "ascendancy": None}]}
    taken = T.seed(pool, start, points=used + 3, asc_points=0)
    add("learn: a learned node that doesn't fit the points is skipped, the next taken", taken == [near["id"]],
        f"{taken} far={far} near={near}")
    taken = T.seed(pool, start, points=used + 40, asc_points=0)
    add("learn: a far node comes with its path", taken == [far["id"]] and pool.points()["used"] >= used + far["dist"],
        f"{taken} {pool.points()}")
    asc = next(n for n in pool.reachable_nodes(3, ascendancy=True))
    add("learn: ascendancy nodes keep to the ascendancy points",
        T.seed(pool, {"nodes": [{"id": asc["id"], "type": "Notable", "ascendancy": "Necromancer"}]}, 999, 0) == [])

    rules = Rules(E.main_metric(pool.stats()), pool.stats(), start_breaks="repair")
    learned = {"popular": [{"kind": "notable", "name": "far", "id": far["id"], "share": 0.9},
                           {"kind": "notable", "name": "other", "id": next(n for n in pool.reachable_nodes(4)
                                                                        if n["dist"] >= 2)["id"], "share": 0.8},
                           {"kind": "support", "name": "Spell Echo", "share": 1.0},
                           {"kind": "support", "name": "Controlled Destruction", "share": 0.7}]}
    before = pool.stats()
    rows = {r["name"]: r for r in L.explain(pool, rules, learned)}
    kept = L.explain(pool, rules, {"popular": learned["popular"][3:]}, keep=["Spell Echo"])
    add("learn: a keep_supports gem is never swapped out in the explanation",
        "replaces" not in kept[0] and kept[0].get("error") == "no support it could replace", kept)
    add("learn: explain measures what's in the design and what isn't",
        rows["far"]["inDesign"] and not rows["other"]["inDesign"] and rows["Spell Echo"]["inDesign"]
        and not rows["Controlled Destruction"]["inDesign"]
        and all(r.get("decidedBy") for r in rows.values()), rows)
    add("learn: a node in the design is measured alone (1 point)", rows["far"].get("points") == 1, rows["far"])
    add("learn: a missing support is tried in place of a current one",
        rows["Controlled Destruction"].get("replaces") == "Spell Echo", rows["Controlled Destruction"])
    add("learn: explaining leaves the build as it was", E.value(pool.stats(), rules.metric)
        == E.value(before, rules.metric) and pool.stats()["player"].get("TotalEHP") == before["player"].get("TotalEHP"))
    add("learn: Spell Echo's worth is positive damage", (rows["Spell Echo"].get("damage") or 0) > 0, rows["Spell Echo"])


def main():
    db = C.GameDB()
    refs_checks()
    with E.EvalPool(workers=0) as pool:
        skeleton_checks(pool, db)
        learn_checks(pool, db)
    if "--run" in sys.argv:
        run_check(db)
    print(f"\n{sum(RESULTS)}/{len(RESULTS)} passed")
    sys.exit(0 if all(RESULTS) else 1)


if __name__ == "__main__":
    main()
