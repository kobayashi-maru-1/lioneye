"""Make a build concept into a finished PoB build: skeleton from a short spec, then the optimizers.

  concept.py new SPEC.json [--out X.xml]                  skeleton only (class, gems, placeholder items)
  concept.py complete SPEC.json [--budget 10] [--quick] [--trade-check] [--out X.xml] [--report R.json]
  concept.py complete --xml BUILD.xml --main-skill X --class C [--ascendancy A] ...   start from a build file

complete: skeleton -> uniques equipped (their poe.ninja price charged to the budget) -> config -> tree grown from
the class start (tree-build) -> 6-link (or `links`) supports -> crafted rares on every non-unique slot (base
implicits) -> jewels -> supports and tree again. Every step ranks results in repair mode: rules first (75%
elemental resists, chaos >= 0, PoB's warnings), then the metric. --quick stops after tree and gems, for screening
several concepts. The tree grows without the resist rules (gear caps resists more cheaply than passives); gear and
the later steps hold them.
Output: a JSON report (numbers, rules still broken, cost, novelty, PoB code) on stdout and in --report; the
build is saved to --out (default Downloads\\concept-<name>.xml; in a chat sandbox, /mnt/user-data/outputs when it
exists, else the current folder).

Spec (JSON):
  name          "Cold DoT Occultist" (used for file names)
  class         Witch | Shadow | Ranger | Duelist | Marauder | Templar | Scion
  ascendancy    optional, e.g. "Occultist"
  level         character level (default 95)
  main_skill    gem name, transfigured names too ("Frost Blades of Katabasis")
  supports      optional starting supports for the main group (the gem optimizer refines them)
  links         main group size (default 6)
  main_slot     where the main group sits (default "Body Armour")
  weapon        base name ("Imbued Wand") or {"unique": "Name", "base"?} or {"text": "<PoB item text>"}
  offhand       same forms; "none" for nothing. Needed when the weapon's type can't be told (item text without
                a known base). Default: a shield of the defence type for a one-handed weapon,
                a quiver for a bow, nothing for two-handed weapons
  defence       armour | evasion | es | armour-evasion | armour-es | evasion-es (picks armour bases: the most
                defence of that kind, usable at the level, drop-only bases left out; default es)
  items         per-slot overrides, same forms as weapon: {"Helmet": {"unique": "Devoto's Devotion"}, "Belt":
                "Stygian Vise"}
  groups        other gem groups: [{"slot": "Helmet", "gems": ["Herald of Ice", "Hatred"]}]
  flasks        up to 5 flask bases, {"unique": ...} or "none" (an empty slot); default life, quicksilver,
                granite/jade, silver, basalt
  config        PoB config vars: {"enemyIsBoss": "Pinnacle", "useFrenzyCharges": true}
  budget        divines (a --budget flag wins). A concept owns nothing: uniques and every starting gem are
                charged before the optimizers spend the rest
  ehp_floor     minimum total EHP (a --ehp-floor flag wins), held like the resist rules
  metric        optional: FullDPS, CombinedDPS, minion.CombinedDPS, ...
"""
import argparse
import base64
import importlib.util
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
LAB = os.path.dirname(HERE)
for sub in ("eval", "opt", "market"):
    sys.path.insert(0, os.path.join(LAB, sub))

CLASS_IDS = {"Scion": 0, "Marauder": 1, "Ranger": 2, "Witch": 3, "Duelist": 4, "Templar": 5, "Shadow": 6}
DEFENCES = {"armour": {"Armour"}, "evasion": {"Evasion"}, "es": {"EnergyShield"},
            "armour-evasion": {"Armour", "Evasion"}, "armour-es": {"Armour", "EnergyShield"},
            "evasion-es": {"Evasion", "EnergyShield"}}
ARMOUR_SLOTS = ("Helmet", "Body Armour", "Gloves", "Boots")
JEWELLERY = {"Amulet": "Onyx Amulet", "Ring 1": "Amethyst Ring", "Ring 2": "Amethyst Ring", "Belt": "Leather Belt"}
SOCKETS = {"Body Armour": 6, "Helmet": 4, "Gloves": 4, "Boots": 4, "Weapon 1": 3, "Weapon 2": 3}
TWO_HANDED = ("Bow", "Staff", "Two Handed Sword", "Two Handed Axe", "Two Handed Mace", "Fishing Rod")
NO_RES_RULE = -1e9      # a resist cap no build falls short of: turns the resist rules off
DEFAULT_LEVEL = 95
DEFAULT_LINKS = 6


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ---------------- game database ----------------

