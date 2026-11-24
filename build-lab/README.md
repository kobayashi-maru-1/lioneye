# Build lab

Tools for designing Path of Exile 1 builds with Claude:
- a game database built from Path of Building's own data;
- a fast evaluator and optimizers on top of headless PoB;
- market prices;
- a concept builder;
- a notebook of what earlier sessions learned.

Plan and status: [plans/build-lab.md](../plans/build-lab.md). The design workflow Claude follows lives in the
poe-build-expert skill (`references/design-workflow.md`).

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

## Optimizers

[opt/opt.py](opt/opt.py) improves a build under rules, saves it (default `Downloads\<build>-<command>.xml`)
and prints a JSON report: before, after, the rules, every change.

```powershell
& $py build-lab\opt\opt.py gems BUILD.xml --main-skill X [--links 6] [--allow-awakened] [--allow-exceptional]
& $py build-lab\opt\opt.py tree BUILD.xml --main-skill X [--points N] [--allow-keystone-removal]
& $py build-lab\opt\opt.py tree-build BUILD.xml --main-skill X --class Marauder [--ascendancy Chieftain]
& $py build-lab\opt\opt.py gear BUILD.xml --main-skill X [--tier 2] [--replace-uniques] [--slots "Helmet,Boots"]
& $py build-lab\opt\opt.py jewels BUILD.xml --main-skill X [--tier 2]
& $py build-lab\opt\opt.py all BUILD.xml --main-skill X        # gems, tree, gear, jewels, gems, tree
& $py build-lab\opt\test-opt.py BUILD.xml::MAIN_SKILL [...] [--build-class Marauder --build-asc Chieftain]
```

| Optimizer | What it does |
|---|---|
| `gems` | Fills empty links, then tries every compatible support in each enabled support slot of the main group. Awakened and exceptional gems are off unless allowed; with `--budget` they're on when affordable |
| `tree` | Spends spare points, then swaps one refundable node for one addition (masteries with each effect) while the tree gets better. Keystones stay unless allowed |
| `tree-build` | Starts from the class start: ascendancy points first, then greedy paths by gain per point (up to 10 away), then the same swap search |
| `gear` | Re-crafts the explicit mods of each non-unique gear item (implicits, enchants, sockets and quality kept): PoB's affix pool, one tier (T2 default), mid rolls, 3 prefixes + 3 suffixes, one bench craft. Two rounds so resists settle where cheapest |
| `jewels` | Rare jewels for allocated sockets that are empty or hold a plain rare/magic jewel: Cobalt, Crimson and Viridian bases, 2 + 2 affixes |

**Rules** ([opt/objective.py](opt/objective.py)) are checked on every result:
- **Elemental resists:** fire, cold and lightning at 75%. An element is exempt only when all of its hits are
  taken as another type.
- **Chaos resist:** 0% or better.
- **EHP:** total EHP not below the loaded build's.
- **PoB's own warnings:** attribute requirements, unreserved life and mana, accuracy, and the main skill's cost.

**How results rank:**
1. Rules met at the start must stay met.
2. Rules broken at the start may not get worse, judged rule by rule. Fixing them earns nothing unless
   `--fix-start-breaks` is set; then a full fix outranks the metric.
3. Then the metric.

`tree-build` repairs every rule as far as it can, because a bare tree breaks most of them. Gear, jewel and tree
changes are checked with a real recalculation before they're kept. Uniques and relics stay unless
`--replace-uniques`.

## Market: prices, build cost, popularity

[market/market.py](market/market.py), plus `--budget` / `--trade-check` on the optimizers:

```powershell
& $py build-lab\market\market.py prices                               # league, divine price, examples
& $py build-lab\market\market.py cost BUILD.xml --main-skill X [--trade-check]
& $py build-lab\market\market.py popularity [--refresh]               # ascendancy, skill, unique shares
& $py build-lab\market\market.py novelty BUILD.xml --main-skill X
& $py build-lab\opt\opt.py all BUILD.xml --main-skill X --budget 10 --trade-check
& $py build-lab\market\test-market.py [BUILD.xml::MAIN_SKILL ...] [--offline]
```

