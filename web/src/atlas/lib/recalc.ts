import type { Graph } from "./graph.ts";
import { mechanicOf, type AtlasData, type Plan } from "./types.ts";

/**
 * Recalc: the cheapest paths to what a plan is for. The nodes it keeps are the allocated
 * cluster nodes, notables, keystones and choice nodes; the small pathing nodes between
 * them are free to change. Finding the cheapest join for sure (a Steiner tree) takes too
 * long for big plans, so this builds joins several ways and improves each by tearing out
 * stretches of pathing and joining again; it never returns more points than the plan has.
 */

/** The allocated nodes Recalc keeps. */
export function kept(data: AtlasData, plan: Plan): Set<string> {
  return new Set(
    plan.allocated.filter((id) => {
      const node = data.nodes[id];
      return (
        node !== undefined &&
        node.kind !== "start" &&
        (mechanicOf(node) >= 0 || node.kind !== "small" || !!node.choices)
      );
    }),
  );
}

/** The plan with the same kept nodes joined by the fewest points it found (the same plan
 *  when nothing cheaper exists). Deterministic: the same plan always gives the same result. */
export function recalc(graph: Graph, data: AtlasData, plan: Plan): Plan {
  const keep = kept(data, plan);
  const current = new Set(plan.allocated);
  // Equal points: fewer nodes taken from clusters the plan didn't use (a later Recalc
  // would keep them), then fewer changes.
  const borrowed = (set: Set<string>) =>
    [...set].filter((id) => !current.has(id) && mechanicOf(data.nodes[id]) >= 0)
      .length;
  const better = (a: Set<string>, b: Set<string>) =>
    a.size !== b.size
      ? a.size < b.size
      : borrowed(a) !== borrowed(b)
        ? borrowed(a) < borrowed(b)
        : changes(a, current) < changes(b, current);

  // The plan as it is first (joined up, in case anything kept hangs loose), then fresh joins.
  current.delete(graph.start);
  let best = improve(graph, keep, join(graph, keep, new Set(current)));
  const random = seeded(plan.allocated.length * 7919 + keep.size);
  for (let i = 0; i < RESTARTS; i++) {
    const order = i === 0 ? graph.neighbours : shuffled(graph, random);
    const found = improve(graph, keep, join(graph, keep, new Set(keep), order));
    if (better(found, best)) best = found;
  }
  // A valid plan never comes back bigger; loose input (not normalised) comes back joined.
  const joined = reach(graph, current);
  const valid =
    plan.allocated.length === current.size &&
    [...current].every((id) => joined.has(id));
  if (valid && best.size >= current.size) return plan;
  const allocated = [...best].sort((a, b) => Number(a) - Number(b));
  const choices = Object.fromEntries(
    Object.entries(plan.choices).filter(([id]) => best.has(id)),
  );
  return { ...plan, allocated, choices };
}

/** Joins built from scratch (the first in id order, the rest shuffled). */
const RESTARTS = 8;
/** Improvement rounds per join (each round tries every stretch of pathing). */
const ROUNDS = 20;

const changes = (a: Set<string>, b: Set<string>) => {
  let n = 0;
  for (const id of a) if (!b.has(id)) n += 1;
  for (const id of b) if (!a.has(id)) n += 1;
  return n;
};

