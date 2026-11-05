import { atom } from "jotai";
import { unwrap } from "jotai/utils";
import { activeEdgeAtom, routeSelector } from "./route";

/** Act number of the route section you're in, from the auto-progress marker. */
const currentActAsync = atom(async (get) => {
  const route = await get(routeSelector);
  const [activeEdge] = get(activeEdgeAtom);

  let sectionName: string | null = route.sections[0]?.name ?? null;
  for (const section of route.sections) {
    const first = section.steps.find(
      (step) => step.type === "fragment_step" && step.edgeIndex !== null,
    );
    if (
      first !== undefined &&
      first.type === "fragment_step" &&
      first.edgeIndex !== null &&
      first.edgeIndex <= activeEdge
    ) {
      sectionName = section.name;
    }
  }

  return sectionName === null ? null : actNumber(sectionName);
});

// Unwrapped so a zone change keeps the last act while the new one resolves,
// instead of suspending (which swapped the page for the loader and lost the scroll).
export const currentActAtom = unwrap(currentActAsync, (prev) => prev ?? null);

function actNumber(name: string): number | null {
  const match = /\bact\s*(\d+)/i.exec(name);
  return match ? Number(match[1]) : null;
}

/**
 * Act range a PoB tree or skill set title covers: "Act 2", "Act 4-6 - 50 pts",
 * "Acts 7 to 10". A spaced dash ("Act 1 - 12 pts") is a separator, not a range.
 */
export function actRange(title: string): [number, number] | null {
  const match =
    /\bacts?\s*(\d+)(?:\s*(?:-|–)(?=\d)\s*(\d+)|\s+to\s+(\d+))?/i.exec(title);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[3] ?? match[1]);
  if (start < 1 || start > 10 || end < start) return null;
  return [start, Math.min(end, 10)];
}

/** Index of the first title whose act range covers `act`, else null. */
export function indexForAct(titles: string[], act: number | null) {
  if (act === null) return null;
  const index = titles.findIndex((title) => {
    const range = actRange(title);
    return range !== null && range[0] <= act && act <= range[1];
  });
  return index === -1 ? null : index;
}

/**
 * Level range a PoB set title names: "Lvl 30", "Level 12-28", "lv. 45 to 60". Open-ended
 * ("Lvl 30") runs until the next title's level.
 */
export function levelRange(title: string): [number, number | null] | null {
  const match = /\b(?:lvl|level|lv)\.?\s*(\d+)(?:\s*(?:-|–|to)\s*(\d+))?/i.exec(
    title,
  );
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] === undefined ? null : Number(match[2]);
  if (start < 1 || start > 100 || (end !== null && end < start)) return null;
  return [start, end];
}

/**
 * Index of the title for your level: the one whose range covers it, else the highest
 * starting level at or below it. Null when no title names a level (or no level yet).
 */
export function indexForLevel(titles: string[], level: number | null) {
  if (level === null) return null;
  let best: { index: number; start: number } | null = null;
  for (const [index, title] of titles.entries()) {
    const range = levelRange(title);
    if (range === null || range[0] > level) continue;
    if (range[1] !== null && level <= range[1]) return index;
    if (best === null || range[0] > best.start)
      best = { index, start: range[0] };
  }
  return best?.index ?? null;
}

/** PoB loadout links like " {a1,a2}" are for PoB, not for reading. */
export function displaySetName(name: string) {
  return name.replace(/\s*\{[^}]*\}\s*$/, "");
}
