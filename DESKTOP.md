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

**Settings** → **App** → **Game log** and **Browser** set the same as `--log-path` and `--browser`,
saved in `%LOCALAPPDATA%\exile-leveling\settings.json`; the command line wins when given.
A new game log applies at once; a new browser when the guide next opens. Whichever browser
opens it, the guide loads the exe's copy of your data (below) when another browser saved it
since, so switching never brings back old progress.

The thin line at the bottom shows the app's version, the bundled Path of Building's, and
the date of the exile-leveling route data merged in, with **Update** when GitHub has a
newer release (checked on start, every 6 hours, and when you come back to the window).

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

In ⚙ **Settings → Build**:

- **Import**: paste a PoB code or a pobb.in, poe.ninja, pastebin or maxroll link.
- **Open**: pick a build file Path of Building saved. The dialog starts in PoB Community's
  builds folder (its "Build save path" if you set one, else
  `Documents\Path of Building\Builds`), or Downloads when there's none. The file's full path
  shows under the code, and the guide follows it: each save in PoB (Ctrl+S) updates the guide
  within a couple of seconds, with a **Build updated** note. The loadout you're on stays (by
  its name) while the new numbers calculate. Saves made while the guide was closed are
  picked up when it opens.
- **Edit** (when PoB Community is installed; also **Desktop PoB** next to **Compare** at the
  top of the guide): opens PoB on the build. For an opened file,
  PoB opens straight into it: Lioneye sets it as PoB's last open build (the `<Mode>` entry in
  PoB's `Settings.xml`), then starts PoB. With PoB already open, a second PoB window opens.
  For a pasted code, **Save to PoB?** first saves it as a new file in PoB's builds folder
  (never over an existing one) under the name you give; from then on it's an opened file.
  Pasted codes are never saved anywhere otherwise.
- **Unload**: removes the build (code, file, tree, links and gem list).

Loading a different build (Import or Open) brings its gem list, class and bandit (Settings →
**Route**) and keeps your progress. A save of the same file in PoB updates only what comes
from PoB (stats, tree, gear, links); the gem list, class and bandit stay as you set them, so
Open the file again to take PoB's. To start over, **Settings → Route** has
**Reset campaign** (campaign ticks, your place and level) and **Reset gems** (gem ticks).

Campaign ticks are kept by what each step says (with the step before it), not by its place,
so a different gem list, bandit or route option never moves a tick onto another step. Ticks
saved before 0.4.7 are moved over once, the first time the guide opens.

Open, Edit and the file watch work only from the guide on this PC: never from another
device (`--address 0.0.0.0`) or another website, and only for local `.xml` files (not
network paths). Edit changes PoB's `Settings.xml` only when it reads cleanly as PoB's own
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
  (click anywhere on the bar): **Campaign**, **Gear**, **Gems**, **Trade List**, **Config**,
  **Tree**, **Notes** and
  **Search**. A panel's header (and the act header inside Campaign) stays pinned while
  you're in that panel. Folding a panel or act while you're inside it lands on the next one.
- An act folds to one line once all its steps are done, and Campaign folds once the last
  act is done. Nothing reopens on its own: a folded act or panel stays folded until you
  click it (or use the bar). **Reset campaign** opens Campaign again.
