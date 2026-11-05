import { type MainSkillPick, mainSkillPickAtom } from "../../state/main-skill";
import { pobAtom } from "../../state/pob";
import { pobCodeToXml } from "../../state/pob/process";
import { stripPob } from "../PobText";
import { useFollowAct } from "../SetPager";
import { useAtom, useAtomValue } from "jotai";
import React, {
  createContext,
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

export type ConfigRow = { section: string } | { label: string; value: string };

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

export interface Stats {
  loadouts: string[];
  loadout: string | null;
  skill: SkillState | null;
  sets: SetTitles | null;
  config: ConfigRow[];
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
    config: list(stats.config),
    rows: list(stats.rows),
    warnings: list(stats.warnings),
  };
}

// PoB's JSON writes an empty list as {}.
function list<T>(value: T[] | undefined | object): T[] {
  return Array.isArray(value) ? value : [];
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
