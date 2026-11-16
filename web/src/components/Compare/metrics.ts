// What Compare shows about two builds: the summary's stats (picked per comparison by rules
// over PoB's output, so a poison build gets Poison chance and a crit build Crit chance),
// the full sidebar list, and the "why" breakdowns built from PoB's own source tables.

import type { StatRow, Stats } from "../PobStats";
import { stripPob } from "../PobText";

/** A row of one of PoB's source tables (Tabulate): a value and where it comes from. */
export interface TabRow {
  value: number | string;
  name?: string;
  source?: string;
  /** The mod's type (BASE, INC, MORE…), on Calcs rows' mod tables. */
  type?: string;
}

/** PoB's per-slot breakdown of a defence. */
export interface SlotRow {
  source: string;
  base?: number;
  total?: number;
  item?: string;
}

/** host_compare's numbers for one build (see pob-host.lua). */
export interface Extra {
  player: Record<string, number>;
  minion?: Record<string, number>;
  minionMain: boolean;
  minionSkill?: string;
  attack: boolean;
  spell: boolean;
  hit: boolean;
  /** The main skill's gem (PoB's granted effect id). */
  skillId?: string;
  /** Whether the pick sent was found (unset: none sent). */
  picked?: boolean;
  /** PoB shows the skill as an average hit, not per second (Essence Drain, Frostblink). */
  average?: boolean;
  tabs?: Record<string, TabRow[]>;
  slots?: Record<string, SlotRow[]>;
  calcsPlayer?: Record<string, number>;
  calcsActor?: Record<string, number>;
  /** The main skill's DPS factors taken apart (hit, speed, Poison, Bleed, Ignite). */
  parts?: Record<string, Record<string, number>>;
  /** PoB's Calcs tab, for the Stats section. */
  calcsPage?: CalcPage;
}

/** A build as Compare has it: its numbers, and (the two compared) PoB's stats answer. */
export interface Calculated {
  extra: Extra;
  stats?: Stats;
}

// PoB's JSON writes an empty table as [] or {}: make each what it should be.
const record = (value: unknown): Record<string, number> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, number>) : {};
const rowsOf = <T>(value: unknown): T[] => (Array.isArray(value) ? value : []);

export function readExtra(raw: Partial<Extra>): Extra {
  const tabs: Record<string, TabRow[]> = {};
  if (raw.tabs && typeof raw.tabs === "object")
    for (const [key, rows] of Object.entries(raw.tabs)) tabs[key] = rowsOf(rows);
  const slots: Record<string, SlotRow[]> = {};
  if (raw.slots && typeof raw.slots === "object")
    for (const [key, rows] of Object.entries(raw.slots)) slots[key] = rowsOf(rows);
  return {
    ...raw,
    player: record(raw.player),
    minion: raw.minion ? record(raw.minion) : undefined,
    minionMain: !!raw.minionMain,
    attack: !!raw.attack,
    spell: !!raw.spell,
    hit: !!raw.hit,
    tabs: raw.tabs ? tabs : undefined,
    slots: raw.slots ? slots : undefined,
    calcsPlayer: raw.calcsPlayer ? record(raw.calcsPlayer) : undefined,
    calcsActor: raw.calcsActor ? record(raw.calcsActor) : undefined,
    calcsPage: readCalcsPage(raw.calcsPage),
    parts: raw.parts
      ? Object.fromEntries(Object.entries(record(raw.parts)).map(([k, v]) => [k, record(v)]))
      : undefined,
  };
}

// Metrics ------------------------------------------------------------------------------

export type MetricKey = string;

export interface Metric {
  key: MetricKey;
  label: string;
  /** "k": big numbers (k, M); "%": a percentage; none: a plain number. */
  fmt?: "k" | "%";
  /** Its "why" breakdown, when PoB's numbers add up for it. */
  why?: string;
  /** The smallest change worth showing on a gap. */
  thresh: number;
  /** "Offence", "Defence" or "Misc", as PoB's Calcs tab groups them. */
  section: "Offence" | "Defence" | "Misc";
}

interface Rule {
  key: string;
  label: string;
  fmt?: "k" | "%";
  why?: string;
  section: Metric["section"];
  get: (x: Extra) => number | undefined;
  show: (x: Extra) => boolean;
}

const actor = (x: Extra) => (x.minionMain ? (x.minion ?? {}) : x.player);
const P = (x: Extra) => x.player;
/** Chaos Inoculation: life is 1. */
const ci = (x: Extra) => (P(x).Life ?? 0) <= 1;
const AILMENT_DPS: Record<string, (a: Record<string, number>) => number> = {
  Poison: (a) => a.TotalPoisonDPS ?? a.PoisonDPS ?? 0,
  Bleed: (a) => a.BleedDPS ?? 0,
  Ignite: (a) => a.TotalIgniteDPS ?? a.IgniteDPS ?? 0,
};
const dpsOf = (x: Extra) => actor(x).CombinedDPS ?? actor(x).TotalDPS ?? 0;

