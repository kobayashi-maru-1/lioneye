import { connected, route, type Graph } from "./graph.ts";
import { mechanicOf, type AtlasData, type Plan } from "./types.ts";

/**
 * Taking a whole mechanic or cluster at once (right-click or long-press): every node of it
 * allocated by the fewest points, or, when all of them already are, refunded.
 */

/** A mechanic's nodes: its clusters, and travel notables shown in its colour. */
export function mechanicNodes(data: AtlasData, m: number): string[] {
  return Object.entries(data.nodes)
    .filter(([, node]) => node.kind !== "start" && mechanicOf(node) === m)
    .map(([id]) => id);
}

/** One cluster's nodes (its group), and travel notables of its mechanic beside it. */
export function clusterNodes(
  graph: Graph,
  data: AtlasData,
  group: string,
): string[] {
  const members = Object.entries(data.nodes)
    .filter(([, node]) => node.g === group && node.kind !== "start")
    .map(([id]) => id);
  const m = members.length ? data.nodes[members[0]].m : -1;
  const inGroup = new Set(members);
  const beside = Object.entries(data.nodes)
    .filter(
      ([id, node]) =>
        node.m < 0 &&
        node.a === m &&
        (graph.neighbours.get(id) ?? []).some((n) => inGroup.has(n)),
    )
    .map(([id]) => id);
  return [...members, ...beside];
}

export type TakeResult =
  | { kind: "allocate"; plan: Plan; points: number }
  | { kind: "refund"; plan: Plan; points: number; rerouted: number }
  | { kind: "over"; needs: number; left: number }
  | { kind: "none" };

/**
 * All of `targets` allocated, cheapest first (from what's allocated, the nearest target
 * not yet taken, again and again), as long as it fits `budget`; or, when every target is
 * already allocated, all of them refunded with the pathing that led only to them (dead ends
 * back to where it meets the rest). Other clusters the refunded nodes joined to the start
 * are routed around them instead (`rerouted` new nodes), never dropped.
 */
export function take(
  graph: Graph,
  data: AtlasData,
  plan: Plan,
  targets: string[],
  budget: number,
): TakeResult {
  const wanted = targets.filter((id) => graph.allocatable.has(id));
  if (wanted.length === 0) return { kind: "none" };
  const allocated = new Set(plan.allocated);

  if (wanted.every((id) => allocated.has(id))) {
    const gone = new Set(wanted);
    const rest = new Set(allocated);
    for (const id of wanted) rest.delete(id);
    // What the plan is for stays: notables, keystones and choice nodes, and every node of
    // a cluster it holds (one with such a node allocated). Small nodes of a cluster it
    // only passed through count as pathing.
    const isKey = (id: string) => {
      const node = data.nodes[id];
      return node.kind !== "small" || !!node.choices;
    };
    const held = new Set(
      [...rest]
        .filter((id) => isKey(id) && mechanicOf(data.nodes[id]) >= 0)
        .map((id) => data.nodes[id].g),
    );
    const wantedNode = (id: string) =>
      isKey(id) ||
      (mechanicOf(data.nodes[id]) >= 0 && held.has(data.nodes[id].g));
    // Anything wanted that only the refunded nodes joined to the start: routed around them.
    const rerouted = rejoin(graph, rest, gone, wantedNode);
    // Pathing left hanging: small nodes that are now dead ends, from the refunded nodes
    // back along the path to where it branches.
    const ends = wanted.flatMap((id) => graph.neighbours.get(id) ?? []);
    while (ends.length) {
      const id = ends.pop()!;
      if (!rest.has(id) || wantedNode(id)) continue;
      const near = (graph.neighbours.get(id) ?? []).filter(
        (n) => rest.has(n) || n === graph.start,
      );
      if (near.length > 1) continue;
      rest.delete(id);
      ends.push(...near);
    }
    const kept = connected(graph, rest);
    const allocatedNext = [
      ...plan.allocated.filter((id) => kept.has(id)),
      ...rerouted.filter((id) => kept.has(id)),
    ];
    const choices = Object.fromEntries(
      Object.entries(plan.choices).filter(([id]) => kept.has(id)),
    );
    return {
      kind: "refund",
      plan: { ...plan, allocated: allocatedNext, choices },
      points: plan.allocated.filter((id) => !kept.has(id)).length,
      rerouted: rerouted.filter((id) => kept.has(id)).length,
    };
  }

  const next = new Set(allocated);
  const added: string[] = [];
  let left = wanted.filter((id) => !next.has(id));
  while (left.length) {
    let best: string[] | null = null;
    for (const id of left) {
      const path = route(graph, next, id);
      if (path !== null && (best === null || path.length < best.length))
        best = path;
    }
    if (best === null) break; // the rest can't be reached
    for (const id of best) {
      next.add(id);
      added.push(id);
    }
    left = left.filter((id) => !next.has(id));
  }
  if (added.length === 0) return { kind: "none" };
  const spare = budget - plan.allocated.length;
  if (added.length > spare)
    return { kind: "over", needs: added.length, left: Math.max(0, spare) };
  return {
    kind: "allocate",
    plan: { ...plan, allocated: [...plan.allocated, ...added] },
    points: added.length,
  };
}

/**
 * Joins back to the start every wanted node of `nodes` that isn't joined, never through
 * `avoid`: from what's joined, the cheapest path (nodes already in `nodes` free) to the
 * nearest one, added, again and again. Adds to `nodes`; returns the nodes added. Wanted
 * nodes that can't be reached stay unjoined (and are dropped by the caller).
 */
function rejoin(
  graph: Graph,
  nodes: Set<string>,
  avoid: ReadonlySet<string>,
  wanted: (id: string) => boolean,
): string[] {
  const added: string[] = [];
  for (;;) {
    const joined = connected(graph, nodes);
    joined.add(graph.start);
    if (![...nodes].some((id) => !joined.has(id) && wanted(id))) return added;
    // Breadth-first by cost, a list per cost: a node in `nodes` is free, others cost one.
    const dist = new Map<string, number>();
    const parent = new Map<string, string>();
    const levels: string[][] = [[...joined]];
    for (const id of joined) dist.set(id, 0);
    let target: string | null = null;
    search: for (let d = 0; d < levels.length; d++) {
      for (const id of levels[d] ?? []) {
        if (dist.get(id)! < d) continue;
        if (!joined.has(id) && nodes.has(id) && wanted(id)) {
          target = id;
          break search;
        }
        for (const next of graph.neighbours.get(id) ?? []) {
          if (avoid.has(next) || next === graph.start) continue;
          const nd = d + (nodes.has(next) ? 0 : 1);
          if (nd >= (dist.get(next) ?? Infinity)) continue;
          dist.set(next, nd);
          parent.set(next, id);
          (levels[nd] ??= []).push(next);
        }
      }
    }
    if (target === null) return added;
    for (
      let at: string | undefined = target;
      at !== undefined && !joined.has(at);
      at = parent.get(at)
    )
      if (!nodes.has(at)) {
        nodes.add(at);
        added.push(at);
      }
  }
}
