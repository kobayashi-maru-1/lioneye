import { characterLevelAtom } from "../../state/character-level";
import { currentActAtom, indexForLevel } from "../../state/current-act";
import { type MainSkillPick, mainSkillPickAtom } from "../../state/main-skill";
import { pobAtom } from "../../state/pob";
import { pobCodeToXml } from "../../state/pob/process";
import { stripPob } from "../PobText";
import { useFollowAct } from "../SetPager";
import { useAtom, useAtomValue } from "jotai";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

/** The exe runs Path of Building; the hosted site has nothing to ask. */
export const STATS_AVAILABLE = import.meta.env.MODE !== "production";

const STATS_URL = "/api/pob/stats";

export type StatRow =
  { gap: true } | { text: string } | { label: string; value: string };

export type ConfigRow =
  | { section: string }
  | { label: string; value: string; check?: boolean }
  /** A Custom Modifiers group's title, when there's more than one group. */
  | { group: string }
  /** A Custom Modifiers line as typed; `off`: PoB doesn't apply it. */
  | { mod: string; off?: boolean };

/** Every set in the build, and which of each the shown loadout uses (from 1). */
export interface SetLists {
  trees: string[];
  skills: string[];
  items: string[];
  configs: { title: string; rows: ConfigRow[] }[];
  active: { tree: number; skills: number; items: number; config: number };
}

/** The build's title and headline numbers, for the header card. */
export interface Headline {
  skill?: string;
  class?: string;
  ascendancy?: string;
  level?: number;
  life?: number;
  es?: number;
  mana?: number;
  ehp?: number;
  dps?: number;
  fire?: number;
  cold?: number;
  lightning?: number;
  chaos?: number;
}

/** PoB's main skill selectors for the shown loadout. Indexes are PoB's (from 1). */
export interface SkillState {
  /** Whether your remembered pick was found in this loadout (unset: no pick sent). */
  picked?: boolean;
  id?: string;
  label?: string;
  groups: string[];
  /** Active skill ids per group, to remember a group you pick by its gem. */
  groupSkills: string[][];
  /** Each group's own main skill (PoB's choice), the default when you pick that group. */
  groupMain: number[];
  group?: number;
  skills: string[];
  skill?: number;
  parts: string[];
  part?: number;
  minions: string[];
  minion?: number;
  minionSkills: string[];
  minionSkill?: number;
}

/** Titles of the sets PoB uses for the shown loadout, with PoB's colour codes. */
export interface SetTitles {
  tree: string;
  /** Unset when the skill set has no title: the guide then groups gems by label. */
  skills?: string;
  items: string;
  config: string;
}

/** A mod line of an item, as PoB applies it. */
export interface ItemLine {
  text: string;
  crafted?: boolean;
  fractured?: boolean;
}

/** An item from the build, as the Gear panel shows it. */
export interface GearItem {
  name: string;
  base?: string;
  /** NORMAL, MAGIC, RARE, UNIQUE or RELIC. */
  rarity?: string;
  type?: string;
  quality?: number;
  level?: number;
  /** "R-G-B B": a dash links sockets, a space separates groups. */
  sockets?: string;
  corrupted?: boolean;
  /** What the item requires (attributes after its mods). */
  requires?: { level?: number; str?: number; dex?: number; int?: number };
  /** The item as PoB writes it as text, for Copy. */
  raw?: string;
  enchant: ItemLine[];
  implicit: ItemLine[];
  explicit: ItemLine[];
}

/** Every item set's slots (PoB's order), the items by id, and each tree's jewels. */
export interface Gear {
  sets: { title: string; slots: { slot: string; item: number }[] }[];
  items: Record<string, GearItem>;
  /** Per tree (PoB's order): the jewels socketed in it. */
  treeJewels: { node: number; item: number }[][];
}

/** A gem in a socket group of the shown skill set. */
export interface SkillGem {
  name: string;
  support?: boolean;
  enabled: boolean;
  level?: number;
  quality?: number;
}

/** A socket group of the shown skill set. */
export interface SkillGroup {
  label?: string;
  slot?: string;
  enabled: boolean;
  /** Granted by an item or a passive, not socketed. */
  granted?: boolean;
  gems: SkillGem[];
}

/** An allocated passive of the shown tree. */
export interface Passive {
  name: string;
  /** Normal, Notable, Keystone, Mastery or Socket. */
  type?: string;
  ascendancy?: string;
  /** A mastery's picked effect. */
  effect?: string;
}

/** Something to look at in the shown loadout (checks ported from PoB Redux). */
export interface HealthFinding {
  severity: "high" | "medium" | "low";
  message: string;
  fix?: string;
  /** The guide panel that fixes it: gear, tree, gems or config. */
  panel?: string;
}

