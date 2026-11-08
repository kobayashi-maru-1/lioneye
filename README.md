# Lioneye

A Path of Exile leveling guide and Path of Building build view in one Windows app. It
follows your zones from the game's log, ticks off the campaign as you go, and shows your
build's stats, gear, gems, tree and trade searches for the loadout that matches your level.

**[Download lioneye.zip](https://github.com/kobayashi-maru-1/lioneye/releases/latest/download/lioneye.zip)**
(Windows 10 or 11; [all releases](https://github.com/kobayashi-maru-1/lioneye/releases)).

## Get started

1. Download `lioneye.zip`, extract it (right-click → **Extract All**) and run `lioneye.exe`.
   Windows SmartScreen may warn that it's unrecognized (the exe isn't signed): pick
   **More info** → **Run anyway**.
2. It runs in the tray (by the clock) and opens the guide in its own Edge window.
3. In **Settings** (⚙ in the top bar, after the panel buttons), import your Path of Building code, or **Open** a
   build file PoB saved.
4. Start Path of Exile in **Windowed** or **Windowed Fullscreen** mode. The guide follows
   your zones from the game's log.

New versions don't install themselves. When the footer shows **Update**, quit Lioneye from
its tray icon, download the zip again and replace `lioneye.exe`. Your progress and
imported build carry over.

## What's in it

- **Campaign** steps that tick off as you change zones, level up and kill bosses. Gem
  rewards name the quest or NPC.
- **Stats** from a bundled Path of Building, for the loadout that matches your level.
- **Gear** with item tooltips (Copy, Trade), **Gems** with Wiki and Trade links, a
  **Trade List** with pob.codes' search options, **Build health**, **Config** (with Custom
  Modifiers), the passive **Tree** and the build's **Notes**.
- **Open** a build file from Path of Building and the guide follows it: each save in PoB
  updates the guide. **Desktop PoB** (or **Edit** in Settings) opens the build in PoB
  Community or PoB Redux (Settings → Build → **Editor**).
- **Compare** any PoB code or build link with the guide's loadout: Stats, Passives,
  Skills and Items.
- An **in-game bar** over the game: its buttons jump the guide to a panel without leaving
  the game. Hover **Gems** for your links, or **Campaign** for your next steps.
- On a wide screen, Campaign and the other panels sit side by side.
- Trade and wiki links open in your usual Edge profile, where you're signed in.
- **Settings → App**: the in-game bar, which game log to follow and which browser opens the
  guide. The guide window reopens where you left it, and the line at the bottom says when
  there's a new release.

How it all works, the command-line options and where it keeps its data:
[DESKTOP.md](DESKTOP.md).

Lioneye was called Exile Leveling desktop up to v0.3.0.

## Credits

- [HeartofPhos/exile-leveling](https://github.com/HeartofPhos/exile-leveling): the guide,
  routes and game data, and [exile-log-api](https://github.com/HeartofPhos/exile-log-api),
  the log watcher. This repo is a fork of both.
- [Path of Building Community](https://github.com/PathOfBuildingCommunity/PathOfBuilding)
  (MIT): the stats, bundled in the exe.
- [PoB Redux](https://github.com/pobredux/pob-redux) (MIT): the Build health checks.

## Developing

Building the exe, the repo layout and pulling upstream updates: see
[DESKTOP.md](DESKTOP.md). The guide's own web app (from upstream):

- `npm i`
- `npm run dev -w web`

### Seeding

#### Passive Tree

- `npm run seed tree -w seeding`

#### General

- Find the list of required `dat` files in `seeding/data/index.ts`
- Use [exile-export](https://github.com/HeartofPhos/exile-export) to get required `.dat.json` files
- `npm run seed data -w seeding`

### Route

Upstream doesn't take PRs for route changes: the base route follows current speedrunning
strategies. Change the route to your playstyle with **Edit route** in the guide's Settings (**Route** section).
