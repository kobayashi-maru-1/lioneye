# Atlas planner (PoE 1, 3.30): standalone web app, later Lioneye's Atlas tab

A planner for Atlas passives, for planning and sharing only (no in-game progress). It is
built as a standalone page on the Lioneye GitHub Pages site, tested there, and is now
the default (**New**) in Lioneye's **Atlas** tab, with poeatlasplanner.com kept as **Old**. It behaves like
poeatlasplanner.com but is drawn in a colour-coded "lite" style only.

Status: plan, revised 2026-11-14 after review. Facts marked **Verified** were checked on
2026-11-14 against GGG's 3.30.0 export or the live site; **Check** items are confirmed
during the build.

## 1. Decisions

| Topic | Decision |
|---|---|
| Where | Lioneye repo, published next to the League page: `kobayashi-maru-1.github.io/lioneye/atlas/` |
| What | Planning and sharing only; no game-log progress |
| Storage | The browser's local storage, like poeatlasplanner.com; no accounts or server |
| Sharing | A link to the page with the plan in the URL fragment; anyone can open it |
| Tests | Node's built-in test runner (`node:test`); no new dependency |
| In Lioneye | The Atlas tab frames this page as **New** (default), poeatlasplanner.com as **Old** |

## 2. Hard rules

1. **No game art.** No GGG sprite sheets, node icons, frames, backgrounds or mastery art
   anywhere (tree, panel, tooltips, bonuses). Coloured circles, letters and text only.
2. **Lite style only.** No "official icons" toggle.
3. **Don't copy poeatlasplanner.com.** Its code, text, guides and preset trees are its
   own. Reading its public share-link format to import links is fine.
4. **Fit the repo.** Reuse Lioneye's tree pipeline and code (section 4). No new
   dependency unless nothing in the repo fits.
5. **UI copy:** the project's UI copy rules: buttons 1–2 words, labels not sentences, no
   explanatory paragraphs. A subagent lists every visible string before it ships.
6. **File names use hyphens.**
7. **Headless tests never touch the live exe.** Test the built static files (or a server
   with no `/api` or `/ws` proxy). Never the Vite preview on 4173.

## 3. Data

- Source: `github.com/grindinggear/atlastree-export`, `data.json` at the 3.30.0 commit,
  **pinned by commit SHA** (the `3.30.0` tag is a pre-release and could move), the same way
  `seeding/src/build-tree/index.ts` pins `skilltree-export`.
- Ignore `assets/`, the `sprites` block and the `ruthless` files.
- Add `seed atlas` to the seeding workspace (next to `seed tree`). It writes one slim file,
  `common/data/atlas/3_30.json`, gitignored and rebuilt in CI like the passive tree data.
  The file records its source (`"version": "3.30.0"`, export SHA). The browser does no
  geometry or grouping.

### Shape of `data.json` (Verified)

| Key | Content |
|---|---|
| `nodes` | 1,117 entries keyed by node id, plus `root` |
| `groups` | 309 entries: `x`, `y`, `orbits`, `nodes`, optional `background` |
| `constants.skillsPerOrbit` | `[1, 6, 16, 16, 40, 72, 72]` |
| `constants.orbitRadii` | `[0, 82, 162, 335, 493, 662, 846]` |
| `points.totalPoints` | `150` |

Node fields: `skill`, `name`, `stats[]`, `group`, `orbit`, `orbitIndex`, `in[]`, `out[]`,
optional `isNotable` (213), `isKeystone` (18), `isMastery` (149), `isWormhole` (4),
`reminderText[]`, `flavourText[]`, `isMultipleChoiceVariant` + `variantEffects[]` (31),
`connections[]` (36 entries across 35 nodes).

### Node kinds (Verified)

| Kind | Count | Treatment |
|---|---|---|
| Start, id `29045` | 1 | Always allocated, costs 0, never refundable; drop `root` |
| Mastery | 149 | Not allocatable, no edges; names its group's mechanic, places the cluster label |
| Small passive | 735 | Allocatable (includes the 4 gateways) |
| Notable | 213 | Allocatable; 31 are choice nodes |
| Keystone | 18 | Allocatable |

966 allocatable, all reachable from the start (the plan first said 967 and 736 small: those counted the start).

### Geometry (Verified)

Positions use the same orbit math as the passive tree (the 16- and 40-slot angle tables
are the same), already in `seeding/src/build-tree/tree.ts`: reuse it.
Test values: node `31` → (−2758.59, −4383.38); `121` → (6374.21, −9414.46);
`1733` → (−1829.61, −11556.78); start `29045` → (42.53, −6724.81). Orbits used: 0, 2–5.