| Piece | Source | Notes |
|---|---|---|
| Uniques, gems, currency | poe.ninja economy API (its documented public surface) | Cached 3 h with ETag revalidation. Uniques at their most-listed variant (with links for linked items); gems at the cheapest listing meeting level/quality, falling back to any quality, then corrupted |
| Crafted rares | [rarecost.py](market/rarecost.py) estimate, then the trade site | The estimate is a tier-based heuristic used during search. `--trade-check` prices the final picks: one search per item: same base, mods at 85%+ (all of them for 3 or fewer, else all but one, marked as a floor), median of the cheapest five; no price when under half the mods match a trade stat |
| Popularity | GGG's public ladder (top 3,000) and 80 public characters | poe.ninja's builds API is closed to third parties. Counts only, no names; cached a day; a refresh takes about 3 minutes within GGG's rate limits |
| Novelty | popularity | 1 − archetype share (ascendancy + main skill) ÷ 5%: 0 for an archetype 5%+ of the top ladder plays, 1 for one nobody plays |

**Budget rules:**
- **Support gems:** priced on poe.ninja. An Awakened or exceptional gem that poe.ninja doesn't list counts as
  unavailable in that league; most Awakened gems aren't in Covens. Any other unlisted gem is treated as a cheap
  vendor gem.
- **Crafted rares:** priced by the estimate.
- **Re-buying:** buying a slot again refunds the earlier purchase.
- **Owned items:** what the build already has costs nothing.
- **Awakened and exceptional gems:** with a budget they're allowed whenever affordable.

build-lab's requests (poe.ninja, GGG, poewiki, its own releases) send the User-Agent `lioneye-build-lab/0.1`,
with no contact. The vendored `pob/pob-headless.py` keeps the skill's `poe-build-expert/1.0` for PoB downloads
from GitHub, so it stays identical to the skill's copy.

## Concepts: a build from a short spec

[design/concept.py](design/concept.py) turns a concept into a finished build. A concept is a class, a skill, a
weapon, a defence type, optional uniques and gem groups, a budget and an EHP floor; the spec format is in its
docstring.

```powershell
& $py build-lab\design\concept.py new SPEC.json                         # skeleton only
& $py build-lab\design\concept.py complete SPEC.json --quick --budget 10 # screen: tree and supports (~1.5 min)
& $py build-lab\design\concept.py complete SPEC.json --budget 10 [--ehp-floor 15000] [--trade-check] --report R.json
& $py build-lab\design\test-design.py [--run]
```

**What `complete` does:**
1. **Skeleton:** builds the starting XML from the spec.
   - Gems come from the game database, transfigured gems included.
   - Each armour slot gets the base with the most defence of the spec's type, usable at the level.
   - Drop-only bases are left out.
   - One-handed weapons get a shield, bows a quiver.
   - Five plain flasks.
2. **Uniques:** equipped from PoB's own data.
3. **Budget:** a concept owns nothing, so the uniques and every starting gem are charged first.
4. **Tree:** grown from the class start without the resist rules, so points go to damage and life.
5. **Supports:** chosen for the main group, up to `links`.
6. **Gear:** crafted rares with base implicits on every other slot. This caps the resists.
7. **Jewels.**
8. **Again:** supports and tree once more.

**The report:**
- numbers, and the rules still broken;
- PoB's warnings;
- `cost` (market prices of uniques and gems) and `spend` (the budget ledger, with rare estimates);
- novelty;
- a PoB import code.

**Gem pricing:** an ordinary gem costs the cheaper of a max-level listing and a level 1 copy at the quality,
levelled by the player. A few price-fixed 20/20 listings could otherwise make a cheap gem cost divines.
Awakened and exceptional gems stay at listed prices.