function rules(minion: boolean): Rule[] {
  const list: Rule[] = [
    {
      key: "dps",
      label: minion ? "Minion DPS" : "DPS",
      fmt: "k",
      why: "dps",
      section: "Offence",
      get: dpsOf,
      show: () => true,
    },
  ];
  for (const ailment of ["Poison", "Bleed", "Ignite"])
    // An ailment's chance matters when that ailment is at least a tenth of the damage.
    list.push({
      key: ailment.toLowerCase(),
      label: `${ailment} chance`,
      fmt: "%",
      why: "ail-" + ailment,
      section: "Offence",
      get: (x) => actor(x)[ailment + "Chance"] ?? 0,
      show: (x) => dpsOf(x) > 0 && AILMENT_DPS[ailment](actor(x)) >= 0.1 * dpsOf(x),
    });
  list.push(
    {
      key: "crit",
      label: "Crit chance",
      fmt: "%",
      section: "Offence",
      get: (x) => actor(x).CritChance ?? 0,
      show: (x) => (actor(x).CritChance ?? 0) >= 20,
    },
    {
      key: "hit",
      label: "Hit chance",
      fmt: "%",
      section: "Offence",
      get: (x) => actor(x).HitChance ?? 100,
      show: (x) => x.attack && (actor(x).HitChance ?? 100) < 99.5,
    },
    {
      key: "life",
      label: "Life",
      why: "life",
      section: "Defence",
      get: (x) => P(x).Life,
      show: (x) => !ci(x) && (P(x).Life ?? 0) >= 0.3 * ((P(x).Life ?? 0) + (P(x).EnergyShield ?? 0)),
    },
    {
      key: "es",
      label: "Energy shield",
      why: "es",
      section: "Defence",
      get: (x) => P(x).EnergyShield ?? 0,
      show: (x) =>
        (P(x).EnergyShield ?? 0) >= 0.3 * ((ci(x) ? 0 : (P(x).Life ?? 0)) + (P(x).EnergyShield ?? 0)),
    },
    {
      key: "ehp",
      label: "EHP",
      fmt: "k",
      section: "Defence",
      get: (x) => P(x).TotalEHP,
      show: () => true,
    },
    {
      key: "phys",
      label: "Phys max hit",
      fmt: "k",
      section: "Defence",
      get: (x) => P(x).PhysicalMaximumHitTaken,
      show: () => true,
    },
    {
      key: "armour",
      label: "Armour",
      why: "armour",
      section: "Defence",
      get: (x) => P(x).Armour ?? 0,
      show: (x) => {
        const armour = P(x).Armour ?? 0;
        return armour >= 1000 && armour >= 0.25 * (armour + (P(x).Evasion ?? 0));
      },
    },
    {
      key: "evasion",
      label: "Evasion",
      why: "evasion",
      section: "Defence",
      get: (x) => P(x).Evasion ?? 0,
      show: (x) => {
        const evasion = P(x).Evasion ?? 0;
        return evasion >= 1000 && evasion >= 0.25 * ((P(x).Armour ?? 0) + evasion);
      },
    },
    {
      key: "block",
      label: "Block",
      fmt: "%",
      section: "Defence",
      get: (x) => P(x).BlockChance ?? 0,
      show: (x) => (P(x).BlockChance ?? 0) >= 25,
    },
    {
      key: "spellBlock",
      label: "Spell block",
      fmt: "%",
      section: "Defence",
      get: (x) => P(x).SpellBlockChance ?? 0,
      show: (x) => (P(x).SpellBlockChance ?? 0) >= 25,
    },
    {
      key: "suppress",
      label: "Suppression",
      fmt: "%",
      why: "suppression",
      section: "Defence",
      get: (x) => P(x).SpellSuppressionChance ?? 0,
      show: (x) => (P(x).SpellSuppressionChance ?? 0) >= 25,
    },
  );
  for (const element of ["Fire", "Cold", "Lightning", "Chaos"])
    // A resistance matters below its cap (chaos doesn't under Chaos Inoculation).
    list.push({
      key: element.toLowerCase(),
      label: `${element} res`,
      fmt: "%",
      why: "res-" + element,
      section: "Defence",
      get: (x) => P(x)[element + "Resist"] ?? 0,
      show: (x) => (P(x)["Missing" + element + "Resist"] ?? 0) > 0 && !(element === "Chaos" && ci(x)),
    });
  list.push({
    key: "move",
    label: "Move speed",
    fmt: "%",
    section: "Misc",
    get: (x) => ((P(x).MovementSpeedMod ?? 1) - 1) * 100,
    show: () => true,
  });
  return list;
}

/** A missing output stays missing (shown as —), never a made-up number. */
const round1 = (value: number | undefined) =>
  value !== undefined && Number.isFinite(value) ? Math.round(value * 10) / 10 : null;

export type Values = Record<MetricKey, number | null>;

/**
 * The summary's stats for these two builds: every rule that holds for either. DPS is each
 * build's main skill (its minion's, for a minion skill), labelled "Minion DPS" only when
 * both are minion builds; a minion build against a self-cast one shows as Different skills.
 */
export function pickMetrics(one: Extra, two: Extra) {
  const all = rules(one.minionMain && two.minionMain);
  const shown = all.filter((rule) => rule.show(one) || rule.show(two));
  const values = (x: Extra): Values =>
    Object.fromEntries(shown.map((rule) => [rule.key, round1(rule.get(x))]));
  const metrics: Metric[] = shown.map((rule) => {
    // A gap needs a change of 1 point (percent stats) or 1% of Build 1's value (the rest).
    const ref = Math.abs(rule.get(one) ?? 0) || Math.abs(rule.get(two) ?? 0) || 1;
    return {
      key: rule.key,
      label: rule.label,
      fmt: rule.fmt,
      why: rule.why,
      section: rule.section,
      thresh: rule.fmt === "%" ? 1 : Math.max(1, Math.round(ref * 0.01)),
    };
  });
  return { metrics, values };
}

// Sidebar stats ------------------------------------------------------------------------

