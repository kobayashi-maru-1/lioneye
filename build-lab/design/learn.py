"""Learn from similar builds: what the skill's reference builds commonly take, as a design's starting point.

  learn.py show --skill GEM --class C [--ascendancy A] [--links 6] [--budget] [--sources ladder,web] [--league L]

Andy, 2026-11-27: a design starts from the skill's common choices and the optimizers try to beat them, keeping a
change only when it measures better. Reports explain why players pick what they pick.

- Group: the references (design/refs.py: ladder crawl, web guides, poe.ninja characters) of the design's
  ascendancy when there are MIN_REFS or more; else those of its class (ascendancy nodes then aren't learned);
  else nothing is learned and the tree grows from the class start.
- Nodes: each passive at least COMMON of the group takes: keystones, notables, travel, masteries (with the effect
  most of those taking the mastery chose), and with an ascendancy group its ascendancy nodes. Cluster-jewel nodes
  and jewel sockets are left out (the jewel step handles sockets).
- Supports: the main skill's group supports at least COMMON of the group use, most common first, up to
  links - 1. With a budget an awakened support starts as its plain version.
- explain(): the EXPLAIN most common keystones, notables and supports measured on a finished design: in it, what
  removing it costs (the node alone, not the branch behind it); not in it, what adding it (a node with its path) or swapping it in for the best current
  support would give, each judged with Rules.why().

Each reference is read once per file content and PoB version and cached (learned.json in the refs folder).
"""
import argparse
import hashlib
import json
import os
import sys
import xml.etree.ElementTree as ET
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
for _sub in ("eval", "opt", "market", "backtest"):
    sys.path.insert(0, os.path.join(HERE, "..", _sub))
sys.path.insert(0, HERE)

MIN_REFS = 5       # Andy, 2026-11-27: fewer references are noise
COMMON = 0.5       # taken by at least half the group
EXPLAIN = 10
CACHE = "learned.json"
PARSER = "p1"      # part of the cache key: bump when parse() changes
EXCEPTIONAL = ("Empower", "Enlighten", "Enhance")   # exceptional supports: left out of a budget start
SKIP_TYPES = ("Socket", "ClassStart", "AscendClassStart")


# ---------------- reading one reference ----------------

def _active(parent, tag, attr):
    """The active child (e.g. the active Spec of Tree), or the first; None when there's none."""
    if parent is None:
        return None
    kids = parent.findall(tag)
    if not kids:
        return None
    want = parent.get(attr)
    for k in kids:
        if want is not None and k.get("id") == want:
            return k
    try:
        i = int(want or 1) - 1
        return kids[i] if 0 <= i < len(kids) else kids[0]
    except ValueError:
        return kids[0]


def _is_support(gem):
    return "SupportGem" in (gem.get("gemId") or "") or (gem.get("skillId") or "").startswith("Support")


def parse(xml, skill):
    """What a build takes: {class, ascendancy, level, nodes, masteries {node: effect}, supports}. supports is
    None when no enabled group holds `skill` (the reference then teaches only its tree)."""
    root = ET.fromstring(xml.encode("utf-8"))
    b = root.find("Build")
    tree = root.find("Tree")
    spec = _active(tree, "Spec", "activeSpec") if tree is not None else None
    nodes = [int(x) for x in ((spec.get("nodes") if spec is not None else "") or "").split(",") if x.strip()]
    masteries = {}
    for pair in ((spec.get("masteryEffects") if spec is not None else "") or "").split("},"):
        parts = pair.strip("{} ").split(",")
        if len(parts) == 2 and parts[0].strip().isdigit() and parts[1].strip().isdigit():
            masteries[int(parts[0])] = int(parts[1])
    skills = root.find("Skills")
    sset = _active(skills, "SkillSet", "activeSkillSet")
    groups = (sset if sset is not None else skills).findall("Skill") if skills is not None else []
    want = (skill or "").lower()
    best = None
    for g in groups:
        if g.get("enabled") == "false":
            continue
        gems = [x for x in g.findall("Gem") if x.get("enabled") != "false"]
        if not any((x.get("nameSpec") or "").lower() == want and not _is_support(x) for x in gems):
            continue
        sup = [x.get("nameSpec") for x in gems if _is_support(x) and x.get("nameSpec")]
        if best is None or len(sup) > len(best):
            best = sup
    asc = b.get("ascendClassName") if b is not None else None
    return {"class": b.get("className") if b is not None else None,
            "ascendancy": None if asc in (None, "", "None") else asc,
            "level": int(b.get("level") or 0) if b is not None else 0,
            "nodes": nodes, "masteries": masteries, "supports": best}


