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

## Evaluator

Fast what-ifs on a loaded build, using worker processes that each run their own PoB.
- Library: [eval/evaluator.py](eval/evaluator.py) (`Evaluator`, `EvalPool`).
- Lua side: [eval/eval-ops.lua](eval/eval-ops.lua).

```powershell
& $py build-lab\eval\eval.py stats BUILD.xml --main-skill "Ethereal Knives"
& $py build-lab\eval\eval.py groups BUILD.xml                       # group and gem indexes for ops
& $py build-lab\eval\eval.py probe BUILD.xml --specs specs.json      # calculator probes, with deltas
& $py build-lab\eval\eval.py apply BUILD.xml --ops ops.json --save out.xml
& $py build-lab\eval\eval.py node-power BUILD.xml --main-skill X [--metric M] [--max-dist 10] [--top 25]
& $py build-lab\eval\eval.py supports BUILD.xml --main-skill X [--slots 2,3] [--top 10]
& $py build-lab\eval\test-eval.py BUILD.xml::MAIN_SKILL [...]       # equivalence tests against XML reloads
```

| Call | What it does | Cost |
|---|---|---|
| `probe` | PoB's misc calculator: allocate or deallocate nodes, swap one item, conditions. No state change | 5–20 ms |
| `apply` | Edits the build in memory as PoB's UI does: passives, equip, gems, config. Then recalculates. All-or-nothing | 130–270 ms |
| `support_trials` | Each candidate support in a slot, one recalculation each; the group is restored after | 110–180 ms each |

Spec, op and trial formats are in the `evaluator.py` docstring.

Rules a caller needs to know:
- **Masteries need an effect.** A mastery (named directly or on a path) needs its effect in `masteries`.
- **Socketed jewels.** A probe that would remove a socket holding a jewel is refused, because the calculator
  doesn't match PoB there. Use `apply`.
- **Failures leave the build untouched.** A failed `apply` restores the build, whether the cause is a bad op,
  a calc error, or a changed main skill (unless `allow_main_change` / `--allow-main-change`).
- **Dead workers.** A dead worker closes the pool (`PoolBroken`).

Other flags: `node-power --defence STAT`, `supports --quality N`.

`test-eval.py` checks every fast path against editing the XML and reloading it, and requires each change to
move a number.

## Benchmarks

```powershell
& $py build-lab\bench\bench-eval.py --pob-lib build-lab\pob\pob-headless.py BUILD.xml [...]
& $py build-lab\bench\bench-pool.py --pob-lib build-lab\pob\pob-headless.py --workers 1 4 8 12 BUILD.xml
```

## pob/pob-headless.py

A copy of the poe-build-expert skill's `scripts/pob-headless.py` (v2), so the workflow can run PoB without the
skill. It has one fix the skill's copy lacks: the GitHub-source checksum accepts CRLF or LF. Keep the two in
sync.
