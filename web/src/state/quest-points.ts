import { Data } from "common";
import { buildDataSelector } from "./build-data";
import { characterLogAtom } from "./character";
import { currentActAtom } from "./current-act";
import { atom } from "jotai";

/**
 * The campaign's passive point quests, by act, with their points (PoB's Build.lua acts
 * table: 23, plus 1 for killing all bandits). "/passives" may leave out quests not done.
 */
const PASSIVE_QUESTS: [string, number, number][] = [
  ["The Dweller of the Deep", 1, 1],
  ["The Marooned Mariner", 1, 1],
  ["The Way Forward", 2, 1],
  ["Through Sacred Ground", 2, 1],
  ["Deal with the Bandits", 2, 1],
  ["Victario's Secrets", 3, 1],
  ["Piety's Pets", 3, 1],
  ["An Indomitable Spirit", 4, 1],
  ["In Service to Science", 5, 1],
  ["Kitava's Torments", 5, 1],
  ["The Father of War", 6, 1],
  ["The Puppet Mistress", 6, 1],
  ["The Cloven One", 6, 1],
  ["The Master of a Million Faces", 7, 1],
  ["Queen of Despair", 7, 1],
  ["Kishara's Star", 7, 1],
  ["Love is Dead", 8, 1],
  ["Reflection of Terror", 8, 1],
  ["The Gemling Legion", 8, 1],
  ["Queen of the Sands", 9, 1],
  ["The Ruler of Highgate", 9, 1],
  ["Vilenta's Vengeance", 10, 1],
  ["An End to Hunger", 10, 2],
];

/** A passive point quest your character left behind, and its act. */
export interface MissedQuest {
  name: string;
  act: number;
}

/**
 * Passive quests your character left behind: from an act finished before you typed the
 * "/passives" list (`act`: the act you were in then), missing from it or with fewer
 * points. The bandit quest only counts when you kill all three.
 */
export function missedQuests(
  quests: [string, number][],
  act: number | null,
  bandit: string,
): MissedQuest[] {
  if (act === null) return [];
  const got = new Map(quests);
  const missed: MissedQuest[] = [];
  for (const [name, questAct, points] of PASSIVE_QUESTS) {
    if (questAct >= act || (got.get(name) ?? 0) >= points) continue;
    if (name === "Deal with the Bandits" && bandit !== "None") continue;
    missed.push({ name, act: questAct });
  }
  return missed;
}

/**
 * The act you were in when you last typed /passives (from the campaign area the log had
 * you in then); null before any list, or when the area isn't known.
 */
const passivesActAtom = atom((get) => {
  const area = get(characterLogAtom)?.questsArea;
  return area ? (Data.Areas[area]?.act ?? null) : null;
});

/**
 * Your character's missed quest points (Build health, the bar's Campaign badge): only
 * acts finished when you last typed /passives, so finishing an act after it never shows a
 * false miss. Empty until you type /passives in game.
 */
export const missedQuestsAtom = atom((get) => {
  const quests = get(characterLogAtom)?.quests;
  if (!quests) return [];
  const listAct = get(passivesActAtom);
  const act = get(currentActAtom);
  // Typed in the epilogue (act 11): act 10 is done, though the route ends at act 10.
  const checked =
    listAct === null || act === null
      ? null
      : listAct > 10
        ? listAct
        : Math.min(listAct, act);
  return missedQuests(quests, checked, get(buildDataSelector).bandit);
});

/**
 * Acts finished since your last /passives aren't checked yet: type it again (or it was
 * never typed).
 */
export const passivesStaleAtom = atom((get) => {
  const character = get(characterLogAtom);
  if (character === null) return false;
  if (!character.quests) return true;
  const listAct = get(passivesActAtom);
  const act = get(currentActAtom);
  return listAct === null || (act !== null && listAct < act);
});