/** A small seeded random generator (mulberry32). */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The nodes of `nodes` (plus the start) joined to the start through `nodes`. */
function reach(graph: Graph, nodes: ReadonlySet<string>, from = graph.start) {
  const seen = new Set([from]);
  const queue = [from];
  for (let head = 0; head < queue.length; head++)
    for (const next of graph.neighbours.get(queue[head]) ?? [])
      if (nodes.has(next) && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
  return seen;
}

/** Neighbour lists in a shuffled order, for another join of equal cost. */
function shuffled(graph: Graph, random: () => number) {
  const out = new Map<string, string[]>();
  for (const [id, list] of graph.neighbours) {
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    out.set(id, copy);
  }
  return out;
}

/**
 * Joins every kept node to the start: from the start's part, the cheapest path (counting
 * only nodes not already in `nodes`) to the nearest kept node not yet joined, added and
 * repeated. `neighbours` sets the order ties are tried in (the graph's id order by default).
 */
function join(
  graph: Graph,
  keep: ReadonlySet<string>,
  nodes: Set<string>,
  neighbours = graph.neighbours,
): Set<string> {
  for (;;) {
    const tree = reach(graph, nodes);
    if ([...keep].every((id) => tree.has(id))) return prune(graph, keep, nodes);
    // Breadth-first by cost, a list per cost: stepping onto a node already in `nodes` is
    // free (same list), any other costs a point (the next list).
    const dist = new Map<string, number>();
    const parent = new Map<string, string>();
    const levels: string[][] = [[...tree]];
    for (const id of tree) dist.set(id, 0);
    let target: string | null = null;
    search: for (let d = 0; d < levels.length; d++) {
      const level = levels[d];
      for (let i = 0; i < level.length; i++) {
        const id = level[i];
        if (dist.get(id)! < d) continue; // reached cheaper since
        if (!tree.has(id) && keep.has(id)) {
          target = id;
          break search;
        }
        for (const next of neighbours.get(id) ?? []) {
          if (next === graph.start) continue;
          const nd = d + (nodes.has(next) ? 0 : 1);
          if (nd >= (dist.get(next) ?? Infinity)) continue;
          dist.set(next, nd);
          parent.set(next, id);
          (levels[nd] ??= []).push(next);
        }
      }
    }
    if (target === null) return prune(graph, keep, nodes); // unreachable: keep what's joined
    for (
      let at: string | undefined = target;
      at !== undefined && !tree.has(at);
      at = parent.get(at)
    )
      nodes.add(at);
  }
}

/** Drops what isn't joined to the start, then pathing dead ends (over and over). */
function prune(
  graph: Graph,
  keep: ReadonlySet<string>,
  nodes: ReadonlySet<string>,
): Set<string> {
  const result = reach(graph, nodes);
  const near = (id: string) =>
    (graph.neighbours.get(id) ?? []).filter((n) => result.has(n));
  // Pathing leaves first (cheap), over and over.
  const leaves = [...result].filter(
    (id) => id !== graph.start && !keep.has(id),
  );
  while (leaves.length) {
    const id = leaves.pop()!;
    if (!result.has(id) || near(id).length > 1) continue;
    result.delete(id);
    for (const n of near(id))
      if (n !== graph.start && !keep.has(n)) leaves.push(n);
  }
  // A node that's redundant only because of a loop stays: improve() tries removing each
  // pathing node on its own, which finds it.
  result.delete(graph.start);
  return result;
}

/** Each run of pathing nodes (not kept) joined to one another: the stretches to try. */
function stretches(
  graph: Graph,
  keep: ReadonlySet<string>,
  nodes: ReadonlySet<string>,
): string[][] {
  const out: string[][] = [];
  const seen = new Set<string>();
  const pathing = [...nodes].filter((id) => !keep.has(id)).sort();
  const free = new Set(pathing);
  for (const id of pathing) {
    // The node alone, and the chain of two-way pathing nodes through it.
    const chain = [id];
    for (const side of graph.neighbours.get(id) ?? []) {
      let prev = id;
      let at = side;
      while (free.has(at) && !chain.includes(at)) {
        const onward = (graph.neighbours.get(at) ?? []).filter(
          (n) => n !== prev && (nodes.has(n) || n === graph.start),
        );
        chain.push(at);
        if (onward.length !== 1) break;
        prev = at;
        at = onward[0];
      }
    }
    out.push([id]);
    if (chain.length > 1) out.push(chain);
    // The whole run of pathing it belongs to.
    if (seen.has(id)) continue;
    const run = [...reach(graph, free, id)];
    run.forEach((n) => seen.add(n));
    if (run.length > 1) out.push(run);
  }
  const keys = new Set<string>();
  return out.filter((stretch) => {
    const key = [...stretch].sort().join(",");
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

/** Tears out each stretch of pathing and joins again; keeps any join with fewer points. */
function improve(
  graph: Graph,
  keep: ReadonlySet<string>,
  start: Set<string>,
): Set<string> {
  let best = start;
  for (let round = 0; round < ROUNDS; round++) {
    let improved = false;
    for (const stretch of stretches(graph, keep, best)) {
      const rest = new Set(best);
      for (const id of stretch) rest.delete(id);
      const found = join(graph, keep, rest);
      if (found.size < best.size) {
        best = found;
        improved = true;
        break;
      }
    }
    if (!improved) break;
  }
  // Last, any single pathing node nothing needs (a loop the rounds didn't reach).
  for (const id of [...best].sort((a, b) => Number(b) - Number(a))) {
    if (keep.has(id) || !best.has(id)) continue;
    const rest = new Set(best);
    rest.delete(id);
    const r = reach(graph, rest);
    if ([...keep].every((k) => r.has(k))) best = prune(graph, keep, rest);
  }
  return best;
}
