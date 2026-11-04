# exile-leveling desktop (poeleveling repo)

Private fork of HeartofPhos/exile-leveling with HeartofPhos/exile-log-api merged
in under `log-api/` (git subtree), built into one Windows exe, `exile-leveling.exe`.
Read DESKTOP.md for how it runs, builds and pulls upstream updates.

## GitHub account
- This repo belongs to **kobayashi-maru-1**: https://github.com/kobayashi-maru-1/poeleveling
- `origin` uses `https://kobayashi-maru-1@github.com/...` so git picks that account's stored credential.
- Before any `gh` command: `gh auth status`, then `gh auth switch -u kobayashi-maru-1` if another account is active.
- Commits: `user.name kobayashi-maru-1` is set in this clone's local git config.

## Remotes
- `origin`: kobayashi-maru-1/poeleveling (this app)
- `upstream`: HeartofPhos/exile-leveling (guide, routes, gems, trees)
- `upstream-log-api`: HeartofPhos/exile-log-api (subtree at `log-api/`)
- Branch `overlay-archive` and tag `overlay-final` keep the old Electron/Tauri overlay that main replaced.

## Rules
- Keep changes small and mergeable with upstream. Don't reformat upstream files.
  `common/` and `seeding/` (league data) stay untouched.
- UI labels: one word.
- PoE1 only. The watcher ignores clients installed under a "Path of Exile 2" folder.
- Build with `.\build.ps1` (Node 22+, Rust). Rust output goes to
  `%LOCALAPPDATA%\exile-leveling\cargo-target`, not into this OneDrive folder.
