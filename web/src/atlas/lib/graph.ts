import { MAX_BUDGET, type AtlasData, type Plan } from "./types.ts";

/** The tree as a routing graph: neighbours sorted by node id, gateway pairs included. */
export interface Graph {
  start: string;
  neighbours: Map<string, string[]>;
  /** Nodes that can be allocated (all but the start). */
  allocatable: Set<string>;
}

const byId = (a: string, b: string) => Number(a) - Number(b);

export function buildGraph(data: AtlasData): Graph {
  const neighbours = new Map<string, string[]>();
  for (const id of Object.keys(data.nodes)) neighbours.set(id, []);
  for (const { a, b } of data.edges) {
    neighbours.get(a)?.push(b);
    neighbours.get(b)?.push(a);
  }
  for (const list of neighbours.values()) list.sort(byId);
  const allocatable = new Set(
    Object.keys(data.nodes).filter((id) => id !== data.start),
  );
  return { start: data.start, neighbours, allocatable };
}

/**
 * The shortest additional path to `target`: a breadth-first search out from the start and
 * every allocated node, through unallocated nodes only. Returns the nodes to add, nearest
 * first, target last ([] when it's already allocated, null when it can't be reached). Ties
 * go to the path found first (the start, then allocated nodes and neighbours in id order),
 * so the same tree always gives the same route.
 */
export function route(
  graph: Graph,
  allocated: ReadonlySet<string>,
  target: string,
): string[] | null {
  if (target === graph.start || allocated.has(target)) return [];
  if (!graph.allocatable.has(target)) return null;
  const sources = [graph.start, ...[...allocated].sort(byId)];
  const parent = new Map<string, string | null>();
  const queue: string[] = [];
  for (const id of sources) {
    parent.set(id, null);
    queue.push(id);
  }
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    for (const next of graph.neighbours.get(id) ?? []) {
      if (parent.has(next)) continue;
      parent.set(next, id);
      if (next === target) {
        const path: string[] = [];
        for (let at: string | null = next; at !== null; at = parent.get(at)!) {
          if (at === graph.start || allocated.has(at)) break;
          path.push(at);
        }
        return path.reverse();
      }
      queue.push(next);
    }
  }
  return null;
}

/** Every node's cost from the plan as it stands (allocated ones and the start: 0). */
export function costs(
  graph: Graph,
  allocated: ReadonlySet<string>,
): Map<string, number> {
  const cost = new Map<string, number>();
  const queue = [graph.start, ...allocated];
  for (const id of queue) cost.set(id, 0);
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    for (const next of graph.neighbours.get(id) ?? []) {
      if (cost.has(next)) continue;
      cost.set(next, cost.get(id)! + 1);
      queue.push(next);
    }
  }
  return cost;
}

/** The allocated nodes still joined to the start through allocated nodes. */
export function connected(
  graph: Graph,
  allocated: ReadonlySet<string>,
): Set<string> {
  const reached = new Set<string>();
  const queue = [graph.start];
  for (let head = 0; head < queue.length; head++) {
    for (const next of graph.neighbours.get(queue[head]) ?? []) {
      if (!allocated.has(next) || reached.has(next)) continue;
      reached.add(next);
      queue.push(next);
    }
  }
  return reached;
}

/** What refunding `node` removes: it, plus every allocated node it alone joined to the start. */
export function refundSet(
  graph: Graph,
  allocated: ReadonlySet<string>,
  node: string,
): Set<string> {
  if (!allocated.has(node)) return new Set();
  const rest = new Set(allocated);
  rest.delete(node);
  const kept = connected(graph, rest);
  return new Set([...allocated].filter((id) => !kept.has(id)));
}

/**
 * A plan made safe, from anything (stored, linked or imported): unknown or unallocatable
 * ids dropped, nodes cut off from the start dropped, choices kept only for allocated choice
 * nodes and known options, budget 1–150 (150 when missing).
 */
export function normalise(
  graph: Graph,
  data: AtlasData,
  plan: Partial<Plan> | null | undefined,
): Plan {
  const given: unknown[] = Array.isArray(plan?.allocated) ? plan.allocated : [];
  const picks: Record<string, unknown> =
    plan?.choices && typeof plan.choices === "object" ? plan.choices : {};
  const wanted = new Set(
    given.map(String).filter((id) => graph.allocatable.has(id)),
  );
  const allocated = [...connected(graph, wanted)].sort(byId);
  const choices: Record<string, number> = {};
  for (const id of allocated) {
    const options = data.nodes[id]?.choices;
    const picked = Object.hasOwn(picks, id) ? Number(picks[id]) : NaN;
    if (options && options.some((o) => o.effect === picked))
      choices[id] = picked;
  }
  const raw = Number(plan?.budget ?? NaN);
  const budget = Number.isFinite(raw)
    ? Math.min(MAX_BUDGET, Math.max(1, Math.round(raw)))
    : MAX_BUDGET;
  return { allocated, choices, budget };
}

/** A route of `cost` points fits the budget with `used` points already spent. */
export function fits(used: number, cost: number, budget: number) {
  return used + cost <= budget;
}

export function emptyPlan(): Plan {
  return { allocated: [], choices: {}, budget: MAX_BUDGET };
}
