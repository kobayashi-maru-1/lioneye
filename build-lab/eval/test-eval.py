"""Equivalence tests: every fast evaluation path must give the same numbers as editing the build XML and
reloading it in PoB (the slow path everyone trusts), and every change tested must actually move a number.

  python test-eval.py BUILD.xml::MAIN_SKILL [BUILD.xml::MAIN_SKILL ...] [--workers 3]

Per build:
  base         probe with no change == full load
  allocate     probe == XML with the node and its path == apply                      (must change a number)
  mastery      probe without an effect is refused; probe with one == XML == apply     (must change a number)
  deallocate   probe == XML without the node and its dependents == apply              (must change a number)
  item         probe == XML equip == apply                                            (must change a number)
  flask        apply equip in a flask slot == reload of save_xml (active state kept)
  gem-off      apply gem-enable false == XML                                          (must change a number)
  gem-swap     support trial == apply == XML, at an explicit level                    (must change a number)
  config       apply == XML                                                            (must change a number)
  rollback     a batch with a bad op, a calc error, or a main-skill change raises and leaves the build as it was
  pool         a worker pool's probe, apply and support trials == single process
Exit code 1 when any check fails. Builds aren't part of the repo: pass your own.
"""
import argparse
import json
import os
import sys
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import evaluator as E  # noqa: E402

KEYS = ("FullDPS", "CombinedDPS", "Life", "EnergyShield", "Mana", "TotalEHP", "Armour", "Evasion",
        "FireResist", "Str", "Dex", "Int", "MovementSpeedMod", "ManaUnreserved")
MINION_KEYS = ("minion.TotalDPS", "minion.CombinedDPS", "minion.Life")
AMULET = """Rarity: RARE
Test Pendant
Onyx Amulet
Implicits: 1
+(10-16) to all Attributes
+70 to maximum Life
+40% to Fire Resistance
+30% to Global Critical Strike Multiplier
20% increased Spell Damage"""
FLASK = """Rarity: NORMAL
Granite Flask"""  # +Armour while active: shows in KEYS
# Config inputs to try, in order, until one moves a number on this build: (var, value).
CONFIG_TRIES = [("enemyFireResist", 60), ("enemyIsBoss", "Pinnacle"), ("enemyIsBoss", "None"),
                ("conditionEnemyShocked", True), ("buffOnslaught", True), ("conditionLowLife", True)]


def same(a, b):
    if a is None or b is None:
        return a == b
    return abs(a - b) <= 1e-6 * max(1.0, abs(a), abs(b))


def diff(x, y):
    bad = {}
    for k in KEYS + MINION_KEYS:
        a, b = E.value(x, k), E.value(y, k)
        if not same(a, b):
            bad[k] = (a, b)
    return bad


# ---- XML edits (the trusted path) ----

def _spec(root):
    tree = root.find("Tree")
    return tree.findall("Spec")[int(tree.get("activeSpec") or 1) - 1]


def xml_nodes(ph, xml, add=(), remove=(), masteries=None):
    root = ph._parse(xml)
    spec = _spec(root)
    nodes = [n for n in (spec.get("nodes") or "").split(",") if n]
    drop = {str(r) for r in remove}
    nodes = [n for n in nodes if n not in drop] + [str(n) for n in add if str(n) not in nodes]
    spec.set("nodes", ",".join(nodes))
    if masteries:
        have = spec.get("masteryEffects") or ""
        extra = ",".join(f"{{{k},{v}}}" for k, v in masteries.items())
        spec.set("masteryEffects", f"{have},{extra}" if have else extra)
    return ph._dump(root)


def xml_gem(ph, xml, group_index, gem_index, enabled=None, info=None, level=None, quality=None):
    root = ph._parse(xml)
    ss = ph._active_set(root, "Skills", "SkillSet", "activeSkillSet")
    grp = ss.findall("Skill")[group_index - 1]
    gem = grp.findall("Gem")[gem_index - 1]
    if enabled is not None:
        gem.set("enabled", "true" if enabled else "false")
    if info:
        keep = {"enabled", "enableGlobal1", "enableGlobal2"}
        for k in list(gem.attrib):
            if k not in keep:
                del gem.attrib[k]
        gem.set("nameSpec", info["name"])
        gem.set("gemId", info["gemId"])
        gem.set("variantId", info["variantId"])
        gem.set("skillId", info["skillId"])
        gem.set("level", str(level or info["maxLevel"]))
        gem.set("quality", str(quality or 0))
        gem.set("qualityId", "Default")
        gem.set("count", "1")
    return ph._dump(root)