class GameDB:
    def __init__(self, pob_version=None):
        gdb = _load("game_db", os.path.join(LAB, "db", "game-db.py"))
        info = gdb.ensure(pob_version)
        self.path = info["path"]
        self.con = sqlite3.connect(f"file:{self.path}?mode=ro", uri=True)
        self.meta = dict(self.con.execute("SELECT key, value FROM meta"))

    def base(self, name):
        row = self.con.execute("SELECT name, type, sub_type, armour FROM base_items WHERE name = ? AND hidden = 0",
                               (name,)).fetchone()
        if not row:
            raise ValueError(f"no item base '{name}' (check the spelling, e.g. 'Imbued Wand')")
        return {"name": row[0], "type": row[1], "subType": row[2], "armour": json.loads(row[3] or "{}")}

    def best_base(self, item_type, defence, level=100):
        """The base of this type with exactly the defence types wanted and the most of them, usable at `level`.
        Drop-only bases (tag not_for_sale: rarer, pricier) are left out; a spec can still name one."""
        want = DEFENCES[defence]
        best = None
        for name, armour, req, tags in self.con.execute(
                "SELECT name, armour, req, tags FROM base_items WHERE type = ? AND hidden = 0", (item_type,)):
            if "not_for_sale" in json.loads(tags or "[]") or json.loads(req or "{}").get("level", 0) > level:
                continue
            a = json.loads(armour or "{}")
            kinds = {k[:-len("BaseMax")] for k, v in a.items() if k.endswith("BaseMax") and v}
            if kinds != want:
                continue
            total = sum(a.get(f"{k}BaseMax", 0) for k in want)
            key = (total, json.loads(req or "{}").get("level", 0), name)
            if best is None or key > best[0]:
                best = (key, name)
        if not best:
            raise ValueError(f"no {item_type} base with {defence} defences")
        return best[1]

    def item_type(self, entry):
        """The base item type of a slot entry ({"base"}, {"unique", "base"?} or {"text"}), or None."""
        if "base" in entry:
            return self.base(entry["base"])["type"]
        if "unique" in entry:
            row = self.con.execute("SELECT base FROM uniques WHERE lower(name) = ? LIMIT 1",
                                   (entry["unique"].lower(),)).fetchone()
            return self.base(row[0])["type"] if row and row[0] else None
        lines = [l.strip() for l in (entry.get("text") or "").splitlines() if l.strip()]
        lines = [l for l in lines if not l.startswith("Rarity:")][:3]  # name and/or base come first
        for line in lines:
            row = self.con.execute("SELECT type FROM base_items WHERE name = ?", (line,)).fetchone()
            if row:
                return row[0]
        return None

    def gem(self, name):
        rows = self.con.execute("SELECT id, name, variant_id, granted_effect_id, max_level, is_support FROM gems "
                                "WHERE lower(name) IN (?, ?)",
                                (name.lower(), re.sub(r" support$", "", name.lower()))).fetchall()
        if not rows:
            raise ValueError(f"no gem '{name}'")
        r = rows[0]
        return {"gemId": r[0], "name": r[1], "variantId": r[2], "skillId": r[3], "maxLevel": r[4] or 20,
                "support": bool(r[5])}

    def quiver(self):
        row = self.con.execute("SELECT name FROM base_items WHERE type = 'Quiver' AND hidden = 0 "
                               "AND name = 'Spike-Point Arrow Quiver'").fetchone()
        return row[0] if row else None


# ---------------- skeleton ----------------

def placeholder(slot, base, sockets=None):
    lines = ["Rarity: RARE", f"Build-lab {slot}", base, "Item Level: 84"]
    if slot not in JEWELLERY:
        lines.append("Quality: 20")
    if sockets:
        lines.append("Sockets: " + "-".join(["R"] * sockets))
    lines.append("Implicits: 0")
    return "\n".join(lines)


def flask_text(base):
    return f"Rarity: NORMAL\n{base}\nQuality: 20"


def _form(v):
    """Normalise a slot entry: "Base" -> {"base"}, {"unique"} / {"text"} kept, "none" -> None."""
    if v is None or (isinstance(v, str) and v.lower() == "none"):
        return None
    if isinstance(v, str):
        return {"base": v}
    if isinstance(v, dict) and ({"base", "unique", "text"} & set(v)):
        return v
    raise ValueError(f"bad item entry {v!r}: give a base name, {{\"unique\": ...}} or {{\"text\": ...}}")


