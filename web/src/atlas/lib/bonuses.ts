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
  /** By mechanic; -1 is Other (lines that name no mechanic). */
  groups: BonusGroup[];
  keystones: { id: string; name: string }[];
  /** Allocated choice nodes with no option picked (an official link carries none). */
  unset: { id: string; name: string }[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Words stat text uses for a mechanic other than its name (3.30's travel lines). */
const ALIASES: Record<string, string[]> = {
  Bestiary: ["Beast", "Beasts"],
  Torment: ["Tormented Spirit", "Tormented Spirits"],
  "Viridian Wildwood": ["Wildwood"],
  "Sacred Flora": ["Sacred Fauna"],
};

/** Per mechanic, a pattern for its name in stat text: without a leading "The", either number. */
const namePatterns = new WeakMap<string[], RegExp[]>();
function patternsFor(names: string[]) {
  let list = namePatterns.get(names);
  if (!list) {
    list = names.map((name) => {
      const base = name.replace(/^The /, "");
      const forms = [base, ...(ALIASES[name] ?? [])];
      // "Threads" also as "Thread", "Strongboxes" as "Strongbox", "Essence" as
      // "Essences"; never "Map" (Map Boss).
      if (base.endsWith("s")) {
        if (base !== "Maps")
          forms.push(base.slice(0, -1), base.replace(/es$/, ""));
      } else forms.push(`${base}s`, `${base}es`);
      return new RegExp(`\\b(?:${forms.map(escape).join("|")})\\b`, "i");
    });
    namePatterns.set(names, list);
  }
  return list;
}

/**
 * The mechanic a travel node's stat line is about, for Bonuses: the first mechanic it
 * names, Maps only when it names no other ("your Maps" is just where things happen). -1
 * when it names none.
 */
export function mechanicInText(line: string, names: string[]): number {
  const text = flat(line).replace(/\byour Maps\b/gi, " ");
  let best = -1;
  let at = Infinity;
  let maps = -1;
  patternsFor(names).forEach((pattern, m) => {
    const found = pattern.exec(text);
    if (!found) return;
    if (names[m] === "Maps") maps = m;
    else if (found.index < at) {
      best = m;
      at = found.index;
    }
  });
  return best >= 0 ? best : maps;
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

/**
 * The plan's combined effects, grouped by mechanic. A cluster node's lines go to its
 * mechanic; a travel node's lines go to the mechanic each one names (else Other, -1). A
 * picked choice is one line, "<node>: <effect>", under its mechanic.
 */
export function bonuses(data: AtlasData, plan: Plan): Bonuses {
  const perMechanic = new Map<number, { line: string; node: string }[]>();
  const nodesOf = new Map<number, Set<string>>();
  const keystones: Bonuses["keystones"] = [];
  const unset: Bonuses["unset"] = [];
  const add = (m: number, line: string, id: string) => {
    perMechanic.set(m, [...(perMechanic.get(m) ?? []), { line, node: id }]);
    nodesOf.set(m, (nodesOf.get(m) ?? new Set()).add(id));
  };
  for (const id of plan.allocated) {
    const node = data.nodes[id];
    if (!node) continue;
    if (node.kind === "keystone") keystones.push({ id, name: node.name });
    const stats = nodeStats(data, plan, id);
    if (node.choices && stats.length === 0) {
      unset.push({ id, name: node.name });
      continue;
    }
    const lines = node.choices
      ? [`${node.name}: ${stats.map(flat).join(" ")}`]
      : stats;
    const own = mechanicOf(node);
    for (const line of lines)
      add(own >= 0 ? own : mechanicInText(line, data.mechanics), line, id);
  }
  const groups = [...perMechanic.entries()]
    .map(([mechanic, entries]) => ({
      mechanic,
      nodes: nodesOf.get(mechanic)?.size ?? 0,
      lines: combine(entries),
    }))
    .sort((a, b) => b.nodes - a.nodes || a.mechanic - b.mechanic);
  keystones.sort((a, b) => a.name.localeCompare(b.name));
  unset.sort((a, b) => a.name.localeCompare(b.name));
  return { groups, keystones, unset };
}