def profile(league, skill, ev=None, sources=None, say=None, exclude=()):
    """Every reference of `skill`, read: [{file, source, class, ascendancy, nodes, masteries, supports}] (cached;
    a reference PoB can't read is left out). sources: e.g. ("ladder",) to leave web references out; exclude:
    reference files left out (a back-test's own reference)."""
    import refs as RF
    say = say or (lambda m: None)
    rows = [r for r in RF.listing(league, skill)
            if (not sources or r["source"] in sources) and r["file"] not in exclude]
    if not rows:
        return []
    folder = RF.refs_dir(league)
    path = os.path.join(folder, CACHE)
    try:
        with open(path, encoding="utf-8") as f:
            cache = json.load(f)
    except (OSError, ValueError):
        cache = {}
    import evaluator as E
    # PoB's version from its manifest: no PoB is started unless a reference isn't cached yet
    if ev is not None:
        version = ev.pob.version
    else:
        pob_dir = E.ph().find_pob()
        if not pob_dir:
            raise RuntimeError("Path of Building isn't installed or downloadable here")
        version = E.ph().pob_version(pob_dir)
    out, dirty = [], False
    for i, r in enumerate(rows):
        with open(os.path.join(folder, r["file"]), "rb") as f:
            content = hashlib.sha1(f.read()).hexdigest()[:12]
        key = f"{PARSER}|{r['file']}|{content}|{version}|{skill.lower()}"
        got = cache.get(key)
        if got is None:
            say(f"learning: {skill} {i + 1}/{len(rows)}")
            try:
                ev = ev or E.Evaluator()
                got = parse(RF.load_xml(league, r["file"], ev), skill)
            except Exception as e:  # noqa: BLE001 - lupa's LuaError too: one bad reference mustn't end a design
                say(f"learning: {r['file']} left out ({type(e).__name__}: {str(e)[:120]})")
                continue
            cache[key] = got
            dirty = True
        out.append({"file": r["file"], "source": r["source"],
                    **{k: v for k, v in got.items()},
                    "masteries": {int(k): v for k, v in (got.get("masteries") or {}).items()}})
    if dirty:   # the cache is optional: a failed write (another process reading it on Windows) loses nothing
        tmp = f"{path}.{os.getpid()}.tmp"   # a back-test and a design can write at the same time
        try:
            os.makedirs(folder, exist_ok=True)
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(cache, f)
            os.replace(tmp, path)
        except OSError as e:
            say(f"learning: cache not saved ({e})")
            try:
                os.remove(tmp)
            except OSError:
                pass
    return out


# ---------------- common choices ----------------

def _node_info(db, ids):
    """{id: {name, type, ascendancy}} from the game database's tree (cluster-jewel nodes aren't in it)."""
    out = {}
    ids = list(ids)
    for i in range(0, len(ids), 500):
        part = ids[i:i + 500]
        q = f"SELECT id, name, type, ascendancy FROM nodes WHERE id IN ({','.join('?' * len(part))})"
        for nid, name, typ, asc in db.con.execute(q, part):
            out[nid] = {"name": name, "type": typ, "ascendancy": asc or None}
    return out


