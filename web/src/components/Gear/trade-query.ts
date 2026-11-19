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

// Downsides ("Adds 4 to 12 Cold Damage to Attacks against you"): left out of the search.
const DOWNSIDE = /\bagainst you\b/;

// Key mods a listing must always have, whatever Min mods says: gem levels, and the item's
// main damage mod: "Minions deal N% increased Damage" when it has one, otherwise its biggest
// plain "N% increased … Damage" (not conditional ones: "Exerted Attacks deal …").
const GEM_LEVEL = /^\+\d+ to Level of .+ Gems$/;
const DAMAGE = /^(Minions deal )?(\d+)% increased (?:[A-Za-z]+ )*Damage$/;

const NUM = /[+-]?\d+(?:\.\d+)?/g;
const NOTABLE = /^1 Added Passive Skill is /;

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
    // PoB: "Grants Level 20 Aspect of the Spider Skill"; the trade site mostly drops "Skill".
    template.replace(/ Skill$/, ""),
  ]))
    tries.push([t, 1]);
  if (/\breduced\b/.test(template))
    tries.push([template.replace(/\breduced\b/, "increased"), -1]);
  if (/\bless\b/.test(template))
    tries.push([template.replace(/\bless\b/, "more"), -1]);

  const local = localKind(slot, base);
  // A crafted mod also counts when a listing has it as a normal mod, and vice versa.
  const groups = crafted ? ["crafted", "explicit"] : ["explicit"];
  // Cluster notables have their number in the stat's text ("1 Added Passive Skill is Feasting Fiends").
  if (NOTABLE.test(text)) {
    const ids = groups.flatMap((group) => index.byText[group]?.get(text) ?? []);
    if (ids.length) return { ids };
  }
  for (const [t, sign] of tries) {
    const variants = local && local.test(t) ? [`${t} (Local)`, t] : [t];
    for (const variant of variants) {
      const ids = groups.flatMap(
        (group) => index.byText[group]?.get(variant) ?? [],
      );
      if (ids.length) {
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
  /** Cluster jewels: the passive count and item level the search requires (its mods are optional). */
  cluster?: { passives?: number; level?: number };
}

const CLUSTER = /^(Large|Medium|Small) Cluster Jewel$/;
const PASSIVES = /^Adds (\d+) Passive Skills$/;

// The trade site lists each small-passive enchant as "<stat id>|<option>", and joins
// enchants that come as a pair ("...with Bows\n...with Bow Skills") into one entry. One text
// can have several options (curse effect: one for Medium, one for Small): any of them counts.
function smallPassiveEnchant(index: TradeIndex, line: string) {
  if (!line.startsWith("Added Small Passive Skills grant: ")) return null;
  for (const [text, ids] of index.byText.enchant ?? []) {
    if (!text.split("\n").includes(line)) continue;
    return ids.map((full) => {
      const [id, option] = full.split("|");
      return option ? { id, value: { option: Number(option) } } : { id };
    });
  }
  return null;
}

/**
 * Cluster jewels, searched the way players do: the base, the exact passive count, the small
 * passives' enchant and the item level or higher. The explicit mods (notables too) come
 * unticked, to add on the trade site.
 */
function clusterSearch(
  index: TradeIndex,
  item: GearItem,
  slot: string,
  base: string,
  query: Record<string, unknown>,
  options: TradeOptions,
) {
  const required: unknown[] = [];
  let grant: ReturnType<typeof smallPassiveEnchant> = null;
  const cluster: NonNullable<TradeSearch["cluster"]> = {};
  // PoB keeps a cluster's enchants as enchant lines; older items may have them as implicits.
  for (const line of [...item.enchant, ...item.implicit]) {
    const count = line.text.match(PASSIVES);
    const countId = index.byText.enchant?.get("Adds # Passive Skills")?.[0];
    if (count && countId && cluster.passives === undefined) {
      cluster.passives = Number(count[1]);
      required.push({
        id: countId,
        value: { min: cluster.passives, max: cluster.passives },
      });
      continue;
    }
    // A pair of enchant lines is one trade entry: the first line finds it.
    grant ??= smallPassiveEnchant(index, line.text);
  }
  if (grant?.length === 1) required.push(grant[0]);
  const optional: unknown[] = [];
  // Mods whose text has several ids ("1 Added Passive Skill is Evil Eye"): any one counts.
  const optionalGroups: unknown[] = [];
  const seen = new Set<string>();
  let matched = 0;
  for (const line of item.explicit) {
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
    const value = filter.value ? { value: filter.value } : {};
    if (filter.ids.length === 1)
      optional.push({ id: filter.ids[0], ...value, disabled: true });
    else
      optionalGroups.push({
        type: "count",
        value: { min: 1 },
        filters: filter.ids.map((id) => ({ id, ...value })),
        disabled: true,
      });
  }
  const filters: Record<string, unknown> = {
    type_filters: { filters: { rarity: { option: "nonunique" } } },
  };
  if (item.level) {
    cluster.level = item.level;
    filters.misc_filters = { filters: { ilvl: { min: item.level } } };
  }
  query.type = base;
  query.filters = filters;
  const stats: unknown[] = [];
  if (required.length) stats.push({ type: "and", filters: required });
  if (grant && grant.length > 1)
    stats.push({ type: "count", value: { min: 1 }, filters: grant });
  if (optional.length) stats.push({ type: "and", filters: optional });
  stats.push(...optionalGroups);
  if (stats.length) query.stats = stats;
  return { matched, total: item.explicit.length, cluster };
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
    query.filters = {
      type_filters: { filters: { rarity: { option: "unique" } } },
    };
  } else {
    const rawBase =
      item.rarity === "RARE"
        ? (item.base ?? "")
        : item.rarity === "NORMAL"
          ? (item.base ?? name)
          : (index.bases.find((b) => name.includes(b)) ?? item.base ?? "");
    const base = tradeBase(rawBase);
    if (CLUSTER.test(base)) {
      const cluster = clusterSearch(index, item, slot, base, query, options);
      return { url: searchUrl(league, query), ...cluster };
    }
    // Rares search the slot's category; normal and magic items keep their base.
    const category =
      item.rarity !== "RARE"
        ? undefined
        : (CATEGORY[slot.replace(/ Swap$/, "")] ??
          (slot.startsWith("Weapon") && !ABYSSAL.test(slot)
            ? weaponCategory(base)
            : undefined));
    const typeFilters: Record<string, unknown> = {
      rarity: { option: "nonunique" },
    };
    if (category) typeFilters.category = { option: category };
    else if (base) query.type = base;
    query.filters = { type_filters: { filters: typeFilters } };
    type Mod = { id: string; value?: StatFilter["value"] }[];
    const mods: Mod[] = [];
    const key = new Set<Mod>();
    let topDamage: { mod: Mod; minion: boolean; value: number } | null = null;
    const seen = new Set<string>();
    for (const line of item.explicit) {
      if (DOWNSIDE.test(line.text)) continue;
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
      const mod = filter.ids.map((id) =>
        filter.value ? { id, value: filter.value } : { id },
      );
      mods.push(mod);
      if (GEM_LEVEL.test(line.text)) key.add(mod);
      const damage = line.text.match(DAMAGE);
      if (damage) {
        const candidate = {
          mod,
          minion: !!damage[1],
          value: Number(damage[2]),
        };
        if (
          !topDamage ||
          (candidate.minion && !topDamage.minion) ||
          (candidate.minion === topDamage.minion &&
            candidate.value > topDamage.value)
        )
          topDamage = candidate;
      }
    }
    if (topDamage) key.add(topDamage.mod);
    const stats: unknown[] = [];
    // Every mod of `list` as its own filter; `disabled` puts them on the search unticked.
    const require = (list: Mod[], disabled = false) => {
      const off = disabled ? { disabled: true } : {};
      const single = list
        .filter((ids) => ids.length === 1)
        .map((ids) => ({ ...ids[0], ...off }));
      if (single.length) stats.push({ type: "and", filters: single });
      // Same text under several ids: any one of them counts.
      for (const ids of list.filter((ids) => ids.length > 1))
        stats.push({ type: "count", value: { min: 1 }, filters: ids, ...off });
    };
    // A share of the mods is enough ("min % of total mods"); all of them at 100%. Key mods
    // always count among them; the rest make up what's left of the share.
    const need = Math.max(1, Math.ceil(mods.length * options.modShare));
    const rest = mods.filter((mod) => !key.has(mod));
    const restNeed = need - (mods.length - rest.length);
    require(mods.filter((mod) => key.has(mod)));
    if (rest.length && restNeed > 0 && restNeed < rest.length) {
      // Every id of every mod in one count; a mod's ids (same text) rarely occur together.
      stats.push({
        type: "count",
        value: { min: restNeed },
        filters: rest.flat(),
      });
    } else if (rest.length && restNeed >= rest.length) require(rest);
    // The key mods already fill Min mods: the rest come unticked, to tick on the trade site.
    else if (rest.length) require(rest, true);
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

/**
 * A gem search. The build's level and quality are minimums, unless the trade options
 * override them: level 1 (exactly), the gem's top level (`maxLevel`, 20 when unknown) or one
 * above it (corrupted); quality as a minimum (0: any).
 */
export function gemTradeUrl(
  name: string,
  level: number | undefined,
  quality: number | undefined,
  league: string,
  options: TradeOptions = DEFAULT_TRADE_OPTIONS,
  maxLevel = 20,
) {
  const misc: Record<string, unknown> = {};
  switch (options.gemLevel) {
    case "1":
      misc.gem_level = { max: 1 };
      break;
    case "max":
      misc.gem_level = { min: maxLevel };
      break;
    case "max+1":
      misc.gem_level = { min: maxLevel + 1 };
      break;
    default:
      if (level !== undefined && level > 1) misc.gem_level = { min: level };
  }
  const minQuality =
    options.gemQuality === undefined || options.gemQuality === null
      ? quality
      : options.gemQuality;
  if (minQuality !== undefined && minQuality > 0)
    misc.quality = { min: minQuality };
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