### Edges (Verified)

- One undirected edge per `out` entry, skipping `root`: **1,050**.
- Gateways `17000 ↔ 13842` (Mortal) and `2017 ↔ 54197` (Cryptic) are ordinary edges:
  kept for routing, **not drawn** → **1,048** drawn.
- 551 same-group, same-orbit edges are arcs (shorter way round); the 36 `connections`
  edges are arcs around (`orbitX`, `orbitY`). Reuse the passive tree's arc handling
  (`Connection.s` sweeps); straight lines are an acceptable fallback.

### Mechanics (Verified)

A node's mechanic is the name of the mastery in its group; groups without one are
**travel** nodes (173, plus the start; a notable or keystone in its own group that hangs off one cluster is shown as part of it). **38 mechanics**, with counts: Mercenaries 40, Strongboxes 39,
Ultimatum 36, Breach 35, Essence 34, Ritual 34, Settlers of Kalguur 34, Rogue Exiles 34,
Blight 33, Maps 33, Sacred Flora 33, Abyss 33, Expedition 31, Shrines 30, Legion 29,
Incursion 28, Torment 27, Bestiary 26, Threads 25, Betrayal 24, The Eater of Worlds 17,
Atlas Memories 14, Rare Monsters 11, Unique Monsters 11, Atlas Anomalies 10,
Divination Cards 10, Beyond 8, Magic Monsters 8, Mirage 8, Delirium 8,
Viridian Wildwood 8, Sentinels 8, Gold 7, The Searing Exarch 6, Conquerors 6,
Synthesis 6, The Shaper and Elder 5, Labyrinth 4.

Four headings (ours, one config file):
- **Maps:** Atlas Anomalies, Atlas Memories, Divination Cards, Gold, Labyrinth,
  Magic Monsters, Maps, Rare Monsters, Threads, Unique Monsters
- **League:** Abyss, Bestiary, Betrayal, Blight, Breach, Expedition, Incursion, Legion,
  Ritual, Ultimatum
- **Extra:** Beyond, Delirium, Essence, Mercenaries, Mirage, Rogue Exiles, Sacred Flora,
  Sentinels, Settlers of Kalguur, Shrines, Strongboxes, Synthesis, Torment,
  Viridian Wildwood
- **Bosses:** Conquerors, The Eater of Worlds, The Searing Exarch, The Shaper and Elder

### Choice nodes (Verified)

31 notables with `isMultipleChoiceVariant`, empty `stats`, and 2–7 `variantEffects`
(`{effect, stats}`); exactly one is picked. Example: `45404` "Secrets Unveiled" →
`55878`, `5301`.

## 4. App

- A Vite build of its own (a workspace in the repo), sharing `common/` (types, tree
  helpers, link decoding) with Lioneye. Stack per the build decision (section 10).
- The **Strats page** workflow builds it and publishes it at `/lioneye/atlas/` next to
  `strats/`. A change to the planner or its data publishes on push, like the League page.
- Reuse from Lioneye: tree layout math (seeding), SVG approach and pan/zoom ideas
  (`web/src/state/tree/svg.ts`, `components/Viewport`), passive-tree link decoding
  (`web/src/state/tree/url-tree.ts`: atlas links use the same format).

## 5. Rendering

- One SVG; 967 nodes and 1,048 paths are fine without canvas.
- Layers: cluster discs, edges, cluster labels, click targets, nodes, start marker.
- Sizes in tree units (`web/src/atlas/lib/geometry.ts`): small dot 42; notable dot 54 with
  a ring at 70; keystone dot 73 with a ring at 95; label disc 80. They fit the layout
  (closest small pair 87 apart, notable–notable 162, passives 162 from their label), and a
  unit test checks no dot, ring or unset ring meets another or a label (the search halo
  on a small node may touch a neighbour). Each node has a transparent click target of at
  least 60 under the dots. `vector-effect: non-scaling-stroke`.
- **Colour:** by mechanic, travel nodes grey. Colour is never the only signal: the cluster
  label and tooltip name the mechanic. Only neighbouring clusters need to differ; hue by
  heading with lightness varied inside it is the fallback if 38 colours blur.
- **Cluster label:** a disc with the mechanic's first letter (two where neighbours clash)
  at the mastery's position; a button that toggles that mechanic's highlight.
- **States:** idle (fill ≈ 30%), allocated (≈ 90%, bright outline and edges), route
  preview (lighter outline, dashed edges), refund preview (red), search match (halo),
  mechanic highlight (others dim), gateway hover (rings both ends).