/** One stat of PoB's sidebar (or Calcs, for the ailment chances it lacks), both builds. */
export interface StatLine {
  section: "Player" | "Minion";
  label: string;
  one?: string;
  two?: string;
  /** Build 1's minus Build 2's, when both are numbers. */
  diff?: number;
  /** Lower is better (costs). */
  lower: boolean;
  /** Its "why" breakdown. */
  why?: string;
  /** From PoB's Calcs tab, not its sidebar. */
  calcs?: boolean;
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

const WHY_LABEL: Record<string, string> = {
  "Total Life": "life",
  "Energy Shield": "es",
  Armour: "armour",
  "Evasion rating": "evasion",
  "Spell Suppression Chance": "suppression",
  "Fire Resistance": "res-Fire",
  "Cold Resistance": "res-Cold",
  "Lightning Resistance": "res-Lightning",
  "Chaos Resistance": "res-Chaos",
};

export function statLines(
  one: Calculated,
  two: Calculated,
  metrics: Metric[],
  whys: Record<string, Why>,
): StatLine[] {
  const a = statValues(one.stats?.rows ?? []);
  const b = statValues(two.stats?.rows ?? []);
  const minion = one.extra.minionMain;
  // The ailment chances the summary picked aren't on PoB's sidebar: from Calcs.
  const calcs = metrics
    .filter((m) => m.why?.startsWith("ail-"))
    .map((m) => {
      const ailment = m.why!.slice(4);
      const value = (x: Extra) => {
        const chance = actor(x)[ailment + "Chance"];
        return chance === undefined ? undefined : `${Math.round(chance)}%`;
      };
      return {
        label: `${minion ? "Minion " : ""}${ailment} chance`,
        one: value(one.extra),
        two: value(two.extra),
        why: m.why,
      };
    });
  const out: StatLine[] = [];
  const push = (
    label: string,
    x: string | undefined,
    y: string | undefined,
    why: string | undefined,
    calc?: boolean,
  ) => {
    const isMinion = label.startsWith("Minion ");
    const nx = leadingNumber(x);
    const ny = leadingNumber(y);
    out.push({
      section: isMinion ? "Minion" : "Player",
      label: isMinion ? label.slice(7) : label,
      one: x,
      two: y,
      diff: nx !== undefined && ny !== undefined ? nx - ny : undefined,
      // As PoB marks them: costs, cooldowns, degen, requirements and use times.
      lower: /cost|cooldown|degen|required|(cast|channel|throwing|laying|placement) time/i.test(label),
      why: why && whys[why] ? why : undefined,
      calcs: calc || undefined,
    });
  };
  // Build 2's order, then stats only Build 1 shows.
  const labels = [...b.keys(), ...[...a.keys()].filter((label) => !b.has(label))];
  let added = false;
  for (const label of labels) {
    // Calcs rows go after the actor's damage rows.
    if (
      !added &&
      calcs.length > 0 &&
      (minion
        ? !label.startsWith("Minion ") && out.some((r) => r.section === "Minion")
        : /Life|Max Hit|Effective Hit Pool/.test(label))
    ) {
      for (const c of calcs) push(c.label, c.one, c.two, c.why, true);
      added = true;
    }
    push(label, a.get(label), b.get(label), label.startsWith("Minion ") ? undefined : WHY_LABEL[label]);
  }
  if (!added) for (const c of calcs) push(c.label, c.one, c.two, c.why, true);
  return out;
}

// Why: PoB's own source tables, labelled by where each mod comes from -----------------

export type SourceGroup = "Base" | "Gear" | "Tree" | "Gems" | "Config" | "Other";

export interface WhyRow {
  group: SourceGroup;
  key: string;
  one: number | null;
  two: number | null;
  oneDetail?: string;
  twoDetail?: string;
}

export interface WhyBlock {
  title: string;
  unit?: "%";
  /** "more" mods multiply: the total is their product, not their sum. */
  product?: boolean;
  /** The rows are separate values, not one total's sources. */
  noTotal?: boolean;
  rows: WhyRow[];
}

/** A pool (flat × (1 + inc%) × more) or a chance (sum, capped). */
export type WhyFormula =
  | {
      kind: "pool";
      flat: number;
      inc: number;
      more: number;
      total: number;
      ok: boolean;
    }
  | { kind: "chance"; sum: number; cap: number; total: number; ok: boolean };

/**
 * "k": big numbers; "%"; "x": a multiplier; "inc": an increase, as its multiplier (1.5 is
 * +50%); "rate": per second; "s": seconds.
 */
export type FactorFmt = "k" | "%" | "x" | "inc" | "rate" | "s";

/** A part of a factor: the factor is the product of its parts. */
export interface Part {
  label: string;
  one: number;
  two: number;
  fmt: FactorFmt;
  /** Where the part comes from, by source. */
  block?: WhyBlock;
}

/** One factor of a DPS (both builds), as PoB multiplies and adds them. */
export interface Factor {
  label: string;
  one: number | null;
  two: number | null;
  fmt: FactorFmt;
  /** A subtotal or the total (shown as a sum line). */
  total?: boolean;
  /** Multiplies the hit DPS: the factor with the widest ratio is marked. */
  multiplies?: boolean;
  parts?: Part[];
  /** The factor is the lower of its parts (a triggered skill's rate), not their product. */
  lowest?: boolean;
}

export interface Why {
  /** Pools and chances: the formula per build. DPS: the factor table instead. */
  formula?: [WhyFormula, WhyFormula];
  factors?: Factor[];
  blocks: WhyBlock[];
}

const numberRows = (rows: TabRow[] | undefined) =>
  (rows ?? []).filter((row): row is TabRow & { value: number } => typeof row.value === "number");
const sumOf = (rows: TabRow[] | undefined) => numberRows(rows).reduce((s, row) => s + row.value, 0);
const prodOf = (rows: TabRow[] | undefined) =>
  numberRows(rows).reduce((s, row) => s * (1 + row.value / 100), 1);

const activeTree = (stats: Stats) =>
  stats.treeExtras[(stats.lists?.active.tree ?? 1) - 1] ?? stats.treeExtras[0];

/** Item ids of the shown item set (and the tree's jewels) by slot. */
function itemSlots(stats: Stats) {
  const bySlot = new Map<string, string>();
  const gear = stats.gear;
  if (!gear) return bySlot;
  const set = gear.sets[(stats.lists?.active.items ?? 1) - 1] ?? gear.sets[0];
  for (const slot of set?.slots ?? []) bySlot.set(String(slot.item), slot.slot);
  for (const jewel of activeTree(stats)?.jewels ?? [])
    if (!bySlot.has(String(jewel.item))) bySlot.set(String(jewel.item), "Tree jewel");
  return bySlot;
}

interface Source {
  group: SourceGroup;
  key: string;
  detail?: string;
}

/** Where a mod comes from, as a row label: "Gear · Body Armour", "Tree · Juggernaut". */
function label(slots: Map<string, string>, source: string | undefined): Source {
  const item = /^Item:(\d+):(.*)$/.exec(source ?? "");
  if (item) {
    const slot = slots.get(item[1]) ?? "Item";
    const [name, base] = item[2].split(", ");
    return {
      group: "Gear",
      key: slot.replace(/ Abyssal Socket \d/, " jewels").replace(/^Ring \d$/, "Rings"),
      detail: !name || name === "New Item" ? base : name,
    };
  }
  if (source?.startsWith("Tree: ")) return { group: "Tree", key: source.slice(6) };
  if (source?.startsWith("Skill:")) {
    const gem = source.slice(6);
    // pob-host.lua sends the gem's name; an id it couldn't name ("SupportChanceToPoison")
    // is spelled out.
    return {
      group: "Gems",
      key: gem.includes(" ")
        ? gem
        : gem
            .replace(/^Support/, "")
            .replace(/([a-z])([A-Z])/g, "$1 $2")
            .replace(/ (To|Of|And) /g, (m) => m.toLowerCase()),
    };
  }
  if (source?.startsWith("Custom:")) return { group: "Config", key: `Custom mods (${source.slice(7)})` };
  // A party member's buffs, set in the config: "Party - Leer Cast, Festival Mask".
  const party = /^Party - ([^,]*)(?:, (.*))?$/.exec(source ?? "");
  if (party) return { group: "Config", key: `Party: ${party[1]}`, detail: party[2] };
  if (source === "Base") return { group: "Base", key: "Base" };
  // The skill's own base damage (pob-host.lua): "Base:Minion base|Level 84".
  const own = /^Base:([^|]*)(?:\|(.*))?$/.exec(source ?? "");
  if (own) return { group: "Base", key: own[1], detail: own[2] };
  if (source && ["Strength", "Dexterity", "Intelligence"].includes(source))
    return { group: "Base", key: source };
  return { group: "Other", key: source || "Other" };
}

/** Mods by source row; `product`: "more" mods, which multiply even within a row. */
function summed(stats: Stats, rows: TabRow[] | undefined, product = false) {
  const slots = itemSlots(stats);
  const out = new Map<string, Source & { value: number }>();
  for (const row of numberRows(rows)) {
    const source = label(slots, row.source);
    const key = source.group + "|" + source.key;
    const entry = out.get(key) ?? { ...source, value: 0 };
    entry.value = product
      ? ((1 + entry.value / 100) * (1 + row.value / 100) - 1) * 100
      : entry.value + row.value;
    if (source.detail) entry.detail = source.detail;
    out.set(key, entry);
  }
  return out;
}

const RANK: Record<SourceGroup, number> = {
  Base: 0,
  Gear: 1,
  Tree: 2,
  Gems: 3,
  Config: 4,
  Other: 5,
};
const byRank = (p: WhyRow, q: WhyRow) =>
  RANK[p.group] - RANK[q.group] ||
  Math.abs((q.two ?? 0) - (q.one ?? 0)) - Math.abs((p.two ?? 0) - (p.one ?? 0));

function paired(
  one: Calculated,
  rowsOne: TabRow[] | undefined,
  two: Calculated,
  rowsTwo: TabRow[] | undefined,
  product = false,
) {
  const a = summed(one.stats!, rowsOne, product);
  const b = summed(two.stats!, rowsTwo, product);
  return [...new Set([...a.keys(), ...b.keys()])]
    .map((key): WhyRow => {
      const x = a.get(key);
      const y = b.get(key);
      return {
        group: (x ?? y)!.group,
        key: (x ?? y)!.key,
        one: x?.value ?? null,
        two: y?.value ?? null,
        oneDetail: x?.detail,
        twoDetail: y?.detail,
      };
    })
    .sort(byRank);
}

/** A defence's base per slot (after the item's own mods) plus the global flat mods. */
function flatRows(x: Calculated, stat: string, baseTab: TabRow[] | undefined) {
  const rows: (Source & { value: number })[] = [];
  let global = false;
  for (const slot of x.extra.slots?.[stat] ?? []) {
    if (slot.source === "Global") {
      global = true;
      continue;
    }
    const [name, base] = (slot.item ?? "").split(", ");
    rows.push({
      group: "Gear",
      key: slot.source,
      detail: name === "New Item" ? base : name || undefined,
      value: Number(slot.base) || 0,
    });
  }
  // PoB's "Global" slot row is the sum of the flat mods (flasks, jewels, tree, gems).
  if (global) {
    const slots = itemSlots(x.stats!);
    for (const row of numberRows(baseTab)) rows.push({ ...label(slots, row.source), value: row.value });
  }
  // One row per source: a tree node taken twenty times, or two rings, add up.
  const merged = new Map<string, Source & { value: number }>();
  for (const row of rows) {
    const entry = merged.get(row.key);
    if (!entry) merged.set(row.key, { ...row });
    else {
      entry.value += row.value;
      if (entry.detail !== row.detail) entry.detail = undefined;
    }
  }
  return [...merged.values()];
}

// Totals and checks use the Calcs pass, the same pass the source tables come from.
const CP = (x: Extra) => x.calcsPlayer ?? P(x);
const CA = (x: Extra) => x.calcsActor ?? actor(x);
const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1, Math.abs(b) * 0.02);

