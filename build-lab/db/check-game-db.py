"""Sanity checks on a built game database. The release workflow runs this before publishing; exit code 1 = don't.

Usage:
  python check-game-db.py game-<version>.sqlite [--pob-version 2.68.1]
"""
import argparse
import json
import os
import re
import sqlite3
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("db")
    ap.add_argument("--pob-version")
    args = ap.parse_args()
    if not os.path.isfile(args.db):
        sys.exit(f"error: no database at {args.db}")
    db = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)

    def one(sql, *a):
        return db.execute(sql, a).fetchone()[0]

    meta = dict(db.execute("SELECT key, value FROM meta"))
    checks = []

    def check(name, ok, got=None):
        checks.append({"check": name, "ok": bool(ok), **({"got": got} if got is not None else {})})

    if args.pob_version:
        check("PoB version matches", meta.get("pob_version") == args.pob_version, meta.get("pob_version"))
    floors = {"gems": 700, "support_compat": 50000, "base_items": 1000, "affixes": 10000, "uniques": 1200,
              "nodes": 3000, "node_edges": 5000, "mastery_effects": 200, "mod_lines": 25000, "mechanic_tags": 20000}
    for table, floor in floors.items():
        n = one(f"SELECT COUNT(*) FROM {table}")
        check(f"{table} >= {floor}", n >= floor, n)

    check("Fireball takes Spell Echo",
          one("SELECT COUNT(*) FROM v_supports_for WHERE active='Fireball' AND support='Spell Echo'") > 0)
    check("Fireball rejects Multistrike",
          one("SELECT COUNT(*) FROM v_supports_for WHERE active='Fireball' AND support='Multistrike'") == 0)
    check("Mageblood has lines", one("SELECT COUNT(*) FROM v_unique_lines WHERE name='Mageblood'") >= 3)
    check("full-text search works", one("SELECT COUNT(*) FROM mod_lines_fts WHERE mod_lines_fts MATCH 'ignite'") > 50)
    check("every class has ascendancies",
          one("SELECT COUNT(DISTINCT class) FROM classes") >= 7, one("SELECT COUNT(DISTINCT class) FROM classes"))
    check("keystones present", one("SELECT COUNT(*) FROM nodes WHERE type='Keystone'") >= 40)

    total = one("SELECT COUNT(*) FROM mod_lines")
    unsupported = one("SELECT COUNT(*) FROM mod_lines WHERE supported=0")
    check("PoB parses >= 85% of lines", total > 0 and unsupported / total <= 0.15, f"{unsupported}/{total} unsupported")

    legacy = []
    for name, vs in db.execute("SELECT name, variants FROM uniques WHERE variants IS NOT NULL"):
        variants = json.loads(vs)
        has_current = "Current" in variants
        legacy += [f"{name}: {v}" for v in variants
                   if re.search(r"\bPre[\s.]*\d", v) or (has_current and re.match(r"\d+\.\d+", v))]
    check("no legacy unique variants", not legacy, legacy[:5] or None)
    # A passive whose stat wraps onto two lines must be stored as one joined, parsed line.
    check("wrapped passive lines joined",
          one("SELECT COUNT(*) FROM mod_lines WHERE source_type='node' AND text LIKE '%' || char(10) || '%'") > 0)
    losses = {k: int(v) for k, v in meta.items() if k.startswith("extract_")}
    check("extraction lost nothing", meta.get("extract_gemErrors") is not None and not any(
        v for k, v in losses.items() if k != "extract_uniquesWithoutBase"), losses)
    check("uniques without a PoB base <= 5", losses.get("extract_uniquesWithoutBase", 99) <= 5,
          losses.get("extract_uniquesWithoutBase"))
    check("duplicate uniques <= 10", int(meta.get("duplicate_uniques", 99)) <= 10, meta.get("duplicate_uniques"))
    if meta.get("wiki", "no") != "no":
        matched, uniques = int(meta.get("wiki_unique_matches", 0)), one("SELECT COUNT(*) FROM uniques")
        check("wiki matches >= 95% of uniques", matched >= 0.95 * uniques, f"{matched}/{uniques}")

    failed = [c for c in checks if not c["ok"]]
    print(json.dumps({"meta": meta, "failed": failed, "passed": len(checks) - len(failed)}, indent=1))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
