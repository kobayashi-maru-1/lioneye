# Build lab: Claude designs PoE 1 builds with real PoB numbers

Andy asks Claude (Claude Code or a claude.ai chat) to design a build. Claude asks about playstyle, budget and
defences, proposes concepts from a game database, completes them with optimizers that run headless Path of
Building, and returns 2–3 finished options with PoB codes, numbers, cost and blind spots.

Status: phases 1–2 built 2026-11-24; checkpoint with Andy before phase 3.

## Decisions

| Topic | Decision |
|---|---|
| Game | PoE 1 only (PoB Community) |
| Goal | Budget endgame builds: strong for a set currency budget |
| Where | Lioneye repo, `build-lab/` (Python, not part of the app) |
| Database | SQLite, one file per PoB release, built from PoB's own data so it can't disagree with the evaluator |
| Database releases | Built and published automatically, daily check: release `db-<PoB version>`, prerelease, `--latest=false` |
| Updater safety | Data releases never become `releases/latest` (prerelease + `db-` tag); the workflow fails if latest isn't `v*` |
| Prices and popularity | Not in the game database: fetched per session (poe.ninja), phase 5 |
| Skill | The design workflow becomes a reference in poe-build-expert; the engine stays here. The skill must still work with no Lioneye app running |
| Checkpoints | After phases 1–2, then per Andy |

## Phases

| # | Phase | Status |
|---|---|---|
| 1 | Benchmark eval speed; prove PoB's in-memory calculator works headless | Done |
| 2 | Game database: builder, checks, client, daily release workflow | Done (first release pending the workflow's first run) |
| 3 | Worker pool and eval API (full load, calculator deltas, in-memory gem changes) | Next |
| 4 | Optimizers: gem links, tree pathing, gear (synthesized rares), jewels | |
| 5 | poe.ninja prices and popularity; novelty score | |
| 6 | Design workflow in the skill: interview, concepts, checkpoints, report | |
| 7 | Back-test on known strong builds | |

## Phase 1 results (PoB 2.68.1, tree 3_30, this PC: 20 threads, 64 GB)

Three real 3.30 builds (two spectre builds, one EK ignite).

| Operation | Time |
|---|---|
| PoB start-up | 2.7 s |
| Full XML load + calc | 0.9–2.3 s |
| PoB's misc calculator: one node added/removed, or an item swapped | 4–18 ms (median 6–16) |
| Gem change in memory (no XML reload), one recalc | 125–250 ms |
| Worker memory | ~470 MB each (largest build) |

Calculator throughput (node-add passes, EK build): 1 worker 194/s, 4 → 653/s, 8 → 1,139/s, 12 → 1,517/s.

**Verified:**
- The calculator's base pass equals the full load exactly:
  - Damage: FullDPS on the spectre builds, CombinedDPS on EK (EK's FullDPS is 0).
  - Defence: Life and TotalEHP on all three builds.
- An item swap through the calculator equals a full reload with the same change:
  - Coven build: FullDPS 202,980,250 and TotalEHP 27,595 both ways. Checked by a one-off script, not in the repo.
  - EK build: CombinedDPS 2,344,907, Life 4,804, TotalEHP 30,798 both ways. Independent verifier check.

**What it means:**
- Tree and gear search use the calculator (`calcs.getMiscCalculator`: addNodes, removeNodes, repSlotName +
  repItem, toggleFlask, conditions).
- Gem changes use in-memory edits plus a recalc (5–8× faster than reloading XML).
- A greedy tree step over ~1,000 candidate nodes takes about 1 s on 8–12 workers.

## Phase 2 results

`build-lab/db`: `build-game-db.py` runs `extract.lua` inside headless PoB and writes SQLite.

| Content | Rows |
|---|---|
| Gems (incl. transfigured, Vaal) | 874 |
| Support → active compatibility (PoB's own rules) | 74,467 |
| Item bases | 1,271 |
| Affixes (rollable domains, bench crafts, veiled) | 15,889 |
| Uniques (current variants; legacy variants with "Pre x.y" in the name dropped) | 1,344 (1,339 matched to poewiki acquisition data) |
| Passive nodes / edges / mastery effects | 3,274 / 6,468 / 353 |
| Stat lines (all sources), with PoB's parse; wrapped lines joined as PoB does | 33,929 (2,569 PoB doesn't fully parse) |
| Interaction tags | ~33,000 over 53 tags |

Size: 44 MB, 6 MB gzipped. Build: about 25 s.

**Checked by `check-game-db.py`:** 24 checks, including no extraction losses, no legacy variants, and wrapped
passive lines joined.

**Fixed after verification and review (2026-11-24):**
- PoB source download. PoB's manifest hashes CRLF files but GitHub serves LF, so a fresh download failed its
  checksum. The vendored `pob-headless.py` now accepts either. **The skill's copy has the same bug.**
- Workflow:
  - A failing check now stops publishing (`pipefail`).
  - The write token only exists in a publish job that runs no downloaded code.
  - lupa is hash-pinned.
  - poewiki is required.
  - Drafts and missing assets are repaired.
  - The guard tells "no latest" apart from API errors.
- Data:
  - Legacy variants are matched anywhere in the variant name.
  - Passive and mastery lines come from PoB's own processing.
  - Affix lines are joined like PoB's item parser does.
  - The poewiki row choice is deterministic (item page, then current, then drop-enabled).
  - Gem levels have interpolation and split reservation.
  - Extraction losses are counted.
- Client: lock for parallel calls, builds into a temp folder, refuses a build for the wrong PoB version,
  atomic writes, survives a corrupt cache, works offline from the cache, and keeps two versions.

**Changed from the earlier plan:**
- RePoE isn't used. PoB already has the affix pools, tiers and spawn weights.
- poewiki supplies only unique acquisition data: drop enabled, drop restricted, removal version.

**First workflow run (2026-11-24):**
- poewiki answered GitHub's runners with 403. `--require-wiki` stopped the build and nothing was published.
  The guard confirmed `releases/latest` is still v0.4.75.
- Fix: the builder tries the live wiki, then falls back to the committed snapshot `build-lab/db/wiki-uniques.json`,
  and records which one it used in meta.
- The snapshot is refreshed from a PC (`--save-wiki-snapshot`) each league.

## Open checks

- **Wiki snapshot freshness.** New uniques get no acquisition data until the snapshot is refreshed.

- **Chat sandbox download.** Can a claude.ai chat download the release asset? GitHub redirects
  `releases/download` to `release-assets.githubusercontent.com`. If it's blocked, the fallback is a data-only
  branch served through `raw.githubusercontent.com`. Test: run `game-db.py path` in a chat.
- **Skill's pob-headless.py.** It has the CRLF checksum bug fixed here, so the skill's GitHub-source mode (chat
  sandbox) fails on a fresh cache. Fix the skill and re-upload it.
- **Spectre gem toggle.** On both spectre builds, Congregation off didn't change FullDPS. EK showed the toggle
  works in general. Check in phase 3 whether that's real or the toggle missing that gem.
- **pob-headless.py copies.** `build-lab/pob/pob-headless.py` is a copy of the skill's script. Phase 6 decides
  which copy is the source.