def check_spec(spec):
    for k in ("name", "class", "main_skill", "weapon"):
        if not spec.get(k):
            raise ValueError(f"the spec needs '{k}'")
    if spec["class"] not in CLASS_IDS:
        raise ValueError(f"class must be one of {', '.join(CLASS_IDS)}")
    if spec.get("defence", "es") not in DEFENCES:
        raise ValueError(f"defence must be one of {', '.join(DEFENCES)}")
    level = spec.get("level", DEFAULT_LEVEL)
    if not isinstance(level, int) or not 1 <= level <= 100:
        raise ValueError("level must be 1-100")
    links = spec.get("links", DEFAULT_LINKS)
    if not isinstance(links, int) or not 1 <= links <= 6:
        raise ValueError("links must be 1-6")
    if len(spec.get("flasks") or []) > 5:
        raise ValueError("at most 5 flasks")


def plan_items(spec, db):
    """{slot: entry} for every slot the skeleton fills; entries are {"base"} / {"unique"} / {"text"}."""
    defence = spec.get("defence", "es")
    level = spec.get("level", DEFAULT_LEVEL)
    items = {}
    overrides = spec.get("items") or {}
    weapon = _form(overrides.get("Weapon 1", spec["weapon"]))
    if not weapon:
        raise ValueError("the spec needs a weapon")
    items["Weapon 1"] = weapon
    wtype = db.item_type(weapon)
    if "offhand" in spec or "Weapon 2" in overrides:
        items["Weapon 2"] = _form(overrides.get("Weapon 2", spec.get("offhand")))
    elif wtype is None:
        raise ValueError("can't tell the weapon's base type: give 'offhand' (a base, a unique, or \"none\")")
        items["Weapon 2"] = _form(spec["offhand"])
    elif wtype == "Bow":
        q = db.quiver()
        items["Weapon 2"] = {"base": q} if q else None
    elif wtype and wtype not in TWO_HANDED:
        items["Weapon 2"] = {"base": db.best_base("Shield", defence, level)}
    for slot in ARMOUR_SLOTS:
        items[slot] = {"base": db.best_base(slot, defence, level)}
    for slot, base in JEWELLERY.items():
        items[slot] = {"base": base}
    for slot, v in (spec.get("items") or {}).items():
        items[slot] = _form(v)
    return {k: v for k, v in items.items() if v}


