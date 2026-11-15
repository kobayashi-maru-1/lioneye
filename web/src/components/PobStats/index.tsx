import { characterLevelAtom } from "../../state/character-level";
import {
  currentActAtom,
  indexForLevel,
  followedAct,
} from "../../state/current-act";
import {
  liveCharacterAtom,
  liveRefreshAtom,
  liveStatsAtom,
} from "../../state/live-character";
import { liveViewAtom, viewingLiveAtom } from "../../state/live-view";
import {
  loadoutPickAtom,
  loadoutPickShownAtom,
  overlayLoadoutAtom,
  type SetSteps,
} from "../../state/overlay";
import { type MainSkillPick, mainSkillPickAtom } from "../../state/main-skill";
import { buildIdSelector, pobAtom } from "../../state/pob";
import { pobCodeToXml } from "../../state/pob/process";
import { stripPob } from "../PobText";
import { type SetPick, useFollowAct } from "../SetPager";
import { persistentAtom } from "../../state";
import {
  type PrimitiveAtom,
  useAtom,
  useAtomValue,
  useSetAtom,
} from "jotai";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

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

/** A ring of a jewel's radius on the tree (tree units); `inner` for Thread of Hope. */
export interface JewelRing {
  x: number;
  y: number;
  outer: number;
  inner?: number;
}

/** A jewel in a taken socket of a tree, where it sits and its radius rings. */
export interface TreeJewel {
  node: number;
  item: number;
  x: number;
  y: number;
  rings: JewelRing[];
}

/** A passive as a timeless jewel left it (PoB's replacement), and which jewel. */
export interface ConqueredNode {
  name: string;
  stats: string[];
  by?: string;
}

/** A cluster jewel passive PoB generated (its id, place and text). */
export interface ClusterNode {
  id: number;
  x: number;
  y: number;
  /** PoB's node type: Normal, Notable, Socket, Keystone or Mastery. */
  kind: string;
  name?: string;
  stats: string[];
  alloc?: boolean;
}

/** A link between cluster passives (or to their socket); r: an arc of that radius. */
export interface ClusterLink {
  a: number;
  b: number;
  r?: number;
  /** Clockwise from a to b. */
  cw?: boolean;
}

/** What a tree's drawing needs from PoB beyond the tree data. */
export interface TreeExtras {
  /** The tree version PoB used (the latest for a spec on an older tree). */
  version?: string;
  jewels: TreeJewel[];
  /** By node id. */
  conquered: Record<string, ConqueredNode>;
  cluster: { nodes: ClusterNode[]; links: ClusterLink[] };
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

/** Which tree and skill, item and config set a loadout uses (places from 1, as `active`). */
export interface LoadoutPlaces {
  tree: number;
  skills: number;
  items: number;
  config: number;
  /** Its skill set has no title (SetTitles' `skills` unset). */
  skillsUntitled?: boolean;
}

export interface Stats {
  loadouts: string[];
  /** Each loadout's sets (as `loadouts`); false where PoB couldn't tell. */
  loadoutSets: (LoadoutPlaces | false)[];
  loadout: string | null;
  skill: SkillState | null;
  sets: SetTitles | null;
  lists: SetLists | null;
  headline: Headline | null;
  gear: Gear | null;
  /** Per tree (PoB's order): jewels, conquered passives and cluster passives. */
  treeExtras: TreeExtras[];
  config: ConfigRow[];
  skills: SkillGroup[];
  passives: Passive[];
  /** Gem top levels other than 20 (Empower 3, Awakened 5), by gem item id. */
  gemMaxLevels: Record<string, number>;
  health: HealthFinding[];
  rows: StatRow[];
  warnings: string[];
}

export interface PobStatsValue {
  /** The imported build as PoB XML; null without a build or when it can't be read. */
  xml: string | null;
  /** A build is imported but its code can't be read. */
  unreadable: boolean;
  /** The answer for the current build; null before the first one. */
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
  /**
   * The page shows your live character (the Loadout dropdown's "Live character"): `xml`,
   * `stats`, `loading` and `error` are its. The plan's own stay in `planStats`.
   */
  live: boolean;
  /** The plan's shown loadout (Compare's Build 2), whatever the page shows. */
  planStats: Stats | null;
  /** The plan's own state: calculating (planStats may be the last loadout's), or failed. */
  planLoading: boolean;
  planError: string | null;
  /**
   * Which set of each kind the loadout you picked uses (from 1): PoB's answer once it's for
   * that loadout, before that the build's loadout map, so panels switch without waiting
   * for PoB. Null before PoB's first answer.
   */
  active: SetLists["active"] | null;
  /**
   * Titles (without colour codes) of the tree and skill set of the loadout you picked, the
   * same way. Null without a loadout shown (the panels then follow the act themselves).
   */
  loadoutSets: { tree: string; skills?: string } | null;
  /** `active` and `loadoutSets` are the loadout you picked (or there's none to wait for). */
  setsReady: boolean;
  /** A loadout picked in the bar is still to be shown (it may leave the live view). */
  pickPending: boolean;
}

const PobStatsContext = createContext<PobStatsValue | null>(null);

const NONE: string[] = [];

/** PoB's answer, with the build, loadout and main skill it was asked for. */
interface Answer {
  xml: string;
  buildId: number;
  pickKey: string;
  /** The loadout asked for (PoB's name); null: the one PoB has. */
  requested: string | null;
  stats: Stats;
}

/**
 * The last answer, kept while the guide page is away (League, Atlas, Settings): back on it,
 * the panels show it at once and PoB recalculates only when the request has changed.
 */
let lastAnswer: Answer | null = null;

/** The loadout you picked, kept through Settings and restarts (see useFollowAct). */
const loadoutMemoryAtom = persistentAtom<SetPick | null>(
  "loadout-pick",
  null,
  0,
);

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

