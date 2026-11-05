# Leveling Companion design demo

Scripts that built the data for the Leveling Companion design canvas
(a pob.codes-style reference screen next to the leveling route). Design only:
this branch is not meant to be merged into `main`.

The design notes are on the canvas itself, below the interactive demo.

## Files

| File | What it does |
| --- | --- |
| `demo-prep.js` | Reads a PoB export and the guide's route, tree and gem data; writes `companion-data.json` and one tree SVG per loadout |
| `trade-query.js` | Builds official trade-site queries for each item (used by `demo-prep.js`) |
| `images-prep.js` | Finds item art (poe.ninja, trade site for missing bases), bundles it as `images.json` and tags each item |
| `pob-outline.js` | Prints the loadout structure of a PoB export |
| `canvas/` | The design canvas files: `Main.dc.html` (demo), `Design.dc.html` (notes), `canvas.json` |

## Run

Needs Node 22+. Run from this folder.

1. Download the reference data (not committed; refresh it each league):

   ```powershell
   New-Item -ItemType Directory -Force trade-data, ninja | Out-Null
   $ua = @{ 'User-Agent' = 'leveling-companion-demo/0.1' }
   foreach ($n in 'stats', 'items', 'leagues') {
       Invoke-WebRequest "https://www.pathofexile.com/api/trade/data/$n" -Headers $ua -OutFile "trade-data\$n.json"
   }
   $league = 'Standard'   # use the current league
   foreach ($t in 'UniqueWeapon', 'UniqueArmour', 'UniqueAccessory', 'UniqueFlask', 'UniqueJewel', 'BaseType', 'ClusterJewel') {
       Invoke-WebRequest "https://poe.ninja/poe1/api/economy/stash/current/item/overview?league=$league&type=$t" -Headers $ua -OutFile "ninja\$t.json"
   }
   ```

2. Build the data, then the art:

   ```powershell
   node demo-prep.js ..\.. C:\path\to\build.xml out
   node images-prep.js out <league>
   ```

`out` then holds `companion-data.json`, `images.json` and `tree-<loadout>.svg`.
On the canvas these were uploaded as assets and referenced by their `/_blob/` URLs.
