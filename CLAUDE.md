# exile-leveling desktop (poeleveling repo)

Fork of HeartofPhos/exile-leveling with HeartofPhos/exile-log-api merged
in under `log-api/` (git subtree), built into one Windows exe, `exile-leveling.exe`.
Read DESKTOP.md for how it runs, builds and pulls upstream updates.

## GitHub account

- This repo belongs to **kobayashi-maru-1**: <https://github.com/kobayashi-maru-1/poeleveling>
- Public fork of HeartofPhos/exile-leveling, kept public on purpose.
- `gh` on Andy's PC holds two accounts. AndyStout (work) stays the active one; don't switch it.
  Run gh for this repo as kobayashi-maru-1 per command:
  `GH_TOKEN=$(gh auth token -u kobayashi-maru-1) gh <command> -R kobayashi-maru-1/poeleveling`
  (PowerShell: `$env:GH_TOKEN = gh auth token -u kobayashi-maru-1`, then remove it after.)
- AndyStout is not a collaborator here: keep the work account out of this repo.
- `origin` uses `https://kobayashi-maru-1@github.com/...` so git pushes with that account's stored credential.
- Commits: `user.name kobayashi-maru-1` is set in this clone's local git config.

## Builds

- Build the exe in GitHub Actions (**Desktop exe** workflow) and download the artifact.
  `npm ci` runs hundreds of install scripts, and this PC holds tokens for work accounts.
  Use `.\build.ps1` locally only when Andy asks.
- Workflow actions are pinned to commit SHAs. Keep them pinned when updating.
- Review `package-lock.json` changes when merging upstream.

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
- Local builds (`.\build.ps1`, Node 22+, Rust) put Rust output in
  `%LOCALAPPDATA%\exile-leveling\cargo-target`, not in this OneDrive folder.