def common(refs, cls, ascendancy, db, links=6, budget=False, min_refs=MIN_REFS, share=COMMON):
    """What the group of references commonly takes. {"refs", "basis", "sources", "nodes": [{id, name, type,
    ascendancy, share}] (most common first), "masteries": {id: effect}, "supports": [{name, share}], "popular":
    [{kind, name, id?, share}]}, or {"refs", "note"} when the group is too small."""
    same_asc = [r for r in refs if ascendancy and r.get("ascendancy") == ascendancy]
    same_cls = [r for r in refs if r.get("class") == cls]
    if len(same_asc) >= min_refs:
        group, basis = same_asc, "ascendancy"
    elif len(same_cls) >= min_refs:
        group, basis = same_cls, "class"
    else:
        return {"refs": len(same_asc) if ascendancy else len(same_cls), "allRefs": len(refs),
                "note": f"fewer than {min_refs} references of {ascendancy or cls}: the tree grows from the class "
                        "start"}
    n = len(group)
    counts = Counter(x for r in group for x in set(r.get("nodes") or []))
    info = _node_info(db, counts)
    nodes = []
    for nid, c in counts.items():
        meta = info.get(nid)
        if not meta or meta["type"] in SKIP_TYPES or c / n < share - 1e-9:
            continue
        if meta["ascendancy"] and (basis != "ascendancy" or meta["ascendancy"] != ascendancy):
            continue
        nodes.append({"id": nid, **meta, "share": round(c / n, 3)})
    masteries, used = {}, set()
    # each effect once (PoB allows an effect on one mastery only): most common masteries choose first
    for m in sorted([x for x in nodes if x["type"] == "Mastery"], key=lambda x: (-x["share"], x["id"])):
        effects = Counter(r["masteries"][m["id"]] for r in group if m["id"] in (r.get("masteries") or {}))
        pick = next((e for e, _ in sorted(effects.items(), key=lambda ec: (-ec[1], ec[0])) if e not in used), None)
        if pick is not None:
            masteries[m["id"]] = pick
            used.add(pick)
    nodes = [x for x in nodes if x["type"] != "Mastery" or x["id"] in masteries]
    # most common first (seed() takes the tree's adjacent learned nodes before these paths anyway); ties by id
    nodes.sort(key=lambda x: (-x["share"], not x["ascendancy"], x["id"]))
    # supports count only when min_refs references show the skill's group (else one reference would be 100%)
    with_group = [r for r in group if r.get("supports") is not None]
    sup_counts = Counter(p for r in with_group for p in {_plain(s, budget) for s in r["supports"]} if p)
    ranked = sorted(sup_counts.items(), key=lambda sc: (-sc[1], sc[0]))   # ties by name: the same every run
    supports = [{"name": s, "share": round(c / len(with_group), 3)} for s, c in ranked
                if c / len(with_group) >= share - 1e-9][:max(0, links - 1)] if len(with_group) >= min_refs else []
    popular = [{"kind": "ascendancy" if x["ascendancy"] else x["type"].lower(), "name": x["name"], "id": x["id"],
                "share": x["share"]} for x in nodes if x["type"] in ("Keystone", "Notable")]
    popular += [{"kind": "support", "name": s["name"], "share": s["share"]} for s in supports]
    # keystones first (few, and the biggest choices), then by share; ties: ascendancy, supports, notables
    order = {"keystone": 0, "ascendancy": 1, "support": 2, "notable": 3}
    popular.sort(key=lambda p: (p["kind"] != "keystone", -p["share"], order[p["kind"]], p["name"]))
    return {"refs": n, "basis": basis, "sources": dict(Counter(r["source"] for r in group)),
            "withMainGroup": len(with_group), "nodes": nodes, "masteries": masteries, "supports": supports,
            "popular": popular[:EXPLAIN]}


def _plain(name, budget):
    """With a budget an awakened support starts as its plain version and an exceptional one (Empower, Enlighten,
    Enhance) is left out (None): the gem optimizer never adds either, and a budget would pay their full price."""
    if not budget:
        return name
    plain = name[len("Awakened "):] if name.startswith("Awakened ") else name
    return None if plain in EXCEPTIONAL else plain


def learn(league, skill, cls, ascendancy, db, ev=None, links=6, budget=False, sources=None, say=None, exclude=()):
    """profile() then common(): the learned start for a design, or {"refs", "note"} when there's too little."""
    refs = profile(league, skill, ev=ev, sources=sources, say=say, exclude=exclude)
    out = common(refs, cls, ascendancy, db, links=links, budget=budget)
    if sources:
        out["sourcesUsed"] = list(sources)
    return out


# ---------------- why ----------------

def _allocated(pool):
    """Every allocated node id (ascendancy ones too) of the pool's build."""
    root = ET.fromstring(pool.save_xml().encode("utf-8"))
    tree = root.find("Tree")
    spec = _active(tree, "Spec", "activeSpec") if tree is not None else None
    return {int(x) for x in ((spec.get("nodes") if spec is not None else "") or "").split(",") if x.strip()}