def skeleton_xml(spec, db, unique_text=None):
    """The skeleton build XML. Uniques are placeholders here (complete() equips them on the loaded build) unless
    unique_text (name, base) -> text is given."""
    check_spec(spec)
    level = spec.get("level", DEFAULT_LEVEL)
    links = spec.get("links", DEFAULT_LINKS)
    main_slot = spec.get("main_slot", "Body Armour")
    defence = spec.get("defence", "es")
    root = ET.Element("PathOfBuilding")
    ET.SubElement(root, "Build", level=str(level), className=spec["class"], ascendClassName="None",
                  mainSocketGroup="1", bandit="None", targetVersion="3_0", viewMode="ITEMS")
    tree = ET.SubElement(root, "Tree", activeSpec="1")
    ET.SubElement(tree, "Spec", treeVersion=db.meta.get("tree_version", "3_30"),
                  classId=str(CLASS_IDS[spec["class"]]), ascendClassId="0", nodes="", masteryEffects="")
    items_el = ET.SubElement(root, "Items", activeItemSet="1", useSecondWeaponSet="false")
    slots = []
    uniques = []
    item_id = 0
    for slot, entry in plan_items(spec, db).items():
        if "unique" in entry:
            uniques.append({"slot": slot, "name": entry["unique"], "base": entry.get("base")})
            if unique_text is None:
                continue
            text = unique_text(entry["unique"], entry.get("base"))
        elif "text" in entry:
            text = entry["text"]
        else:
            b = db.base(entry["base"])
            n = SOCKETS.get(slot)
            if slot == main_slot:
                n = max(links, n or 0)
            elif slot == "Weapon 1" and b["type"] in TWO_HANDED:
                n = 6
            elif slot == "Weapon 2" and b["type"] == "Quiver":
                n = None
            text = placeholder(slot, b["name"], n)
        item_id += 1
        ET.SubElement(items_el, "Item", id=str(item_id)).text = text
        slots.append((slot, item_id, False))
    flasks = spec.get("flasks")
    if flasks is None:
        flasks = ["Divine Life Flask", "Quicksilver Flask",
                  "Granite Flask" if "Armour" in DEFENCES[defence] else "Jade Flask", "Silver Flask", "Basalt Flask"]
    for i, f in enumerate(flasks, 1):
        entry = _form(f)
        if entry is None:  # "none": leave this flask slot empty
            continue
        if "unique" in entry:
            uniques.append({"slot": f"Flask {i}", "name": entry["unique"], "base": entry.get("base")})
            if unique_text is None:
                continue
            text = unique_text(entry["unique"], entry.get("base"))
        else:
            text = entry.get("text") or flask_text(db.base(entry["base"])["name"])
        item_id += 1
        ET.SubElement(items_el, "Item", id=str(item_id)).text = text
        slots.append((f"Flask {i}", item_id, True))
    iset = ET.SubElement(items_el, "ItemSet", id="1", useSecondWeaponSet="false")
    for slot, iid, flask in slots:
        ET.SubElement(iset, "Slot", name=slot, itemId=str(iid), **({"active": "true"} if flask else {}))

    skills = ET.SubElement(root, "Skills", activeSkillSet="1", defaultGemLevel="normalMaximum",
                           defaultGemQuality="0", sortGemsByDPS="true")
    sset = ET.SubElement(skills, "SkillSet", id="1")

    def group(slot, gems, main=False):
        el = ET.SubElement(sset, "Skill", enabled="true", slot=slot, mainActiveSkill="1", mainActiveSkillCalcs="1",
                           includeInFullDPS="true" if main else "false", label="")
        for name in gems:
            g = db.gem(name)
            ET.SubElement(el, "Gem", gemId=g["gemId"], variantId=g["variantId"] or "", skillId=g["skillId"] or "",
                          nameSpec=g["name"], level=str(g["maxLevel"]), quality="20", enabled="true",
                          enableGlobal1="true", enableGlobal2="false", count="1")

    main = db.gem(spec["main_skill"])
    if main["support"]:
        raise ValueError(f"main_skill '{spec['main_skill']}' is a support gem")
    supports = list(spec.get("supports") or [])[:max(0, links - 1)]
    group(main_slot, [spec["main_skill"]] + supports, main=True)
    for g in spec.get("groups") or []:
        if not g.get("gems"):
            raise ValueError("each extra group needs 'gems'")
        group(g.get("slot") or "", g["gems"])
    ET.SubElement(root, "Config", activeConfigSet="1").append(ET.Element("ConfigSet", id="1", title="Default"))
    return ET.tostring(root, encoding="unicode", xml_declaration=True), uniques


def pob_code(xml):
    """A PoB import code: zlib, then URL-safe base64 (as PoB's Export does)."""
    return base64.urlsafe_b64encode(zlib.compress(xml.encode("utf-8"), 9)).decode("ascii")


# ---------------- complete ----------------

SANDBOX_OUTPUTS = "/mnt/user-data/outputs"  # a claude.ai chat sandbox's folder for files handed to the user


def _downloads():
    if os.name == "nt":
        return os.path.join(os.path.expanduser("~"), "Downloads")
    return SANDBOX_OUTPUTS if os.path.isdir(SANDBOX_OUTPUTS) else os.getcwd()


