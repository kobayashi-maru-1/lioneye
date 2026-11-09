import type { UrlTree } from "./url-tree";
import type { SkillTree } from "common";

/** How many points out from your tree count as next, along every path the guide takes. */
export const NEXT_DEPTH = 3;

/** The in-game bar's Tree tooltip: your tree, the guide's next points, zoomed to them. */
export interface TreeTip {
  /** The tree data version (common/data/tree/<version>.json). */
  version: string;
  /** The tree set's name, as PoB has it (colour codes and all). */
  set: string;
  ascendancy?: string;
  /** Your points (blue). */
  have: string[];
  /** The guide's points within NEXT_DEPTH of yours (green). */
  next: string[];
  /** The guide's other points still to take (dim green). */
  later: string[];
  /** The area to show, in tree coordinates. */
  view: { x: number; y: number; w: number; h: number };
  /** Where the set is among the build's tree sets (the tooltip's ‹ › arrows). */
  index?: number;
  count?: number;
  /** The set's ascendancy notables you don't have yet, nearest the start first. */
  ascendancyNext?: { name: string; stats: string[] }[];
}

/** The tree's ascendancy notables still to take, in path order from its start. */
function ascendancyNext(
  tree: UrlTree.Data,
  haveSet: Set<string>,
  skillTree: SkillTree.Data,
) {
  const graph =
    tree.ascendancy !== undefined
      ? skillTree.graphs[tree.ascendancy.graphIndex]
      : undefined;
  if (!graph || !tree.ascendancy) return [];
  const want = new Set(
    tree.nodes.filter(
      (id) => graph.nodes[id]?.k === "Notable" && !haveSet.has(id),
    ),
  );
  if (want.size === 0) return [];
  const neighbours = new Map<string, string[]>();
  for (const { a, b } of graph.connections) {
    neighbours.set(a, [...(neighbours.get(a) ?? []), b]);
    neighbours.set(b, [...(neighbours.get(b) ?? []), a]);
  }
  // Walk out from the start: nearer notables come first.
  const order: string[] = [];
  const seen = new Set([tree.ascendancy.startNodeId]);
  let frontier = [tree.ascendancy.startNodeId];
  while (frontier.length > 0) {
    const reached: string[] = [];
    for (const id of frontier) {
      if (want.has(id)) order.push(id);
      for (const other of neighbours.get(id) ?? []) {
        if (!seen.has(other)) {
          seen.add(other);
          reached.push(other);
        }
      }
    }
    frontier = reached;
  }
  // Any the walk missed (no path in the data), after the rest.
  for (const id of want) if (!order.includes(id)) order.push(id);
  return order.map((id) => ({
    name: graph.nodes[id].text,
    stats: graph.nodes[id].stats ?? [],
  }));
}

/** Space around the next points, and the smallest area shown (tree units). */
const PADDING = 450;
const MIN_WIDTH = 2400;
const MIN_HEIGHT = 1600;

/**
 * The guide's main-tree points you don't have yet that are within NEXT_DEPTH points of
 * yours, walking only through points the guide takes. With none in reach (a new
 * character, the first set, a branch from the class start), every point to take is next.
 */
export function treeTip(
  tree: UrlTree.Data,
  have: string[],
  skillTree: SkillTree.Data,
): TreeTip {
  const main = skillTree.graphs[skillTree.graphIndex];
  const haveSet = new Set(have);
  // Masteries have no connections to walk; they're picked with their notables.
  const toTake = new Set(
    tree.nodes.filter(
      (id) =>
        main.nodes[id] !== undefined &&
        main.nodes[id].k !== "Mastery" &&
        !haveSet.has(id),
    ),
  );

  const neighbours = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const list = neighbours.get(a);
    if (list) list.push(b);
    else neighbours.set(a, [b]);
  };
  for (const { a, b } of main.connections) {
    link(a, b);
    link(b, a);
  }

  const seeds = have.filter((id) => main.nodes[id] !== undefined);
  const next = new Set<string>();
  if (seeds.length > 0) {
    let frontier = seeds;
    for (let depth = 1; depth <= NEXT_DEPTH && frontier.length > 0; depth++) {
      const reached: string[] = [];
      for (const id of frontier) {
        for (const other of neighbours.get(id) ?? []) {
          if (toTake.has(other) && !next.has(other)) {
            next.add(other);
            reached.push(other);
          }
        }
      }
      frontier = reached;
    }
  }
  // Nothing within reach of yours: the guide's points left start elsewhere (the tree data
  // has no class start to walk from, and a respec'd tree may not touch the guide's). Then
  // all of them are next.
  if (next.size === 0) for (const id of toTake) next.add(id);
  const later = [...toTake].filter((id) => !next.has(id));

  // The next points and the points of yours they start from.
  const shown = [...next];
  for (const id of next) {
    for (const other of neighbours.get(id) ?? []) {
      if (haveSet.has(other)) shown.push(other);
    }
  }
  return {
    version: tree.version,
    set: tree.name,
    ascendancy: tree.ascendancy?.id,
    have,
    next: [...next],
    later,
    view: bounds(shown, main.nodes),
    ascendancyNext: ascendancyNext(tree, haveSet, skillTree),
  };
}

function bounds(ids: string[], nodes: SkillTree.NodeLookup) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of ids) {
    const node = nodes[id];
    if (!node) continue;
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x);
    maxY = Math.max(maxY, node.y);
  }
  if (minX === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
  const w = Math.max(maxX - minX + PADDING * 2, MIN_WIDTH);
  const h = Math.max(maxY - minY + PADDING * 2, MIN_HEIGHT);
  return {
    x: (minX + maxX) / 2 - w / 2,
    y: (minY + maxY) / 2 - h / 2,
    w,
    h,
  };
}