def explain(pool, rules, learned, keep=(), say=None):
    """The popular choices measured on the pool's (finished) build: [{kind, name, share, inDesign, decidedBy,
    damage, ehp, moved?, points?, replaces?}]. In the design: damage/ehp are what having it is worth against
    removing it. Not in it: what adding it (a node with its path) or swapping it in for the best current support
    would change. keep: supports never swapped out (the spec's keep_supports). Nothing on the build changes:
    nodes are probes, supports PoB's own support trials (the group is restored after each)."""
    say = say or (lambda m: None)
    popular = (learned or {}).get("popular") or []
    if not popular:
        return []
    say("why players pick the popular choices")
    base = pool.stats()
    have = _allocated(pool)
    main = next((g for g in pool.groups() if g.get("main")), None) or {"gems": []}
    live = [x for x in main["gems"] if x.get("support") and x.get("enabled", True)]
    in_group = {(x["name"] or "").lower(): x for x in live}
    keep = {k.lower().removesuffix(" support") for k in keep}
    swappable = [x for x in live if (x["name"] or "").lower().removesuffix(" support") not in keep]
    rows = []
    node_specs, node_rows, trials, trial_rows = [], [], [], []
    for p in popular:
        row = {"kind": p["kind"], "name": p["name"], "share": p["share"]}
        rows.append(row)
        if p["kind"] != "support":
            row["inDesign"] = p["id"] in have
            # in the design: the node alone taken out (nodes past it stay, as with any probe), so a notable on a
            # junction isn't charged with the branch behind it; not in it: the node with its path
            node_specs.append({"removeNodes": [p["id"]]} if row["inDesign"] else {"allocate": [p["id"]]})
            node_rows.append(row)
            continue
        gem = in_group.get(p["name"].lower()) or in_group.get(f"{p['name']} support".lower())
        row["inDesign"] = gem is not None
        if gem is not None:   # its worth: the group with it turned off
            trials.append({"index": gem["index"], "name": gem["name"], "level": gem.get("level"),
                           "quality": gem.get("quality") or 0, "enabled": False})
            trial_rows.append((row, None))
        else:                 # swapped in for each replaceable support in turn; the best is reported
            for g in swappable:
                trials.append({"index": g["index"], "name": p["name"], "quality": g.get("quality") or 0})
                trial_rows.append((row, g["name"]))
    for row, r in zip(node_rows, pool.probe(node_specs) if node_specs else []):
        if "error" in r:
            row["error"] = r["error"][:160]
        else:
            row.update(rules.why(r, base) if row["inDesign"] else rules.why(base, r))
            row["points"] = abs(r.get("points") or 0)
    best = {}
    for (row, replaced), r in zip(trial_rows, pool.support_trials(trials) if trials else []):
        if "error" in r:
            row.setdefault("error", r["error"][:160])
            continue
        if replaced is None:
            row.pop("error", None)
            row.update(rules.why(r, base))
        elif id(row) not in best or rules.better(r, best[id(row)][0]):
            best[id(row)] = (r, replaced, row)
    for r, replaced, row in best.values():
        row.pop("error", None)
        row.update(rules.why(base, r))
        row["replaces"] = replaced
    for row in rows:
        if row["kind"] == "support" and not row["inDesign"] and "replaces" not in row and "error" not in row:
            row["error"] = "no support it could replace"
    return rows


# ---------------- command line ----------------

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
    ap = argparse.ArgumentParser(description="What a skill's reference builds commonly take")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("show")
    p.add_argument("--skill", required=True)
    p.add_argument("--class", dest="cls", required=True)
    p.add_argument("--ascendancy")
    p.add_argument("--links", type=int, default=6)
    p.add_argument("--budget", action="store_true", help="awakened supports start as their plain version")
    p.add_argument("--sources", help="e.g. ladder (default: ladder and web)")
    p.add_argument("--league")
    args = ap.parse_args()
    from concept import GameDB
    from ninja import Prices
    league = args.league or Prices(None).league
    sources = tuple(s.strip() for s in args.sources.split(",")) if args.sources else None
    out = learn(league, args.skill, args.cls, args.ascendancy, GameDB(), links=args.links, budget=args.budget,
                sources=sources, say=lambda m: print(m, file=sys.stderr, flush=True))
    print(json.dumps(out, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError) as e:
        sys.exit(f"error: {e}")