**Supports never picked:** Cast when Stunned, Cast when Damage Taken and Cast on Death. PoB counts their
condition as always met (see the notebook's blind spots).

## Notebook

[notebook/notebook.py](notebook/notebook.py): what designing builds has taught, read before every new design.

```powershell
& $py build-lab\notebook\notebook.py search "minion crit" [--kind concept]
& $py build-lab\notebook\notebook.py add --kind interaction --title T --body B --evidence E [--tags a,b]
& $py build-lab\notebook\notebook.py add --json entries.json
& $py build-lab\notebook\notebook.py check ID --result holds|contradicted --evidence E
& $py build-lab\notebook\notebook.py recheck | import FILE | sync | index | sql "SELECT ..."
& $py build-lab\notebook\test-notebook.py
```

| Kind | Where | Holds |
|---|---|---|
| `concept`, `interaction`, `blind-spot` | `notebook/<kind>s.jsonl`, public | Tried builds with verdicts; interactions and blind spots with evidence |
| `check` | `notebook/checks.jsonl` (or local, for local entries) | A re-test: holds or contradicted |
| `preference`, `feedback` | `notebook/local/`, git-ignored | Andy's play preferences and how his builds felt |

**Each entry records:**
- the patch (the passive tree version);
- the PoB version;
- the league;
- the date.

**Weight:** 1 + held checks − 2 × contradicting checks, halved until it's confirmed on the current patch. Search
ranks by weight.

**Long lessons:** in markdown under `notebook/`, committed normally, with a short entry pointing to it.

**Writes never touch the working tree:**
- An entry is appended to the file as it is on `origin/main`.
- It's committed with git plumbing on a private index and pushed to `main`, retrying if `main` moved.
- So it doesn't matter what else is uncommitted in the clone. The clone's own `main` falls behind, so pull
  before your next push.
- Reads come from `origin/main` too, so an entry is searchable once it's pushed.

**Nothing is lost:**
- A batch is checked in full before anything is written.
- Public entries go into `local/pending.jsonl` first and leave it only once pushed. If GitHub can't be reached,
  or git fails or times out, they stay there for `sync`.
- Git never prompts for a login: it fails fast and the entry waits.
- A file on main that can't be read is never rewritten.
- Local files are written under a lock, because the CLI and the MCP server can write at once.

**Privacy:**
- A public entry may carry only its kind's fields. `build`, or anything else naming a character, is refused, as
  is a `refs` pointing at a private entry.
- An account name (`Name#1234`) or an email address anywhere in a public entry is refused.
- A check's id never repeats its entry's title.

**Without a clone** (a chat sandbox), search reads GitHub and public writes are refused. The chat hands entries
back as JSON lines for `import`.

`*.jsonl` merge with the union driver ([.gitattributes](../.gitattributes)), so concurrent appends keep both
sides. Notebook pushes trigger no workflow: none watch `build-lab/`.

### notebook-mcp: the notebook in Claude Desktop

[notebook-mcp/server.py](notebook-mcp/server.py) is a local MCP server (stdio, standard library only).

**Tools:**
- `notebook_search`
- `notebook_show`
- `notebook_add`
- `notebook_check`
- `notebook_recheck`
- `notebook_sync`

It runs on the PC with the PC's git login.

```powershell
.\build-lab\notebook-mcp\install-notebook-mcp.ps1          # add it to claude_desktop_config.json (backup in Downloads)
.\build-lab\notebook-mcp\install-notebook-mcp.ps1 -Remove
& $py build-lab\notebook-mcp\test-server.py
```

Restart Claude Desktop after installing.

## Chat sandboxes

[manifest.txt](manifest.txt) lists the engine files. The skill's `scripts/build-lab-fetch.py` downloads them
from raw.githubusercontent.com when there's no clone. After adding or removing build-lab files, run
`make-manifest.py`; `make-manifest.py --check` fails while it's stale.

## Benchmarks

```powershell
& $py build-lab\bench\bench-eval.py --pob-lib build-lab\pob\pob-headless.py BUILD.xml [...]
& $py build-lab\bench\bench-pool.py --pob-lib build-lab\pob\pob-headless.py --workers 1 4 8 12 BUILD.xml
```

## pob/pob-headless.py

The source of the poe-build-expert skill's `scripts/pob-headless.py`. The engine and its tests run this copy.
When the skill is repackaged, copy this file into it; don't edit the skill's copy.
