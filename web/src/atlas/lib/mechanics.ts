import type { AtlasData } from "./types.ts";

/** The panel's headings and their mechanics (ours to define; unknown names go to Extra). */
export const HEADINGS: { name: string; mechanics: string[] }[] = [
  {
    name: "Maps",
    mechanics: [
      "Atlas Anomalies",
      "Atlas Memories",
      "Divination Cards",
      "Gold",
      "Labyrinth",
      "Magic Monsters",
      "Maps",
      "Rare Monsters",
      "Threads",
      "Unique Monsters",
    ],
  },
  {
    name: "League",
    mechanics: [
      "Abyss",
      "Bestiary",
      "Betrayal",
      "Blight",
      "Breach",
      "Expedition",
      "Incursion",
      "Legion",
      "Ritual",
      "Ultimatum",
    ],
  },
  {
    name: "Extra",
    mechanics: [
      "Beyond",
      "Delirium",
      "Essence",
      "Mercenaries",
      "Mirage",
      "Rogue Exiles",
      "Sacred Flora",
      "Sentinels",
      "Settlers of Kalguur",
      "Shrines",
      "Strongboxes",
      "Synthesis",
      "Torment",
      "Viridian Wildwood",
    ],
  },
  {
    name: "Bosses",
    mechanics: [
      "Conquerors",
      "The Eater of Worlds",
      "The Searing Exarch",
      "The Shaper and Elder",
    ],
  },
];

export function headingOf(mechanic: string) {
  return HEADINGS.find((h) => h.mechanics.includes(mechanic))?.name ?? "Extra";
}

/** Colours for clusters, readable on Lioneye's near-black page; neighbours never share one. */
export const PALETTE = [
  "#e0a23a", // amber
  "#5aa9e6", // blue
  "#7fc97f", // green
  "#e06c75", // red
  "#c792ea", // purple
  "#4fd1c5", // teal
  "#f2d16b", // yellow
  "#f78c6b", // orange
  "#9aa7ff", // periwinkle
  "#b8e04f", // lime
  "#ff8fc7", // pink
  "#c49a6c", // tan
  "#3ccbf4", // cyan
  "#b0709f", // mauve
  "#a8a84a", // olive
  "#d0d0d0", // silver
];

export const TRAVEL_COLOUR = "#8a8a8a";

/** Clusters whose centres are closer than this are neighbours: they never share a colour. */
export const NEIGHBOUR_REACH = 3000;

/**
 * A colour per mechanic (DSatur): the mechanic with the most differently coloured
 * neighbours goes next and takes the first colour none of them has. 3.30 needs 14 of the
 * 16; if a later tree needs more, the extra mechanics reuse colours (the test catches it).
 */
export function mechanicColours(data: AtlasData): string[] {
  const n = data.mechanics.length;
  const touching = Array.from({ length: n }, () => new Set<number>());
  for (const p of data.labels)
    for (const q of data.labels)
      if (p.m !== q.m && Math.hypot(p.x - q.x, p.y - q.y) < NEIGHBOUR_REACH) {
        touching[p.m].add(q.m);
        touching[q.m].add(p.m);
      }
  const index = new Array<number>(n).fill(-1);
  for (let k = 0; k < n; k++) {
    let next = -1;
    let bestSat = -1;
    let bestDeg = -1;
    for (let m = 0; m < n; m++) {
      if (index[m] >= 0) continue;
      const sat = new Set(
        [...touching[m]].map((t) => index[t]).filter((c) => c >= 0),
      ).size;
      const deg = touching[m].size;
      if (sat > bestSat || (sat === bestSat && deg > bestDeg)) {
        next = m;
        bestSat = sat;
        bestDeg = deg;
      }
    }
    const taken = new Set([...touching[next]].map((t) => index[t]));
    let c = 0;
    while (taken.has(c)) c++;
    index[next] = c;
  }
  return index.map((c) => PALETTE[c % PALETTE.length]);
}

const MINOR = new Set(["the", "of", "and"]);

/**
 * A cluster label's letters: the first letter, or where another mechanic shares it, two:
 * the initials of its main words, else its first letter and a later one, whichever no
 * other mechanic took (in name order, so it's always the same).
 */
export function mechanicLetters(names: string[]): string[] {
  const words = (name: string) =>
    name.split(/\s+/).filter((w) => !MINOR.has(w.toLowerCase()));
  const first = (name: string) => (words(name)[0]?.[0] ?? "?").toUpperCase();
  const candidates = (name: string) => {
    const w = words(name);
    const out: string[] = [];
    if (w.length > 1) out.push((w[0][0] + w[1][0]).toUpperCase());
    const head = w[0][0].toUpperCase();
    for (const ch of w.join("").slice(1)) out.push(head + ch.toLowerCase());
    return out;
  };
  const letters = new Array<string>(names.length);
  const used = new Set<string>();
  const order = names
    .map((name, i) => ({ name, i }))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const { name, i } of order) {
    const shared = names.some(
      (other) => other !== name && first(other) === first(name),
    );
    const pick = shared
      ? (candidates(name).find((c) => !used.has(c)) ?? name.slice(0, 2))
      : first(name);
    letters[i] = pick;
    used.add(pick);
  }
  return letters;
}
