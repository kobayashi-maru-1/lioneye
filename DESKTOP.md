# Exile Leveling desktop

One Windows program, `exile-leveling.exe`, that runs the leveling guide and the
auto-progress log watcher together. It serves the guide at
http://127.0.0.1:6754 and opens it in a borderless Edge app window.

## Run

1. Start `exile-leveling.exe`. It runs in the tray (by the clock), with no console window.
   Closing the guide window leaves it running there. Click the icon or pick **Open** to bring
   the window back (or reopen it); pick **Quit** to close the window and stop.
   The icon's tooltip shows **Waiting** or **Auto**.
   The log is at `%LOCALAPPDATA%\exile-leveling\exile-leveling.log`. Started from a terminal,
   it also prints there; the prompt returns right away, and Ctrl+C in that terminal quits it.
2. The guide opens in an Edge app window. Drag it to the monitor you want; Edge
   remembers its size and place next time.
3. Start Path of Exile. The pill at the top right of the panel turns green (**Auto**)
   once the game's log is found, and the route advances as you change zones.

Running the exe again while it's already open brings its window to the front.

| Option | Default | What it does |
| --- | --- | --- |
| `--browser edge\|default\|none` | `edge` | How to open the guide on start |
| `--log-path <file>` | found from the game | Use this `Client.txt` / `LatestClient.txt` |
| `--address <ip:port>` | `127.0.0.1:6754` | Where to serve. Keep the port the same: progress is saved per address |
| `--heart-beat <secs>` | `1` | How often the log is read |

Progress, your imported build and layout are saved in Edge for
`127.0.0.1:6754`. Builds imported on the hosted site don't carry over, so import
your PoB once in **Settings** (the ⚙ at the top right).

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
  (click anywhere on the bar): **Campaign**, **Gems**, **Config**, **Tree**, **Notes** and
  **Search**. A panel's header (and the act header inside Campaign) stays pinned while
  you're in that panel. Folding a panel or act while you're inside it lands on the next one.
- An act folds to one line once all its steps are done, and Campaign folds once the last
  act is done. Nothing reopens on its own: a folded act or panel stays folded until you
  click it (or use the bar). Importing a build opens Campaign again.
- The one bar at the top jumps to each panel and holds the auto-progress pill and ⚙
  **Settings** (import, build options, search strings, gems, Edit route, Export). The
  Campaign header's dropdown jumps to an act. Auto-progress only scrolls to your zone while
  Campaign is on screen.
- The card at the top shows the build (skill, ascendancy, PoB's level), your level from the
  game log (**Char lvl**), its headline numbers and the **Loadout** dropdown. The loadout follows your
  level when PoB titles name levels (`Lvl 30`, `Level 12-28`), else your act (`Act 2`,
  `Act 4-6 - 50 pts`); pick another until your level or act changes. A zone's suggested
  level (`12+`) turns red while you're below it.
- The left column shows Path of Building's sidebar (life, DPS and the rest) for that
  loadout, calculated by the PoB release bundled in the exe. Its thin scrollbar only shows
  there's more; scroll it with the wheel.
- Gems, Config and Tree show the loadout's sets; each has its own dropdown to look at
  another set until the loadout or act changes. **Config** lists only the options a set
  changes from PoB's defaults. On the tree, Ctrl+scroll zooms and dragging pans.
- At the top of the left column, pick the main skill as in PoB. The pick is remembered by
  skill gem, so the same skill stays selected in every loadout that has it; loadouts without
  it show PoB's own pick, tagged **PoB pick**. Importing a build clears the pick.
- The first stats after starting take a few seconds while PoB loads; it unloads after
  10 minutes unused. PoB is unpacked to `%LOCALAPPDATA%\exile-leveling\pob`. A build with a
  timeless jewel downloads that jewel's data (2-30 MB) from PoB's GitHub the first time.
  Specs on an older tree are calculated on the latest one (noted under the stats).
- On the hosted site (no exe) there are no stats or config; Tree and Gems follow your act
  with their own arrows.

## Build

Needs [Node.js 22+](https://nodejs.org), [Rust](https://rustup.rs) and Git.

Each build bundles the latest [Path of Building](https://github.com/PathOfBuildingCommunity/PathOfBuilding)
release (code and game data only, about 5 MB) for the Stats tab; `log-api\fetch-pob.ps1`
downloads it and skips the download when that release is already there.

```powershell
.\build.ps1            # writes .\exile-leveling.exe
.\build.ps1 -SkipTree  # reuse the downloaded tree data
```

Rust's build output (1-2 GB) goes to `%LOCALAPPDATA%\exile-leveling\cargo-target`,
outside the repo, so a synced folder such as OneDrive doesn't copy it. Set
`CARGO_TARGET_DIR` to use another folder.

Or run **Desktop exe** from the GitHub Actions tab and download the artifact.
Pushing a tag such as `v1.0.0` attaches the exe to a release.

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
.\build.ps1
```

After cloning, add the remotes once:

```powershell
git remote add upstream https://github.com/HeartofPhos/exile-leveling.git
git remote add upstream-log-api https://github.com/HeartofPhos/exile-log-api.git
```

Both projects are MIT licensed; see `LICENSE` and `log-api/LICENSE`. Path of Building
is MIT licensed too; its license ships inside the bundle.