/** The largest hit of each type the loadout survives, and its other defenses. */
export interface Defences {
  physical?: number;
  fire?: number;
  cold?: number;
  lightning?: number;
  chaos?: number;
  armour?: number;
  evasion?: number;
  block?: number;
  spellBlock?: number;
  lifeRegen?: number;
  manaRegen?: number;
  /** A multiplier: 1.3 is +30%. */
  movementSpeed?: number;
}

export interface Stats {
  loadouts: string[];
  loadout: string | null;
  skill: SkillState | null;
  sets: SetTitles | null;
  lists: SetLists | null;
  headline: Headline | null;
  gear: Gear | null;
  config: ConfigRow[];
  skills: SkillGroup[];
  passives: Passive[];
  /** Gem top levels other than 20 (Empower 3, Awakened 5), by gem item id. */
  gemMaxLevels: Record<string, number>;
  health: HealthFinding[];
  defences: Defences | null;
  rows: StatRow[];
  warnings: string[];
}

export interface PobStatsValue {
  /** The imported build as PoB XML; null without a build or when it can't be read. */
  xml: string | null;
  /** A build is imported but its code can't be read. */
  unreadable: boolean;
  /** The answer for the current build; null before the first one (or on the hosted site). */
  stats: Stats | null;
  /** Loadout names without colour codes, for the pager. */
  titles: string[];
  index: number;
  setIndex: (index: number) => void;
  loading: boolean;
  error: string | null;
  retry: () => void;
  pick: MainSkillPick | null;
  setPick: (pick: MainSkillPick) => void;
  /** Your remembered skill isn't in this loadout; PoB's own pick is shown. */
  fallback: boolean;
}

const PobStatsContext = createContext<PobStatsValue | null>(null);

const NONE: string[] = [];

/**
 * Asks the exe's Path of Building for the imported build's stats, for one loadout at a
 * time. The loadout follows your act; everything on the page that shows a loadout
 * (stats, tree, gems, config) reads it from here.
 */
export function PobStatsProvider({ children }: React.PropsWithChildren) {
  const code = useAtomValue(pobAtom);
  const xml = useMemo(() => {
    if (code === null) return null;
    try {
      return pobCodeToXml(code);
    } catch {
      return null;
    }
  }, [code]);

  // Kept with the build and pick it was asked with, so a new import never shows the old
  // build's loadouts and the "PoB pick" tag never describes an older pick.
  const [answer, setAnswer] = useState<{
    xml: string;
    pickKey: string;
    stats: Stats;
  } | null>(null);
  const stats = answer !== null && answer.xml === xml ? answer.stats : null;
  const loadouts = stats?.loadouts ?? NONE;
  // PoB's names carry its colour codes ("^2Act 1 - 12 pts"); match and show them without.
  const titles = useMemo(() => loadouts.map(stripPob), [loadouts]);
  const [index, setIndex] = useFollowAct(titles);
  const requested = loadouts[index] ?? null;

  const [pick, setPick] = useAtom(mainSkillPickAtom);
  const pickKey = JSON.stringify(pick);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!STATS_AVAILABLE || xml === null) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchStats(xml, requested, pick, controller.signal)
      .then((stats) => {
        setAnswer({ xml, pickKey, stats });
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => controller.abort();
  }, [xml, requested, pickKey, attempt]);

  const value = useMemo<PobStatsValue>(
    () => ({
      xml,
      unreadable: code !== null && xml === null,
      stats,
      titles,
      index,
      setIndex,
      loading,
      error,
      retry: () => setAttempt((n) => n + 1),
      pick,
      setPick,
      fallback:
        pick !== null &&
        answer?.pickKey === pickKey &&
        stats?.skill?.picked === false,
    }),
    [code, xml, stats, titles, index, loading, error, pick, pickKey, answer],
  );

  return (
    <PobStatsContext.Provider value={value}>
      {children}
    </PobStatsContext.Provider>
  );
}

/** The page's PoB stats; null outside a PobStatsProvider. */
export function usePobStats() {
  return useContext(PobStatsContext);
}

/**
 * Titles (without colour codes) of the tree and skill set PoB uses for the shown
 * loadout, so other sections follow the stats' loadout. Null until PoB has answered,
 * and for builds without PoB loadouts (the sections then follow the act themselves).
 */
export function useLoadoutSets() {
  const stats = usePobStats()?.stats;
  return useMemo(
    () =>
      stats?.sets && stats.loadout !== null
        ? {
            tree: stripPob(stats.sets.tree),
            skills:
              stats.sets.skills === undefined
                ? undefined
                : stripPob(stats.sets.skills),
          }
        : null,
    [stats],
  );
}