  const buildId = useAtomValue(buildIdSelector);

  // Kept with the build and pick it was asked with, so a new import never shows the old
  // build's loadouts and the "PoB pick" tag never describes an older pick. A save of the
  // same build in PoB keeps the last answer (shown as calculating) until the new one
  // comes, so the loadout list and your pick stay put. Kept while the guide page is away
  // too (lastAnswer), so coming back shows it at once.
  const [answer, setAnswer] = useState<Answer | null>(() => lastAnswer);
  const stats =
    answer !== null &&
    xml !== null &&
    (answer.xml === xml || answer.buildId === buildId)
      ? answer.stats
      : null;
  const loadouts = stats?.loadouts ?? NONE;
  // PoB's names carry its colour codes ("^2Act 1 - 12 pts"); match and show them without.
  const titles = useMemo(() => loadouts.map(stripPob), [loadouts]);
  const [index, setIndex, followed] = useFollowAct(titles, loadoutMemoryAtom);
  const requested = loadouts[index] ?? null;
  // The loadout you picked, while PoB still calculates it: its sets from the build's
  // loadout map (in the answer before), so panels show them at once.
  const ahead =
    stats !== null && requested !== null && stats.loadout !== requested
      ? placesIn(stats, index)
      : null;
  const planActive = ahead ?? stats?.lists?.active ?? null;
  const planSets = useMemo(() => loadoutSetsOf(stats, ahead), [stats, ahead]);

