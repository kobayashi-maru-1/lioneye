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
  /** The set's ascendancy points you don't have yet (green). */
  ascend?: string[];
  /** Your main-tree points the set doesn't have: to refund (red). */
  remove?: string[];
  /** The area to show, in tree coordinates: the next points, or a finished set's points. */
  view: { x: number; y: number; w: number; h: number };
  /** Where the set is among the build's tree sets (the tooltip's ‹ › arrows). */
  index?: number;
  count?: number;
}

/** Space around the next points, and the smallest area shown (tree units). */
const PADDING = 450;
const MIN_WIDTH = 2400;
const MIN_HEIGHT = 1600;

/**
 * The guide's main-tree points you don't have yet that are within NEXT_DEPTH points of
 * yours, walking only through points the guide takes. With none in reach (a new
 * character, the first set, a branch from the class start), every point to take is next.
 *
 * Also your main-tree points the set doesn't take, to refund. Not for a finished set
 * before the build's last (`last` false): you're past it, so yours it lacks are later
 * sets' points.
 */
export function treeTip(
  tree: UrlTree.Data,
  have: string[],
  skillTree: SkillTree.Data,
  last = true,
): TreeTip {
  const main = skillTree.graphs[skillTree.graphIndex];
  const haveSet = new Set(have);
  const setNodes = new Set(tree.nodes);
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

  // Walk from your points the set keeps: not from ones it refunds.
  const seeds = have.filter(
    (id) => main.nodes[id] !== undefined && setNodes.has(id),
  );
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

  // The ascendancy's points to take, at the next labs. They're far from the main tree, so
  // they don't count towards the area shown, nor towards the set being done.
  const ascendGraph = tree.ascendancy
    ? skillTree.graphs[tree.ascendancy.graphIndex]
    : undefined;
  const ascend = ascendGraph
    ? tree.nodes.filter(
        (id) =>
          ascendGraph.nodes[id] !== undefined &&
          ascendGraph.nodes[id].k !== "Ascendancy_Start" &&
          !haveSet.has(id),
      )
    : [];

  // Your main-tree points the set doesn't take (masteries too): a respec refunds them.
  const finished = toTake.size === 0;
  const remove =
    finished && !last
      ? []
      : have.filter((id) => main.nodes[id] !== undefined && !setNodes.has(id));

  // The next points and the points of yours they start from. A finished set (none left):
  // the set's own points, all yours now. Either way, with the points to refund near them
  // (a stray one across the tree would shrink the rest; the title counts them all).
  const shown = [...next];
  for (const id of next) {
    for (const other of neighbours.get(id) ?? []) {
      if (haveSet.has(other)) shown.push(other);
    }
  }
  if (shown.length === 0)
    shown.push(...tree.nodes.filter((id) => main.nodes[id] !== undefined));
  shown.push(...near(remove, shown, main.nodes));
  return {
    version: tree.version,
    set: tree.name,
    ascendancy: tree.ascendancy?.id,
    have,
    next: [...next],
    later,
    ascend,
    remove,
    view: bounds(shown, main.nodes),
  };
}

/** Of `ids`, those within MIN_WIDTH of the middle of `around`. */
function near(ids: string[], around: string[], nodes: SkillTree.NodeLookup) {
  const { x, y, w, h } = bounds(around, nodes);
  // No area to be near (none of `around` on the main tree): none.
  if (w === 0) return [];
  const cx = x + w / 2;
  const cy = y + h / 2;
  return ids.filter((id) => {
    const node = nodes[id];
    return (
      node !== undefined && Math.hypot(node.x - cx, node.y - cy) <= MIN_WIDTH
    );
  });
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
