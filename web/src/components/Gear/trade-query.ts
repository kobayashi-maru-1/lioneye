// Builds official trade site searches for PoB items (ported from the companion design's
// trade-query.js). Uniques: name + base. Magic, normal, rare: base or slot category plus
// explicit mods, each with a minimum of a share of the PoB value (TradeOptions).
import type { GearItem } from "../PobStats";
import {
  DEFAULT_TRADE_OPTIONS,
  type TradeItemsData,
  type TradeOptions,
  type TradeStatsData,
} from "./data";

export interface TradeIndex {
  /** Per stat group ("explicit", "crafted"...): stat text → trade ids with that text. */
  byText: Record<string, Map<string, string[]>>;
  /** Base types, longest first ("Divine Life Flask" before "Life Flask"). */
  bases: string[];
  /** Unique names, longest first. */
  uniques: string[];
}

export function tradeIndex(stats: TradeStatsData, items: TradeItemsData) {
  const byText: TradeIndex["byText"] = {};
  for (const group of stats.result) {
    const map = new Map<string, string[]>();
    for (const entry of group.entries) {
      const ids = map.get(entry.text) ?? [];
      ids.push(entry.id);
      map.set(entry.text, ids);
    }
    byText[group.id] = map;
  }
  const bases: string[] = [];
  const uniques: string[] = [];
  const kinds = ["accessory", "armour", "flask", "jewel", "weapon", "graft"];
  for (const group of items.result) {
    if (!kinds.includes(group.id)) continue;
    for (const entry of group.entries) {
      if (entry.name) uniques.push(entry.name);
      else if (entry.type) bases.push(entry.type);
    }
  }
  bases.sort((a, b) => b.length - a.length);
  uniques.sort((a, b) => b.length - a.length);
  return { byText, bases, uniques } satisfies TradeIndex;
}

// PoB names some bases by variant ("Two-Stone Ring (Fire/Cold)"); the trade site uses the plain name.
const tradeBase = (base: string) => base.replace(/ \([^)]*\)$/, "");

const CATEGORY: Record<string, string> = {
  Helmet: "armour.helmet",
  "Body Armour": "armour.chest",
  Gloves: "armour.gloves",
  Boots: "armour.boots",
  Amulet: "accessory.amulet",
  "Ring 1": "accessory.ring",
  "Ring 2": "accessory.ring",
  "Ring 3": "accessory.ring",
  Belt: "accessory.belt",
};

// Weapon slots: category from the base name when it's clear, otherwise the exact base.
const WEAPON_CATEGORY: [RegExp, string][] = [
  [/Wand$/, "weapon.wand"],
  [/Sceptre$/, "weapon.sceptre"],
  [/Shield$/, "armour.shield"],
  [/Quiver$/, "armour.quiver"],
  [/Bow$/, "weapon.bow"],
  [/Claw$/, "weapon.claw"],
  [/Dagger$/, "weapon.dagger"],
  [/(Foil|Rapier|Spike)$/, "weapon.onesword"],
];
const weaponCategory = (base: string) =>
  WEAPON_CATEGORY.find(([re]) => re.test(base))?.[1];

// Which stats are local depends on the item: defences on armour and shields, attack stats on weapons.
const LOCAL_DEFENCE =
  /(Armour|Evasion Rating|Energy Shield|Ward|Chance to Block)/;
