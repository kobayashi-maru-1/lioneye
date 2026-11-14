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
const PALETTE = [
  "#e0a23a",
  "#5aa9e6",
  "#7fc97f",
  "#e06c75",
  "#c792ea",
  "#4fd1c5",
  "#f2d16b",
  "#f78c6b",
  "#9aa7ff",
  "#a3d977",
  "#ff8fc7",
  "#6fc3df",
];

export const TRAVEL_COLOUR = "#8a8a8a";

/**
 * A colour per mechanic: biggest mechanics first, each taking the first palette colour no
 * touching mechanic (an edge between their nodes, or labels within reach) already has.
 */
export function mechanicColours(data: AtlasData): string[] {
  const n = data.mechanics.length;
  const touching = Array.from({ length: n }, () => new Set<number>());
  const join = (a: number, b: number) => {
    if (a < 0 || b < 0 || a === b) return;
    touching[a].add(b);
    touching[b].add(a);
  };
  for (const { a, b } of data.edges) join(data.nodes[a].m, data.nodes[b].m);
  const REACH = 2600;
  for (const p of data.labels)
    for (const q of data.labels)
      if (Math.hypot(p.x - q.x, p.y - q.y) < REACH) join(p.m, q.m);
  const size = new Array(n).fill(0);
  for (const node of Object.values(data.nodes)) if (node.m >= 0) size[node.m]++;
  const order = [...Array(n).keys()].sort((a, b) => size[b] - size[a] || a - b);
  const colours: string[] = new Array(n);
  for (const m of order) {
    const taken = new Set([...touching[m]].map((t) => colours[t]));
    colours[m] =
      PALETTE.find((c) => !taken.has(c)) ?? PALETTE[m % PALETTE.length];
  }
  return colours;
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
