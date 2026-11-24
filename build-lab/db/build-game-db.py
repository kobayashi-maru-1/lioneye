"""Build the build-lab game database from Path of Building's own data.

Starts PoB headless (build-lab/pob/pob-headless.py: installed app, POB_DIR, or PoB's source from GitHub), reads
gems, support compatibility, item bases, affixes, uniques and the passive tree out of it with extract.lua,
adds unique acquisition data from poewiki (optional), tags every stat line with mechanic-rules.json, and writes:

  game-<pob version>.sqlite      the database
  game-<pob version>.sqlite.gz   the same, compressed (the release asset)
  game-<pob version>.json        manifest: versions, row counts, sha256 of both files

Usage:
  python build-game-db.py [--out DIR] [--no-wiki]

Needs Python 3 with lupa (pip install lupa). Default output: Downloads on Windows, the current folder elsewhere.
"""
import argparse
import gzip
import hashlib
import html
import importlib.util
import json
import os
import re
import shutil
import sqlite3
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA_VERSION = 1
WIKI_API = "https://www.poewiki.net/w/api.php"
UA = {"User-Agent": "lioneye-build-lab/0.1 (+https://github.com/kobayashi-maru-1/lioneye)"}


def load_pob_lib():
    path = os.path.join(HERE, "..", "pob", "pob-headless.py")
    spec = importlib.util.spec_from_file_location("ph", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def default_out():
    if os.name == "nt":
        return os.path.join(os.path.expanduser("~"), "Downloads")
    return os.getcwd()


# ---------------- extraction ----------------

def extract(pob):
    with open(os.path.join(HERE, "extract.lua"), "rb") as f:
        pob.L.execute(f.read())
    out = {}
    for name in ("meta", "gems", "supportCompat", "bases", "affixes", "uniques", "tree", "stats"):
        t = time.perf_counter()
        out[name] = json.loads(pob.g.bl_extract(name.encode()))
        print(f"  {name}: {time.perf_counter() - t:.1f}s", file=sys.stderr)
    return out


# ---------------- poewiki ----------------

def _wiki_rank(row, name):
    """Lower is better when the wiki has several rows for one unique (legacy pages, variant pages): the page
    named after the item, then rows not removed from the game, then rows that can drop."""
    return (0 if _unescape(row.get("page")) == name else 1,
            0 if not row.get("removal_version") else 1,
            0 if str(row.get("drop_enabled")) == "1" else 1)


WIKI_SNAPSHOT = os.path.join(HERE, "wiki-uniques.json")
WIKI_LICENSE = ("Unique item acquisition data from poewiki.net (Cargo table 'items'), licensed CC BY-NC-SA 3.0: "
                "https://www.poewiki.net/wiki/Path_of_Exile_Wiki:Copyrights")


def fetch_wiki_rows():
    """Every unique's acquisition row from poewiki's Cargo API. Raises on network failure (poewiki refuses
    datacenter IPs such as GitHub's runners with 403; the workflow uses the snapshot then)."""
    rows, offset = [], 0
    fields = ("items._pageName=page,items.name=name,items.base_item=base,items.drop_enabled=drop_enabled,"
              "items.is_drop_restricted=drop_restricted,items.drop_text=drop_text,"
              "items.release_version=release_version,items.removal_version=removal_version")
    while True:
        q = {"action": "cargoquery", "format": "json", "tables": "items", "fields": fields,
             "where": 'items.rarity_id="unique"', "order_by": "items._pageName,items.name,items._ID",
             "limit": "500", "offset": str(offset)}
        req = urllib.request.Request(WIKI_API + "?" + urllib.parse.urlencode(q), headers=UA)
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.loads(r.read())
        if "error" in data:
            raise RuntimeError(f"poewiki: {data['error']}")
        batch = [x["title"] for x in data.get("cargoquery", [])]
        rows.extend(batch)
        if len(batch) < 500:
            break
        offset += 500
        time.sleep(1)  # be polite
    return rows


def save_wiki_snapshot(rows, path=WIKI_SNAPSHOT):
    snap = {"about": WIKI_LICENSE, "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "rows": rows}
    tmp = path + ".part"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(snap, f, ensure_ascii=False, indent=0, sort_keys=True)
        f.write("\n")
    os.replace(tmp, path)
    return snap["fetched_at"]


def load_wiki_snapshot(path=WIKI_SNAPSHOT):
    with open(path, encoding="utf-8") as f:
        snap = json.load(f)
    return snap["rows"], snap["fetched_at"]


def index_wiki_rows(rows):
    """{(name, base) or (name, None): best row}."""
    index = {}
    for r in rows:
        name = _unescape(r.get("name"))
        if not name:
            continue
        for key in ((name, _unescape(r.get("base"))), (name, None)):
            have = index.get(key)
            if have is None or _wiki_rank(r, name) < _wiki_rank(have, name):
                index[key] = r
    return index


def _unescape(s):
    return html.unescape(s) if isinstance(s, str) else s


def _int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


# ---------------- mechanic tags ----------------

class Tagger:
    def __init__(self, path):
        with open(path, encoding="utf-8") as f:
            self.rules = []
            for r in json.load(f)["rules"]:
                self.rules.append({
                    "tag": r["tag"],
                    "text": re.compile(r["text"], re.I) if r.get("text") else None,
                    "mod": re.compile(r["mod"]) if r.get("mod") else None,
                    "kw": r.get("kw"), "flag": r.get("flag"),
                    "cond": re.compile(r["cond"], re.I) if r.get("cond") else None,
                })

    def tags(self, text, mods):
        out = set()
        for r in self.rules:
            if r["text"] and r["text"].search(text):
                out.add(r["tag"])
                continue
            for m in mods:
                if ((r["mod"] and r["mod"].search(m.get("n") or ""))
                        or (r["kw"] and r["kw"] in (m.get("k") or []))
                        or (r["flag"] and r["flag"] in (m.get("f") or []))
                        or (r["cond"] and any(isinstance(t, dict) and r["cond"].search(str(t.get("var", "")))
                                              for t in (m.get("tags") or [])))):
                    out.add(r["tag"])
                    break
        return out


# ---------------- writing ----------------

def _j(v):
    return json.dumps(v, separators=(",", ":"), ensure_ascii=False) if v is not None else None


def _list(v):
    """A JSON list, or [] when the field is missing. (dkjson writes an empty Lua table as [], but a sparse Lua
    array would arrive as an object; extract.lua builds its lists densely, so that doesn't happen.)"""
    return v if isinstance(v, list) else []


class Writer:
    def __init__(self, db, tagger):
        self.db, self.tagger = db, tagger
        self.line_id = 0
        self.counts = {"lines": 0, "unsupported": 0, "tags": 0}

    def lines(self, source_type, source_id, entries):
        for seq, e in enumerate(entries, 1):
            self.line_id += 1
            mods = _list(e.get("mods"))
            supported = 1 if e.get("supported") else 0
            self.db.execute(
                "INSERT INTO mod_lines (id, source_type, source_id, seq, kind, text, variants, supported, extra, parsed)"
                " VALUES (?,?,?,?,?,?,?,?,?,?)",
                (self.line_id, source_type, str(source_id), seq, e.get("kind"), e["text"],
                 _j(e.get("variants")) if e.get("variants") else None, supported, e.get("extra"), _j(mods)))
            tags = self.tagger.tags(e["text"], mods)
            self.db.executemany("INSERT INTO mechanic_tags (line_id, tag) VALUES (?,?)",
                                [(self.line_id, t) for t in sorted(tags)])
            self.counts["lines"] += 1
            self.counts["unsupported"] += 1 - supported
            self.counts["tags"] += len(tags)


def write_db(path, data, wiki, wiki_source, pob_version, schema_sql, tagger):
    if os.path.exists(path):
        os.remove(path)
    db = sqlite3.connect(path)
    db.executescript(schema_sql)
    w = Writer(db, tagger)

    for g in data["gems"]:
        db.execute("INSERT INTO gems VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
            g["id"], g["name"], g.get("baseTypeName"), g.get("variantId"), g.get("grantedEffectId"),
            g.get("secondaryGrantedEffectId"), int(g["support"]), int(g["vaal"]), int(g["transfigured"]),
            int(g["unsupported"]), g.get("tagString"), g.get("reqStr"), g.get("reqDex"), g.get("reqInt"),
            g.get("maxLevel"), g.get("castTime"), g.get("description"),
            _j(_list(g.get("skillTypes"))), _j(_list(g.get("minionSkillTypes"))),
            _j(_list(g.get("requireSkillTypes"))), _j(_list(g.get("addSkillTypes"))),
            _j(_list(g.get("excludeSkillTypes"))), _j(_list(g.get("weaponTypes"))),
            _j(g.get("stats")), _j(g.get("constantStats")), _j(_list(g.get("qualityStats")))))
        db.executemany("INSERT OR IGNORE INTO gem_tags VALUES (?,?)", [(g["id"], t) for t in _list(g.get("tags"))])
        db.executemany("INSERT OR IGNORE INTO gem_skill_types VALUES (?,?,0)",
                       [(g["id"], t) for t in _list(g.get("skillTypes"))])
        db.executemany("INSERT OR IGNORE INTO gem_skill_types VALUES (?,?,1)",
                       [(g["id"], t) for t in _list(g.get("minionSkillTypes"))])
        db.executemany("INSERT OR REPLACE INTO gem_levels VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", [
            (g["id"], lv["level"], lv.get("req"), _j(lv.get("values")), _j(lv.get("interpolation")), _j(lv.get("cost")),
             lv.get("manaMultiplier"), lv.get("effectiveness"), lv.get("crit"), lv.get("cooldown"),
             lv.get("storedUses"), _j(lv.get("reservation"))) for lv in _list(g.get("levels"))])

    db.executemany("INSERT OR IGNORE INTO support_compat VALUES (?,?,?)", [tuple(r) for r in data["supportCompat"]])

    for b in data["bases"]:
        db.execute("INSERT INTO base_items VALUES (?,?,?,?,?,?,?,?,?,?,?)", (
            b["name"], b.get("type"), b.get("subType"), int(b.get("hidden") or 0), b.get("socketLimit"),
            _j(_list(b.get("tags"))), _j(b.get("influenceTags")), _j(b.get("req")), _j(b.get("armour")),
            _j(b.get("weapon")), _j(b.get("flask"))))
        db.executemany("INSERT OR IGNORE INTO base_tags VALUES (?,?)", [(b["name"], t) for t in _list(b.get("tags"))])
        w.lines("base", b["name"], _list(b.get("implicits")))

    for a in data["affixes"]:
        db.execute("INSERT OR REPLACE INTO affixes VALUES (?,?,?,?,?,?,?,?)", (
            a["domain"], a["id"], a.get("type"), a.get("affix"), a.get("group"), a.get("level"),
            _j(_list(a.get("modTags"))), _j(_list(a.get("types")))))
        db.executemany("INSERT OR REPLACE INTO affix_spawn VALUES (?,?,?,?,?)", [
            (a["domain"], a["id"], i, s["tag"], s.get("weight") or 0) for i, s in enumerate(_list(a.get("weights")), 1)])
        w.lines("affix", f"{a['domain']}:{a['id']}", _list(a.get("lines")))

    # PoB can list the same name and base twice (e.g. in two files); keep the first, count the rest.
    seen, uniques, duplicates = set(), [], 0
    for u in data["uniques"]:
        uid = f"{u['name']}|{u.get('base')}"
        if uid in seen:
            duplicates += 1
            continue
        seen.add(uid)
        uniques.append((uid, u))
    matched = 0
    for uid, u in uniques:
        wr = None
        if wiki:
            wr = wiki.get((u["name"], u.get("base"))) or wiki.get((u["name"], None))
            matched += wr is not None
        db.execute("INSERT INTO uniques VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
            uid, u["name"], u.get("base"), u.get("type"), u.get("file"), u.get("league"), u.get("source"),
            u.get("reqLevel"), _j(_list(u.get("variants"))),
            _int(wr.get("drop_enabled")) if wr else None, _int(wr.get("drop_restricted")) if wr else None,
            _unescape(wr.get("drop_text")) if wr else None, wr.get("release_version") if wr else None,
            wr.get("removal_version") if wr else None))
        w.lines("unique", uid, _list(u.get("lines")))

    tree = data["tree"]
    for n in tree["nodes"]:
        db.execute("INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?,?,?)", (
            n["id"], n.get("name"), n.get("type"), n.get("ascendancy"), n.get("class"), n.get("x"), n.get("y"),
            n.get("group"), int(n.get("multipleChoice") or 0), int(n.get("blighted") or 0)))
        w.lines("node", n["id"], _list(n.get("lines")))
        db.executemany("INSERT OR IGNORE INTO node_mastery_effects VALUES (?,?)",
                       [(n["id"], e) for e in _list(n.get("masteryEffects"))])
    node_ids = {n["id"] for n in tree["nodes"]}
    edges = set()
    for n in tree["nodes"]:
        for other in _list(n.get("links")):
            if other in node_ids and other != n["id"]:
                edges.add((n["id"], other))
                edges.add((other, n["id"]))
    db.executemany("INSERT INTO node_edges VALUES (?,?)", sorted(edges))
    for e in tree["masteryEffects"]:
        db.execute("INSERT INTO mastery_effects VALUES (?)", (e["id"],))
        w.lines("mastery", e["id"], _list(e.get("lines")))
    for c in tree["classes"]:
        db.executemany("INSERT OR IGNORE INTO classes VALUES (?,?)",
                       [(c["name"], a) for a in _list(c.get("ascendancies")) if a != "None"])

    db.execute("INSERT INTO mod_lines_fts (mod_lines_fts) VALUES ('rebuild')")
    meta = {
        "schema_version": SCHEMA_VERSION, "pob_version": pob_version,
        "tree_version": data["meta"].get("treeVersion"), "built_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "wiki": wiki_source, "wiki_unique_matches": matched, "duplicate_uniques": duplicates,
        **({"wiki_license": WIKI_LICENSE} if wiki else {}),
        # Extraction losses from extract.lua (all should be 0 or near it; check-game-db.py checks them).
        **{f"extract_{k}": v for k, v in (data.get("stats") or {}).items()},
    }
    db.executemany("INSERT INTO meta VALUES (?,?)", [(k, str(v)) for k, v in meta.items()])
    db.commit()
    counts = {t: db.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in (
        "gems", "support_compat", "base_items", "affixes", "uniques", "nodes", "node_edges", "mastery_effects",
        "mod_lines", "mechanic_tags")}
    counts["unsupported_lines"] = w.counts["unsupported"]
    db.execute("ANALYZE")  # planner statistics, so joins like affixes -> mod_lines pick the indexes
    db.commit()
    db.execute("VACUUM")
    db.close()
    return meta, counts


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser(description="Build the build-lab game database from PoB")
    ap.add_argument("--out", default=default_out())
    ap.add_argument("--no-wiki", action="store_true", help="skip poewiki acquisition data")
    ap.add_argument("--require-wiki", action="store_true",
                    help="fail instead of building without poewiki data, live or snapshot (CI)")
    ap.add_argument("--wiki-from-snapshot", action="store_true", help="use db/wiki-uniques.json, skip the live wiki")
    ap.add_argument("--save-wiki-snapshot", action="store_true",
                    help="fetch poewiki live and save db/wiki-uniques.json (run on a PC; commit the file), then exit")
    ap.add_argument("--print-latest-version", action="store_true",
                    help="print the latest PoB release (what a GitHub-source build would use) and exit")
    args = ap.parse_args()

    if args.save_wiki_snapshot:
        rows = fetch_wiki_rows()
        print(f"saved {len(rows)} poewiki rows to {WIKI_SNAPSHOT} ({save_wiki_snapshot(rows)})")
        return
    ph = load_pob_lib()
    if args.print_latest_version:
        print(ph.latest_version())
        return
    t0 = time.perf_counter()
    pob = ph.Pob()
    version = pob.version
    print(f"PoB {version} ({pob.info()['mode']}), extracting...", file=sys.stderr)
    data = extract(pob)

    # poewiki: live, else the committed snapshot, else (unless --require-wiki) none.
    wiki, wiki_source = None, "no"
    if not args.no_wiki:
        try:
            if args.wiki_from_snapshot:
                raise RuntimeError("--wiki-from-snapshot")
            rows = fetch_wiki_rows()
            wiki, wiki_source = index_wiki_rows(rows), "live"
            print(f"  poewiki: {len(rows)} uniques (live)", file=sys.stderr)
        except Exception as e:  # noqa: BLE001 - fall back to the snapshot
            try:
                rows, fetched = load_wiki_snapshot()
                wiki, wiki_source = index_wiki_rows(rows), f"snapshot {fetched}"
                print(f"  poewiki unavailable ({e}); using snapshot from {fetched}", file=sys.stderr)
            except (OSError, ValueError, KeyError) as e2:
                if args.require_wiki:
                    raise RuntimeError(f"poewiki unavailable ({e}) and no snapshot ({e2})") from None
                print(f"  poewiki unavailable ({e}), no snapshot; building without acquisition data",
                      file=sys.stderr)

    os.makedirs(args.out, exist_ok=True)
    base = os.path.join(args.out, f"game-{version}")
    with open(os.path.join(HERE, "schema.sql"), encoding="utf-8") as f:
        schema_sql = f.read()
    meta, counts = write_db(base + ".sqlite", data, wiki, wiki_source, version, schema_sql,
                            Tagger(os.path.join(HERE, "mechanic-rules.json")))
    with open(base + ".sqlite", "rb") as src, gzip.open(base + ".sqlite.gz", "wb", compresslevel=9) as dst:
        shutil.copyfileobj(src, dst)
    manifest = {**meta, "counts": counts,
                "files": {os.path.basename(p): {"bytes": os.path.getsize(p), "sha256": sha256(p)}
                          for p in (base + ".sqlite", base + ".sqlite.gz")},
                "build_seconds": round(time.perf_counter() - t0)}
    with open(base + ".json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1)
    print(json.dumps(manifest, indent=1))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError) as e:
        sys.exit(f"error: {e}")
