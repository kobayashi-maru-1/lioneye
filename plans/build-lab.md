# Build lab: Claude designs PoE 1 builds with real PoB numbers

Andy asks Claude (Claude Code or a claude.ai chat) to design a build. Claude asks about playstyle, budget and
defences, proposes concepts from a game database, completes them with optimizers that run headless Path of
Building, and returns 2–3 finished options with PoB codes, numbers, cost and blind spots.

Status: phases 1–6 built 2026-11-24; phase 7 (back-test) next.

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
| 3 | Worker pool and eval API (full load, calculator deltas, in-memory gem changes) | Done |
| 4 | Optimizers: gem links, tree pathing, gear (synthesized rares), jewels | Done |
| 5 | poe.ninja prices and popularity; novelty score | Done |
| 6 | Design workflow in the skill: interview, concepts, checkpoints, report; the lab notebook (below) | Done |
| 7 | Back-test on known strong builds | Next |

## Lab notebook (phase 6): what the designer learns and remembers

Every run records what it found; later runs read it before searching. Decided with Andy 2026-11-24.

**What it holds:**
- tried concepts (numbers, cost, verdict);
- discovered interactions;
- PoB blind spots (e.g. generous trigger supports, jewel-socket probes);
- Andy's feedback after playing a build;
- Andy's preferences.

Every entry carries the patch, PoB version, evidence and date. Entries from an older patch are re-checked before
they're trusted. Findings that keep holding up gain weight in which concepts get proposed first; ones a patch or
a playthrough contradicts lose it.

**Storage, all in the Lioneye repo, no artifact:**
- `build-lab/notebook/`: JSONL per kind, plus markdown for longer lessons. This is the source of truth;
  SQLite is only a throwaway query index rebuilt from it.
- Findings and concepts are committed (public). Preferences and feedback on Andy's own characters go to a
  git-ignored local file on his PC.

**Writing:**
- Claude Code (VS Code or the Desktop app) writes directly.
- Claude Desktop chats write through a small local MCP server, `build-lab/notebook-mcp`, registered in Claude
  Desktop's config. Its tools read, add and sync (pull, commit, push). It uses the PC's existing git login for
  kobayashi-maru-1, so there's no token in the skill.
- Web and phone chats read from GitHub and hand back new entries for the next Desktop session to commit.
- Notebook entries commit and push automatically (no confirmation), like League page updates.

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

## Phase 3 results

`build-lab/eval`: `evaluator.py` (`Evaluator`, `EvalPool`), `eval-ops.lua`, the `eval.py` CLI, and `test-eval.py`.

