import { characterNodesNowAtom } from "../character";
import { displaySetName } from "../current-act";
import { TREE_DATA_LOOKUP } from ".";
import { type UrlTree, urlTreesSelector } from "./url-tree";
import type { SkillTree } from "common";
import { atom } from "jotai";
import { unwrap } from "jotai/utils";

/** Your character's progress through the build's tree sets (urlTreesSelector's order). */
export interface TreeProgress {
  titles: string[];
  /** Per set: your character (from the game's log) has all its main-tree points. */
  done: boolean[];
}

/**
 * A set is finished when you have every main-tree point of it. Masteries and ascendancy
 * points don't count: a lab you haven't run doesn't hold the next set back.
 */
export function treeDone(
  tree: UrlTree.Data,
  have: Set<string>,
  skillTree: SkillTree.Data,
) {
  const main = skillTree.graphs[skillTree.graphIndex].nodes;
  return tree.nodes.every(
    (id) => main[id] === undefined || main[id].k === "Mastery" || have.has(id),
  );
}

const treeProgressAsync = atom(async (get) => {
  const character = get(characterNodesNowAtom);
  if (character === null) return null;
  const trees = await get(urlTreesSelector);
  const lookup = trees[0] && TREE_DATA_LOOKUP[trees[0].version];
  if (!lookup) return null;
  const [skillTree] = await lookup;
  const have = new Set(character.nodes);
  const progress: TreeProgress = {
    titles: trees.map((tree) => tree.name),
    done: trees.map((tree) => treeDone(tree, have, skillTree)),
  };
  return progress;
});

/** TreeProgress without waiting; null until your character's tree is known. */
export const treeProgressAtom = unwrap(
  treeProgressAsync,
  (previous) => previous ?? null,
);

/** "^2Lvl 1-12 {1}" → "lvl 1-12": PoB colour codes and loadout links don't name a set. */
function setKey(title: string) {
  return displaySetName(title.replace(/\^(x[0-9a-fA-F]{6}|[0-9])/g, ""))
    .trim()
    .toLowerCase();
}

/**
 * For sets named by neither level nor act: the index among `titles` (loadouts, tree or
 * skill sets) of the tree set after the last one you've finished (the last when all are).
 * Never back to an earlier set when a later one refunds its points. Matched by name, else
 * by position when the lists are as long; null when they don't line up.
 */
export function progressIndex(
  titles: string[],
  progress: TreeProgress | null,
): number | null {
  if (progress === null || progress.done.length === 0) return null;
  const at = Math.min(
    progress.done.lastIndexOf(true) + 1,
    progress.done.length - 1,
  );
  const key = setKey(progress.titles[at]);
  const byName = titles.findIndex((title) => setKey(title) === key);
  if (byName !== -1) return byName;
  return titles.length === progress.done.length ? at : null;
}

/**
 * The Tree panel's look-ahead: once you have every point of the set at `index`, the next
 * set you haven't finished (index unchanged when there's none, or progress is unknown).
 */
export function lookAhead(
  titles: string[],
  index: number,
  progress: TreeProgress | null,
) {
  // Another build's progress (kept while the new build's loads) doesn't count.
  if (
    progress === null ||
    progress.titles.length !== titles.length ||
    progress.titles.some((title, i) => title !== titles[i]) ||
    !progress.done[index]
  )
    return index;
  for (let next = index + 1; next < titles.length; next++) {
    if (!progress.done[next]) return next;
  }
  return titles.length - 1; // Every set finished: the final tree.
}
