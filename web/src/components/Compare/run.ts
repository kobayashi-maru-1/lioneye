// Runs a comparison: PoB calculates both builds in full, matches Build 1 to Build 2's PoB
// setup, then finds the path toward Build 2: every change tried on Build 1, the biggest DPS
// gain kept, the rest tried again on top of it, and so on. One request at a time: PoB holds
// one build at a time and the guide shares its queue, so the guide's own requests never
// wait long; leaving the page stops the rest.

import { readStats } from "../PobStats";
import type { MainSkillPick } from "../../state/main-skill";
import {
  type Calculated,
  type ConfigDiff,
  type Extra,
  type Metric,
  type StatLine,
  type Values,
  type Why,
  configDiff,
  mainCooldown,
  mainDps,
  pickMetrics,
  readExtra,
  statLines,
  whys,
} from "./metrics";
import {
  type Change,
  type ChangeKind,
  type Fix as SetupFix,
  type SetPlaces,
  changes,
  flatten,
  mainGroupIn,
  offTests,
  setupFixes,
} from "./xml";
import type { Stats } from "../PobStats";

const COMPARE_URL = "/api/pob/compare";

/**
 * Items' "Unique ID:" lines (poe.ninja and game imports have one per item) change nothing
 * PoB calculates but make it load a build slowly (20 s instead of 1 s for a 35-item build).
 */
const withoutIds = (xml: string) => xml.replace(/^[ \t]*Unique ID:[^\r\n]*\r?\n/gm, "");

async function calculate(
  xml: string,
  loadout: string | null,
  pick: MainSkillPick | null,
  full: boolean,
  signal: AbortSignal,
): Promise<Calculated> {
  const response = await fetch(COMPARE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ xml: withoutIds(xml), loadout, pick, full }),
    signal,
  });
  if (!response.ok) {
    const text = response.status === 404 ? "" : await response.text();
    throw new Error(text || "PoB unavailable. Restart the app.");
  }
  const raw = (await response.json()) as { extra?: Partial<Extra>; stats?: Partial<Stats> };
  return {
    extra: readExtra(raw.extra ?? {}),
    stats: raw.stats ? readStats(raw.stats) : undefined,
  };
}

/** A side to compare: the build's XML, its loadout (PoB's name) and the main skill pick. */
export interface Input {
  xml: string;
  loadout: string | null;
  pick: MainSkillPick | null;
}

/** Where a change's Show goes, and its Trade search. */
export interface Place {
  id: string;
  kind: ChangeKind;
  /** "items" (with `slot`), "skills" or "passives" (no Show). */
  target: string;
  slot?: string;
}

/** A change tried once on Build 1 as set up: each metric's change (null: PoB had no number). */
export interface Gap extends Place {
  title: string;
  detail: string;
  d: Values;
}

/** A setup difference matched before the path; `on` false when undone. */
export interface Fix {
  id: string;
  kind: SetupFix["kind"];
  title: string;
  detail: string;
  on: boolean;
  /** Its DPS change, as a fraction (0.5: +50%); null when undone. */
  gain: number | null;
}

/** A change on the path: Build 1 after it, and what no longer fits. */
export interface Step extends Place {
  title: string;
  detail: string;
  /** DPS change as a fraction of the DPS before it. */
  gain: number;
  /** DPS after it; null for the small ones (each tried on its own). */
  dps: number | null;
  /** The main skill's cooldown after it. */
  cd: number | null;
  /** What it breaks: "Mana −40", "Str −12", "Fire res −8%", "Life −6%". */
  issues: string[];
}