def slug(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "concept"


def charge_start_gems(pool, budget, log):
    """A concept owns nothing: charge every gem it starts with. Main-group gems use the gem optimizer's keys
    (gem:<index>), so a support it replaces is refunded."""
    from ninja import is_rare_gem
    for g in pool.groups():
        if not g["enabled"] or g.get("source"):
            continue
        for gem in g["gems"]:
            name = gem.get("name")
            if not name:
                continue
            rare = is_rare_gem(name)
            cost = budget.gem_cost(name, gem.get("level") or 1, gem.get("quality") or 0, rare=rare)
            entry = {"step": "start gems", "change": f"group {g['index']}: {name}"}
            if cost is None:
                entry["note"] = "not in this league's economy: not charged"
            else:
                key = f"gem:{gem['index']}" if g["main"] else f"group:{g['index']}:gem:{gem['index']}"
                budget.charge(cost, f"gem {name}", key)
                entry["divine"] = round(cost, 3)
            log.append(entry)


def complete(spec=None, xml=None, main_skill=None, cls=None, ascendancy=None, budget_div=None, quick=False,
             trade_check=False, league=None, workers=None, metric=None, tier=2, ehp_floor=None, log_progress=None):
    """Run the pipeline; returns (report, final_xml). ehp_floor: a minimum total EHP the build must reach (a rule
    like the resists); default none."""
    import evaluator as E
    import gear as R
    import gems as G
    import opt as O
    import tree as T
    from objective import Rules, summary
    say = log_progress or (lambda m: None)
    t0 = time.perf_counter()
    db = GameDB()
    uniques = []
    if spec is not None:
        xml, uniques = skeleton_xml(spec, db)
        main_skill, cls, ascendancy = spec["main_skill"], spec["class"], spec.get("ascendancy")
        metric = metric or spec.get("metric")
        ehp_floor = ehp_floor or spec.get("ehp_floor")
        if budget_div is None:
            budget_div = spec.get("budget")
    log = []
    prices = budget = None
    from ninja import Prices
    try:
        prices = Prices(league)  # for the cost report even without a budget
    except (RuntimeError, OSError) as e:
        if budget_div is not None or trade_check:
            raise RuntimeError(f"a budget or trade check needs poe.ninja prices: {e}") from None
        say(f"no prices ({e}); cost left out")
    if budget_div is not None:
        from budget import Budget
        budget = Budget(budget_div, prices)
    with E.EvalPool(workers=E.default_workers() if workers is None else workers) as pool:
        start = pool.load(xml, main_skill)
        # Uniques: PoB's own item text, equipped on the loaded build; charged at their poe.ninja price.
        for u in uniques:
            info = pool.unique_text(u["name"], u.get("base"))
            pool.apply([{"op": "equip", "slot": u["slot"], "text": info["text"],
                         **({"active": True} if u["slot"].startswith("Flask") else {})}])
            entry = {"step": "uniques", "change": f"{u['slot']}: {info['name']}"}
            if budget is not None:
                p = prices.unique(info["name"], base=info["base"])
                if not p or p.get("divine") is None:
                    entry["note"] = "not on poe.ninja: not charged"
                else:
                    budget.charge(p["divine"], f"unique {info['name']}", f"unique:{u['slot']}")
                    entry["divine"] = round(p["divine"], 3)
            log.append(entry)
        for var, value in ((spec or {}).get("config") or {}).items():
            pool.apply([{"op": "config", "var": var, "value": value}])
        if budget is not None and spec is not None:  # a loaded build (--xml) owns its gems
            charge_start_gems(pool, budget, log)
        start = {**start, "stats": pool.stats()}
        metric = metric or E.main_metric(start["stats"])
        floor = ehp_floor if ehp_floor else "none"
        rules = Rules(metric, start["stats"], ehp_floor=floor, start_breaks="repair")
        # The tree grows without the resist rules: crafted gear caps resists far more cheaply than passives, so
        # points go to damage and life, and a quick screen compares damage fairly. Gear and the later steps
        # hold the full rules.
        growth = Rules(metric, start["stats"], res_cap=NO_RES_RULE, chaos_min=None, ehp_floor=floor,
                       start_breaks="repair")
        pts = pool.points()
        say(f"tree: {cls} {ascendancy or ''}, {pts['available']} points")
        T.build(pool, growth, cls, ascendancy, points=pts["available"], asc_points=pts["ascendancyAvailable"],
                max_dist=10, main_skill=pool.main_skill(), log=log)
        links = (spec or {}).get("links", DEFAULT_LINKS)
        say("gems")
        owned = set() if spec is not None else None  # a concept buys its gems; a loaded build owns its own
        G.optimize_gems(pool, rules if not quick else growth, links=links, budget=budget, log=log, owned=owned)
        if not quick:
            say("gear")
            R.optimize_gear(pool, rules, tier=tier, keep_implicits=False, main_skill=pool.main_skill(),
                            budget=budget, log=log)
            say("jewels")
            R.optimize_jewels(pool, rules, tier=tier, main_skill=pool.main_skill(), budget=budget, log=log)
            say("gems and tree again")
            G.optimize_gems(pool, rules, links=links, budget=budget, log=log, owned=owned)
            T.improve(pool, rules, main_skill=pool.main_skill(), log=log)
        final = pool.stats()
        final_xml = pool.save_xml()
        report = {
            "concept": (spec or {}).get("name"), "class": cls, "ascendancy": ascendancy,
            "mainSkill": pool.main_skill(), "pobVersion": start["pobVersion"],
            "treeVersion": db.meta.get("tree_version"), "metric": metric, "quick": quick,
            "after": summary(rules, final), "brokenRules": sorted(rules.shortfalls(final)),
            **({"note": "quick: no crafted gear yet, so resist rules are left to the full run"} if quick else {}),
            "warnings": final.get("warnings") or [], "points": pool.points(),
            "gems": [{"slot": g.get("slot"), "gems": [x["name"] for x in g["gems"]]}
                     for g in pool.groups() if g["enabled"] and not g.get("source")],
            "changes": len(log),
        }
        if prices is not None:
            import buildcost
            try:
                report["cost"] = buildcost.price_build(pool, prices)
            except (RuntimeError, OSError) as e:
                report["cost"] = {"error": str(e)}
            if budget is not None:
                report["spend"] = budget.report()
                if budget.remaining < -1e-9:
                    report["overBudget"] = round(-budget.remaining, 2)
            if trade_check:
                report["tradeChecks"] = O.trade_checks(prices, log)
        report["novelty"] = O.novelty(pool, league, pool.main_skill())
    report["seconds"] = round(time.perf_counter() - t0, 1)
    report["pobCode"] = pob_code(final_xml)
    report["log"] = [{k: v for k, v in c.items() if k != "item"} for c in log]
    return report, final_xml


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
    ap = argparse.ArgumentParser(description="Build concepts: skeleton and full optimization")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("new")
    p.add_argument("spec")
    p.add_argument("--out")
    p = sub.add_parser("complete")
    p.add_argument("spec", nargs="?")
    p.add_argument("--xml", help="start from this build instead of a spec")
    p.add_argument("--main-skill")
    p.add_argument("--class", dest="cls")
    p.add_argument("--ascendancy")
    p.add_argument("--budget", type=float)
    p.add_argument("--quick", action="store_true", help="tree and gems only (screening)")
    p.add_argument("--trade-check", action="store_true")
    p.add_argument("--league")
    p.add_argument("--metric")
    p.add_argument("--tier", type=int, default=2)
    p.add_argument("--ehp-floor", type=float, help="minimum total EHP, held like the resist rules")
    p.add_argument("--workers", type=int)
    p.add_argument("--out")
    p.add_argument("--report")
    args = ap.parse_args()

    if args.cmd == "new":
        with open(args.spec, encoding="utf-8") as f:
            spec = json.load(f)
        db = GameDB()
        with E.EvalPool(workers=0) as pool:
            xml, uniques = skeleton_xml(spec, db)
            pool.load(xml, spec["main_skill"])
            xml, _ = skeleton_xml(spec, db, unique_text=lambda n, b: pool.unique_text(n, b)["text"])
            pool.load(xml, spec["main_skill"])
        out = args.out or os.path.join(_downloads(), f"concept-{slug(spec['name'])}-skeleton.xml")
        with open(out, "w", encoding="utf-8") as f:
            f.write(xml)
        print(json.dumps({"saved": out, "uniques": [u["name"] for u in uniques]}, indent=1))
        return

    spec = None
    if args.spec:
        with open(args.spec, encoding="utf-8") as f:
            spec = json.load(f)
        name = spec.get("name") or "concept"
    elif args.xml:
        if not (args.main_skill and args.cls):
            raise ValueError("--xml needs --main-skill and --class")
        name = os.path.splitext(os.path.basename(args.xml))[0]
    else:
        raise ValueError("give a spec file or --xml")
    xml = None
    if args.xml:
        with open(args.xml, encoding="utf-8") as f:
            xml = f.read()
    out = args.out or os.path.join(_downloads(), f"concept-{slug(name)}.xml")
    if not os.path.isdir(os.path.dirname(os.path.abspath(out))):
        raise ValueError(f"no folder for --out: {os.path.dirname(os.path.abspath(out))}")
    report, final_xml = complete(spec, xml, args.main_skill, args.cls, args.ascendancy, args.budget, args.quick,
                                 args.trade_check, args.league, args.workers, args.metric, args.tier,
                                 args.ehp_floor, log_progress=lambda m: print(m, file=sys.stderr, flush=True))
    with open(out, "w", encoding="utf-8") as f:
        f.write(final_xml)
    report["saved"] = out
    text = json.dumps(report, indent=1, ensure_ascii=False)
    if args.report:
        with open(args.report, "w", encoding="utf-8") as f:
            f.write(text)
    print(text)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError, EOFError) as e:
        sys.exit(f"error: {e}")