function poolWhy(one: Calculated, two: Calculated, stat: string, key: string, title: string): Why {
  const side = (x: Calculated): WhyFormula => {
    const tabs = x.extra.tabs ?? {};
    const flat =
      key === "life"
        ? sumOf(tabs.lifeBase)
        : flatRows(x, stat, tabs[key + "Base"]).reduce((s, row) => s + row.value, 0);
    const inc = sumOf(tabs[key + "Inc"]);
    const more = prodOf(tabs[key + "More"]);
    const total = Math.round(CP(x.extra)[stat] ?? 0);
    return {
      kind: "pool",
      flat,
      inc,
      more,
      total,
      ok: close(flat * (1 + inc / 100) * more, total),
    };
  };
  const tabsOne = one.extra.tabs ?? {};
  const tabsTwo = two.extra.tabs ?? {};
  let base: WhyBlock;
  if (key === "life")
    base = {
      title: "Base life",
      rows: paired(one, tabsOne.lifeBase, two, tabsTwo.lifeBase),
    };
  else {
    const a = flatRows(one, stat, tabsOne[key + "Base"]);
    const b = flatRows(two, stat, tabsTwo[key + "Base"]);
    const keys = [...new Set([...a.map((r) => r.key), ...b.map((r) => r.key)])];
    base = {
      title: key === "es" ? "Base ES" : "Base " + title.toLowerCase(),
      rows: keys.map((k) => {
        const x = a.find((r) => r.key === k);
        const y = b.find((r) => r.key === k);
        return {
          group: (x ?? y)!.group,
          key: k,
          one: x?.value ?? null,
          two: y?.value ?? null,
          oneDetail: x?.detail,
          twoDetail: y?.detail,
        };
      }),
    };
  }
  return {
    formula: [side(one), side(two)],
    blocks: [
      base,
      {
        title: "Increased",
        unit: "%",
        rows: paired(one, tabsOne[key + "Inc"], two, tabsTwo[key + "Inc"]),
      },
    ],
  };
}

