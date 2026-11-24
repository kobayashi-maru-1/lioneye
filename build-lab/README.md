# Build lab

Tools for designing Path of Exile 1 builds with Claude: a game database built from Path of Building's own
data, and (later phases) a fast evaluator and optimizers on top of headless PoB. Plan and status:
[plans/build-lab.md](../plans/build-lab.md).

Nothing here is part of the Lioneye app or its build. It's Python, run on its own.

## Setup

Python 3 with `lupa` (LuaJIT). On Andy's PC the poe-build-expert skill's venv already has it:

```powershell
$py = "$env:LOCALAPPDATA\poe-build-expert\venv\Scripts\python.exe"
```

Elsewhere: `pip install lupa`.

## Game database

```powershell
& $py build-lab\db\game-db.py path                 # the database for this PoB version (cache, release, or local build)
& $py build-lab\db\game-db.py sql "SELECT ..."     # read-only query, rows as JSON
& $py build-lab\db\build-game-db.py --out DIR      # build one (about 30 s)
& $py build-lab\db\check-game-db.py DIR\game-<v>.sqlite --pob-version <v>
```

- Schema and what each table means: [db/schema.sql](db/schema.sql).
- Interaction tags: [db/mechanic-rules.json](db/mechanic-rules.json). Add rules there for mechanics PoB doesn't parse.
- Cache: `%LOCALAPPDATA%\poe-build-expert\game-db` (or `~/.cache/poe-build-expert/game-db`).

### Releases

The **Build-lab database** workflow runs daily. When PoB has a release with no complete database yet:
1. A read-only build job builds it from PoB's source, with poewiki required, and runs `check-game-db.py`.
2. A publish job releases `db-<PoB version>` with `game-<version>.sqlite.gz` and `game-<version>.json`.

lupa is installed hash-pinned from [db/requirements-ci.txt](db/requirements-ci.txt).

poewiki refuses GitHub's runners (403), so the workflow uses the committed snapshot
[db/wiki-uniques.json](db/wiki-uniques.json). Refresh it from a PC each league, or when new uniques appear,
and commit it:

```powershell
& $py build-lab\db\build-game-db.py --save-wiki-snapshot
```

The data is poewiki's, licensed CC BY-NC-SA 3.0. The snapshot, each database's meta and the release notes
all carry the attribution.

These are data releases, kept away from the app updater:

- They're published as prereleases with `--latest=false`. The updater reads `releases/latest`, which never
  returns a prerelease.
- Their tags start with `db-`, never `v`.
- The workflow's guard job fails if `releases/latest` is ever not a `v*` app release.

## Benchmarks

```powershell
& $py build-lab\bench\bench-eval.py --pob-lib build-lab\pob\pob-headless.py BUILD.xml [...]
& $py build-lab\bench\bench-pool.py --pob-lib build-lab\pob\pob-headless.py --workers 1 4 8 12 BUILD.xml
```

## pob/pob-headless.py

A copy of the poe-build-expert skill's `scripts/pob-headless.py` (v2), so the workflow can run PoB without the
skill. It has one fix the skill's copy lacks: the GitHub-source checksum accepts CRLF or LF. Keep the two in
sync.
