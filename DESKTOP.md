# Exile Leveling desktop

One Windows program, `exile-leveling.exe`, that runs the leveling guide and the
auto-progress log watcher together. It serves the guide at
http://127.0.0.1:6754 and opens it in a borderless Edge app window.

## Run

1. Start `exile-leveling.exe`. A console window shows what it's doing; close it to stop.
2. The guide opens in an Edge app window. Drag it to the monitor you want; Edge
   remembers its size and place next time.
3. Start Path of Exile. The pill at the top right of the panel turns green (**Auto**)
   once the game's log is found, and the route advances as you change zones.

Running the exe again while it's already open just brings up another window.

| Option | Default | What it does |
| --- | --- | --- |
| `--browser edge\|default\|none` | `edge` | How to open the guide on start |
| `--log-path <file>` | found from the game | Use this `Client.txt` / `LatestClient.txt` |
| `--address <ip:port>` | `127.0.0.1:6754` | Where to serve. Keep the port the same: progress is saved per address |
| `--heart-beat <secs>` | `1` | How often the log is read |

Progress, your imported build and layout are saved in Edge for
`127.0.0.1:6754`. Builds imported on the hosted site don't carry over, so import
your PoB once on the **Build** page.

## Using the guide

- **Click** a step to mark it done. **Shift-click** marks it and every step before it.
  Shift-click a done step to clear it and every step after it.
- An act folds to one line once all its steps are done. Click its header to open it again.
- The right panel shows the tree, gem links and search strings together (**All**).
  The tabs show one at a time; the arrow at the left hides the panel.
- The tree and gem set follow the act you're in, matched by PoB titles such as
  `Act 2` or `Act 4-6 - 50 pts`. The arrows pick another set until you reach the next act.
- Drag the bar between the route and the panel to resize; double-click it to reset.

## Build

Needs [Node.js 22+](https://nodejs.org) and [Rust](https://rustup.rs).

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

Both projects are MIT licensed; see `LICENSE` and `log-api/LICENSE`.