function chanceWhy(
  one: Calculated,
  two: Calculated,
  title: string,
  rowsFor: (x: Extra) => TabRow[] | undefined,
  capOf: (x: Extra) => number,
  totalOf: (x: Extra) => number | undefined,
): Why {
  const side = (x: Extra): WhyFormula => {
    const sum = sumOf(rowsFor(x));
    const cap = capOf(x);
    const total = Math.round(totalOf(x) ?? 0);
    return {
      kind: "chance",
      sum,
      cap,
      total,
      ok: close(Math.min(sum, cap), total),
    };
  };
  return {
    formula: [side(one.extra), side(two.extra)],
    blocks: [
      {
        title,
        unit: "%",
        rows: paired(one, rowsFor(one.extra), two, rowsFor(two.extra)),
      },
    ],
  };
}

/**
 * The breakdowns for two builds (both calculated in full). Offered only where PoB's numbers
 * add up on both sides (not shield block or Chaos Inoculation life), so a table's total is
 * always the stat.
 */
export function whys(one: Calculated, two: Calculated): Record<string, Why> {
  if (!one.stats || !two.stats || !one.extra.tabs || !two.extra.tabs) return {};
  const out: Record<string, Why> = {
    life: poolWhy(one, two, "Life", "life", "Life"),
    es: poolWhy(one, two, "EnergyShield", "es", "Energy shield"),
    armour: poolWhy(one, two, "Armour", "armour", "Armour"),
    evasion: poolWhy(one, two, "Evasion", "evasion", "Evasion"),
    suppression: chanceWhy(
      one,
      two,
      "Suppression",
      (x) => x.tabs?.suppression,
      () => 100,
      (x) => CP(x).SpellSuppressionChance,
    ),
  };
  for (const element of ["Fire", "Cold", "Lightning", "Chaos"])
    out["res-" + element] = chanceWhy(
      one,
      two,
      `${element} res`,
      (x) => (x.tabs?.[element + "Resist"] ?? []).filter((row) => /Resist$/.test(row.name ?? "")),
      (x) => Math.min(90, sumOf(x.tabs?.[element + "ResistMax"])),
      (x) => CP(x)[element + "Resist"],
    );
  for (const ailment of ["Poison", "Bleed", "Ignite"])
    out["ail-" + ailment] = chanceWhy(
      one,
      two,
      `${ailment} chance`,
      (x) => x.tabs?.[ailment + "Chance"],
      () => 100,
      (x) => CA(x)[ailment + "Chance"],
    );
  for (const [key, why] of Object.entries(out)) if (!why.formula?.every((f) => f.ok)) delete out[key];
  const dps = dpsWhy(one, two);
  if (dps) out.dps = dps;
  return out;
}

/**
 * Where a DPS comes from, as PoB adds it up: hit damage × hit chance × hits per second ×
 * a multiplier (projectiles, count) is the hit DPS; ailments, damage over time and impale
 * add to it; cull and the rest scale the total. Then the damage and speed mods by source.
 */
function dpsWhy(one: Calculated, two: Calculated): Why | null {
  const a = CA(one.extra);
  const b = CA(two.extra);
  if (a.CombinedDPS === undefined || b.CombinedDPS === undefined) return null;
  const parts = (x: Record<string, number>) => {
    const chance = x.HitChance ?? 100;
    // Attacks keep their average hit per hand; PoB combines only the damage after hit chance.
    const hit =
      x.AverageHit ?? (x.AverageDamage !== undefined && chance > 0 ? (x.AverageDamage * 100) / chance : 0);
    const speed = x.HitSpeed ?? x.Speed ?? 0;
    const hitDps = x.TotalDPS ?? 0;
    const poison = x.TotalPoisonDPS ?? x.PoisonDPS ?? 0;
    const bleed = x.BleedDPS ?? 0;
    const ignite = x.TotalIgniteDPS ?? x.IgniteDPS ?? 0;
    const dot = x.TotalDotDPS ?? 0;
    const impale = x.ImpaleDPS ?? 0;
    const total = x.CombinedDPS ?? 0;
    const base = hit * (chance / 100) * speed;
    return {
      hit,
      crit: x.CritChance ?? 0,
      critMulti: x.CritMultiplier ?? 0,
      chance,
      speed,
      multiplier: base > 0 ? hitDps / base : 0,
      hitDps,
      poison,
      bleed,
      ignite,
      // Damage over time PoB adds besides the ailments listed (TotalDotDPS holds them).
      dot: Math.max(0, dot - poison - bleed - ignite),
      impale,
      other: total - hitDps - Math.max(dot, poison + bleed + ignite) - impale,
      total,
    };
  };
  const x = parts(a);
  const y = parts(b);
  const factors: Factor[] = [];
  const add = (factor: Factor, show = true) => {
    if (show) factors.push(factor);
  };
  const some = (key: keyof ReturnType<typeof parts>, min = 0) =>
    Math.abs(x[key]) > min || Math.abs(y[key]) > min;
  const pair = (key: keyof ReturnType<typeof parts>) => ({
    one: x[key],
    two: y[key],
  });
  const hits = some("hit");
  const split = factorParts(one, two, x.hit, y.hit, x.speed, y.speed);
  add(
    {
      label: "Hit damage",
      fmt: "k",
      multiplies: true,
      ...pair("hit"),
      parts: split.hit,
    },
    hits,
  );
  // With the hit taken apart, crit is one of its parts.
  add({ label: "Crit chance", fmt: "%", ...pair("crit") }, hits && !split.hit && some("crit"));
  add({ label: "Crit multi", fmt: "x", ...pair("critMulti") }, hits && !split.hit && some("crit"));
  add({ label: "Hit chance", fmt: "%", multiplies: true, ...pair("chance") }, hits);
  // A skill PoB shows as an average hit has no per-second parts: its total is that hit.
  if (one.extra.average || two.extra.average) {
    add({ label: "Total", fmt: "k", total: true, ...pair("total") });
    return { factors, blocks: dpsBlocks(one, two, !split.hit, false) };
  }
  add(
    {
      label: "Hits/sec",
      fmt: "rate",
      multiplies: true,
      ...pair("speed"),
      ...(hits ? split.speed : undefined),
    },
    hits,
  );
  add(
    { label: "Multiplier", fmt: "x", multiplies: true, ...pair("multiplier") },
    hits && (Math.abs(x.multiplier - 1) > 0.01 || Math.abs(y.multiplier - 1) > 0.01),
  );
  add({ label: "Hit DPS", fmt: "k", total: true, ...pair("hitDps") }, hits);
  const small = Math.max(x.total, y.total) * 0.01;
  for (const [label, key, name] of [
    ["Poison DPS", "poison", "Poison"],
    ["Bleed DPS", "bleed", "Bleed"],
    ["Ignite DPS", "ignite", "Ignite"],
  ] as const)
    add(
      {
        label,
        fmt: "k",
        ...pair(key),
        parts: split.ailment(name, x[key], y[key]),
      },
      some(key),
    );
  add({ label: "Other DoT", fmt: "k", ...pair("dot") }, some("dot", small));
  add({ label: "Impale DPS", fmt: "k", ...pair("impale") }, some("impale"));
  add({ label: "Cull & other", fmt: "k", ...pair("other") }, some("other", small));
  add({ label: "Total", fmt: "k", total: true, ...pair("total") });
  // The sources sit under the parts they make up; without parts, they follow the table.
  return {
    factors,
    blocks: dpsBlocks(one, two, !split.hit, !(hits && split.speed?.parts)),
  };
}

