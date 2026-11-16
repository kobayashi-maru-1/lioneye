# Lioneye

One Windows program, `lioneye.exe` (called Exile Leveling and `exile-leveling.exe` up to
v0.3.0), that runs the leveling guide and the
auto-progress log watcher together. It serves the guide at
http://127.0.0.1:6754 and opens it in a borderless Edge app window (Edge is part of every
Windows 10 and 11 PC, whichever browser you use).

## Run

1. Start `lioneye.exe`. It runs in the tray (by the clock), with no console window.
   Closing the guide window leaves it running there. Click the icon or pick **Open** to bring
   the window back (or reopen it); pick **Quit** to close the window and stop.
   The icon's tooltip shows **Waiting** or **Auto**.
   The log is at `%LOCALAPPDATA%\exile-leveling\exile-leveling.log`. Started from a terminal,
   it also prints there; the prompt returns right away, and Ctrl+C in that terminal quits it.
2. The guide opens in its own Edge profile (`%LOCALAPPDATA%\exile-leveling\browser`), apart
   from the profiles you browse with. Drag it to the monitor you want: the exe notes where it
   is (`%LOCALAPPDATA%\exile-leveling\guide-window.json`) and reopens it there, at that size
   (Edge saves an app window's place but doesn't put it back). After an update the open
   window reloads itself when the new exe starts.
3. Start Path of Exile. The pill at the top right of the panel turns green (**Auto**)
   once the game's log is found, and the route advances as you change zones.

Running the exe again while it's already open brings its window to the front.

**Settings** → **App** → **Game** → **Game log** and **Browser** set the same as `--log-path`
and `--browser`,
saved in `%LOCALAPPDATA%\exile-leveling\settings.json`; the command line wins when given.
A new game log applies at once; a new browser when the guide next opens. Whichever browser
opens it, the guide loads the exe's copy of your data (below) when another browser saved it
since, so switching never brings back old progress.

The thin line at the bottom shows the app's version, the bundled Path of Building's, and
the date of the exile-leveling route data merged in, with **Update** when GitHub has a
newer release (checked on start, every 6 hours, and when you come back to the window, at
most once an hour). The ↻ beside the version checks now (at most once a minute; 5 s after a failed check) and shows
**Up to date**, or **Not checked. Retry.** when GitHub can't be reached, for a few seconds.
**Update** opens the release's page; the download icon beside it, or **Update** in the tray
menu, installs it: the exe downloads `lioneye.zip`, checks it against GitHub's SHA-256 and
the release key's signature (below), renames itself to `lioneye.exe.old`, puts the new exe
in its place and starts it (the new copy deletes the `.old` file). The open guide window
reloads; your data carries over. If it fails, the icon's tooltip says why and clicking it tries again; the exe log has the
details. The exe's folder must be writable (the `Lioneye` folder in Downloads is). If the
new exe doesn't start within a minute, the old one is put back. Should `lioneye.exe` ever
be missing after an update, rename `lioneye.exe.old` back to it.

Only a release signed with the release key is offered: `lioneye.zip.minisig`, signed on the
publisher's PC (Releases, below). The exe has the public key built in
(`log-api\release-key.pub`) and checks that the signature covers that zip and names that
release's tag. The secret key never reaches GitHub, so someone who took over the GitHub
account still couldn't ship an update. Copies older than 0.4.37 don't check signatures
yet; they do once they've updated to it.

| Option | Default | What it does |
| --- | --- | --- |
| `--browser app\|edge\|default\|none` | Settings, else `app` | How to open the guide: an Edge app window in the guide's own profile (`app`); an Edge app window in your last-used Edge profile, as before 0.3 (`edge`); a normal tab in your default browser (`default`); nothing (`none`) |
| `--log-path <file>` | Settings, else found from the game | Use this `Client.txt` / `LatestClient.txt` |
| `--address <ip:port>` | `127.0.0.1:6754` | Where to serve. Keep the port the same: progress is saved per address |
| `--heart-beat <secs>` | `1` | How often the log is read |

Progress, your imported build and layout are saved in the guide's window, and the exe keeps
a copy in `%LOCALAPPDATA%\exile-leveling\state.json`: a new or reset guide profile picks up
from it. The first start after updating from 0.2 or earlier moves them from the Edge or
Chrome profiles that hold the guide's data: the guide opens briefly in each, and the most
recently used one with an imported build is kept (else the most recent with any data). Each
profile's data is also kept in `%LOCALAPPDATA%\exile-leveling\moved`, and is never removed
from the profile. Builds imported on the hosted site don't carry over, so import your PoB
once in **Settings** (the ⚙ in the top bar, after the panel buttons).

## Your build

In ⚙ **Settings → Build**, under the code box, **Load** brings a build in and **Loaded**
acts on the one you have:

- **Import code** (Load): paste a PoB code or a pobb.in, poe.ninja, pastebin or maxroll
  link into the box first.
- **Open file** (Load): pick a build file Path of Building saved. The dialog starts in PoB Community's
  builds folder (its "Build save path" if you set one, else
  `Documents\Path of Building\Builds`), else PoB Redux's, or Downloads when there's none. The file's full path
  shows under the code, and the guide follows it: each save in PoB (Ctrl+S) updates the guide
  within a couple of seconds, with a **Build updated** note. The loadout you're on stays (by
  its name) while the new numbers calculate. Saves made while the guide was closed are
  picked up when it opens.
- **Editor**: which Path of Building the **Edit PoB** buttons open, **PoB
  Community** (the default) or **PoB Redux**. **Not installed** under it means the chosen
  one isn't on this PC, and neither button shows.
- **Edit PoB** (Loaded, when the chosen editor is installed; also next to **Compare** at
  the top of the guide; called Edit in PoB and Desktop PoB before v0.4.52): opens PoB on
  the build. For an opened file, PoB opens straight into it. PoB Community: Lioneye sets the file as PoB's last open build (the `<Mode>` entry in
  PoB's `Settings.xml`), then starts PoB. PoB Redux: Lioneye starts Redux with the file.
  With PoB already open, a second PoB window opens. A save updates the guide when the editor
  writes it back to the same file.
  For a pasted code, **Save to PoB?** first saves it as a new file in the editor's builds
  folder (never over an existing one) under the name you give; from then on it's an opened
  file. Redux's builds folder is the PoE 1 folder set in Redux, else
  `Documents\Path of Building\Builds`. The header's 💾 icon saves a pasted code the same
  way without opening PoB. Pasted codes are never saved anywhere otherwise.