- Pan by drag, zoom by wheel and pinch; **Zoom in**, **Zoom out**, **Fit** (whole tree),
  **Focus** (fit to allocated; not "Route", which means the campaign in Lioneye).

## 6. Behaviour

### State

`{ allocated: string[], choices: { [nodeId]: effectId }, budget: number }` (budget
default 150; the start node is implicit). Undo and redo stacks of whole states.

### Allocate

- Hover an unallocated node: tooltip (name, kind, stats, reminder text, cost "+N") and a
  route preview.
- **Route:** breadth-first search from {start + allocated} through unallocated nodes to the
  target; cost = unallocated nodes on the path, target included. **Ties break by lowest
  node id at each step**, so results are stable. Tests: on an empty tree `45404` costs
  **13**; the furthest node costs **21**.
- Click allocates the path as one undo step. A choice node opens a small picker first;
  clicking an allocated choice node reopens it (change or refund).
- Over budget: show the cost, mark it, block the click.

### Refund

Hover an allocated node: preview it plus every allocated node that would lose its link to
the start. Click removes that set (and their choices) as one undo step.

### Points bar

`used / budget`; budget editable 1–150. **Undo**, **Redo**, **Clear**. Clicking the start
marker asks **Clear tree?** first (review round 3, 2026-11-15); a tap on it does nothing.