/**
 * The parts of the hit, the hit rate and each ailment (pob-host.lua's compareParts), each
 * with its sources. What the parts don't cover (conversion, double damage, crits on
 * ailments and the like) is "Other", so the parts always multiply to the factor.
 */
function factorParts(
  one: Calculated,
  two: Calculated,
  hitOne: number,
  hitTwo: number,
  speedOne: number,
  speedTwo: number,
) {
  const pa = one.extra.parts ?? {};
  const pb = two.extra.parts ?? {};
  const both = one.stats && two.stats;
  const tabsOne = one.extra.tabs ?? {};
  const tabsTwo = two.extra.tabs ?? {};
  /** `noTotal`: the table lists more than the part (several damage types' mods). */
  const block = (
    title: string,
    key: string,
    unit?: "%",
    product?: boolean,
    noTotal?: boolean,
  ): WhyBlock | undefined => {
    if (!both) return undefined;
    const rows = paired(one, tabsOne[key], two, tabsTwo[key], product);
    return rows.length ? { title, unit, product, noTotal, rows } : undefined;
  };
  const percentOf = (value: number | undefined) =>
    typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) : null;
  const num = (value: number | undefined) => (value !== undefined && Number.isFinite(value) ? value : 1);
  const positive = (value: number | undefined): value is number =>
    value !== undefined && Number.isFinite(value) && value > 0;
  /** "Other": the factor over the product of the parts, shown when it isn't ×1 for both. */
  const finish = (list: Part[], totalOne: number, totalTwo: number) => {
    const product = (pick: (p: Part) => number) => list.reduce((s, p) => s * pick(p), 1);
    const pOne = product((p) => (p.fmt === "%" ? p.one / 100 : p.one));
    const pTwo = product((p) => (p.fmt === "%" ? p.two / 100 : p.two));
    if (!(pOne > 0 && pTwo > 0)) return undefined;
    const other: Part = {
      label: "Other",
      fmt: "x",
      one: totalOne / pOne,
      two: totalTwo / pTwo,
    };
    if (Math.abs(other.one - 1) > 0.01 || Math.abs(other.two - 1) > 0.01) list.push(other);
    return list;
  };

  let hit: Part[] | undefined;
  const ha = pa.hit;
  const hb = pb.hit;
  if (ha && hb && positive(ha.base) && positive(hb.base) && hitOne > 0 && hitTwo > 0) {
    const mixed = !!ha.mixed || !!hb.mixed;
    const list: Part[] = [
      {
        label: "Base damage",
        fmt: "k",
        one: ha.base,
        two: hb.base,
        block: block("Base damage", "hitBase"),
      },
      {
        label: "Increased",
        fmt: "inc",
        one: num(ha.inc),
        two: num(hb.inc),
        block: block("Increased damage", "damageInc", "%", false, mixed),
      },
      {
        label: "More",
        fmt: "x",
        one: num(ha.more),
        two: num(hb.more),
        block: block("More damage", "damageMore", "%", true, mixed),
      },
      {
        label: "Crit",
        fmt: "x",
        one: num(ha.crit),
        two: num(hb.crit),
        block: {
          title: "Crit",
          unit: "%",
          noTotal: true,
          rows: [
            {
              group: "Base",
              key: "Crit chance",
              one: ha.critChance ?? null,
              two: hb.critChance ?? null,
            },
            {
              group: "Base",
              key: "Crit multi",
              one: percentOf(ha.critMulti),
              two: percentOf(hb.critMulti),
            },
          ],
        },
      },
    ];
    const resistOne = num(ha.resist);
    const resistTwo = num(hb.resist);
    if (Math.abs(resistOne - 1) > 0.005 || Math.abs(resistTwo - 1) > 0.005)
      list.push({
        label: "Vs enemy",
        fmt: "x",
        one: resistOne,
        two: resistTwo,
      });
    hit = finish(list, hitOne, hitTwo);
  }

  let speed: { parts?: Part[]; lowest?: boolean } | undefined;
  const sa = pa.speed;
  const sb = pb.speed;
  if (sa && sb && positive(sa.cap) && positive(sb.cap) && positive(sa.source) && positive(sb.source)) {
    const list: Part[] = [
      {
        label: "Cooldown cap",
        fmt: "rate",
        one: sa.cap,
        two: sb.cap,
        block: block("Cooldown recovery", "cooldownRecovery", "%"),
      },
      { label: "Trigger rate", fmt: "rate", one: sa.source, two: sb.source },
    ];
    // PoB's rate also counts trigger chance and skills sharing the trigger: "Other" is the
    // rate over the lower of the two.
    const other: Part = {
      label: "Other",
      fmt: "x",
      one: speedOne / Math.min(sa.cap, sa.source),
      two: speedTwo / Math.min(sb.cap, sb.source),
    };
    if (Math.abs(other.one - 1) > 0.01 || Math.abs(other.two - 1) > 0.01) list.push(other);
    speed = { lowest: true, parts: list };
  } else if (sa && sb && positive(sa.base) && positive(sb.base) && speedOne > 0 && speedTwo > 0)
    speed = {
      parts: finish(
        [
          { label: "Base rate", fmt: "rate", one: sa.base, two: sb.base },
          {
            label: "Increased",
            fmt: "inc",
            one: num(sa.inc),
            two: num(sb.inc),
            block: block("Increased speed", "speedInc", "%"),
          },
          {
            label: "More",
            fmt: "x",
            one: num(sa.more),
            two: num(sb.more),
            block: block("More speed", "speedMore", "%", true),
          },
        ],
        speedOne,
        speedTwo,
      ),
    };

  const ailment = (key: string, totalOne: number, totalTwo: number): Part[] | undefined => {
    const a = pa[key];
    const b = pb[key];
    if (!a || !b || !positive(a.base) || !positive(b.base) || !(totalOne > 0 && totalTwo > 0))
      return undefined;
    const mixed = !!a.mixed || !!b.mixed;
    const list: Part[] = [
      { label: "Base damage", fmt: "k", one: a.base, two: b.base },
      {
        label: "Increased",
        fmt: "inc",
        one: num(a.inc),
        two: num(b.inc),
        block: block("Increased damage", key + "Inc", "%", false, mixed),
      },
      {
        label: "More",
        fmt: "x",
        one: num(a.more),
        two: num(b.more),
        block: block("More damage", key + "More", "%", true, mixed),
      },
      {
        label: "DoT multi",
        fmt: "inc",
        one: num(a.multi),
        two: num(b.multi),
        block: block("DoT multi", key + "Multi", "%"),
      },
    ];
    const enemyOne = num(a.enemy);
    const enemyTwo = num(b.enemy);
    if (Math.abs(enemyOne - 1) > 0.005 || Math.abs(enemyTwo - 1) > 0.005)
      list.push({ label: "Vs enemy", fmt: "x", one: enemyOne, two: enemyTwo });
    if (key === "Poison") {
      if (!positive(a.chance) || !positive(b.chance) || !positive(a.duration) || !positive(b.duration))
        return undefined;
      list.push(
        {
          label: "Poison chance",
          fmt: "%",
          one: a.chance,
          two: b.chance,
          block: block("Poison chance", "PoisonChance", "%"),
        },
        {
          label: "Duration",
          fmt: "s",
          one: a.duration,
          two: b.duration,
          block: block("Increased duration", "PoisonDuration", "%"),
        },
        { label: "Hits/sec", fmt: "rate", one: speedOne, two: speedTwo },
      );
    }
    return finish(list, totalOne, totalTwo);
  };

  return { hit, speed, ailment };
}

