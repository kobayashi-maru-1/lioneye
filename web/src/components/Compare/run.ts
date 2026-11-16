// Runs a comparison: PoB calculates both builds in full, then each gap (Build 1 with one
// piece of Build 2), one request at a time. PoB holds one build at a time and the guide
// shares its queue, so one at a time keeps the guide's own requests from waiting long;
// leaving the page stops the rest.

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
  pickMetrics,
  readExtra,
  statLines,
  whys,
} from "./metrics";
import { type GapKind, type SetPlaces, flatten, variants, withConfig } from "./xml";
import type { Stats } from "../PobStats";

const COMPARE_URL = "/api/pob/compare";

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
    body: JSON.stringify({ xml, loadout, pick, full }),
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

export interface Gap {
  id: string;
  kind: GapKind;
  title: string;
  detail: string;
  target: string;
  slot?: string;
  /** Each metric's change to Build 1 (null: PoB had no number). */
  d: Values;
}

export interface Result {
  one: Calculated;
  two: Calculated;
  /** Build 2 on its own config, for the Config section. */
  twoOwn: Calculated;
  /** Build 2 uses Build 1's main skill. */
  sameSkill: boolean;
  metrics: Metric[];
  values: { one: Values; two: Values };
  lines: StatLine[];
  why: Record<string, Why>;
  config: ConfigDiff;
  /** Gaps measured so far. */
  gaps: Gap[];
  /** Gaps still to measure (0: done). */
  pending: number;
  /** Gaps PoB couldn't calculate. */
  failed: number;
}

/** The pick that gives Build 2 and the gaps Build 1's main skill. */
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

/** Results kept for this session, by what was compared. */
const cache = new Map<string, Result>();
export const cacheKey = (one: Input, two: Input) =>
  JSON.stringify([one.xml, one.loadout, one.pick, two.xml, two.loadout]);

/**
 * Compares `one` (Build 1) and `two` (Build 2, on Build 1's config). Calls `update` with the
 * summary once both builds are calculated, then again after each gap.
 */
export async function compare(
  one: Input,
  two: Input,
  update: (result: Result) => void,
  signal: AbortSignal,
): Promise<void> {
  const key = cacheKey(one, two);
  const kept = cache.get(key);
  if (kept && kept.pending === 0) {
    update(kept);
    return;
  }

  const first = await calculate(one.xml, one.loadout, one.pick, true, signal);
  const pick = pickOf(first.stats, first.extra);
  const twoOwn = await calculate(two.xml, two.loadout, pick, true, signal);
  const flatOne = flatten(one.xml, placesOf(first.stats));
  const flatTwo = flatten(two.xml, placesOf(twoOwn.stats));
  const second = await calculate(withConfig(flatTwo, flatOne), null, pick, true, signal);
  const sameSkill = pick !== null && second.extra.picked === true;

  const { metrics, values } = pickMetrics(first.extra, second.extra);
  const why = whys(first, second);
  for (const metric of metrics) if (metric.why && !why[metric.why]) metric.why = undefined;
  let result: Result = {
    one: first,
    two: second,
    twoOwn,
    sameSkill,
    metrics,
    values: { one: values(first.extra), two: values(second.extra) },
    lines: statLines(first, second, metrics, why),
    why,
    config: configDiff(first.stats, twoOwn.stats),
    gaps: [],
    pending: 0,
    failed: 0,
  };

  const list = variants(
    flatOne,
    flatTwo,
    first.stats?.skill?.group ?? null,
    sameSkill ? (second.stats?.skill?.group ?? null) : null,
  );
  result = { ...result, pending: list.length };
  update(result);
  if (list.length === 0) {
    cache.set(key, result);
    return;
  }

  // Gaps are measured against Build 1 as rebuilt here, so a change is only the gap's.
  let baseValues: Values;
  try {
    baseValues = values((await calculate(flatOne, null, pick, false, signal)).extra);
  } catch (error) {
    if (signal.aborted) throw error;
    console.warn("Compare: Build 1 not rebuilt; no gaps", error);
    update({ ...result, pending: 0, failed: list.length });
    return;
  }
  for (const variant of list) {
    let gap: Gap | null = null;
    try {
      const after = values((await calculate(variant.xml, null, pick, false, signal)).extra);
      gap = {
        id: variant.id,
        kind: variant.kind,
        title: variant.title,
        // The config gap counts the settings PoB labels (as its Config tab lists them).
        detail:
          variant.id === "config" && result.config.rows.length
            ? `${result.config.rows.length} differ`
            : variant.detail,
        target: variant.target,
        slot: variant.slot,
        d: Object.fromEntries(
          metrics.map((m) => {
            const a = baseValues[m.key];
            const b = after[m.key];
            return [m.key, a === null || b === null ? null : Math.round((b - a) * 10) / 10];
          }),
        ),
      };
    } catch (error) {
      if (signal.aborted) throw error;
      console.warn("Compare: gap not calculated", variant.id, error);
    }
    result = {
      ...result,
      gaps: gap ? [...result.gaps, gap] : result.gaps,
      pending: result.pending - 1,
      failed: result.failed + (gap ? 0 : 1),
    };
    update(result);
  }
  // A run with failed gaps tries them again next time.
  if (result.failed === 0) cache.set(key, result);
}
