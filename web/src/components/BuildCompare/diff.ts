import type {
  GearItem,
  ItemLine,
  Passive,
  SkillGroup,
  Stats,
  StatRow,
} from "../PobStats";
import { stripPob } from "../PobText";

// What differs between your build ("yours") and the guide's shown loadout ("guide").

/** A sidebar stat whose value differs. */
export interface StatDiff {
  label: string;
  yours?: string;
  guide?: string;
  /** Yours minus the guide's, when both are numbers. */
  diff?: number;
}

/**
 * "Total Life:" → "Total Life". PoB lists a minion's stats under "Minion:" with the
 * player's labels, so those get "Minion " in front. Other repeats get " (2)", " (3)".
 */
function statValues(rows: StatRow[]) {
  const values = new Map<string, string>();
  let section = "";
  for (const row of rows) {
    if ("text" in row) {
      const header = stripPob(row.text).trim();
      if (header === "Minion:") section = "Minion ";
      else if (header === "Player:") section = "";
      continue;
    }
    if (!("label" in row)) continue;
    const base = section + stripPob(row.label).trim().replace(/:$/, "");
    let label = base;
    for (let n = 2; values.has(label); n++) label = `${base} (${n})`;
    values.set(label, stripPob(row.value).trim());
  }
  return values;
}

/** The leading number of a PoB value: "3,706" → 3706, "75% (+15%)" → 75. */
export function leadingNumber(value: string | undefined) {
  const match = value ? /^[+-]?[\d,]*\.?\d+/.exec(value) : null;
  if (!match) return undefined;
  const number = Number(match[0].replace(/,/g, ""));
  return Number.isFinite(number) ? number : undefined;
}

export function statDiffs(yours: Stats, guide: Stats): StatDiff[] {
  const mine = statValues(yours.rows);
  const theirs = statValues(guide.rows);
  // The guide's order, then stats only your build shows.
  const labels = [
    ...theirs.keys(),
    ...[...mine.keys()].filter((l) => !theirs.has(l)),
  ];
  const out: StatDiff[] = [];
  for (const label of labels) {
    const a = mine.get(label);
    const b = theirs.get(label);
    if (a === b) continue;
    const x = leadingNumber(a);
    const y = leadingNumber(b);
    out.push({
      label,
      yours: a,
      guide: b,
      diff: x !== undefined && y !== undefined ? x - y : undefined,
    });
  }
  return out;
}

// Items -------------------------------------------------------------------------------

/** A mod on both items with different numbers. */
export interface RollDiff {
  yours: string;
  guide: string;
}

export interface ItemDiff {
  slot: string;
  yours?: GearItem;
  guide?: GearItem;
  onlyYours: ItemLine[];
  onlyGuide: ItemLine[];
  rolls: RollDiff[];
}

/** The items of the shown loadout's item set, by slot (PoB's slot order). */
function equipped(stats: Stats) {
  const slots = new Map<string, GearItem>();
  const gear = stats.gear;
  if (!gear) return slots;
  const index = (stats.lists?.active.items ?? 1) - 1;
  const set = gear.sets[index] ?? gear.sets[0];
  for (const { slot, item } of set?.slots ?? []) {
    const found = gear.items[String(item)];
    if (found) slots.set(slot, found);
  }
  return slots;
}

/** A mod line with its numbers as "#", to pair the same mod on two items. */
export function modTemplate(text: string) {
  return text.replace(/\d+(\.\d+)?/g, "#");
}

function modLines(item: GearItem | undefined) {
  return item ? [...item.enchant, ...item.implicit, ...item.explicit] : [];
}

export function itemDiff(
  slot: string,
  yours: GearItem | undefined,
  guide: GearItem | undefined,
): ItemDiff {
  const theirs = new Map<string, ItemLine[]>();
  for (const line of modLines(guide)) {
    const key = modTemplate(line.text);
    theirs.set(key, [...(theirs.get(key) ?? []), line]);
  }
  const onlyYours: ItemLine[] = [];
  const rolls: RollDiff[] = [];
  for (const line of modLines(yours)) {
    const pair = theirs.get(modTemplate(line.text));
    const match = pair?.shift();
    if (!match) onlyYours.push(line);
    else if (match.text !== line.text)
      rolls.push({ yours: line.text, guide: match.text });
  }
  const onlyGuide = [...theirs.values()].flat();
  return { slot, yours, guide, onlyYours, onlyGuide, rolls };
}

/** Same item: name, base, sockets and links, quality, corruption and every mod. */
function sameItem(diff: ItemDiff) {
  const { yours, guide } = diff;
  return (
    yours?.name === guide?.name &&
    yours?.base === guide?.base &&
    yours?.sockets === guide?.sockets &&
    (yours?.quality ?? 0) === (guide?.quality ?? 0) &&
    !!yours?.corrupted === !!guide?.corrupted &&
    diff.onlyYours.length === 0 &&
    diff.onlyGuide.length === 0 &&
    diff.rolls.length === 0
  );
}

/** Slots whose items may sit either way round: matched by item when swapped. */
const SWAPPABLE: [string, string][] = [["Ring 1", "Ring 2"]];