  const [pick, setPick] = useAtom(mainSkillPickAtom);
  const pickKey = JSON.stringify(pick);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Back on the guide page with the answer for this very request: nothing to calculate.
  const firstRequest = useRef(true);
  useEffect(() => {
    if (xml === null) return;
    const first = firstRequest.current;
    firstRequest.current = false;
    if (
      first &&
      answer !== null &&
      answer.xml === xml &&
      answer.buildId === buildId &&
      answer.requested === requested &&
      answer.pickKey === pickKey
    )
      return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchStats(xml, requested, pick, controller.signal)
      .then((stats) => {
        // An older request (previous save or loadout) never replaces the current one.
        if (controller.signal.aborted) return;
        const next = { xml, buildId, pickKey, requested, stats };
        lastAnswer = next;
        setAnswer(next);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => controller.abort();
  }, [xml, buildId, requested, pickKey, attempt]);

  // Your live character, when the Loadout dropdown shows it: its numbers (calculated by
  // LiveCharacterSync) in place of the plan's. The loadout list and your place in it
  // stay the plan's, so picking a loadout again lands where you were.
  const viewingLive = useAtomValue(viewingLiveAtom);
  const live = useAtomValue(liveCharacterAtom);
  const liveStats = useAtomValue(liveStatsAtom);
  const setRefresh = useSetAtom(liveRefreshAtom);
  const liveAnswer =
    viewingLive && live !== null && liveStats?.code === live.code
      ? liveStats
      : null;
  const liveXml = useMemo(() => {
    if (!viewingLive || live === null) return null;
    try {
      return pobCodeToXml(live.code);
    } catch {
      return null;
    }
  }, [viewingLive, live?.code]);

  // The bar's Loadout tooltip: the plan's loadouts, kept while the same build's are read
  // again. None without a build, for one PoB found no loadouts in, while a different
  // build calculates, or when PoB couldn't read it.
  const setOverlayLoadout = useSetAtom(overlayLoadoutAtom);
  const otherBuild = answer !== null && answer.buildId !== buildId;
  useEffect(() => {
    if (
      code === null ||
      (stats !== null && titles.length === 0) ||
      (stats === null && (error !== null || otherBuild))
    )
      setOverlayLoadout(null);
    else if (titles.length > 0)
      setOverlayLoadout({
        titles,
        index,
        auto: followed,
        live: viewingLive,
        buildId,
      });
  }, [
    code,
    stats,
    error,
    otherBuild,
    titles,
    index,
    followed,
    viewingLive,
    buildId,
  ]);
  // A loadout picked there: shown as if from the Loadout dropdown (back on the plan, too,
  // so the bar's other tooltips follow it). One picked while this page was away (on
  // Settings) is shown once PoB has answered with the loadouts again, unless the build,
  // that loadout or the Auto one has changed since.
  const loadoutPick = useAtomValue(loadoutPickAtom);
  const [shownPick, setShownPick] = useAtom(loadoutPickShownAtom);
  const setLiveView = useSetAtom(liveViewAtom);
  useEffect(() => {
    if (
      loadoutPick === null ||
      loadoutPick.n === shownPick ||
      titles.length === 0
    )
      return;
    setShownPick(loadoutPick.n);
    const { index: at, title, buildId: pickBuild, auto } = loadoutPick;
    if (pickBuild !== buildId) return;
    const target = titles[at] === title ? at : titles.indexOf(title);
    if (target < 0 || target >= titles.length) return;
    const autoNow = followed === null ? null : (titles[followed] ?? null);
    if (auto !== autoNow) return;
    setLiveView(false);
    setIndex(target);
  }, [loadoutPick, titles.length]);
  // The panels know the sets of the loadout you picked: PoB answered for it, or the
  // loadout map has it, and no pick from the bar is still to be shown (that effect runs
  // after the panels'). Or there's nothing to wait for: no build, or PoB failed.
  const pickPending =
    loadoutPick !== null && loadoutPick.n !== shownPick && titles.length > 0;
  const setsReady =
    !pickPending &&
    (xml === null ||
      error !== null ||
      (stats !== null &&
        (requested === null ||
          stats.loadout === requested ||
          ahead !== null)));

  const value = useMemo<PobStatsValue>(
    () =>
      viewingLive
        ? {
            xml: liveXml,
            unreadable: false,
            stats: liveAnswer?.state === "ready" ? liveAnswer.stats : null,
            titles,
            index,
            setIndex,
            loading: liveAnswer?.state !== "ready",
            error: liveAnswer?.state === "error" ? "Live not calculated" : null,
            retry: () => setRefresh((n) => n + 1),
            pick,
            setPick,
            fallback: false,
            live: true,
            planStats: stats,
            planLoading: loading,
            planError: error,
            active:
              liveAnswer?.state === "ready"
                ? (liveAnswer.stats.lists?.active ?? null)
                : null,
            loadoutSets:
              liveAnswer?.state === "ready"
                ? loadoutSetsOf(liveAnswer.stats, null)
                : null,
            setsReady:
              !pickPending &&
              (liveAnswer?.state === "ready" || liveAnswer?.state === "error"),
            pickPending,
          }
        : {
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
            live: false,
            planStats: stats,
            planLoading: loading,
            planError: error,
            active: planActive,
            loadoutSets: planSets,
            setsReady,
            pickPending,
          },
    [
      pickPending,
      planActive,
      planSets,
      setsReady,
      code,
      xml,
      stats,
      titles,
      index,
      loading,
      error,
      pick,
      pickKey,
      answer,
      viewingLive,
      liveXml,
      liveAnswer,
    ],
  );

  return (
    <PobStatsContext.Provider value={value}>
      {children}
    </PobStatsContext.Provider>
  );
}

/** Loadout `index`'s sets from the build's loadout map, if they fit the set lists. */
function placesIn(stats: Stats, index: number): LoadoutPlaces | null {
  const places = stats.loadoutSets[index];
  const lists = stats.lists;
  if (!places || typeof places !== "object" || !lists) return null;
  const fits = (place: unknown, count: number) =>
    Number.isInteger(place) && (place as number) >= 1 && (place as number) <= count;
  return fits(places.tree, lists.trees.length) &&
    fits(places.skills, Math.max(lists.skills.length, 1)) &&
    fits(places.items, Math.max(lists.items.length, 1)) &&
    fits(places.config, Math.max(lists.configs.length, 1))
    ? places
    : null;
}

/** The tree and skill set titles of the shown loadout, or of `ahead` (see `loadoutSets`). */
function loadoutSetsOf(stats: Stats | null, ahead: LoadoutPlaces | null) {
  if (!stats?.sets) return null;
  // (Also when the answer before had no loadout: the build's saved sets match none.)
  if (ahead && stats.lists) {
    const tree = stats.lists.trees[ahead.tree - 1];
    const skills = stats.lists.skills[ahead.skills - 1];
    if (tree !== undefined)
      return {
        tree: stripPob(tree),
        skills:
          ahead.skillsUntitled || skills === undefined
            ? undefined
            : stripPob(skills),
      };
  }
  if (stats.loadout === null) return null;
  return {
    tree: stripPob(stats.sets.tree),
    skills:
      stats.sets.skills === undefined ? undefined : stripPob(stats.sets.skills),
  };
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
  return usePobStats()?.loadoutSets ?? null;
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
  // The act sets follow (useFollowAct): the marker's, or the one your level suggests.
  const actKey = followedAct(act, level) ?? "";
  const key = `${loadout}|${actKey}|${levelIndex}|${titles.join("\n")}`;
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
  const picked = current.index !== null && current.index < titles.length;
  const index = picked ? current.index! : base;
  const choose = useCallback(
    (index: number) => setOverride({ key, index }),
    [key],
  );
  // The loadout's set, while a loadout is shown (null without loadouts): a panel showing
  // another marks its dropdown.
  const loadoutAt =
    pob?.loadoutSets != null &&
    loadoutIndex !== null &&
    loadoutIndex >= 0 &&
    loadoutIndex < titles.length
      ? loadoutIndex
      : null;
  // `picked`: you chose this set in the panel.
  return [index, choose, picked, loadoutAt] as const;
}

/** How long a bar arrow press waits for its panel (the guide coming back, PoB answering). */
const STEP_WAIT_MS = 30_000;

/**
 * A bar tooltip's ‹ › arrows (`stepAtom`: presses not yet taken): the panel shows the set
 * before or after, as if picked in its dropdown. Taken once the panel knows the loadout's
 * sets (setsReady), so a press that brought the guide back from another page lands on
 * them. Dropped while the page shows your live character (the tooltip's sets are the
 * plan's), and when it waited too long (a build without this panel).
 */
export function useSetSteps(
  stepAtom: PrimitiveAtom<SetSteps>,
  index: number,
  count: number,
  choose: (index: number) => void,
) {
  const [steps, setStep] = useAtom(stepAtom);
  const { total, at } = steps;
  const viewingLive = useAtomValue(viewingLiveAtom);
  const pob = usePobStats();
  const ready = pob === null || pob.setsReady;
  const waiting = pob?.pickPending ?? false;
  // The presses already taken (the atom's value then), so running again on the same
  // value (React's StrictMode does) doesn't take them twice.
  const taken = useRef<SetSteps | null>(null);
  useEffect(() => {
    if (total === 0 || waiting || (!ready && !viewingLive)) return;
    if (taken.current === steps) return;
    taken.current = steps;
    // Only what was seen here: a press that came since stays for the next run.
    setStep((now) => ({ ...now, total: now.total - total }));
    if (viewingLive || count === 0 || Date.now() - at > STEP_WAIT_MS) return;
    const next = Math.min(Math.max(index + total, 0), count - 1);
    if (next !== index) choose(next);
  }, [steps, ready, waiting, viewingLive]);
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
    loadoutSets: list(stats.loadoutSets),
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
    treeExtras: list(stats.treeExtras).map(treeExtrasData),
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

function treeExtrasData(extras: Partial<TreeExtras>): TreeExtras {
  const conquered: Record<string, ConqueredNode> = {};
  const raw =
    extras.conquered && !Array.isArray(extras.conquered)
      ? extras.conquered
      : {};
  for (const [id, node] of Object.entries(raw))
    conquered[id] = { ...node, stats: list(node.stats) };
  const cluster: Partial<TreeExtras["cluster"]> =
    extras.cluster && !Array.isArray(extras.cluster) ? extras.cluster : {};
  return {
    version: extras.version,
    jewels: list(extras.jewels).map((jewel) => ({
      ...jewel,
      rings: list(jewel.rings),
    })),
    conquered,
    cluster: {
      nodes: list(cluster.nodes).map((node) => ({
        ...node,
        stats: list(node.stats),
      })),
      links: list(cluster.links),
    },
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