export interface Result {
  /** Build 1 as imported, on its own config. */
  oneOwn: Calculated;
  /** Build 1 on Build 2's setup: what the summary, stats, skills and items show. */
  one: Calculated;
  /** Build 2 on its own config. */
  two: Calculated;
  /** Build 2 uses Build 1's main skill. */
  sameSkill: boolean;
  metrics: Metric[];
  values: { one: Values; two: Values };
  lines: StatLine[];
  why: Record<string, Why>;
  config: ConfigDiff;
  fixes: Fix[];
  /** The main DPS: Build 1 imported, set up, and Build 2's. */
  dps: { imported: number; matched: number; target: number };
  /** Each change tried once on Build 1 as set up (the summary's top gains). */
  gaps: Gap[];
  steps: Step[];
  /** Changes left off the path that still add something (each tried on the build at its time). */
  small: Step[];
  /** The main skill has a cooldown (Build 1 or 2). */
  cooldown: boolean;
  done: boolean;
  /** First pass progress: changes tried and all of them. */
  tried: number;
  total: number;
  failed: number;
}

/** The pick that gives Build 2 and the path Build 1's main skill. */
function pickOf(stats: Stats | undefined, extra: Extra): MainSkillPick | null {
  const skill = stats?.skill;
  const id = extra.skillId ?? skill?.id;
  if (!id) return null;
  const at = (list: string[] | undefined, index: number | undefined) =>
    index === undefined ? undefined : list?.[index - 1];
  return {
    id,
    label: skill?.label,
    group: skill?.group,
    skill: skill?.skill,
    part: at(skill?.parts, skill?.part),
    minion: at(skill?.minions, skill?.minion),
    minionSkill: at(skill?.minionSkills, skill?.minionSkill),
  };
}

const placesOf = (stats: Stats | undefined): SetPlaces => ({
  tree: stats?.lists?.active.tree ?? 1,
  skills: stats?.lists?.active.skills ?? 1,
  items: stats?.lists?.active.items ?? 1,
  config: stats?.lists?.active.config ?? 1,
});

const MINUS = "−";
/** How short a build is: unreserved mana and life below 0, attributes below need, uncapped resists. */
function shortfalls(p: Record<string, number>): Record<string, number> {
  const below = (have: number | undefined, need: number | undefined) => Math.max(0, (need ?? 0) - (have ?? 0));
  return {
    Mana: Math.max(0, -(p.ManaUnreserved ?? 0)),
    "Unreserved life": (p.Life ?? 0) > 1 ? Math.max(0, -(p.LifeUnreserved ?? 0)) : 0,
    Str: below(p.Str, p.ReqStr),
    Dex: below(p.Dex, p.ReqDex),
    Int: below(p.Int, p.ReqInt),
    "Fire res": p.MissingFireResist ?? 0,
    "Cold res": p.MissingColdResist ?? 0,
    "Lightning res": p.MissingLightningResist ?? 0,
  };
}
/** What a change breaks, from the player's numbers before and after it. */
function issuesOf(before: Record<string, number>, after: Record<string, number>): string[] {
  const a = shortfalls(before);
  const b = shortfalls(after);
  const out = Object.keys(b)
    .filter((key) => b[key] > a[key] + 0.5)
    .map((key) => `${key} ${MINUS}${Math.round(b[key])}${key.endsWith(" res") ? "%" : ""}`);
  const life = before.Life ?? 0;
  if (life > 1 && (after.Life ?? 0) < life * 0.95)
    out.push(`Life ${MINUS}${Math.round((1 - (after.Life ?? 0) / life) * 100)}%`);
  return out;
}

/** The path stops when the best change left adds less than this. */
const STEP_MIN = 0.01;
/** Smaller changes still listed from this. */
const SMALL_MIN = 0.002;
/** Changes re-tried each round before one is kept (the rest keep their last gain). */
const FRESH = 3;
const MAX_STEPS = 15;

/** Results kept for this session, by what was compared. */
const cache = new Map<string, Result>();
export const cacheKey = (one: Input, two: Input, off: string[] = []) =>
  JSON.stringify([one.xml, one.loadout, one.pick, two.xml, two.loadout, [...off].sort()]);