- **Copy code** (Loaded): copies the build's PoB code.
- **Clear build** (Loaded): removes the build (code, file, tree, links and gem list), after
  **Clear build?**. Your progress stays.

Loading a different build (Import code or Open file) brings its gem list, class and bandit (Settings →
**Route**) and keeps your progress. A save of the same file in PoB updates only what comes
from PoB (stats, tree, gear, links); the gem list, class and bandit stay as you set them, so
Open the file again to take PoB's. To start over, **Settings → Route → Reset** has
**Reset campaign** (campaign ticks, your place and level) and **Reset gems** (gem ticks).
The ↺ on the Campaign panel does both.

Campaign ticks are kept by what each step says (with the step before it), not by its place,
so a different gem list, bandit or route option never moves a tick onto another step. Ticks
saved before 0.4.7 are moved over once, the first time the guide opens.

### Live character (poe.ninja)

Also in **Settings → Build** (the **Character** card), for the character you're playing: the guide can show it
(the Loadout dropdown's **Live character**), compare it with the plan (**Compare**) and
check it (**Build health**).

- **PoE account**: your account name (`Name#1234`), then **Load**. It lists the characters
  your poe.ninja profile shows (name, level, class, league), and the account is kept once
  they load. Emptied, the button reads **Clear** and forgets the account and the live
  character. Connect your account on poe.ninja and keep the profile public: reading it
  needs no sign-in.
- **Live character**: pick one (**None** stops following). The guide reads the PoB code
  poe.ninja's character page shows ("Import code for Path of Building"), then the bundled
  PoB calculates it. Under it: the character's name, level and class, or why it wasn't read.
- It stays current by itself: every 3 minutes the exe asks poe.ninja whether the
  character changed and reads it only if so. **Refresh** reads it now. poe.ninja re-reads a
  character from the game on its own schedule, which can be an hour or more apart. The
  header's Live row has the same Refresh (⟳).
- **poe.ninja: Sign in** opens Lioneye's own poe.ninja window on its account page; sign in
  there with poe.ninja's own Path of Exile sign-in, then close it (closing only hides it;
  the login is kept in `%LOCALAPPDATA%\exile-leveling\ninja-webview2`). Signed in, a
  level-up and **Refresh** ask poe.ninja to re-read the character now (its profile page's
  own refresh), then check for the new data 20 seconds, 1 minute and 4 minutes later.
  The row reads **Signed in**, **Not signed in** or **Not checked**. It's checked once
  you've used **Sign in** (until then the poe.ninja window isn't started): when the guide
  opens, and when the guide gets focus while you're not signed in (at most every 20
  seconds).