def xml_config(ph, xml, var, value):
    root = ph._parse(xml)
    cs = ph._active_set(root, "Config", "ConfigSet", "activeConfigSet")
    for e in cs.findall("Input"):
        if e.get("name") == var:
            cs.remove(e)
    attr = "boolean" if isinstance(value, bool) else ("number" if isinstance(value, (int, float)) else "string")
    ET.SubElement(cs, "Input", {"name": var, attr: ("true" if value else "false") if attr == "boolean" else str(value)})
    return ph._dump(root)


def run_build(path, main_skill, workers, report):
    ph = E.ph()
    xml = open(path, encoding="utf-8").read()
    name = os.path.basename(path)
    ev = E.Evaluator()

    def add(test, ok, **extra):
        report.append({"build": name, "test": test, "ok": bool(ok), **extra})

    def skip(test, why):
        report.append({"build": name, "test": test, "ok": True, "skip": why})

    def check(test, x, y):
        bad = diff(x, y)
        add(test, not bad, **({"diff": bad} if bad else {}))

    def moved(test, base_stats, x):
        add(f"{test} changes a number", bool(diff(base_stats, x)))

    def full(x):
        return ev.load(x, main_skill=main_skill)["stats"]

    def fresh():
        return ev.load(xml, main_skill=main_skill)["stats"]

    base = fresh()
    check("base: probe == load", ev.probe([{}])[0], base)

    # allocate: the reachable node 2+ points away whose probe moves the most numbers
    cands = [n for n in ev.reachable_nodes(6) if n["dist"] >= 2]
    probes = ev.probe([{"allocate": [n["id"]]} for n in cands])
    target, probe = max(zip(cands, probes), key=lambda t: (len(diff(base, t[1])) if "error" not in t[1] else -1, -t[0]["id"]))
    path_ids = ev.node_path(target["id"])
    applied = ev.apply([{"op": "allocate", "nodes": [target["id"]]}])
    check(f"allocate {target['name']} ({len(path_ids)} pts): probe == XML", probe, full(xml_nodes(ph, xml, add=path_ids)))
    check("allocate: apply == probe", applied, probe)
    moved("allocate", base, probe)

    # mastery: the nearest reachable mastery, first effect
    fresh()
    ms = sorted(ev.reachable_masteries(8), key=lambda m: (m["dist"], m["id"]))
    if ms:
        refused = ev.probe([{"allocate": [ms[0]["id"]]}])[0]
        add(f"mastery {ms[0]['name']}: probe without an effect is refused", "error" in refused)
        best = None
        for m in ms[:15]:  # the nearest mastery with an effect that moves a number on this build
            for eff in m["effects"]:
                r = ev.probe([{"allocate": [m["id"]], "masteries": {str(m["id"]): eff}}])[0]
                if "error" not in r and diff(base, r):
                    best = (eff, r)
                    break
            if best:
                break
        if best:
            eff, probe = best
            mpath = ev.node_path(m["id"])
            applied = ev.apply([{"op": "allocate", "nodes": [m["id"]], "masteries": {str(m["id"]): eff}}])
            check(f"mastery {m['name']} effect {eff}: probe == XML", probe,
                  full(xml_nodes(ph, xml, add=mpath, masteries={m["id"]: eff})))
            check("mastery: apply == probe", applied, probe)
        else:
            add("mastery: an effect that changes a number (15 nearest masteries)", False)
    else:
        skip("mastery", "no mastery reachable within 8 points")

    # a mastery effect already taken on the tree can't be chosen again (PoB allows each effect once)
    fresh()
    taken = {}
    spec_el = _spec(ph._parse(xml))
    for pair in (spec_el.get("masteryEffects") or "").strip("{}").split("},{"):
        if "," in pair:
            nid, eff = pair.split(",")
            taken[int(nid)] = int(eff)
    names = {n["id"]: n["name"] for n in ev.allocated_nodes() if n["type"] == "Mastery"}
    dup = next(((m, taken[nid]) for nid in taken for m in ev.reachable_masteries(12)
                if names.get(nid) == m["name"]), None)
    if dup:
        m, eff = dup
        r = ev.probe([{"allocate": [m["id"]], "masteries": {str(m["id"]): eff}}])[0]
        add(f"mastery {m['name']}: an effect already taken is refused", "already taken" in r.get("error", ""),
            **({} if "error" in r else {"got": "accepted"}))
    else:
        skip("mastery duplicate effect", "no reachable mastery of a type already allocated")

    # deallocate: the small passive whose removal moves the most numbers (probes that would take out a socketed
    # jewel are refused: checked separately below)
    fresh()
    alloc = [n for n in ev.allocated_nodes() if n["type"] == "Normal"]
    probes = ev.probe([{"deallocate": [n["id"]]} for n in alloc])
    jewel_refusals = [(n, p) for n, p in zip(alloc, probes) if "socketed jewel" in p.get("error", "")]
    if jewel_refusals:
        n, _ = jewel_refusals[0]
        deps = ev.node_depends(n["id"])
        applied = ev.apply([{"op": "deallocate", "nodes": [n["id"]]}])
        check(f"deallocate {n['name']} (takes out a jewel; probe refused): apply == XML", applied,
              full(xml_nodes(ph, xml, remove=deps)))
        fresh()
    victim, probe = max(zip(alloc, probes), key=lambda t: (len(diff(base, t[1])) if "error" not in t[1] else -1, -t[0]["frees"]))
    deps = ev.node_depends(victim["id"])
    applied = ev.apply([{"op": "deallocate", "nodes": [victim["id"]]}])
    check(f"deallocate {victim['name']} ({len(deps)} nodes): probe == XML", probe, full(xml_nodes(ph, xml, remove=deps)))
    check("deallocate: apply == probe", applied, probe)
    moved("deallocate", base, probe)

    # item swap
    fresh()
    probe = ev.probe([{"item": {"slot": "Amulet", "text": AMULET}}])[0]
    applied = ev.apply([{"op": "equip", "slot": "Amulet", "text": AMULET}])
    check("item: probe == XML equip", probe, full(ph.equip(xml, "Amulet", AMULET)))
    check("item: apply == probe", applied, probe)
    moved("item", base, probe)

    # flask: a Granite Flask, on and off, in the first slot where switching it on changes a number (Mageblood
    # builds can make that none); both states must match the XML and survive a save
    flask_done = False
    for slot in ("Flask 5", "Flask 4", "Flask 3", "Flask 2", "Flask 1"):
        fresh()
        off = ev.apply([{"op": "equip", "slot": slot, "text": FLASK, "active": False}])
        off_saved = ev.save_xml()
        fresh()
        on = ev.apply([{"op": "equip", "slot": slot, "text": FLASK, "active": True}])
        on_saved = ev.save_xml()
        if not diff(off, on):
            continue
        check(f"flask on ({slot}): apply == XML equip (active)", on, full(ph.equip(xml, slot, FLASK, active=True)))
        check(f"flask off ({slot}): apply == XML equip (off)", off, full(ph.equip(xml, slot, FLASK, active=False)))
        check("flask on: apply == reload of save_xml", on, full(on_saved))
        check("flask off: apply == reload of save_xml", off, full(off_saved))
        flask_done = True
        break
    if not flask_done:
        skip("flask", "switching a Granite Flask on changes no number in any slot on this build (Mageblood?)")

    # gem-off: an enabled support in the main group whose removal moves a number
    fresh()
    groups = ev.groups()
    main = next(g for g in groups if g["main"])
    sups = [g for g in main["gems"] if g["support"] and g["enabled"]]
    picked = None
    for sup in sups:
        fresh()
        a = ev.apply([{"op": "gem-enable", "group": "main", "index": sup["index"], "enabled": False}])
        if diff(base, a):
            picked = (sup, a)
            break
    if picked:
        sup, applied = picked
        check(f"gem-off {sup['name']}: apply == XML", applied,
              full(xml_gem(ph, xml, main["index"], sup["index"], enabled=False)))
    else:
        add("gem-off: a support whose removal changes a number", False)
        sup = sups[0]

    # gem-swap at an explicit level (an Awakened gem at 3 when one fits, else level 1)
    fresh()
    cands = [c for c in ev.compatible_supports() if c != sup["name"]]
    awakened = [c for c in cands if c.startswith("Awakened ")]
    order = awakened + [c for c in cands if c not in awakened]
    level = 3 if awakened else 1
    trials = ev.support_trials([{"index": sup["index"], "name": c, "quality": 20, "level": level} for c in order[:25]])
    after_groups, after_main = ev.groups(), ev.main_skill()
    add("support trials leave numbers, gems and main skill unchanged",
        not diff(ev.stats(), base) and after_groups == groups and after_main == main_skill)
    choice = next(((c, t) for c, t in zip(order, trials) if "error" not in t and diff(base, t)), None)
    if choice:
        swap_to, trial = choice
        info = ev.gem_info(swap_to)
        applied = ev.apply([{"op": "gem", "group": "main", "index": sup["index"], "name": swap_to,
                             "quality": 20, "level": level}])
        lv = next(g for g in ev.groups() if g["main"])["gems"][sup["index"] - 1]["level"]
        add(f"gem-swap {sup['name']} -> {swap_to}: level {level} kept", lv == level, got=lv)
        check(f"gem-swap {swap_to} L{level}: apply == trial", applied, trial)
        check("gem-swap: apply == XML", applied,
              full(xml_gem(ph, xml, main["index"], sup["index"], info=info, level=level, quality=20)))
    else:
        add("gem-swap: a candidate that changes a number", False)

    # config: the first input that moves a number
    done = False
    for var, val in CONFIG_TRIES:
        fresh()
        try:
            a = ev.apply([{"op": "config", "var": var, "value": val}])
        except ValueError:
            continue
        if diff(base, a):
            check(f"config {var}={val}: apply == XML", a, full(xml_config(ph, xml, var, val)))
            done = True
            break
    if not done:
        add("config: an input that changes a number", False)

    # rollback: bad op after a good one; calc error; main skill change
    def item_count(x):
        return len(ph._parse(x).find("Items").findall("Item"))

    fresh()
    items_before = item_count(ev.save_xml())

    def rollback(label, ops, must_raise=True, expect=None):
        fresh()
        msg = None
        try:
            ev.apply(ops)
        except ValueError as e:
            msg = str(e)
        if msg is None and not must_raise:
            return False
        unchanged = (not diff(ev.stats(), base) and ev.groups() == groups and ev.main_skill() == main_skill
                     and item_count(ev.save_xml()) == items_before)
        right_error = msg is not None and (expect is None or expect in msg)
        add(f"rollback ({label}): raises and leaves the build as it was", right_error and unchanged,
            **({} if msg is not None else {"note": "didn't raise"}), **({"error": msg} if msg and not right_error else {}))
        return True

    rollback("bad op", [{"op": "allocate", "nodes": [target["id"]]}, {"op": "nope"}], expect="unknown op")
    rollback("equip then bad op", [{"op": "equip", "slot": "Amulet", "text": AMULET}, {"op": "nope"}],
             expect="unknown op")
    # A text value in a number input breaks PoB's calculation, but only where that input is used.
    if not any(rollback(f"calc error via {var}", [{"op": "config", "var": var, "value": "abc"}], must_raise=False,
                        expect="calculation failed")
               for var in ("enemyFireResist", "enemyColdResist", "enemyLightningResist", "enemyChaosResist",
                           "enemyPhysicalReduction", "enemyArmour", "enemyEvasion")):
        skip("rollback (calc error)", "no input found that breaks this build's calc")
    rollback("main skill change", [{"op": "gem-remove", "group": "main",
                                    "index": next(g["index"] for g in main["gems"] if not g["support"])}],
             expect="main skill changed")
    add("load works after a failed apply", ev.load(xml, main_skill=main_skill)["mainSkill"] == main_skill)

    # pool == single process: probes, an apply, support trials
    fresh()
    specs = [{"allocate": [n["id"]]} for n in ev.reachable_nodes(4)[:40]]
    single = ev.probe(specs)
    single_trials = ev.support_trials([{"index": sup["index"], "name": c, "quality": 20} for c in order[:8]])
    single_apply = ev.apply([{"op": "allocate", "nodes": [target["id"]]}])
    with E.EvalPool(workers=workers) as pool:
        pool.load(xml, main_skill=main_skill)
        pooled = pool.probe(specs, chunk=3)
        pooled_trials = pool.support_trials([{"index": sup["index"], "name": c, "quality": 20} for c in order[:8]], chunk=2)
        pooled_apply = pool.apply([{"op": "allocate", "nodes": [target["id"]]}])
    errs = sum("error" in r for r in single)
    bad = [i for i, (a, b) in enumerate(zip(single, pooled)) if diff(a, b) or "error" in a or "error" in b]
    add(f"pool ({workers} workers): {len(specs)} probes == single, none failed", not bad and not errs,
        **({"diffAt": bad[:5]} if bad else {}))
    bad = [i for i, (a, b) in enumerate(zip(single_trials, pooled_trials)) if diff(a, b) or "error" in a or "error" in b]
    add(f"pool: {len(single_trials)} support trials == single, none failed", not bad, **({"diffAt": bad} if bad else {}))
    check("pool: apply == single", pooled_apply, single_apply)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("builds", nargs="+", help="BUILD.xml::MAIN SKILL")
    ap.add_argument("--workers", type=int, default=3)
    args = ap.parse_args()
    report = []
    for b in args.builds:
        path, _, skill = b.partition("::")
        if not skill:
            sys.exit("give each build as BUILD.xml::MAIN SKILL")
        try:
            run_build(path, skill, args.workers, report)
        except Exception as e:  # noqa: BLE001 - report and continue with the next build
            report.append({"build": os.path.basename(path), "test": "run", "ok": False, "error": f"{type(e).__name__}: {e}"})
    failed = [r for r in report if not r["ok"]]
    skipped = [r for r in report if r.get("skip")]
    print(json.dumps({"passed": len(report) - len(failed) - len(skipped), "skipped": len(skipped), "failed": failed,
                      "tests": [f"{'SKIP' if r.get('skip') else 'ok  ' if r['ok'] else 'FAIL'} {r['build']}: {r['test']}"
                                + (f" ({r['skip']})" if r.get("skip") else "") for r in report]},
                     indent=1, default=str))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
