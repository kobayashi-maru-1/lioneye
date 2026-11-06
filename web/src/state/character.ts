import { persistentAtom } from ".";
import { atom } from "jotai";
import { unwrap } from "jotai/utils";

/**
 * Your character from the game's log (log-api/src/character-log.rs): who it is, the
 * passives it took (by the log's ids, "dexterity869") and its latest "/passives" list.
 */
export interface CharacterLog {
  name: string;
  class: string;
  level: number;
  allocated: string[];
  /** [quest name, points]; null until you type /passives in game. */
  quests: [string, number][] | null;
}

/** Null until the exe has read the game's log (or it names no character yet). */
export const characterLogAtom = atom<CharacterLog | null>(null);

/** Log lines that change what the exe reads back: points, /passives, who is playing. */
const CHARACTER_LINE =
  /Successfully allocated passive skill id: |Passive Skill Points from quests:|\] : \(\d+ from |has been slain\.$|is now level \d+$/;

export function isCharacterLine(line: string) {
  return CHARACTER_LINE.test(line);
}

/** Asks the exe to read your character back from the log; null when it can't. */
export async function fetchCharacterLog(): Promise<CharacterLog | null> {
  try {
    const response = await fetch("/api/character");
    if (!response.ok) return null;
    const log = (await response.json()) as CharacterLog | null;
    return log && Array.isArray(log.allocated) ? log : null;
  } catch {
    return null;
  }
}

/** The log's passive ids → tree node numbers (RePoE, through the exe), once per load. */
let passiveIds: Promise<Record<string, number> | null> | null = null;
function fetchPassiveIds() {
  passiveIds ??= fetch("/api/data/repoe-passives")
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null)
    .then((ids: Record<string, number> | null) => {
      if (ids === null) passiveIds = null;
      return ids;
    });
  return passiveIds;
}

/** Your character's allocated tree nodes (node numbers, as the tree uses them); null when unknown. */
export const characterNodesAtom = atom(async (get) => {
  const log = get(characterLogAtom);
  if (log === null || log.allocated.length === 0) return null;
  const ids = await fetchPassiveIds();
  if (ids === null) return null;
  const nodes = new Set<string>();
  for (const id of log.allocated) {
    const node = ids[id];
    if (node !== undefined) nodes.add(String(node));
  }
  return { name: log.name, nodes: [...nodes] };
});

/** characterNodesAtom without waiting: null until known. */
export const characterNodesNowAtom = unwrap(
  characterNodesAtom,
  (previous) => previous ?? null,
);

/** What the Tree panel compares a loadout's tree with: the loadout before, or your character. */
export const treeCompareAtom = persistentAtom<"previous" | "character">(
  "tree-compare",
  "previous",
  0,
);