export function itemDiffs(yours: Stats, guide: Stats): ItemDiff[] {
  const mine = equipped(yours);
  const theirs = equipped(guide);
  for (const [a, b] of SWAPPABLE) {
    const straight = [
      itemDiff(a, mine.get(a), theirs.get(a)),
      itemDiff(b, mine.get(b), theirs.get(b)),
    ];
    const crossed = [
      itemDiff(a, mine.get(b), theirs.get(a)),
      itemDiff(b, mine.get(a), theirs.get(b)),
    ];
    const matches = (diffs: ItemDiff[]) => diffs.filter(sameItem).length;
    if (matches(crossed) > matches(straight)) {
      const first = mine.get(a);
      const second = mine.get(b);
      if (second) mine.set(a, second);
      else mine.delete(a);
      if (first) mine.set(b, first);
      else mine.delete(b);
    }
  }
  const slots = [
    ...theirs.keys(),
    ...[...mine.keys()].filter((s) => !theirs.has(s)),
  ];
  return slots
    .map((slot) => itemDiff(slot, mine.get(slot), theirs.get(slot)))
    .filter((diff) => !sameItem(diff));
}

// Skills ------------------------------------------------------------------------------

export interface SkillDiff {
  /** The group's active gems (or its first gem), in name order. */
  name: string;
  yours?: SkillGroup;
  guide?: SkillGroup;
  /** Gems in the guide's group that yours lacks. */
  missing: string[];
  /** Gems in your group that the guide's lacks. */
  extra: string[];
}

function gemNames(group: SkillGroup | undefined) {
  return group?.gems.filter((gem) => gem.enabled).map((gem) => gem.name) ?? [];
}

/** A group's active (non-support) gems, or its first gem when all are supports. */
function activeGems(group: SkillGroup) {
  const gems = group.gems.filter((gem) => gem.enabled);
  const active = gems.filter((gem) => !gem.support).map((gem) => gem.name);
  return active.length > 0 ? active : gems.slice(0, 1).map((gem) => gem.name);
}

/** "Clarity + Herald of Ash": gem order in PoB means nothing, so names are sorted. */
function groupName(group: SkillGroup) {
  return [...activeGems(group)].sort().join(" + ");
}

/** Enabled, socketed groups (granted skills come with items and show under Items). */
function compared(groups: SkillGroup[]) {
  return groups.filter(
    (group) => group.enabled && !group.granted && activeGems(group).length > 0,
  );
}

/** Gems two groups share, counting repeats. */
function shared(a: string[], b: string[]) {
  return a.length - without(a, b).length;
}

/** What's in `a` and not in `b`, counting repeats. */
function without(a: string[], b: string[]) {
  const rest = [...b];
  return a.filter((name) => {
    const at = rest.indexOf(name);
    if (at < 0) return true;
    rest.splice(at, 1);
    return false;
  });
}

export function skillDiffs(yours: Stats, guide: Stats): SkillDiff[] {
  const mine = compared(yours.skills);
  const out: SkillDiff[] = [];
  for (const group of compared(guide.skills)) {
    // Your group sharing an active gem with it and the most gems overall.
    const active = activeGems(group);
    let at = -1;
    let best = 0;
    mine.forEach((candidate, index) => {
      if (shared(activeGems(candidate), active) === 0) return;
      const score = shared(gemNames(candidate), gemNames(group));
      if (score > best) {
        best = score;
        at = index;
      }
    });
    const match = at >= 0 ? mine.splice(at, 1)[0] : undefined;
    out.push({
      name: groupName(group),
      yours: match,
      guide: group,
      missing: without(gemNames(group), gemNames(match)),
      extra: without(gemNames(match), gemNames(group)),
    });
  }
  for (const group of mine) {
    out.push({
      name: groupName(group),
      yours: group,
      missing: [],
      extra: gemNames(group),
    });
  }
  return out.filter(
    (diff) =>
      diff.yours === undefined ||
      diff.guide === undefined ||
      diff.missing.length > 0 ||
      diff.extra.length > 0,
  );
}

// Passives ----------------------------------------------------------------------------

export type PassiveKind =
  "Keystone" | "Notable" | "Ascendancy" | "Mastery" | "Socket" | "Normal";

export const PASSIVE_KINDS: PassiveKind[] = [
  "Keystone",
  "Notable",
  "Ascendancy",
  "Mastery",
  "Socket",
  "Normal",
];

export interface PassiveDiff {
  kind: PassiveKind;
  name: string;
  effect?: string;
  yours: number;
  guide: number;
}

function kindOf(passive: Passive): PassiveKind {
  if (passive.ascendancy) return "Ascendancy";
  switch (passive.type) {
    case "Keystone":
    case "Notable":
    case "Mastery":
    case "Socket":
      return passive.type;
    default:
      return "Normal";
  }
}

/**
 * Allocated passives by name (small passives counted, "+10 Strength" ×3), where your
 * count differs from the guide's. Names, not node ids, so other tree versions match.
 */
export function passiveDiffs(yours: Stats, guide: Stats): PassiveDiff[] {
  const counts = new Map<string, PassiveDiff>();
  const add = (list: Passive[], side: "yours" | "guide") => {
    for (const passive of list) {
      const kind = kindOf(passive);
      const effect =
        kind === "Mastery" ? passive.effect || undefined : undefined;
      const key = `${kind}\n${passive.name}\n${effect ?? ""}`;
      const entry =
        counts.get(key) ??
        ({
          kind,
          name: passive.name,
          effect,
          yours: 0,
          guide: 0,
        } as PassiveDiff);
      entry[side] += 1;
      counts.set(key, entry);
    }
  };
  add(yours.passives, "yours");
  add(guide.passives, "guide");
  return [...counts.values()]
    .filter((entry) => entry.yours !== entry.guide)
    .sort(
      (a, b) =>
        PASSIVE_KINDS.indexOf(a.kind) - PASSIVE_KINDS.indexOf(b.kind) ||
        a.name.localeCompare(b.name) ||
        (a.effect ?? "").localeCompare(b.effect ?? ""),
    );
}