**Speeds (independent verifier's measurements):**

| Operation | Time |
|---|---|
| Probes through PoB's calculator | 5 ms on EK, 14–16 ms on the spectre builds |
| In-memory changes, including the ~20 ms rollback snapshot | 130–270 ms |
| Support trials | 110–180 ms each |

**Equivalence tests (99/99 pass on 3 builds, none skipped):** every fast path gives the same numbers as editing
the XML and reloading it, and every tested change has to move a number. Covered:
- passive allocate, including path, and deallocate, including dependents;
- mastery with a chosen effect, and refusal of an effect already taken;
- item swap and flask on/off, matching the XML and surviving a save;
- gem disable and gem replace at an explicit level, plus support trials;
- config input;
- rollback after a bad op, a calc error, or a main-skill change;
- a 3-worker pool against a single process, for probes, apply and support trials.

**First tools on top, times on this PC with 12 workers including start-up:**

| Command | Work | Time |
|---|---|---|
| `node-power` | every reachable passive ranked by gain per point, ~1,500 | 7–11 s |
| `supports` | each support in the main group swapped for every compatible support | 16–34 s (610–855 trials) |

**Fixed after verification and review:**
- PoB calc errors were silently swallowed; `apply` wasn't atomic; the main skill could change unnoticed.
- Masteries applied every option at once; gem swaps lost the requested level.
- Flask active state wasn't saved; slots weren't validated.
- A dead worker left the pool out of sync.

**Found by the stronger tests:** the calculator doesn't match a real deallocation when the removed nodes include
a socket holding a jewel (cluster subgraphs). Such probes are now refused, and `apply` handles them exactly.

**Second review fixes:**
- A mastery effect already taken on the tree was accepted and inflated numbers; it's now refused, as in PoB.
- A calc error while choosing the main skill on load was swallowed.
- A failed rollback was silent; it now raises `BuildLost`, which breaks the pool.
- Mixed results across workers now break the pool, and so does use after close.
- Numeric fields are validated, and PoB's error text is trimmed.

Compatibility comes from PoB's own check against the live main skill, not the database.

**Resolved:** spectre Congregation toggle. Disabling it in memory equals disabling it in the XML. PoB's own
answer is that Congregation doesn't change those builds' FullDPS.

**Not done:** a persistent local server, so separate tool calls don't each pay ~5 s of worker start-up. Phase 4
optimizers run in one process, so they don't need it. Revisit if interactive what-ifs feel slow.

## Phase 4 results

`build-lab/opt`: objective.py (rules), gems.py, tree.py, gear.py (gear and jewels), the `opt.py` CLI and
`test-opt.py`.

**Decisions (Andy, 2026-11-24):**
- **Tree:** improve existing trees and grow trees from a class start.
- **Default rules:** capped resists, chaos at 0% or better, requirements and mana met, EHP not below the start.
- **Crafted rares:** real affixes, tiers T1–T3, 3 prefixes and 3 suffixes including one bench craft, mid rolls.

**Rules as built:**
- **Resists:** an element is exempt only when all its hits are taken as another type. This is what makes
  Coven's "cold and lightning taken as fire" build pass.
- **PoB's warnings:** they count as hard rules. The main skill's cost is checked the same way for probes and
  the main calc.
- **Rules broken at the start:** they may not get worse, rule by rule, and fixing them earns nothing unless
  `--fix-start-breaks` is set.
- **`tree-build`:** repairs every rule as far as it can.

**Results on three builds (the metric's change; no rule made worse, EHP kept):**

| Build | gems | tree | gear | jewels |
|---|---|---|---|---|
| EK (CombinedDPS) | +19% | +56% | +15% | +19% |
| Wretched Defiler (FullDPS) | +40% | +4% | +6% | +4% |
| Coven (FullDPS) | +138% | +23% | +22% | +1% |

**Growing EK's tree from the Marauder start (Chieftain):**
- 7.05M CombinedDPS, against 3.13M for SpicySushi's hand-made tree.
- EHP 32.9k, at or above the original's 32.2k.
- No rule broken, 123/8 points, about 110 s.

**Checks:**
- `test-opt.py`: 45/45 on three builds, none skipped. That's 12 rule unit tests, plus never-worse, saved-XML
  fidelity, budgets and the no-pricey-gems check per optimizer.
- `test-eval.py` still passes.

**Fixed after verification and review:**
- **Resist rule:** the first version passed an element when the enemy dealt none of that damage, or when armour
  or suppression cut the hits.
- **Rules broken at the start:** a full fix used to outrank any DPS loss (EK's gems lost 20% to fix mana).
  This is now opt-in, and broken rules can no longer trade against each other.
- **Swap search:** the conflict check never fired, so some probes counted floating paths.
- **Jewels:** nearly every socket was skipped.
- **Gear:**
  - changes weren't verified with a real recalc;
  - made-up items dropped implicits, sockets and quality;
  - relic uniques weren't protected.
- **Tree-build:** it ignored the build's own point budget.

**Known limits:**
- **Recovery:** PoB's EHP doesn't count recovery such as leech and regen. Keystones are kept by default for
  that reason, but small recovery nodes can still be traded away.
- **Trigger supports:** "Cast when Stunned" and the like may be modelled generously by PoB.
- **Gear bases:** gear keeps each slot's base, and influenced or eldritch affixes aren't in the pool.
- **Prices:** none yet (phase 5), so "good crafted" is a tier choice, not a budget.

## Phase 5 results

`build-lab/market`: net.py, ninja.py, rarecost.py, trade.py, budget.py, buildcost.py, popularity.py, the
`market.py` CLI and `test-market.py`. The optimizers gain `--budget`, `--trade-check` and a novelty score in
their report.

**Decisions (Andy, 2026-11-24):**
- **Popularity:** GGG's public ladder plus a small daily sample of public characters, because poe.ninja's
  builds API is closed to third parties.
- **Rare prices:** a tier-based estimate during search, then trade checks for the final picks.
- **poe.ninja:** fetched directly with a local cache.
- **User-Agent:** `lioneye-build-lab/0.1`, no contact. The poewiki fetch was changed to match.

**What it found on the live league (Covens):**
- **Prices:** a divine is 181 chaos. Mageblood (4 flasks) is 240 divine, Headhunter 260, Spell Echo 20/20 0.48.
- **Awakened gems:** most aren't in the Covens economy; only Empower, Enhance and Enlighten are listed. An
  unlisted Awakened or exceptional gem counts as unavailable, not cheap.
- **Build costs (known items only):** EK 782 divine, Coven 75. Coven's Mageblood is saved as a rare in its PoB
  file, so it isn't priced.
- **Popularity:** 3,000 ladder characters and 75 public samples, read in about 3 minutes. Elementalist leads,
  and EK is the most common main skill. Novelty: Necromancer spectres 0.97, Chieftain EK 0.73.
- **Budget runs:**

  | Build | Gems with 1 divine | Gear with 3 divine |
  |---|---|---|
  | EK | +19% for 0.92 | +15% for 0.98 |
  | Defiler | +40% for 0.31 | nothing affordable helped |
  | Coven | +138% for 0.50 | +2% for 2.82 |

  Never worse on any of them; every purchase is in the ledger.
- **Trade checks:** they came in well under the first estimate table (wand 0.16 vs 0.83, belt 0.07 vs 0.37,
  boots 0.05 vs 1.9). The table was cut to about a third, still above those prices. Re-check it each league.

**Fixed after review:**
- **GGG throttle:** it could have earned 30–60 minute trade bans. It now reads every listed rule, honours
  restricted states, waits out whole windows with a margin of two, and stops instead of sleeping past 5 minutes.
- **`cost --trade-check`:**
  - local armour and weapon mods matched global stats;
  - searches fell back silently;
  - items with no matched mods got a base-item price.
- **Pricing:**
  - foil uniques were never priced;
  - unique shares in novelty were always 0 ("Name, Base" titles).
- **Other fixes:**
  - leagues with spaces crashed;
  - the main-skill guess counted aura and warcry setups;
  - one character's error lost a whole refresh;
  - unlisted gems were dropped silently;
  - item-granted skills were priced;
  - too many trade searches ran per item;
  - refunds drifted with rounding.

**Known limits:**
- The rare-cost estimate is a heuristic.
- Unique prices use the most-listed variant, not the item's own roll.
- The popularity sample is 75–80 characters, so small shares are noisy.
- Novelty covers the archetype (ascendancy plus main skill), not item or tree choices.

## Phase 6 results

**Built:**
- `build-lab/design/concept.py`: a short spec becomes a finished build (skeleton, uniques, tree, supports,
  crafted rares, jewels), with numbers, cost, novelty and a PoB code. `test-design.py`.
- `build-lab/notebook/notebook.py`: the lab notebook (JSONL in the repo, private kinds in a git-ignored folder,
  weights from checks, SQLite index). `test-notebook.py` runs against a throwaway remote.
- `build-lab/notebook-mcp/`: the notebook as a local MCP server for Claude Desktop, with an install script.
  `test-server.py`.
- `build-lab/manifest.txt` and `make-manifest.py`: the files a chat sandbox downloads.
- The skill (new zip): `references/design-workflow.md` (notebook, interview, concepts from the game database,
  screening, checkpoint, finishing, report, recording) and `scripts/build-lab-fetch.py`.
- The notebook starts with six blind spots from phases 3–6, each with its evidence.

**Decisions:**
- **Notebook writes:** git plumbing straight onto `origin/main`, so a push never touches the clone's working tree
  or branch, whatever else is uncommitted there.
- **pob-headless.py:** the repo copy is the source; the skill gets a copy when it's repackaged.
- **Chat sandboxes:** they download the engine from raw.githubusercontent.com using the manifest.

**Found while testing, and fixed:**
- **Price-fixed gem listings:** Fireball 20/20 was priced at 11.4 divine from three price-fixed listings.
  Ordinary gems now cost the cheaper of a max-level listing and a level 1 copy levelled by the player.
- **Trigger supports:** PoB counts Cast when Stunned as firing at its cooldown (no stun rate), so the gem
  optimizer chose it over Spell Echo. It now never picks Cast when Stunned, Cast when Damage Taken or Cast on
  Death.
- **Tree points on resists:** a tree grown under the resist rules spent its points on resists. Cyclone screened
  at 121k DPS that way, 513k without. The tree now grows without those rules, and gear caps resists.
- **Drop-only bases:** the base picker chose level-84 drop-only bases; it now skips them.
- **Budget:** starting gems are now charged too, since a concept owns nothing.

**Fixed after review:**
- **Notebook data loss:**
  - A failed read of a notebook file on main could have pushed a rewritten file holding only the new lines.
  - Git failures other than "offline" (a timeout, a missing `origin/main`, a temp-file error) dropped public
    entries.
  - `sync` could delete an entry queued while it pushed.
  - Public entries now go to the queue before the push and leave it only once pushed.
  - Git runs without prompts.
  - Local files are written under a lock.
- **Notebook privacy:** public entries could carry any field (a character name in `build`) and point at
  private entries. Now each public kind has a fixed field list, refs must be public, and check ids no longer
  repeat a private entry's title.
- **Chat fetch:** run from the repo root, it would have deleted the clone's `build-lab`. It now refuses folders
  inside a git clone and folders it didn't make, and swaps the new copy in with renames.
- **Manifest:** it listed untracked files, which GitHub wouldn't have. It now lists tracked files only.
- **Self-levelled gem prices:** ignored the listing minimum and treated a missing price as free.
- **Concepts:**
  - `--xml --budget` charged a loaded build for gems it owns.
  - A unique or item-text weapon got no default shield.
  - A `"none"` flask crashed.
- **MCP server:** it now negotiates the protocol version, and bad argument types come back as tool errors.

**Concept runs (Covens, PoB 2.68.1, level 95, 10 divine):**

| Concept | Mode | DPS | EHP | Spent |
|---|---|---|---|---|
| Fireball Elementalist | full | 1.05M | 7.1k | 9.28 |
| Fireball Elementalist, EHP floor 15k | full | 1.29M | 15.9k | 10.00 |
| Cyclone Slayer, EHP floor 15k | full | 2.75M | 15.2k | 9.99 |
| Absolution Necromancer | quick | 239k | 7.7k | 3.24 |

**Timing:** a full run takes 1.5–2.5 minutes, a quick screen about 1.5.

**Results:**
- Resists were capped and no rule was broken in the full runs.
- The Fireball runs bought Spell Echo, Invert the Rules, Arcane Surge and Controlled Destruction.
- The run with the floor ended with more damage than the one without. The search is greedy, so its result
  depends on the path it takes. Phase 7 should run several orders or seeds before trusting one result.

**Known limits:**
- No anoint optimizer: PoB warns about the empty amulet anoint.
- Flasks are plain bases.
- The concept spec has no cluster jewels, spectres or minion choices.
- Interview answers map to an EHP floor by hand.

## Open checks

- **Wiki snapshot freshness.** New uniques get no acquisition data until the snapshot is refreshed.

- **Chat sandbox download.** Can a claude.ai chat download the release asset? GitHub redirects
  `releases/download` to `release-assets.githubusercontent.com`. If it's blocked, the fallback is a data-only
  branch served through `raw.githubusercontent.com`. Test: run `game-db.py path` in a chat.
- **Claude Desktop notebook tools.** Run `install-notebook-mcp.ps1`, restart Desktop, and check a chat lists
  the `notebook_*` tools and that a search answers.
- **Chat fetch.** In a claude.ai chat, run `scripts/build-lab-fetch.py`, then `concept.py new` on a spec.
