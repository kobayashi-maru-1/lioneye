import { flat } from "./text.ts";
import { mechanicOf, type AtlasData, type Plan } from "./types.ts";

/** One combined stat line: identical lines with one number are summed. */
export interface BonusLine {
  text: string;
  /** Nodes it comes from. */
  nodes: string[];
  /** How many lines were merged into it (shown when they couldn't be summed). */
  count: number;
}

export interface BonusGroup {
  mechanic: number;
  nodes: number;
  lines: BonusLine[];
}

export interface Bonuses {
  groups: BonusGroup[];
  keystones: { id: string; name: string }[];
  choices: { id: string; name: string; stats: string[] }[];
}

const NUMBER = /-?\d+(?:\.\d+)?/g;
const PERCENT = /-?\d+(?:\.\d+)?(?=%)/g;

/** The number a line's value is: its only percentage, else its only number; null if unclear. */
function valueOf(text: string): { value: number; template: string } | null {
  const percents = text.match(PERCENT) ?? [];
  if (percents.length === 1)
    return { value: Number(percents[0]), template: text.replace(PERCENT, "#") };
  const numbers = text.match(NUMBER) ?? [];
  if (numbers.length === 1)
    return { value: Number(numbers[0]), template: text.replace(NUMBER, "#") };
  return null;
}

/** A node's stat lines in the plan: a choice node's are its picked option's. */
export function nodeStats(data: AtlasData, plan: Plan, id: string): string[] {
  const node = data.nodes[id];
  if (!node) return [];
  if (node.choices) {
    const picked = node.choices.find((o) => o.effect === plan.choices[id]);
    return picked ? picked.stats : [];
  }
  return node.stats;
}

/**
 * Lines whose value is clear (one percentage, or one number) become "#" templates and are
 * summed: eight "Tier 1-15 Maps found have 5% chance …" give one "… 40% chance …". The rest
 * are listed once with a count.
 */
export function combine(
  entries: { line: string; node: string }[],
): BonusLine[] {
  const byKey = new Map<
    string,
    {
      template: string;
      sum: number;
      summed: boolean;
      nodes: Set<string>;
      count: number;
      text: string;
    }
  >();
  for (const { line, node } of entries) {
    const text = flat(line);
    const found = valueOf(text);
    const summed = found !== null;
    const template = found ? found.template : text;
    const key = (summed ? "1:" : "0:") + template;
    const entry = byKey.get(key) ?? {
      template,
      sum: 0,
      summed,
      nodes: new Set<string>(),
      count: 0,
      text,
    };
    if (found) entry.sum += found.value;
    entry.nodes.add(node);
    entry.count += 1;
    byKey.set(key, entry);
  }
  return [...byKey.values()].map((e) => ({
    text: e.summed
      ? e.template.replace("#", String(Math.round(e.sum * 100) / 100))
      : e.text,
    nodes: [...e.nodes],
    count: e.summed ? 1 : e.count,
  }));
}

/** The plan's combined effects, grouped by mechanic (travel nodes under -1). */
export function bonuses(data: AtlasData, plan: Plan): Bonuses {
  const perMechanic = new Map<number, { line: string; node: string }[]>();
  const nodeCount = new Map<number, number>();
  const keystones: Bonuses["keystones"] = [];
  const choices: Bonuses["choices"] = [];
  for (const id of plan.allocated) {
    const node = data.nodes[id];
    if (!node) continue;
    if (node.kind === "keystone") keystones.push({ id, name: node.name });
    const stats = nodeStats(data, plan, id);
    if (node.choices)
      choices.push({ id, name: node.name, stats: stats.map(flat) });
    if (stats.length === 0) continue;
    const m = mechanicOf(node);
    nodeCount.set(m, (nodeCount.get(m) ?? 0) + 1);
    const list = perMechanic.get(m) ?? [];
    for (const line of stats) list.push({ line, node: id });
    perMechanic.set(m, list);
  }
  const groups = [...perMechanic.entries()]
    .map(([mechanic, entries]) => ({
      mechanic,
      nodes: nodeCount.get(mechanic) ?? 0,
      lines: combine(entries),
    }))
    .sort((a, b) => b.nodes - a.nodes || a.mechanic - b.mechanic);
  keystones.sort((a, b) => a.name.localeCompare(b.name));
  choices.sort((a, b) => a.name.localeCompare(b.name));
  return { groups, keystones, choices };
}