- **Loadout → Live character** (the first entry once one is set) shows it in the guide:
  the left column's stats, the header's numbers, **Items**, **Skills**, **Tree**, **Trade
  List** and **Config**. Its name and level show under the dropdown, and PoB's own main
  skill is used (no skill picker). **Campaign**, your gem list, **Notes** and your tree
  progress stay on the plan, **Compare** picks its own two builds, **Build health**
  follows its own **Live**/**Plan** dropdown, and the in-game bar's buttons and tooltips
  stay on the plan. Picking a loadout goes back to the plan (so does reopening the guide,
  or clearing the live character).

poe.ninja's addresses for this are the ones its own pages use, not a published API, so a
change on poe.ninja's side can break it until Lioneye is updated. The bundled PoB holds one
build at a time, so after the live character is calculated, the guide's next loadout
change takes a few seconds longer (as after a Compare).

Open file, Edit PoB, the builds list and the file watch work only from the guide on this PC: never from another
device (`--address 0.0.0.0`) or another website, and only for local `.xml` files (not
network paths). Edit PoB changes PoB's `Settings.xml` only when it reads cleanly as PoB's own
settings; otherwise it leaves it alone and says so.

## Using the guide

- **Click** a step to mark it done. **Shift-click** marks it and every step before it.
  Shift-click a done step to clear it and every step after it.
- With the game running, the guide follows your zone changes: the ▶ circle moves to the zone
  you're in, even after a waypoint jump up to 12 stops ahead. Leaving a zone ticks its steps;
  zones you skip stay open. After a trip to town, the zone you came from ticks when you leave
  town for another zone, so selling mid-zone ticks nothing. Portalling back into a zone or
  returning to one you just left changes nothing. Click a circle to set where you are by hand.
- Bosses whose death the game logs tick their step the moment they die: Piety, Gravicius,
  Dominus, Malachai, Maligaro, Kitava, and the Act 5-10 gods and bosses Sin announces.
  Others (Hillock, Merveil, Brutus and most Act 1-4 bosses) log nothing when they die;
  their step ticks when you leave the zone.
- The page is laid out like a pob.codes build page. Panels fold from their gold header bars
  (click anywhere on the bar): **Campaign**, **Items**, **Skills**, **Trade List**, **Config**,
  **Tree**, **Notes** and
  **Search**. A panel's header (and the act header inside Campaign) stays pinned while
  you're in that panel. Folding a panel or act while you're inside it lands on the next one.
- An act folds to one line once all its steps are done, and Campaign folds once the last
  act is done. Nothing reopens on its own: a folded act or panel stays folded until you
  click it (or use the bar). **Reset campaign** opens Campaign again.
- The one bar at the top jumps to each panel and holds the auto-progress pill (at the right)
  and ⚙ **Settings** (right after the panel buttons): one list in three sections, with a bar
  pinned at its top that jumps to each and underlines the one you're in. Each section is a
  set of cards, two side by side when the window is wide enough, each setting a row with its
  label at the left:
  - **App** (Settings opens here): **Overlay** (**Show in game**, **Auto tree**, **Buttons**)
    and **Game** (**Game log**, **Browser**; with the exe).
  - **Build**: **Build** (the code box; Load: **Import code**, **Open file**; Loaded:
    **Edit PoB**, **Copy code**, **Clear build**; **Editor**; see [Your build](#your-build)),
    **Character** (**PoE account**, **Live character**, **poe.ninja**) and **Search**
    (your search strings, with a link to poe.re).
  - **Route**: **Route** (class, bandits, **League start**, **Library**, **Gems only**,
    **All hints**, **Edit route**, **Export**), **Gems** (the gem list, scrolling inside its
    card) and **Reset** (**Reset campaign**, **Reset gems**).

  The
  Campaign header's dropdown jumps to an act, and its ↺ resets the campaign and gem ticks
  (it asks first). Auto-progress only scrolls to your zone while
  Campaign is on screen.
- The card at the top shows the build (skill, ascendancy) and two rows of headline numbers.
  With the chosen editor installed, the title is a dropdown of the builds in its builds
  folder (the top of the folder, not subfolders such as `Archived`; last saved first, with
  a search box). Picking one opens it as **Open file** does, and the guide follows the file; the
  one loaded is gold. With no build loaded, the same list is under **Builds** beside
  **Import**. The 💾 icon beside the title saves a pasted code to the builds folder
  (**Save to PoB?**, the same as Edit PoB's) without opening PoB; from then on it's an opened
  file. It's greyed out, with why as its tooltip, when it can't save: **PoB not found**
  (no answer from the exe yet), **PoB Community not installed** (or **PoB Redux**, the
  chosen editor), **No build**, **Already in PoB** (an opened file) or **Saving**. An
  open **Save to PoB?** closes by itself if the build changes or gets saved meanwhile. The
  import icon after it (**Load code**) opens **Load build**: paste a PoB code or build link
  and **Import**, as Settings' **Import code** does, without leaving the guide. **Plan**: the shown loadout as PoB calculates it, with PoB's level. **Live**: your
  character, with your level from the game log (it's never behind poe.ninja's) and the
  numbers from poe.ninja's copy; without a live character, just the log's level. Live's
  ⟳ (once a live character is set) does what **Refresh** in Settings does, and opens the
  poe.ninja sign-in first while you're not signed in. It turns amber while poe.ninja's
  copy is from a lower level than the log's. The **Loadout** dropdown heads the left
  column, above **Stats**. The loadout follows your level when PoB titles name levels
  (`Lvl 30`, `Level 12-28`), else your act (`Act 2`, `Act 4-6 - 50 pts`). Once your level
  is more than 10 past the usual level for the end of the act the campaign marker is in
  (5 from Act 8; mapping, or a campaign the guide didn't follow), it follows the first act
  your level still fits instead, and above level 73 the set after the act ones
  (`SRS Early Maps`), or the last act one when none follows. When no title names a level
  or act (`Early`, `27 points`), it follows your tree: the set after the last one whose
  main-tree points you all have (from the game's log; matched by name, else by position
  when the counts match; the last set once all are done). Pick another until your level,
  act or tree moves on; the loadout you pick is kept through Settings and restarts until
  then. From v0.4.58 a pick further down the list than the set followed stays while that
  set moves forward, until it reaches or passes the pick: `HRoC Swap` picked in Act 7 is
  kept once the guide follows `SRS Early Maps` past level 73. A new character (the
  followed set moving back) starts over; **Auto** follows again. A zone's suggested level (`12+`) turns red while you're below it.
- The **Tree** panel draws what PoB knows about the set's jewels (with the exe): each
  socketed jewel gets a ring in its rarity color, and jewels with a radius get their
  radius (Thread of Hope's as a band, Impossible Escape's around its keystone). Cluster
  jewel passives are drawn where PoB places them. Hovering a passive shows its tooltip
  beside it: a timeless jewel's version of it (Slum Lord, with "Elegant Hubris … was
  Arcanist's Dominion"), a cluster passive's stats, or the jewel's item card on a socket.
  The exe's PoB sends these per tree (`treeExtras` in `log-api/src/pob-host.lua`).
- When you have every main-tree point of the shown tree set, the **Tree** panel (and the
  in-game Tree tooltip) shows the next set you haven't finished, with "… done" in its
  hint. Stats, items and skills stay on the loadout's set. Picking a set in the panel turns
  this off until the loadout, act or level set changes. Masteries and ascendancy points
  don't count toward finishing a set. Refunds aren't in the log, so a point you refunded
  still counts as taken.
- Masteries show in both trees as rings in the middle of their notables, filled in the
  same colors as other points once they're yours or the set's. In the Tree tooltip a mastery
  the set takes is next (green) once one of its own notables is yours or next, else later
  (dim green). The tree data lists each mastery's notables (`m`, from GGG's groups, made by
  `seeding/src/build-tree/tree.ts`).
- The card's clipboard button copies the build's PoB code. **Compare** opens the Compare
  page (see [Compare](#compare)).
- The left column shows Path of Building's sidebar (life, DPS and the rest) for that
  loadout, calculated by the PoB release bundled in the exe. Its thin scrollbar only shows
  there's more; scroll it with the wheel.
- **Items** shows the loadout's item set as a paper doll (with flasks, weapon swap, abyssal
  sockets, grafts and the jewels in the tree's taken sockets). Base art comes from RePoE's
  base item list (every base, flasks included) and unique art from poe.ninja for the league
  you pick. The trade site's stat and item lists drive the trade searches. The exe fetches
  all of them with curl.exe and caches them in `%LOCALAPPDATA%\exile-leveling\cache` for
  12 hours (the cached copy is used offline).
- Links out of the guide (trade searches, the wiki, poe.re) open in your default browser,
  where you're signed in to the trade site, whichever **Browser** opens the guide. The
  exe starts the browser Windows has for https links with the address (so long trade
  searches arrive whole), else lets Windows open it. Right-click → open in a new tab in
  the guide's own window still stays in its Edge profile.
- **Build health** (under the Tree) lists what to look at in the shown loadout, worst
  first, each with a link to the panel that fixes it. The checks are
  [PoB Redux](https://github.com/pobredux/pob-redux)'s (MIT): resistances, passive
  points, main skill links, skills to press, flasks, pantheon, skill costs, life, movement
  speed, attribute requirements, gem errors and reduced-requirement affixes. Two are
  Lioneye's own for leveling: **Labyrinths** due by level (Normal by 35, Cruel by 57,
  Merciless by 70, Eternal by 78, counted from the ascendancy points on the tree; this
  replaces Redux's two ascendancy checks, which ignore your level; bloodline points don't
  count), and worn rares and magic items 15 or more item levels below your level (one
  medium finding; uniques, flasks, jewels, items without an item level and slots PoB hides,
  like the weapon set not in use, left out). Like Redux, it uses the build's level from
  PoB; for these two, where a loadout's points say a level well below it (a guide saved at
  level 90 in manual mode), that level. With a live
  character set, its header's dropdown picks what it checks: **Live** (your character from
  poe.ninja, named under the header; its findings don't link to the guide's panels, which
  show the plan) or **Plan** (the shown loadout).
- Your character, from the game's log: the exe reads back the character the guide follows
  (by name, so party members' level-ups are ignored): every "Successfully allocated passive
  skill" line since its level 2 (refunds aren't logged; a point taken on another of your
  characters meanwhile would count too) and its latest `/passives` list. A LatestClient.txt
  log is read through the full Client.txt beside it. Node ids map to
  the tree through RePoE's passive data. In **Tree**, pick **Character** (instead of **Previous set**) to see the
  loadout against your tree (green: to take; red: not in the guide). Type `/passives` in
  game and **Build health** lists quest points missed in the acts you'd finished when you
  typed it (the in-game bar's **Campaign** icon turns amber for them). Its note asks for
  `/passives` again once you're in a later act.
- Hover an item or gem for its in-game tooltip, with its buttons underneath; click it to pin
  the tooltip and use them: items have **Copy** (the item as PoB text, to paste into PoB) and **Trade**; gems have
  **W** (the wiki) and **Trade**. Escape, a click elsewhere or a second click unpins it.
- **Trade List** has a trade search for every item of the loadout's item set and every gem of
  its skill set, as on pob.codes. Pick the league, the search type (**Instant Buyout**,
  **In Person**, **Any**), **Min mods** (the share of a rare's mods a listing must have)
  and **Min values** (each mod's minimum, as a share of yours). The settings apply to the
  tooltip Trade buttons too.
- Cluster jewel searches (from v0.4.66) require the base, the exact passive count, the small
  passives' enchant and the jewel's item level or higher. Every explicit mod, notables too,
  is on the search unticked, to tick on the trade site; **Min mods** doesn't apply.
- Gem rows show level/quality from the PoB code.
- Gems turned off in PoB are dimmed, in the Skills panel (its tooltip says **Off in PoB**)
  and the in-game bar's Skills tooltip. They still count on the gem list, its searches and
  Trade. A build loaded before this version is read again once on start to pick them up
  (and its level/quality, if it predates those).
- Items, Skills, Config and Tree show the loadout's sets; each has its own dropdown to look at
  another set until the loadout or act changes. A dropdown showing a set that isn't the
  loadout's turns gold (also when Tree moves ahead to the next set on its own); builds
  without loadouts have nothing to differ from, so theirs stay plain. **Config** lists only the options a set
  changes from PoB's defaults, and its Custom Modifiers (lines PoB doesn't apply, such as
  `#` notes, are dimmed). On the tree, Ctrl+scroll zooms and dragging pans.
- Under **Stats** in the left column, pick the main skill as in PoB. The pick is remembered by
  skill gem, so the same skill stays selected in every loadout that has it; loadouts without
  it show PoB's own pick, tagged **PoB pick**. Loading a different build clears the pick.
- The first stats after starting take a few seconds while PoB loads; it unloads after
  10 minutes unused. PoB is unpacked to `%LOCALAPPDATA%\exile-leveling\pob`. From v0.4.65,
  another copy of the app (a test copy on another port) can't remove it while PoB is loaded,
  and if it goes missing anyway the next stats unpack it again; before, stats failed until a
  restart. Debug builds use `pob-dev`. A build with a
  timeless jewel downloads that jewel's data (2-30 MB) from PoB's GitHub the first time.
  Specs on an older tree are calculated on the latest one (noted under the stats).

## Compare

The build card's **Compare** opens its own page (back with **Guide** in the top bar): two
builds side by side, calculated by the bundled PoB, in pinned panels with a section bar
(Summary, Gaps, Stats, Skills, Items).

- **Builds**: each side's dropdown picks what it is: **Live** (your live character),
  **Loadout** (the imported build), **Account** (a character on a PoE account's public
  poe.ninja profile: **Add…** an account (`Name#1234`, **Load**), then pick a character;
  accounts are kept, **Remove** drops one) or **Pasted** (a PoB code or a pobb.in,
  poe.ninja, pastebin or maxroll link; **Change** pastes another). A build with more than
  one loadout gets a loadout dropdown. ⇄ swaps the sides. **Refresh** reads a live or
  account character again. An account's character is read when it's picked and on Refresh
  only, and is as new as poe.ninja's last read of it. The first side carried over the old
  Compare's pasted code.
- **Same footing**: Build 2 is calculated on Build 1's config and party (the party members' buffs), so the difference is the
  builds, not their setups (**Config: Build 1**). Main skill: Build 1's own (for a Loadout,
  the skill you picked in the guide), and Build 2 uses the same skill gem when it has it
  (**Same**; else **Different**, and each uses its own).
- **Colors**: Build 1 is blue and Build 2 orange, and nothing else is colored: whatever
  is in a build's color is where that build is ahead (costs count lower as better).
- **Summary**: the stats that matter for these two builds, picked by rules over PoB's
  output: DPS, EHP, phys max hit and move speed always; an ailment's chance when that
  ailment is at least a tenth of the damage; crit from 20%; hit chance for attacks under
  99.5%; life or ES by which is the pool (not life under Chaos Inoculation); armour or
  evasion by which the build uses; block and suppression from 25%; resistances below cap.
  Grouped as PoB's Calcs tab (Offence, Defence, Misc), each row has a bar from the center
  toward the build that's ahead. Click a row for PoB's breakdown of both (life, ES,
  armour, evasion, suppression, resistances, ailment chances, where PoB's numbers add up)
  and its top gains. DPS breaks down as PoB adds it up: hit damage × hit chance × hits per
  second × a multiplier (projectiles, count) is the hit DPS, then poison, bleed, ignite,
  other damage over time, impale and cull; the multiplying factor with the widest ratio
  is marked **Biggest**. A factor opens (▸) into the parts PoB multiplies for it, each
  with both builds and the ratio, the widest marked **Biggest**: hit damage is base
  damage × increased × more × crit × vs enemy (the enemy's resists and damage taken);
  hits/sec is base rate × increased × more, or for a triggered skill (Holy Relic's
  Nova) the lower of its cooldown cap and its trigger rate; poison, bleed and ignite are
  base damage × increased × more × DoT multi × vs enemy, and poison also × chance ×
  duration × hits/sec. Whatever the parts leave out (conversion, double damage, crits on
  ailments) is **Other**, shown when it isn't ×1, so the parts always multiply to the
  factor. A part opens into its sources (gear slot, tree node, gem, party): base damage
  is the skill's own (a minion's from its level, an attack's from the weapon) plus added
  damage after effectiveness; more mods multiply.
- **Gaps**: a table, a row per piece of Build 2 tried on Build 1 and recalculated by PoB
  (Build 2's config, each gear slot that differs (weapons as a pair around a two-hander,
  flasks as a set), all gear at once (one-slot swaps don't add up: Mageblood needs its
  flasks), the whole tree with its jewels, the main links, a support that's unlinked in
  the main skill's item, a support Build 2 links that fits, gems Build 2 has at a higher
  level), a column per summary stat. Each cell is the change to Build 1: ▲ in blue a gain,
  ▼ in orange a loss, · too small to show (under a point, or 1% of Build 1's value).
  Click a stat's header to sort by it. **Show** opens the item or skills; **Trade**
  searches for Build 2's item.
- **Stats** is every sidebar stat (search; **Show same** adds equal ones), and **Skills**
  and **Items** what differs.
- PoB calculates both builds in full, then each gap (15-30 builds, 1-2 seconds each), one
  at a time on the same PoB the guide uses: the guide's own requests wait for one at most.
  The Gaps header counts them. Leaving the page stops the rest; finished results are kept until the
  app restarts. Each side is first cut down to its loadout's sets, so every gap edits
  "the" item, skill and config set. The exe's `/api/pob/compare` (host_compare in
  `log-api/src/pob-host.lua`) answers with every number PoB has, and for the two builds
  also PoB's source tables.

## League

- **League** in the top bar (called Strats before v0.4.48) opens the league page: our
  builds, the league cheat sheet and trade searches, loaded live from
  <https://kobayashi-maru-1.github.io/lioneye/strats/>. It works in any browser too, so
  friends without Lioneye can use the same link. The top bar stays as it is (its panel
  buttons take you back to the guide, at that panel); under it, the page pins its own bar
  with a button per section (Builds, Trade, Leveling, ...), which the page lists itself.
- Each section's header bar folds it; the page remembers which are folded (per browser).
  Jumping to a folded section opens it. It also remembers where you'd scrolled to and opens
  there again (not when a link points at a section, `#trade`).
- **Builds**: a card per build with a copy button for its PoB code (paste into PoB's
  Import or Lioneye's Settings). The codes are files in `strats/builds/`, made from the PoB
  files without their character-import details (account, character, realm) or item
  Unique IDs.
- **Trade**: a card per search (or list of searches), grouped under a heading
  per build (named like its Builds card). Each link is built from
  its own `data-query` (official trade search JSON) and the section's `data-league`;
  at a new league, change `data-league` to the league's trade name and every link follows.
  Every search is buyout only: the script sets the status to Instant Buyout (`securable`)
  and drops any sale type filter (the default is Buyout or Fixed Price). A card can hold
  several links in its list (the Animate Guardian gear card); only single-link cards get
  a copy button.
  The full links run past Discord's 2,000-character limit for big searches: share the
  page instead.
- **Atlas trees**: a card per atlas tree, linking to its **Share tree** link from Atlas
  Route (poeatlasplanner.com, the app's **Atlas** tab), with a copy button. The link holds
  the whole tree, so opening it shows the tree in the planner. In the app (from v0.4.53) a
  click on the tree's name opens it in the **Atlas** tab; in a browser it opens the planner.
- **Cheat sheets**: league mechanics with their own strats, as wide cards. **Betrayal** is a
  member × division table rebuilt as text from Ayeleth's 3.30 Syndicate sheet (credited in
  Sources): the best picks (`td.best`, with a hidden "Best:" for screen readers) are
  bright and the rest in the page's secondary color; Intervention is one
  line, as it's the same for every member. **Temple rooms** (moved here from Farms) ranks
  the rooms worth upgrading, with each one's upgrade path.
- The copy buttons need the frame's `clipboard-write` permission, which the app grants
  from v0.4.48; older versions fall back to the browser's copy command.
- It needs a connection: offline, or when the page doesn't answer, it shows **Not loaded**
  with **Retry**. Links in the page open in your default browser, like the guide's.
- The page is `strats/index.html` in this repo. A push to `main` that changes `strats/`
  publishes it (workflow **Strats page**, `.github/workflows/strats.yml`), and the app shows
  the new version without a release (GitHub caches it for up to 10 minutes). Each
  `<section>` needs an `id` and a `data-jump` label for its bar button; keep the script at
  the end of the file. This is the only thing published to GitHub Pages: upstream's website
  build stays out.
- Pages was turned on once for the repo with the source **GitHub Actions** (Settings >
  Pages, or `gh api -X POST repos/kobayashi-maru-1/lioneye/pages -f build_type=workflow`).
- The page runs in a sandboxed frame that can't navigate the app window. The app opens a
  link from it only right after a real click with the sheet focused, one link per click
  (5 s), so a changed page can't open links on load or a pile of tabs. Left and middle
  clicks both go to your default browser.
- Its fonts (Cinzel, Alegreya Sans, SIL OFL) are in `strats/fonts/`, so the page loads
  nothing from Google. When copying a new version of the cheat sheet in, keep the
  `@font-face` rules instead of a Google Fonts link, and keep the Builds, Trade, Atlas trees
  and Cheat sheets sections, their CSS (the "(Lioneye)" blocks at the end of the style), `builds/` and the script: they aren't part of the cheat sheet artifact.

## Atlas

- **Atlas** in the top bar loads <https://poeatlasplanner.com/> (Atlas Route, an
  independent atlas tree planner; not open source) live in a frame. Lioneye doesn't copy
  or change it: when the site changes, the tab does too.
- The planner keeps its draft and **Saved trees** in its own browser storage. In the
  frame that storage belongs to Lioneye: kept across restarts, separate from the same site
  in a normal Edge tab, and gone if Edge's site data is cleared. **Share tree** links hold
  the whole tree (nodes, effects, point budget), so keep one for any tree that matters.
- A tree clicked on the League page (**Atlas trees**) opens here: the League page hands the
  link to the app, which switches to this tab with the planner on that link. The planner
  shows it as **Viewing a shared tree**, with **My draft** to go back and **Save as draft**
  to keep it. **Atlas** in the top bar opens the planner on your draft again. Any other
  League page link still opens in your default browser, and the same click rules apply (one per click).
- If Edge blocks third-party cookies, it also blocks the framed site's storage: the
  planner still works but forgets trees.
- The site runs its own analytics (Plausible, Google Analytics) in the frame.
- Offline it shows **Not loaded** with **Retry**. The frame can't navigate the app window
  (its **About** link opens inside the frame). If the site ever refuses to be framed, the
  tab shows a blank frame instead of **Not loaded**.

### Our Atlas planner (testing)

A planner of our own, meant to replace poeatlasplanner.com in this tab once it's tested
(plans/atlas-planner.md). For now it's a standalone page, not linked from the app or the
League page: <https://kobayashi-maru-1.github.io/lioneye/atlas/>.

- **Data:** `npm -w seeding run seed atlas` reads GGG's official atlas tree export (pinned
  by commit in `seeding/src/build-atlas/index.ts`) and writes
  `common/data/atlas/3_30.json` (gitignored, rebuilt in CI). It keeps positions, edges,
  mechanics, stats and choice options; GGG's link markup in stat text becomes plain text.
  No game art: nodes are coloured circles, clusters a letter disc.
- **Page:** `web/atlas.html` with `web/src/atlas/` (React, Lioneye's look), built by
  `npm -w web run build:atlas` (`web/vite.atlas.config.ts`: relative paths, no proxy, so
  it never talks to lioneye.exe) into `web/dist-atlas/`.
- **Tests:** `npm -w web run test:atlas` (Node's test runner via tsx, after the seed):
  counts, positions, routes and costs, refunds, gateways, budget, links and bonuses.
- **Publishing:** the **Strats page** workflow seeds, tests and builds it, then publishes
  it at `/lioneye/atlas/` next to `strats/` on every run (a Pages deploy replaces the whole
  site, so both always go together).
- **Plans** live in the browser's local storage (keys `lioneye-atlas-…`): the draft,
  named **Saved** plans, and **Export** / **Import** as a JSON file. Saving with no name
  typed uses the first free "Plan <n>". The plan's name and
  **Save** start the toolbar: a new plan has a name box; a saved one shows its name in
  gold (a dot when changed), **Save** updates it, and clicking the name saves a copy
  under a new name. **Clear** stays on the save; clicking the start node asks
  **Clear tree?** first. **Recalc** rejoins the plan's cluster nodes, notables, keystones
  and choice nodes by the fewest points, dropping or swapping small pathing nodes (one
  undo step; "Freed N points", or "Already shortest"). The toolbar keeps one row: narrow windows get arrow icons for
  Undo and Redo and a **More** menu, and phones put Undo and Redo in More too. **Share** gives our
  link (`#t=`: nodes, choices, budget) and the official pathofexile.com link (nodes only);
  **Open** takes our links, poeatlasplanner.com links (`#p=`, so the League page's trees
  open) and official links. An official link carries no choices, so its choice nodes open
  **Unset** (a dashed ring, listed first in Bonuses) until one is picked.
- **Bonuses** files a travel node's lines under the mechanic they name ("Maps found" →
  Maps), else **Other**; a picked choice shows once, under its mechanic; gateways add
  nothing.
- **Colours:** clusters within 3,000 units never share a colour (16-colour palette; 3.30
  needs 14). Discs show only for the hovered or pinned mechanic.
- **Keyboard:** Tab reaches the zoom buttons, then every cluster label and node; Enter or
  Space acts as a click, and a focused node shows its tooltip.
- **Routes** are the shortest path from what's allocated (ties go to the lower node id, so
  they're stable); refunding a node drops everything only it joined to the start.
- Testing it in a browser: serve `web/dist-atlas` as plain files (`atlas.html` renamed
  `index.html`). Never through `vite preview` on 4173, which proxies to the exe.

### Compare concept (demo)

The design the app's [Compare](#compare) page was built from (the app's runs Build 2 on
Build 1's config; the demo shows Build 2's config or each build's own). A static mock in
the guide's layout (foldable panels, jump bar):
the live character against the shown loadout (HRoC Early Maps), on the guide's config, with
per-stat sources, ranked gaps (each one PoB recalculating your build with one guide piece
swapped in) and an in-game summary. Nothing in it is specific to one build: the summary's
stats are picked by rules over PoB's output (an ailment's chance only when that ailment is a
tenth of the damage, life or ES by which is the pool, resistances only below cap), and the
gaps come from diffing the two builds (each differing slot, all gear at once, the tree,
links, higher gem levels, unlinked supports). A second example (a public Lightning Strike
Juggernaut against its Mageblood version) shows the same page picking different stats. Each
build has its own color (Build 1 blue, Build 2 orange) and nothing else on the page is
colored, so whatever is in a build's color is where that build is ahead: the summary's rows
are Calcs-style sections with a bar that grows from the center toward the leading build
(clicking a row opens PoB's breakdown for both and the top gains), and a gap's bar points
left when it pulls Build 1 ahead. Either side's source dropdown (Live, Loadout, Account,
Pasted) and the swap button are mock-ups. The
numbers are real PoB output from a one-off run, frozen into the page; it doesn't update. It's not
part of the app: `compare-demo/index.html`, published by the **Strats page** workflow at
<https://kobayashi-maru-1.github.io/lioneye/compare-demo/>. Not linked from anywhere;
share the address.

## Overlay

- While Path of Exile is the window in front and you're playing a character, the exe shows a
  small bar over the game (hidden on the login and character select screens, as the game's
  log tells: a zone shows it, logging in or out hides it) with an
  icon button per guide panel: a flag for **Campaign**, plate armour for **Items**, a cut
  gem for **Skills**, two arrows for **Trade**, sliders for **Config**, linked nodes for
  **Tree**, a heart with a pulse for **Health**, a page for **Notes**, a magnifier for
  **Search** and stacked layers for **Loadout** (hover one for its name). **Health** turns red with a high finding and amber
  with a medium one; **Campaign** turns amber with missed quest points (which then don't
  colour **Health** too). A button opens that panel in the guide (on your other monitor) and
  scrolls to it; **Campaign** scrolls to the step for your zone. The game keeps focus, and the
  guide window comes up without taking it. With no guide open, the button opens one first.
  **Loadout** has no panel: clicking it opens its tooltip.
- Hover **Skills** for the Skills panel's links (the set it shows for your loadout, named in
  the title; the small ‹ › after the name step the Skills panel to the set before or after,
  as picking it in the panel does, until your loadout, act or level set changes; from
  League, Atlas or Settings they go back to the guide first, from v0.4.64; each
  group's header names the gear slot PoB socketed it in, as in the Skills panel; its copy
  icon puts a search for the set's gems still unticked on the gem list on the clipboard,
  or for all the set's gems once none are left to get,
  to paste into a vendor or stash search: the gem list's soonest first, as many as fit the
  game's 50-character box (a gem too long to fit is skipped for shorter ones after it),
  with the count in the icon's label when some don't fit. Each
  gem is a short piece of its name that starts at a word and no other gem's name has,
  anchored to the name's start or end where that helps, as [poe.re](https://poe.re/gems)
  does: Arc is `arc$`, so Arctic Armour stays dark),
  **Items** for the Items panel's items with their PoB mods (enchants and implicits, then
  explicits; crafted lighter; the small ‹ › after the set name step the Items panel's item
  set, as Skills' do),
  **Loadout** for the guide's loadouts (its button shows when the build has two or more;
  the one shown is gold, the one your level, act or tree points to is tagged **Auto**;
  click another to show it in the guide, as its **Loadout** dropdown does, back on the
  plan if the page showed your live character, until your level, act or tree moves on
  (a pick further down the list stays, as there); from League, Atlas or Settings it goes
  back to the guide first, from v0.4.58; click the **Auto** one to follow again; the
  guide's panels and the bar's tooltips switch to the loadout's sets at once, and only
  the stats wait for PoB, from v0.4.64),
  **Health** for Build health's findings as the panel lists
  them, each with its severity dot and fix (**Live** or **Plan** by the title when a live
  character is set, as the panel's dropdown picks; dimmed while PoB recalculates),
  **Notes** for the build's PoB notes in PoB's
  colours (all three scroll with the mouse wheel when long),
  **Campaign** for your next 3 steps (each with a small checkbox at its right that marks it
  done in the guide, for what the log can't tell, like a bandit killed early; the next step
  then shows; quest points your character missed in finished acts, from your latest
  `/passives`, list above the steps under **Missed points**, and turn the **Campaign**
  icon amber; its copy icon puts a vendor search on the
  clipboard for the gems to buy at your next vendor stop: from your zone on, the first
  unticked gem to buy and every one after it until the route leaves town, as the Skills
  search is built; quest reward gems are left out, since they come from the reward
  window), or **Tree** for the tree zoomed to your next points
  (for the set the Tree panel shows, named beside the title; the small ‹ › after the name
  step the Tree panel to the set before or after, as Skills' do; a finished set is titled
  **Tree** and shows its
  points, all yours):
  yours blue, the guide's points up to 3 away from yours
  along its paths bright green, its later ones dim green, and yours the set doesn't take
  red (a respec refunds them; their lines go red too, the view takes in those near the
  next points, and the title row counts them all, e.g. **3 to remove**; none for a finished
  set before the build's last, since yours past it are later sets' points). A refund in
  game takes the point off at once. Your points come from the game's
  log; before the log has any, the set before stands in for them (for the first set, all
  its points are next). In the Tree tooltip the mouse wheel zooms around the pointer,
  dragging moves the tree and a double-click goes back to the next points; the zoom stays
  until your next points change. Hovering a node shows its name and stats on one line at
  the tooltip's far edge (away from the bar; cut short when long); a mastery shows the
  effect the set picks. All need the guide open.
- Every tooltip's title row sits on its edge next to the bar, with two icons: the pin at
  its left keeps that tooltip open while you play (one at a time, kept after a restart),
  and the flip (**Show above** / **Show below**) at its right moves tooltips to the other
  side of the bar (below to start, kept after a restart; the bar stays put). A pinned
  tooltip moves at once; otherwise the next one opens on the new side. Hovering another
  button shows its tooltip until the pointer leaves the bar and its tooltip.
- Right-clicking a button pins or unpins its tooltip, like the pin. A pinned tooltip's
  button has a gold border.
- With **Auto tree** on, the Tree tooltip opens by itself while the game's passive tree is
  open, and the pinned tooltip (if any) comes back about a second after the tree closes.
  Hovering another button still shows its tooltip meanwhile. The exe spots the tree by its
  **Skills** header at the top center of the game window, read off the screen a few times
  a second while the bar shows (the game scales it with the window's height, so this works
  at any resolution; only with the **Tree** button on the bar). While the bar or its tooltip
  covers too much of that header to read around (a tooltip opened over it, say), Windows
  leaves the bar out of screenshots and recordings, so the check sees the game under it;
  otherwise the bar shows in them as usual.
- Drag the bar by its dotted grip; its place is kept in `%LOCALAPPDATA%\exile-leveling\overlay.json`.
  The dot at its end is the auto-progress state (green, **Auto**: following the log).
- **Settings** → **App** → **Overlay**: **Show in game**, **Auto tree** (on to start), and
  **Buttons**: which panels get a button (Campaign, Items,
  Skills, Tree, Health, Notes and Loadout to start; a bar set up before Health or Loadout
  existed gets it once, and unticking it keeps it off). Panels the build doesn't have are
  left off, and Loadout with fewer than two loadouts.
- The bar is a page of the guide (`overlay.html`) in WebView2, the engine Edge uses (part of
  Windows 11; its data is kept in `%LOCALAPPDATA%\exile-leveling\webview2`).
- PoE must run in **Windowed** or **Windowed Fullscreen** mode: nothing can show over its
  exclusive **Fullscreen**.
- To try it without the game, start the exe with `EXILE_LEVELING_OVERLAY_ALWAYS=1` set; the bar
  then shows over any window.

## Build

Needs [Node.js 22+](https://nodejs.org), [Rust](https://rustup.rs) and Git.

Each build bundles the latest [Path of Building](https://github.com/PathOfBuildingCommunity/PathOfBuilding)
release (code and game data only, about 5 MB) for the Stats tab; `log-api\fetch-pob.ps1`
downloads it and skips the download when that release is already there. An exe keeps the
PoB it was built with: build again after a PoB release to pick it up.

PoB loads on the first stats request and stays loaded while a guide is open, so loadout
switches stay quick; it's unloaded (freeing about 500 MB) 10-20 minutes after the last
guide closes. Each calculation is logged ("PoB stats for … in 0.8s", with "PoB loaded
first" when it had to load).

Build health is a port of PoB Redux's `sanity_check`, with its two ascendancy checks
replaced by Lioneye's Labyrinth check and an item level check added (both marked
"Lioneye" in `healthFindings`; keep them when porting). `log-api\redux-watch.ps1` says
whether Redux changed it since the port (the Watch workflow runs it daily and warns
on a change); after porting, `.\log-api\redux-watch.ps1 -Update` records the new version.

```powershell
.\build.ps1            # writes .\lioneye.exe
.\build.ps1 -SkipTree  # reuse the downloaded tree data
```

Rust's build output (1-2 GB) goes to `%LOCALAPPDATA%\exile-leveling\cargo-target`,
outside the repo, so a synced folder such as OneDrive doesn't copy it. Set
`CARGO_TARGET_DIR` to use another folder.

Or run **Desktop exe** from the GitHub Actions tab and download the artifact.
Pushing a tag such as `v1.0.0` attaches `lioneye.zip` (the exe, zipped) to a release.

The footer shows the version and the build's commit (`0.4.1 (1a2b3c4)`).

### Releases

1. Raise `version` in `log-api\Cargo.toml` (and its entry in `Cargo.lock`), commit, and push
   a matching tag (`v0.4.2`). The workflow builds the exe (without the Rust cache, which
   nothing checks), attaches `lioneye.zip` to a **draft** release that nobody sees yet, and
   records a provenance attestation: which workflow and commit built it. A re-run stops if
   the tag already has a release; to rebuild an unsigned draft, delete the draft first.
2. Sign it on the publisher's PC: `.\tools\sign-release\sign-draft.ps1 -Tag v0.4.2`. It
   checks the tag is the same commit here and on GitHub, verifies the attestation (built by
   `desktop.yml` from that commit), checks the exe carries `log-api\release-key.pub`, then
   signs and uploads `lioneye.zip.minisig`. Signing GitHub's zip without those checks would
   sign whatever a taken-over account put there.
3. Add the notes and publish:
   `gh release edit v0.4.2 -R kobayashi-maru-1/lioneye --draft=false --latest --notes-file ...`.

Copies on an older version then show **Update** in the footer and the tray. The zip keeps
its name every release, so `releases/latest/download/lioneye.zip` always downloads the newest.

**The release key.** The tool is `tools\sign-release`, not part of the exe or CI. Build it
outside OneDrive:

```powershell
cd tools\sign-release
$env:CARGO_TARGET_DIR = "$env:LOCALAPPDATA\exile-leveling\cargo-target-sign"
cargo build --release   # sign-release.exe lands in that folder's release\
Remove-Item Env:CARGO_TARGET_DIR
```

Its key folder, `%USERPROFILE%\Downloads\lioneye-signing`, holds:

- `release.key`: the secret key, password-protected. The backup: keep a copy and its
  password off this PC.
- `release.key.dpapi`: the same key locked to this Windows account, so signing asks nothing.
- `release.pub`: the public key, the same as `log-api\release-key.pub`.

`sign-release.exe keygen` made them once. On a new PC, copy `release.key` into that folder
and run `sign-release.exe restore` (it asks the password). `sign` refuses a key that isn't the one in
`log-api\release-key.pub`. Losing the key means a new one: installed copies refuse releases
signed with it, so everyone installs that release by hand once.

For UI work, run the exe, then `npm -w web run dev` and open the address it prints;
the dev page uses the running exe for auto-progress.

## Layout of this repo

- `web`, `common`, `seeding`: [HeartofPhos/exile-leveling](https://github.com/HeartofPhos/exile-leveling) (remote `upstream`)
- `log-api`: [HeartofPhos/exile-log-api](https://github.com/HeartofPhos/exile-log-api) (remote `upstream-log-api`, a git subtree), extended to serve the guide
- `strats`: this repo's own league page (builds, cheat sheet, trade searches), published to GitHub Pages (see League)

## Pull upstream updates

New league data (routes, gems, trees) comes from upstream:

```powershell
git fetch upstream
git merge upstream/main
git subtree pull --prefix=log-api upstream-log-api main
.\upstream-watch.ps1 -Update   # records what was merged (the footer's route date)
.\build.ps1
```

Lioneye doesn't build upstream's website. When a merge brings back their GitHub Pages
workflow (`.github/workflows/build-and-deploy.yml`), the PWA plugin (`vite-plugin-pwa`) or
the phone icons in `web/public`, keep them out, and keep this repo's `web/vite.config.ts`.

`upstream-watch.ps1` (without `-Update`) says whether either upstream has changes not merged
yet. The **Watch** workflow runs it and `log-api\redux-watch.ps1` daily. When there's
something to merge or port, the run passes with a yellow warning and lists it in the run
summary. There's no email, so check Actions.

After cloning, add the remotes once:

```powershell
git remote add upstream https://github.com/HeartofPhos/exile-leveling.git
git remote add upstream-log-api https://github.com/HeartofPhos/exile-log-api.git
```

Both projects are MIT licensed; see `LICENSE` and `log-api/LICENSE`. Path of Building
is MIT licensed too; its license ships inside the bundle.