/** The damage and speed mods of both builds by source ("more" mods multiply). */
function dpsBlocks(one: Calculated, two: Calculated, damage: boolean, speed: boolean) {
  const tabsOne = one.extra.tabs ?? {};
  const tabsTwo = two.extra.tabs ?? {};
  const blocks: WhyBlock[] = [];
  const block = (title: string, key: string, product?: boolean) => {
    const rows = one.stats && two.stats ? paired(one, tabsOne[key], two, tabsTwo[key], product) : [];
    if (rows.length) blocks.push({ title, unit: "%", product, rows });
  };
  if (damage) {
    block("Increased damage", "damageInc");
    block("More damage", "damageMore", true);
  }
  if (speed) {
    block("Increased speed", "speedInc");
    block("More speed", "speedMore", true);
  }
  return blocks;
}

// Config -------------------------------------------------------------------------------

export interface ConfigDiff {
  rows: { label: string; one: string | null; two: string | null }[];
  modsOne: string[];
  modsTwo: string[];
}

function configMap(stats: Stats | undefined) {
  const rows = new Map<string, string>();
  const mods: string[] = [];
  const lists = stats?.lists;
  const set = lists ? (lists.configs[(lists.active.config ?? 1) - 1] ?? lists.configs[0]) : undefined;
  for (const row of set?.rows ?? []) {
    if ("label" in row) rows.set(stripPob(row.label).replace(/:$/, ""), stripPob(row.value));
    else if ("mod" in row && !row.off) mods.push(stripPob(row.mod));
  }
  return { rows, mods };
}

/** Settings that differ between the two builds' own configs, and their custom mods. */
export function configDiff(one: Stats | undefined, two: Stats | undefined): ConfigDiff {
  const a = configMap(one);
  const b = configMap(two);
  const labels = [...new Set([...a.rows.keys(), ...b.rows.keys()])];
  return {
    rows: labels
      .map((l) => ({
        label: l,
        one: a.rows.get(l) ?? null,
        two: b.rows.get(l) ?? null,
      }))
      .filter((row) => row.one !== row.two),
    modsOne: a.mods,
    modsTwo: b.mods,
  };
}

// PoB's Calcs tab -----------------------------------------------------------------------

/** A cell of PoB's Calcs tab (pob-host.lua's compareCalcsPage): value, working and mods. */
export interface CalcCell {
  label: string;
  value: string;
  /** Its place in PoB's whole Calcs table: the same cell on both builds. */
  order: number;
  /** PoB's working, as its tooltip shows it. */
  lines: string[];
  tables: { label?: string; footer?: string; cols: string[]; rows: string[][] }[];
  /** The tooltip's mod tables: each mod with its type and source. */
  mods: { label?: string; rows: TabRow[] }[];
}

export interface CalcPageSection {
  id: string;
  label: string;
  rows: CalcCell[];
}

export interface CalcPage {
  player: CalcPageSection[];
  minion?: CalcPageSection[];
}