/**
 * Compares `one` (Build 1) with `two` (Build 2): Build 1 on Build 2's setup (the fixes in
 * `off` left out), then the path. Calls `update` once the builds are calculated, then
 * after each change tried.
 */
export async function compare(
  one: Input,
  two: Input,
  off: string[],
  update: (result: Result) => void,
  signal: AbortSignal,
): Promise<void> {
  const key = cacheKey(one, two, off);
  const kept = cache.get(key);
  if (kept) {
    update(kept);
    return;
  }

  const oneOwn = await calculate(one.xml, one.loadout, one.pick, true, signal);
  const pick = pickOf(oneOwn.stats, oneOwn.extra);
  const twoOwn = await calculate(two.xml, two.loadout, pick, true, signal);
  const sameSkill = pick !== null && twoOwn.extra.picked === true;
  const flatOne = flatten(one.xml, placesOf(oneOwn.stats));
  const flatTwo = flatten(two.xml, placesOf(twoOwn.stats));
  // The main groups' places in the files (PoB's own list can skip groups).
  const oneMain = mainGroupIn(flatOne, pick?.id ?? null, oneOwn.stats?.skill?.group ?? null);
  const twoMain = sameSkill ? mainGroupIn(flatTwo, pick?.id ?? null, twoOwn.stats?.skill?.group ?? null) : null;
  const quick = async (xml: string) => (await calculate(xml, null, pick, false, signal)).extra;

  // ---- Setup: each fix kept in turn, measured on top of the ones before ----
  let current = flatOne;
  let currentDps = mainDps(await quick(current));
  const fixes: Fix[] = [];
  let setupFailed = 0;
  const tryFix = async (fix: SetupFix) => {
    const row = { id: fix.id, kind: fix.kind, title: fix.title, detail: fix.detail };
    if (off.includes(fix.id)) {
      fixes.push({ ...row, on: false, gain: null });
      return;
    }
    try {
      const next = fix.apply(current);
      if (next === current) return;
      const after = mainDps(await quick(next));
      // A skill is only left out for a real gain (none to measure when the DPS is 0).
      if (fix.test && !(currentDps > 0 && after >= currentDps * (1 + STEP_MIN))) return;
      fixes.push({ ...row, on: true, gain: currentDps > 0 ? after / currentDps - 1 : null });
      current = next;
      currentDps = after;
    } catch (error) {
      if (signal.aborted) throw error;
      console.warn("Compare: setup not calculated", fix.id, error);
      setupFailed++;
    }
  };
  for (const fix of setupFixes(flatOne, flatTwo, oneMain, twoMain)) await tryFix(fix);
  for (const fix of offTests(current, flatTwo, oneMain)) await tryFix(fix);

  const set = await calculate(current, null, pick, true, signal);
  const { metrics, values } = pickMetrics(set.extra, twoOwn.extra);
  const why = whys(set, twoOwn);
  for (const metric of metrics) if (metric.why && !why[metric.why]) metric.why = undefined;
  const list = changes(current, flatTwo, oneMain, twoMain);
  let result: Result = {
    oneOwn,
    one: set,
    two: twoOwn,
    sameSkill,
    metrics,
    values: { one: values(set.extra), two: values(twoOwn.extra) },
    lines: statLines(set, twoOwn, metrics, why),
    why,
    config: configDiff(oneOwn.stats, twoOwn.stats),
    fixes,
    dps: { imported: mainDps(oneOwn.extra), matched: mainDps(set.extra), target: mainDps(twoOwn.extra) },
    gaps: [],
    steps: [],
    small: [],
    cooldown: mainCooldown(set.extra) !== null || mainCooldown(twoOwn.extra) !== null,
    done: list.length === 0,
    tried: 0,
    total: list.length,
    // A setup fix PoB couldn't calculate counts too (and keeps the run out of the cache).
    failed: setupFailed,
  };
  update(result);
  if (list.length === 0) {
    if (result.failed === 0) cache.set(key, result);
    return;
  }

  // ---- Path ----
  // Changes are measured against Build 1 as rebuilt here, so a change is only its own.
  let base: Extra;
  try {
    base = await quick(current);
  } catch (error) {
    if (signal.aborted) throw error;
    console.warn("Compare: Build 1 not rebuilt; no path", error);
    update({ ...result, done: true, failed: list.length });
    return;
  }
  interface Tried {
    change: Change;
    /** DPS gain on the build of round `round`. */
    gain: number;
    round: number;
    extra: Extra;
    issues: string[];
  }
  const dpsGain = (before: Extra, after: Extra) => {
    const a = mainDps(before);
    return a > 0 ? mainDps(after) / a - 1 : 0;
  };
  /** One change on the current build; null when PoB couldn't calculate it. */
  const measure = async (change: Change, xml: string, before: Extra) => {
    try {
      const extra = await quick(change.apply(xml));
      return { extra, gain: dpsGain(before, extra), issues: issuesOf(before.player, extra.player) };
    } catch (error) {
      if (signal.aborted) throw error;
      console.warn("Compare: change not calculated", change.id, error);
      return null;
    }
  };
  const place = (change: Change): Place & { title: string; detail: string } => ({
    id: change.id,
    kind: change.kind,
    title: change.title,
    detail: change.detail,
    target: change.target,
    slot: change.slot,
  });

  // First pass: every change on Build 1 as set up (also the summary's top gains).
  const baseValues = values(base);
  let pool: Tried[] = [];
  for (const change of list) {
    const m = await measure(change, current, base);
    if (m) {
      const after = values(m.extra);
      pool.push({ change, gain: m.gain, round: 0, extra: m.extra, issues: m.issues });
      result = {
        ...result,
        gaps: [
          ...result.gaps,
          {
            ...place(change),
            d: Object.fromEntries(
              metrics.map((metric) => {
                const a = baseValues[metric.key];
                const b = after[metric.key];
                return [metric.key, a === null || b === null ? null : Math.round((b - a) * 10) / 10];
              }),
            ),
          },
        ],
      };
    } else result = { ...result, failed: result.failed + 1 };
    result = { ...result, tried: result.tried + 1 };
    update(result);
  }

  // Then the path: keep the biggest gain, re-try the leaders on top of it, repeat. A change
  // keeps its last gain until it's among the leaders again (gains rarely grow much).
  let build = current;
  let before = base;
  for (let round = 0; pool.length > 0 && result.steps.length < MAX_STEPS; round++) {
    for (;;) {
      pool.sort((a, b) => b.gain - a.gain);
      const stale = pool.slice(0, FRESH).find((t) => t.round !== round);
      if (!stale) break;
      const m = await measure(stale.change, build, before);
      if (m) Object.assign(stale, { ...m, round });
      else {
        pool = pool.filter((t) => t !== stale);
        result = { ...result, failed: result.failed + 1 };
      }
    }
    const best = pool[0];
    if (!best || best.gain < STEP_MIN) break;
    build = best.change.apply(build);
    before = best.extra;
    pool = pool.filter((t) => t !== best);
    result = {
      ...result,
      steps: [
        ...result.steps,
        {
          ...place(best.change),
          gain: best.gain,
          dps: mainDps(best.extra),
          cd: mainCooldown(best.extra),
          issues: best.issues,
        },
      ],
    };
    update(result);
  }

  result = {
    ...result,
    // The rest that still add something: under 1%, or past the path's last step.
    small: pool
      .filter((t) => t.gain >= SMALL_MIN)
      .sort((a, b) => b.gain - a.gain)
      .map((t) => ({ ...place(t.change), gain: t.gain, dps: null, cd: mainCooldown(t.extra), issues: t.issues })),
    done: true,
  };
  update(result);
  // A run with failed changes tries them again next time.
  if (result.failed === 0) cache.set(key, result);
}