/**
 * Which set (of `titles`) a panel shows: the loadout's (`loadoutIndex`), or the one for
 * your act without loadouts, unless you pick another in the panel. Your pick lasts until
 * the loadout or the act changes.
 */
export function usePanelSet(titles: string[], loadoutIndex: number | null) {
  const pob = usePobStats();
  // The loadout you picked (or the act picked), even before PoB has answered for it.
  const loadout = pob ? (pob.titles[pob.index] ?? "") : "";
  const act = useAtomValue(currentActAtom);
  const level = useAtomValue(characterLevelAtom)?.level ?? null;
  const levelIndex = indexForLevel(titles, level) ?? "";
  const [followIndex] = useFollowAct(titles);
  const key = `${loadout}|${act ?? ""}|${levelIndex}|${titles.join("\n")}`;
  // A panel pick belongs to one loadout, act and level set; it's dropped when they change.
  const [override, setOverride] = useState<{
    key: string;
    index: number | null;
  }>({ key, index: null });
  let current = override;
  if (override.key !== key) {
    current = { key, index: null };
    setOverride(current);
  }
  const base =
    loadoutIndex !== null && loadoutIndex >= 0 && loadoutIndex < titles.length
      ? loadoutIndex
      : followIndex;
  const index =
    current.index !== null && current.index < titles.length
      ? current.index
      : base;
  const choose = useCallback(
    (index: number) => setOverride({ key, index }),
    [key],
  );
  return [index, choose] as const;
}

/** PoB's stats for a build as saved (its own loadout and main skill), e.g. for Compare. */
export function fetchBuildStats(xml: string, signal: AbortSignal) {
  return fetchStats(xml, null, null, signal);
}

async function fetchStats(
  xml: string,
  loadout: string | null,
  pick: MainSkillPick | null,
  signal: AbortSignal,
): Promise<Stats> {
  const response = await fetch(STATS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ xml, loadout, pick }),
    signal,
  });
  if (!response.ok) {
    const text = response.status === 404 ? "" : await response.text();
    throw new Error(text || "PoB unavailable. Restart the app.");
  }
  const stats = (await response.json()) as Partial<Stats>;
  return {
    loadouts: list(stats.loadouts),
    loadout: stats.loadout ?? null,
    skill: stats.skill ? skillState(stats.skill) : null,
    sets: stats.sets ?? null,
    lists: stats.lists
      ? {
          trees: list(stats.lists.trees),
          skills: list(stats.lists.skills),
          items: list(stats.lists.items),
          configs: list(stats.lists.configs).map((set) => ({
            title: set.title,
            rows: list(set.rows),
          })),
          active: stats.lists.active,
        }
      : null,
    headline: stats.headline ?? null,
    gear: stats.gear ? gearData(stats.gear) : null,
    config: list(stats.config),
    skills: list(stats.skills).map((group) => ({
      ...group,
      gems: list(group.gems),
    })),
    passives: list(stats.passives),
    gemMaxLevels:
      stats.gemMaxLevels && !Array.isArray(stats.gemMaxLevels)
        ? stats.gemMaxLevels
        : {},
    health: list(stats.health),
    defences:
      stats.defences && !Array.isArray(stats.defences) ? stats.defences : null,
    rows: list(stats.rows),
    warnings: list(stats.warnings),
  };
}

// PoB's JSON writes an empty list as {}.
function list<T>(value: T[] | undefined | object): T[] {
  return Array.isArray(value) ? value : [];
}

function gearData(gear: Partial<Gear>): Gear {
  const items: Record<string, GearItem> = {};
  const raw = gear.items && !Array.isArray(gear.items) ? gear.items : {};
  for (const [id, item] of Object.entries(raw)) {
    items[id] = {
      ...item,
      // PoB's JSON writes an empty table as [].
      requires:
        item.requires && !Array.isArray(item.requires)
          ? item.requires
          : undefined,
      enchant: list(item.enchant),
      implicit: list(item.implicit),
      explicit: list(item.explicit),
    };
  }
  return {
    sets: list(gear.sets).map((set) => ({ ...set, slots: list(set.slots) })),
    items,
    treeJewels: list(gear.treeJewels).map((jewels) => list(jewels)),
  };
}

function skillState(skill: Partial<SkillState>): SkillState {
  return {
    ...skill,
    groups: list(skill.groups),
    groupSkills: list<string[]>(skill.groupSkills).map((ids) => list(ids)),
    groupMain: list(skill.groupMain),
    skills: list(skill.skills),
    parts: list(skill.parts),
    minions: list(skill.minions),
    minionSkills: list(skill.minionSkills),
  };
}