- The one bar at the top jumps to each panel and holds the auto-progress pill (at the right)
  and ⚙ **Settings** (right after the panel buttons), in three tabs: **App** (Overlay, Game log, Browser; Settings opens here), **Build** (the loaded build: **Unload**, **Copy**, **Open**, **Edit**, **Import**; search strings; see [Your build](#your-build)), **Route** (Edit
  route, Export, **Reset campaign**, **Reset gems**, class, bandits, League Start, Library, Gems Only, hints, and the gem list,
  open until you fold it). The
  Campaign header's dropdown jumps to an act. Auto-progress only scrolls to your zone while
  Campaign is on screen.
- The card at the top shows the build (skill, ascendancy, PoB's level), your level from the
  game log (**Char lvl**), its headline numbers and the **Loadout** dropdown. The loadout follows your
  level when PoB titles name levels (`Lvl 30`, `Level 12-28`), else your act (`Act 2`,
  `Act 4-6 - 50 pts`). When no title names a level or act (`Early`, `27 points`), it
  follows your tree: the set after the last one whose main-tree points you all have (from
  the game's log; matched by name, else by position when the counts match; the last set
  once all are done). Pick another until your level, act or tree moves on. A zone's suggested
  level (`12+`) turns red while you're below it.
- When you have every main-tree point of the shown tree set, the **Tree** panel (and the
  in-game Tree tooltip) shows the next set you haven't finished, with "… done" in its
  hint. Stats, gear and gems stay on the loadout's set. Picking a set in the panel turns
  this off until the loadout, act or level set changes. Masteries and ascendancy points
  don't count toward finishing a set. Refunds aren't in the log, so a point you refunded
  still counts as taken.
- The card's clipboard button copies the build's PoB code. **Compare** works like pob.codes'
  "Compare my PoB": paste any build's PoB code (your character imported in PoB, a
  streamer's, a poe.ninja player's) or a pobb.in, poe.ninja, pastebin or maxroll link. The
  same bundled PoB calculates it as **Build 1**; **Build 2** is the guide's shown loadout.
  The Stats, Passives, Skills and Items tabs list what differs between them. Passives
  match by name, so a build on another tree version still lines up. The last code is
  remembered; **Change** pastes another. PoB holds one build at a time, so the guide's next
  loadout change takes a few seconds longer after a compare.
- The left column shows Path of Building's sidebar (life, DPS and the rest) for that
  loadout, calculated by the PoB release bundled in the exe. Its thin scrollbar only shows
  there's more; scroll it with the wheel.
- **Gear** shows the loadout's item set as a paper doll (with flasks, weapon swap, abyssal
  sockets, grafts and the jewels in the tree's taken sockets). Base art comes from RePoE's
  base item list (every base, flasks included) and unique art from poe.ninja for the league
  you pick. The trade site's stat and item lists drive the trade searches. The exe fetches
  all of them with curl.exe and caches them in `%LOCALAPPDATA%\exile-leveling\cache` for
  12 hours (the cached copy is used offline).
- Links out of the guide (trade searches, the wiki, poe.re) open in a normal tab of your
  last-used Edge profile, where you're signed in to the trade site, not in the guide's own
  profile.
- **Build health** (under the Tree) lists what to look at in the shown loadout, worst
  first, each with a link to the panel that fixes it. The checks are
  [PoB Redux](https://github.com/pobredux/pob-redux)'s (MIT), with its rules unchanged:
  resistances, passive and ascendancy points, main skill links, skills to press, flasks,
  pantheon, skill costs, life, movement speed, attribute requirements, gem errors and
  reduced-requirement affixes. Like Redux, it uses the build's level from PoB.
- Your character, from the game's log: the exe reads back the character the guide follows
  (by name, so party members' level-ups are ignored): every "Successfully allocated passive
  skill" line since its level 2 (refunds aren't logged; a point taken on another of your
  characters meanwhile would count too) and its latest `/passives` list. A LatestClient.txt
  log is read through the full Client.txt beside it. Node ids map to
  the tree through RePoE's passive data. In **Tree**, pick **Character** (instead of **Previous set**) to see the
  loadout against your tree (green: to take; red: not in the guide). Type `/passives` in
  game and **Build health** lists quest points missed in finished acts.
- Hover an item or gem for its in-game tooltip, with its buttons underneath; click it to pin
  the tooltip and use them: items have **Copy** (the item as PoB text, to paste into PoB) and **Trade**; gems have
  **W** (the wiki) and **Trade**. Escape, a click elsewhere or a second click unpins it.
- **Trade List** has a trade search for every item of the loadout's gear and every gem of
  its skill set, as on pob.codes. Pick the league, the search type (**Instant Buyout**,
  **In Person**, **Any**), **Min mods** (the share of a rare's mods a listing must have)
  and **Min values** (each mod's minimum, as a share of yours). The settings apply to the
  tooltip Trade buttons too.
- Gem rows show level/quality from the PoB code. Builds imported before this version show
  them after you import the build again.
- Gear, Gems, Config and Tree show the loadout's sets; each has its own dropdown to look at
  another set until the loadout or act changes. **Config** lists only the options a set
  changes from PoB's defaults, and its Custom Modifiers (lines PoB doesn't apply, such as
  `#` notes, are dimmed). On the tree, Ctrl+scroll zooms and dragging pans.
- At the top of the left column, pick the main skill as in PoB. The pick is remembered by
  skill gem, so the same skill stays selected in every loadout that has it; loadouts without
  it show PoB's own pick, tagged **PoB pick**. Loading a different build clears the pick.
- The first stats after starting take a few seconds while PoB loads; it unloads after
  10 minutes unused. PoB is unpacked to `%LOCALAPPDATA%\exile-leveling\pob`. A build with a
  timeless jewel downloads that jewel's data (2-30 MB) from PoB's GitHub the first time.
  Specs on an older tree are calculated on the latest one (noted under the stats).

## Overlay

- While Path of Exile is the window in front and you're playing a character, the exe shows a
  small bar over the game (hidden on the login and character select screens, as the game's
  log tells: a zone shows it, logging in or out hides it) with a
  button per guide panel. A button opens that panel in the guide (on your other monitor) and
  scrolls to it; **Campaign** scrolls to the step for your zone. The game keeps focus, and the
  guide window comes up without taking it. With no guide open, the button opens one first.
- Hover **Gems** for the Gems panel's links (the set it shows for your loadout; its copy
  icon puts a search for the set's gems still unticked on the gem list on the clipboard,
  to paste into a vendor or stash search: the gem list's soonest first, as many as fit the
  game's 50-character box, with the count in the icon's label when some don't fit. Each
  gem is a short piece of its name that starts at a word and no other gem's name has, so
  a few gems whose names sit inside others', like Arc, light up those too),
  **Gear** for the Gear panel's items with their PoB mods (enchants and implicits, then
  explicits; crafted lighter), **Notes** for the build's PoB notes in PoB's colours (both
  scroll with the mouse wheel when long),
  **Campaign** for your next 3 steps, or **Tree** for the tree zoomed to your next points
  (for the set the Tree panel shows, named beside the title):
  yours blue, the guide's points up to 3 away from yours
  along its paths bright green, its later ones dim green. Your points come from the game's
  log; before the log has any, the set before stands in for them (for the first set, all
  its points are next). In the Tree tooltip the mouse wheel zooms around the pointer,
  dragging moves the tree and a double-click goes back to the next points; the zoom stays
  until your next points change. All need the guide open.
- Every tooltip's title row sits on its edge next to the bar, with two icons: the pin at
  its left keeps that tooltip open while you play (one at a time, kept after a restart),
  and the flip (**Show above** / **Show below**) at its right moves tooltips to the other
  side of the bar (below to start, kept after a restart; the bar stays put). A pinned
  tooltip moves at once; otherwise the next one opens on the new side. Hovering another
  button shows its tooltip until the pointer leaves the bar and its tooltip.
- Right-clicking a button pins or unpins its tooltip, like the pin. A pinned tooltip's
  button has a gold border.
- Drag the bar by its dotted grip; its place is kept in `%LOCALAPPDATA%\exile-leveling\overlay.json`.
  The dot at its end is the auto-progress state (green, **Auto**: following the log).
- **Settings** → **App** → **Overlay**: **Show in game**, and which panels get a button (Campaign, Gear,
  Gems, Tree and Notes to start). Panels the build doesn't have are left off.
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

Build health is a port of PoB Redux's `sanity_check`. `log-api\redux-watch.ps1` says
whether Redux changed it since the port (the Watch workflow runs it daily and fails
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

The footer shows the version and the build's commit (`0.4.1 (1a2b3c4)`). To release: raise
`version` in `log-api\Cargo.toml` (and its entry in `Cargo.lock`), commit, push a matching
tag (`v0.4.2`), then add the notes to the release the workflow made. Copies on an older
version show **Update** in the footer. The zip keeps its name every release, so
`releases/latest/download/lioneye.zip` always downloads the newest.

For UI work, run the exe, then `npm -w web run dev` and open the address it prints;
the dev page uses the running exe for auto-progress.

## Layout of this repo

- `web`, `common`, `seeding`: [HeartofPhos/exile-leveling](https://github.com/HeartofPhos/exile-leveling) (remote `upstream`)
- `log-api`: [HeartofPhos/exile-log-api](https://github.com/HeartofPhos/exile-log-api) (remote `upstream-log-api`, a git subtree), extended to serve the guide

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
yet. The **Watch** workflow runs it and `log-api\redux-watch.ps1` daily and fails (GitHub
emails you) when there's something to merge or port.

After cloning, add the remotes once:

```powershell
git remote add upstream https://github.com/HeartofPhos/exile-leveling.git
git remote add upstream-log-api https://github.com/HeartofPhos/exile-log-api.git
```

Both projects are MIT licensed; see `LICENSE` and `log-api/LICENSE`. Path of Building
is MIT licensed too; its license ships inside the bundle.