const text = (value: unknown) => stripPob(String(value ?? "")).trim();

function readCalcPage(raw: unknown): CalcPageSection[] {
  return rowsOf<Record<string, unknown>>(raw).map((section) => ({
    id: String(section.id ?? ""),
    label: text(section.label ?? section.id),
    rows: rowsOf<Record<string, unknown>>(section.rows).map((cell) => ({
      label: text(cell.label),
      value: text(cell.value),
      order: Number(cell.order) || 0,
      lines: rowsOf<unknown>(cell.lines).map(text),
      tables: rowsOf<Record<string, unknown>>(cell.tables).map((table) => ({
        label: table.label ? text(table.label) : undefined,
        footer: table.footer ? text(table.footer) : undefined,
        cols: rowsOf<unknown>(table.cols).map(text),
        rows: rowsOf<unknown>(table.rows).map((row) => rowsOf<unknown>(row).map(text)),
      })),
      mods: rowsOf<Record<string, unknown>>(cell.mods).map((mods) => ({
        label: mods.label ? text(mods.label) : undefined,
        rows: rowsOf<TabRow>(mods.rows),
      })),
    })),
  }));
}

export function readCalcsPage(raw: unknown): CalcPage | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const page = raw as Record<string, unknown>;
  const minion = readCalcPage(page.minion);
  return { player: readCalcPage(page.player), minion: minion.length ? minion : undefined };
}

/** A Calcs row on both builds. */
export interface CalcLine {
  section: string;
  label: string;
  order: number;
  one?: CalcCell;
  two?: CalcCell;
  /** Build 1's minus Build 2's, when both start with a number. */
  diff?: number;
  /** Lower is better (costs, cooldowns). */
  lower: boolean;
}

/** Costs, cooldowns, requirements, use times and reservations: lower is better anywhere. */
const LOWER_BETTER =
  /cost|cooldown(?! recovery)|degen|required|recharge delay|reserved|(cast|channel|throwing|laying|placement) time/i;

/** Rows where lower is better within a section: damage you take and effects on you. */
const LOWER_IN: Record<string, RegExp> = {
  "Skill type-specific Stats": /per second/i,
  "Damage Taken": /./,
  "Damaging Hits": /^Hit taken/,
  'Effective "Health" Pool': /^Unmitigated/,
  "Dots and Build Degens": /^DoT taken/,
  "Other Ailment Defences": /./,
  "Other Defences": /Effect on You|Exposure Effect|Wither Effect/,
  "Stun Duration": /Stun Chance|Stun Duration/,
  "Other Avoidance": /Blind Duration/,
  Flasks: /Charges Used/,
  Rage: /Inherent Rage Loss/,
};

const lowerBetter = (section: string, label: string) =>
  LOWER_BETTER.test(label) || !!LOWER_IN[section]?.test(label);

/** The leading number of a Calcs value: "x 1.158" → 1.158, "18,754 to 27,823" → 18754. */
const calcNumber = (value: string | undefined) => leadingNumber(value?.replace(/^x\s*/, ""));

/** Both builds' Calcs rows for the player or the minion, in PoB's order. */
export function calcLines(one: Extra, two: Extra, who: "player" | "minion"): CalcLine[] {
  const lines = new Map<number, CalcLine>();
  const add = (sections: CalcPageSection[] | undefined, which: "one" | "two") => {
    for (const section of sections ?? [])
      for (const cell of section.rows) {
        const line = lines.get(cell.order) ?? {
          section: section.label,
          label: cell.label,
          order: cell.order,
          lower: lowerBetter(section.label, cell.label),
        };
        line[which] = cell;
        lines.set(cell.order, line);
      }
  };
  add(one.calcsPage?.[who], "one");
  add(two.calcsPage?.[who], "two");
  return [...lines.values()]
    .map((line) => {
      const a = calcNumber(line.one?.value);
      const b = calcNumber(line.two?.value);
      return { ...line, diff: a !== undefined && b !== undefined ? a - b : undefined };
    })
    .sort((p, q) => p.order - q.order);
}

const MOD_TYPE: Record<string, string> = {
  BASE: "Base",
  INC: "Increased",
  MORE: "More",
  OVERRIDE: "Override",
  FLAG: "Flag",
  LIST: "List",
};

/**
 * A Calcs row's mod tables for both builds, a table per mod type ("more" mods multiply).
 * Base mods get a table per stat when there are several (max resist apart from resist);
 * increases to several stats add up, as PoB adds them.
 */
export function calcBlocks(one: Calculated, two: Calculated, line: CalcLine): WhyBlock[] {
  if (!one.stats || !two.stats) return [];
  const groups = new Map<string, { a: TabRow[]; b: TabRow[] }>();
  const baseNames = new Set(
    [line.one, line.two].flatMap((cell) =>
      (cell?.mods ?? []).flatMap((mods) => mods.rows.filter((r) => r.type === "BASE").map((r) => r.name)),
    ),
  );
  const collect = (cell: CalcCell | undefined, which: "a" | "b") => {
    for (const mods of cell?.mods ?? [])
      for (const row of mods.rows) {
        const stat = row.type === "BASE" && baseNames.size > 1 ? (row.name ?? "") : "";
        const key = (mods.label ?? "") + "|" + (row.type ?? "") + "|" + stat;
        const group = groups.get(key) ?? { a: [], b: [] };
        group[which].push(row);
        groups.set(key, group);
      }
  };
  collect(line.one, "a");
  collect(line.two, "b");
  const blocks: WhyBlock[] = [];
  for (const [key, group] of groups) {
    const [label, type, stat] = key.split("|");
    const product = type === "MORE";
    const rows = paired(one, group.a, two, group.b, product);
    if (!rows.length) continue;
    blocks.push({
      // "FireResistMax" → "Fire Resist Max".
      title: [label, MOD_TYPE[type] ?? type, stat.replace(/([a-z])([A-Z])/g, "$1 $2")]
        .filter(Boolean)
        .join(" · "),
      unit: type === "INC" || type === "MORE" ? "%" : undefined,
      product,
      noTotal: type === "FLAG" || type === "LIST" || type === "OVERRIDE",
      rows,
    });
  }
  return blocks;
}