**Recalc** (2026-11-15) rejoins the plan by the fewest points: it keeps every allocated
cluster node, notable, keystone and choice node (with its pick) and treats small pathing
nodes as free to drop or swap (their bonuses don't count). It's a Steiner tree search
(`lib/recalc.ts`): joins built from the start several ways (seeded, so the same plan always
gives the same result), each improved by tearing out stretches of pathing and joining
again; the cheapest wins, ties going to the fewest nodes taken from clusters the plan
didn't use (a later Recalc would keep those), then the fewest changes. It can route
through nodes of unused clusters, as a click's route does. It never returns more points
than the plan has, matches an exact search on small plans (tests), and takes about 0.2 s
on a 140-point plan. One undo step; the message says **Freed N points** or **Already
shortest**.

The toolbar stays on one row (review round 3): narrower than 820px, Undo and Redo become
arrows and Clear, Recalc, Share and Open move to a **More** menu; narrower than 540px (phones),
Undo and Redo move to More too. On phones the panel opens with **Panel**. A tap on a node
opens its card (details, cost, **Allocate**); a mouse click allocates at once, as the
tooltip already showed the cost.

### Panel tabs

1. **Explore:** search (names and stat text; halo on matches; list with a locate action)
   and the mechanic list under the four headings (swatch + letter, name, cluster count;
   hover highlights, click pins, **Clear**).
2. **Bonuses:** `used / budget`; combined effects grouped by heading then mechanic, with
   node counts; keystones by name; a picked choice once, as `<node>: <effect>` under its
   mechanic; allocated choice nodes with no pick first, under **Unset** (click to pick);
   travel nodes' lines under the mechanic they name, else **Other**
   (review round 1, 2026-11-15); gateways add no line ("Connects to …", round 3); identical lines summed (eight "2%
   increased Maps found in your Maps" → one "16% …"); a line with one percentage among
   other numbers sums that percentage; other lines with no or several numbers are listed
   once with a count; clicking a line highlights its nodes.
3. **Saved:** named plans: load (undoable), rename, delete; the open one marked. No
   bundled presets.

### Storage, sharing and links

- **Draft:** saved to local storage on every change, restored on load. Keys prefixed
  `lioneye-atlas-` (the League page shares the `kobayashi-maru-1.github.io` storage).
  All storage access in try/catch.
- **Save** (start of the toolbar, review round 2, 2026-11-15): a new plan has a name box
  and Save adds it to Saved (with no name typed: the first free "Plan <n>"). A loaded or saved plan shows its name as gold text with a dot
  when it differs from the save; Save (off when unchanged) updates that save. Clicking
  the name edits it in place: Enter or Save stores a copy under a new name and stays on
  it (Save as), or with the same name saves over it; Escape or leaving the box keeps the
  original. Clear stays on the save; Open, a link and deleting the save start a new
  plan. Each undo step remembers its save, so undoing a Load or an opened link goes back
  to the save that was open. The open save's id is kept (`lioneye-atlas-current`) so a
  reload stays on it. Opening a link over an unchanged save makes no Draft copy.
- **Export / Import:** all saved plans as one JSON file, so plans can move between
  browsers and into Lioneye's frame (which gets its own storage).
- **Share:** `…/lioneye/atlas/#t=<base64url>` of
  `[formatVersion, treeVersion, budget, allocatedIds, [[nodeId, effectId], …]]`, in a
  small dialog with **Copy**.
- **Open:** paste a link. Accepted:
  - our share links;
  - poeatlasplanner.com links (`#p=` base64url JSON
    `[schema, "3.30.0", "3.30.0-r1", budget, [nodeIds], [[node, effect], …]]`), so trees from
    poeatlasplanner (its Share tree is its only way out: no file export) and old League
    page links keep working;
  - official links `https://www.pathofexile.com/fullscreen-atlas-skill-tree/<base64url>`
    (u32 version 6, class, ascendancy, node count, u16 ids, then two count bytes).
    **Check:** the trailing section may hold choices as (effect, node) pairs like passive
    masteries; test with a link made with a choice picked before relying on it.

  Anything else gets a one-line error. Unknown ids are dropped, then the refund rule runs,
  so the result is always a connected tree.
- A link opened with `#t=`/`#p=` loads that plan; the draft is kept and **Undo** returns
  to it.

## 7. Narrow windows

Lioneye's window and phones: the tree fills the page; the panel opens over it with a close
control; tooltips become a bottom card with **Allocate** / **Refund**.

## 8. Into Lioneye (done 2026-11-16)

- The Atlas tab has a bar with **New** (this page, the default) and **Old**
  (poeatlasplanner.com, loaded the first time it's picked), both live in frames
  (`web/src/containers/Atlas`, `web/src/state/atlas.ts`). Switching keeps each as it was
  while on the tab; each visit starts on New.
- League page tree links open in New: our `#t=` links and poeatlasplanner `#p=` links,
  carried over as the fragment only, onto New's address.
- The League page's Atlas trees cards use our `#t=` links, with points and top three
  mechanics.
- Trees saved in poeatlasplanner don't move over automatically (its storage is its own
  site's): Share tree in Old, then Open in New and Save, one at a time.

## 9. Order of work

1. `seed atlas` + slim data file; tests for the counts and four positions.
2. Static tree: nodes, edges, colours, labels, pan/zoom; published at `/lioneye/atlas/`.
3. Graph functions with tests (route, refund, normalise, bonuses); allocate, refund,
   choices, budget, undo/redo.
4. Explore tab.
5. Bonuses tab.
6. Draft, Saved, Export/Import, Share, Open (all three link kinds).
7. Narrow layout.
8. Verification (section 11), then a test round with the maintainer.

## 10. Build decisions (2026-11-14)

- **Stack:** React + Vite, like Lioneye; no new dependencies. As built, plan state is a
  `useReducer` history (whole plans, so Undo restores choices exactly) rather than jotai,
  and pan/zoom and link decoding are written for the atlas rather than shared with the
  passive tree's `Viewport` and `url-tree.ts`.
- **Version 1:** the tree (allocate, refund, choices, budget, undo/redo) plus Share/Open
  (all three link kinds), Saved (draft, named plans, Export/Import), Explore and Bonuses.
- **Look:** the Lioneye app's (its colours, fonts, panels and buttons).
- **Testing:** live at `/lioneye/atlas/`, not linked from the League page yet.

## 11. Acceptance checks

Data and geometry: 1,117 nodes; 966 allocatable; 149 mastery; 1 start; 1,050 graph edges;
1,048 drawn; 38 mechanics; 173 travel nodes; per-mechanic counts match; four positions
within 0.01.

Behaviour: `45404` costs 13 on an empty tree and stores its choice; nothing costs over 21;
all 966 reachable; a far-side node routes through a taken gateway when cheaper; refunding
mid-route never leaves the tree disconnected; budget 50 blocks a route to 51; Undo/Redo
restore exact states with choices; our share link round-trips nodes, choices and budget;
the sample official link
`https://www.pathofexile.com/fullscreen-atlas-skill-tree/AAAABgAAEQmdLrszg0GMW9lqJH0dkX2xXLH7xgzJqtdN4cHuzPJN-toAAA==`
decodes to `2461, 11963, 13187, 16780, 23513, 27172, 32029, 37245, 45404, 45563, 50700,
51626, 55117, 57793, 61132, 62029, 64218` and re-encodes the same; the League page's three
former poeatlasplanner links (now a test fixture) open with their point counts
(64, 150, 109); reload restores the
draft; Export then Import restores Saved.

Rules: no image requests to GGG, no `<image>` in the SVG, nothing from the export's
`assets/` in the repo; every visible string passes the UI copy check.

Method: a verifier subagent checks the build against this plan, a separate reviewer
reviews the code, and a browser run (static files only, rule 7) walks the checks.

## 12. Attribution

One line on the page: tree data from Grinding Gear Games' official export; fan-made, not
affiliated with or endorsed by GGG.