const LOCAL_WEAPON =
  /(Attack Speed|Accuracy Rating|Critical Strike Chance|Adds # to # \w+ Damage|increased Physical Damage|Leeched as)/;
function localKind(slot: string, base: string) {
  // An abyss jewel in a weapon or armour socket has no local stats of its own.
  if (ABYSSAL.test(slot)) return null;
  if (["Helmet", "Body Armour", "Gloves", "Boots"].includes(slot))
    return LOCAL_DEFENCE;
  if (!slot.startsWith("Weapon")) return null;
  if (/Shield$/.test(base)) return LOCAL_DEFENCE;
  if (/Quiver$/.test(base)) return null;
  return LOCAL_WEAPON;
}

const ABYSSAL = /Abyssal Socket/;

// Drawbacks (flask downsides, trigger costs): required as a mod, never as a target value.
const DRAWBACK =
  /(reduced Amount Recovered|less Duration|reduced Duration|more Cost|reduced Recovery rate)/;

const NUM = /[+-]?\d+(?:\.\d+)?/g;

// Small whole numbers (gem levels, flask charges) stay exact.
function minOf(value: number, share: number) {
  if (Number.isInteger(value) && value < 5) return value;
  const min = value * share;
  return Number.isInteger(value)
    ? Math.floor(min)
    : Math.floor(min * 100) / 100;
}

interface StatFilter {
  ids: string[];
  value?: { min: number } | { max: number };
}

// One mod line -> trade ids plus a value filter, or null when the trade site has no matching stat.
function statFilter(
  index: TradeIndex,
  text: string,
  crafted: boolean,
  slot: string,
  base: string,
  share: number,
): StatFilter | null {
  const nums = (text.match(NUM) ?? []).map(Number);
  const template = text.replace(NUM, (s) => (s[0] === "+" ? "+#" : "#"));
  const signedTemplate = text.replace(NUM, (s) =>
    s[0] === "+" || s[0] === "-" ? "+#" : "#",
  );
  const tries: [string, number][] = [];
  for (const t of new Set([
    template,
    signedTemplate,
    template.replace(/# Charges\b/, "# Charge"),
  ]))
    tries.push([t, 1]);
  if (/\breduced\b/.test(template))
    tries.push([template.replace(/\breduced\b/, "increased"), -1]);
  if (/\bless\b/.test(template))
    tries.push([template.replace(/\bless\b/, "more"), -1]);

  const local = localKind(slot, base);
  const groups = crafted ? ["crafted", "explicit"] : ["explicit"];
  for (const [t, sign] of tries) {
    const variants = local && local.test(t) ? [`${t} (Local)`, t] : [t];
    for (const group of groups) {
      for (const variant of variants) {
        const ids = index.byText[group]?.get(variant);
        if (!ids) continue;
        let value: StatFilter["value"];
        if (nums.length && !DRAWBACK.test(text)) {
          const average =
            (nums.reduce((a, b) => a + b, 0) / nums.length) * sign;
          value =
            average >= 0
              ? { min: minOf(average, share) }
              : { max: -minOf(-average, share) };
        }
        return { ids, value };
      }
    }
  }
  return null;
}

/** A trade search for something like an item: its URL and how many of its mods it uses. */
export interface TradeSearch {
  url: string;
  /** Mods the search filters on, of the item's explicit mods (rares and magic items). */
  matched: number;
  total: number;
}

export function tradeSearch(
  index: TradeIndex,
  item: GearItem,
  slot: string,
  league: string,
  options: TradeOptions = DEFAULT_TRADE_OPTIONS,
): TradeSearch {
  let matched = 0;
  let total = 0;
  const query: Record<string, unknown> = {
    status: { option: options.status },
  };
  // "Foulborn X" is a variant of the unique X on the trade site.
  const name = (item.name ?? "").replace(/^Foulborn /, "");
  if (item.rarity === "UNIQUE" || item.rarity === "RELIC") {
    // PoB lets you rename items: keep the known unique name it starts with.
    const unique = index.uniques.find(
      (u) => name === u || name.startsWith(`${u} `) || name.startsWith(`${u};`),
    );
    if (unique) query.name = unique;
    if (item.base) query.type = tradeBase(item.base);
  } else {
    const rawBase =
      item.rarity === "RARE"
        ? (item.base ?? "")
        : item.rarity === "NORMAL"
          ? (item.base ?? name)
          : (index.bases.find((b) => name.includes(b)) ?? item.base ?? "");
    const base = tradeBase(rawBase);
    const category =
      CATEGORY[slot.replace(/ Swap$/, "")] ??
      (slot.startsWith("Weapon") &&
      !ABYSSAL.test(slot) &&
      item.rarity === "RARE"
        ? weaponCategory(base)
        : undefined);
    const typeFilters: Record<string, unknown> = {
      rarity: { option: "nonunique" },
    };
    if (category) typeFilters.category = { option: category };
    else if (base) query.type = base;
    query.filters = { type_filters: { filters: typeFilters } };
    const and: unknown[] = [];
    const anyOf: unknown[] = [];
    const seen = new Set<string>();
    for (const line of item.explicit) {
      total++;
      const filter = statFilter(
        index,
        line.text,
        !!line.crafted,
        slot,
        base,
        options.valueShare,
      );
      if (!filter || seen.has(filter.ids[0])) continue;
      seen.add(filter.ids[0]);
      matched++;
      const filters = filter.ids.map((id) =>
        filter.value ? { id, value: filter.value } : { id },
      );
      // Same text under several ids: any one of them counts.
      if (filters.length === 1) and.push(filters[0]);
      else anyOf.push({ type: "count", value: { min: 1 }, filters });
    }
    const stats: unknown[] = [];
    // A share of the mods is enough ("min % of total mods"); all of them at 100%.
    const need = Math.max(1, Math.ceil(and.length * options.modShare));
    if (and.length && need < and.length)
      stats.push({ type: "count", value: { min: need }, filters: and });
    else if (and.length) stats.push({ type: "and", filters: and });
    stats.push(...anyOf);
    if (stats.length) query.stats = stats;
  }
  return { url: searchUrl(league, query), matched, total };
}

/** The trade site search URL for an item in a slot, in a league. */
export function tradeUrl(
  index: TradeIndex,
  item: GearItem,
  slot: string,
  league: string,
  options?: TradeOptions,
) {
  return tradeSearch(index, item, slot, league, options).url;
}

/** A trade search for a gem at (at least) the build's level and quality. */
export function gemTradeUrl(
  name: string,
  level: number | undefined,
  quality: number | undefined,
  league: string,
  options: TradeOptions = DEFAULT_TRADE_OPTIONS,
) {
  const misc: Record<string, unknown> = {};
  if (level !== undefined && level > 1) misc.gem_level = { min: level };
  if (quality !== undefined && quality > 0) misc.quality = { min: quality };
  const query: Record<string, unknown> = {
    status: { option: options.status },
    type: name,
    filters: {
      type_filters: { filters: { category: { option: "gem" } } },
      ...(Object.keys(misc).length ? { misc_filters: { filters: misc } } : {}),
    },
  };
  return searchUrl(league, query);
}

function searchUrl(league: string, query: Record<string, unknown>) {
  const q = JSON.stringify({ query, sort: { price: "asc" } });
  return `https://www.pathofexile.com/trade/search/${encodeURIComponent(league)}?q=${encodeURIComponent(q)}`;
}

/** The PoE wiki's search for a name (lands on its page when there is one). */
export function wikiUrl(name: string) {
  return `https://www.poewiki.net/wiki/Special:Search?search=${encodeURIComponent(name)}`;
}
