import { type MainSkillPick, mainSkillPickAtom } from "../../state/main-skill";
import { pobCodeToXml } from "../../state/pob/process";
import { formStyles } from "../../styles";
import { SetPager, useFollowAct } from "../SetPager";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useAtom } from "jotai";
import React, { Fragment, useEffect, useMemo, useState } from "react";

/** The exe runs Path of Building; the hosted site has nothing to ask. */
export const STATS_AVAILABLE = import.meta.env.MODE !== "production";

const STATS_URL = "/api/pob/stats";

type StatRow =
  { gap: true } | { text: string } | { label: string; value: string };

/** PoB's main skill selectors for the shown loadout. Indexes are PoB's (from 1). */
interface SkillState {
  /** Whether your remembered pick was found in this loadout (unset: no pick sent). */
  picked?: boolean;
  id?: string;
  label?: string;
  groups: string[];
  /** Active skill ids per group, to remember a group you pick by its gem. */
  groupSkills: string[][];
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

interface Stats {
  loadouts: string[];
  loadout: string | null;
  skill: SkillState | null;
  rows: StatRow[];
  warnings: string[];
}

const NONE: string[] = [];

/** Path of Building's sidebar stats for the loadout that matches your act. */
export function StatsViewer({ code }: { code: string }) {
  const xml = useMemo(() => {
    try {
      return pobCodeToXml(code);
    } catch {
      return null;
    }
  }, [code]);

  // Kept with the build it came from, so a new import never shows the old build's loadouts.
  const [answer, setAnswer] = useState<{ xml: string; stats: Stats } | null>(
    null,
  );
  const stats = answer !== null && answer.xml === xml ? answer.stats : null;
  const loadouts = stats?.loadouts ?? NONE;
  // PoB's names carry its colour codes ("^2Act 1 - 12 pts"); match and show them without.
  const titles = useMemo(
    () => loadouts.map((name) => name.replace(COLOUR_CODE, "")),
    [loadouts],
  );
  const [index, setIndex] = useFollowAct(titles);
  const requested = loadouts[index] ?? null;

  const [pick, setPick] = useAtom(mainSkillPickAtom);
  const pickKey = JSON.stringify(pick);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (xml === null) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchStats(xml, requested, pick, controller.signal)
      .then((stats) => {
        setAnswer({ xml, stats });
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => controller.abort();
  }, [xml, requested, pickKey, attempt]);

  if (xml === null)
    return (
      <p className={classNames(styles.status)}>Build unreadable. Re-import.</p>
    );

  return (
    <div className={classNames(styles.stats)}>
      {loadouts.length > 0 && (
        <SetPager titles={titles} index={index} onIndex={setIndex} />
      )}
      {stats?.skill && stats.skill.groups.length > 0 && (
        <SkillPicker
          state={stats.skill}
          fallback={pick !== null && stats.skill.picked === false}
          disabled={loading}
          onPick={setPick}
        />
      )}
      {error !== null && (
        <div className={classNames(styles.status)} title={error}>
          Stats failed
          <button
            className={classNames(formStyles.formButton, styles.retry)}
            onClick={() => setAttempt((n) => n + 1)}
          >
            Retry
          </button>
        </div>
      )}
      {error === null && stats === null && (
        <p className={classNames(styles.status)}>Calculating</p>
      )}
      {/* After a failed loadout the old rows would sit under the new loadout's name. */}
      {error === null && stats !== null && (
        <div
          className={classNames(styles.rows, { [styles.stale]: loading })}
          aria-busy={loading}
        >
          {stats.rows.length === 0 && (
            <p className={classNames(styles.text)}>No stats</p>
          )}
          {stats.rows.map((row, i) =>
            "gap" in row ? (
              <div key={i} className={classNames(styles.gap)} />
            ) : "text" in row ? (
              <div key={i} className={classNames(styles.text)}>
                <PobText text={row.text} />
              </div>
            ) : (
              <Fragment key={i}>
                <div className={classNames(styles.label)}>
                  <PobText text={row.label} />
                </div>
                <div className={classNames(styles.value)}>
                  <PobText text={row.value} />
                </div>
              </Fragment>
            ),
          )}
          {stats.warnings.map((warning, i) => (
            <div
              key={`w${i}`}
              className={classNames(styles.text, styles.warning)}
            >
              <PobText text={warning} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface SkillPickerProps {
  state: SkillState;
  /** Your remembered skill isn't in this loadout; PoB's own pick is shown. */
  fallback: boolean;
  disabled: boolean;
  onPick: (pick: MainSkillPick) => void;
}

/** PoB's main skill selectors. A pick is remembered by skill gem across loadouts. */
function SkillPicker({ state, fallback, disabled, onPick }: SkillPickerProps) {
  // Lists are PoB's, numbered from 1.
  const at = (list: string[], index?: number) =>
    index === undefined ? undefined : list[index - 1];
  const current: MainSkillPick | null = state.id
    ? {
        id: state.id,
        label: state.label,
        group: state.group,
        part: at(state.parts, state.part),
        minion: at(state.minions, state.minion),
        minionSkill: at(state.minionSkills, state.minionSkill),
      }
    : null;

  const pickGroup = (group: number, skill = 1) => {
    const id = state.groupSkills[group - 1]?.[skill - 1];
    if (id) onPick({ id, label: state.groups[group - 1], group });
  };

  return (
    <div className={classNames(styles.picker)}>
      <div className={classNames(styles.pickerRow)}>
        <Select
          label="Skill group"
          options={state.groups}
          value={state.group}
          disabled={disabled}
          isEnabled={(i) => (state.groupSkills[i - 1]?.length ?? 0) > 0}
          onChange={(group) => pickGroup(group)}
        />
        {fallback && (
          <span
            className={classNames(styles.tag)}
            title="Your skill isn't in this loadout"
          >
            PoB pick
          </span>
        )}
      </div>
      {state.skills.length > 1 && state.group !== undefined && (
        <Select
          label="Skill"
          options={state.skills}
          value={state.skill}
          disabled={disabled}
          onChange={(skill) => pickGroup(state.group!, skill)}
        />
      )}
      {current && state.parts.length > 0 && (
        <Select
          label="Part"
          options={state.parts}
          value={state.part}
          disabled={disabled}
          onChange={(part) =>
            onPick({ ...current, part: state.parts[part - 1] })
          }
        />
      )}
      {current && state.minions.length > 0 && (
        <Select
          label="Minion"
          options={state.minions}
          value={state.minion}
          disabled={disabled || state.minions.length < 2}
          onChange={(minion) =>
            onPick({
              ...current,
              minion: state.minions[minion - 1],
              minionSkill: undefined,
            })
          }
        />
      )}
      {current && state.minionSkills.length > 0 && (
        <Select
          label="Minion skill"
          options={state.minionSkills}
          value={state.minionSkill}
          disabled={disabled || state.minionSkills.length < 2}
          onChange={(minionSkill) =>
            onPick({
              ...current,
              minionSkill: state.minionSkills[minionSkill - 1],
            })
          }
        />
      )}
    </div>
  );
}

interface SelectProps {
  label: string;
  options: string[];
  /** PoB index, from 1. */
  value?: number;
  disabled: boolean;
  isEnabled?: (index: number) => boolean;
  onChange: (index: number) => void;
}

function Select({
  label,
  options,
  value,
  disabled,
  isEnabled,
  onChange,
}: SelectProps) {
  return (
    <select
      className={classNames(styles.select)}
      aria-label={label}
      title={label}
      value={value ?? ""}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
    >
      {value === undefined && <option value="" />}
      {options.map((option, i) => (
        <option
          key={i}
          value={i + 1}
          disabled={isEnabled ? !isEnabled(i + 1) : false}
        >
          {option.replace(COLOUR_CODE, "")}
        </option>
      ))}
    </select>
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
    skills: list(skill.skills),
    parts: list(skill.parts),
    minions: list(skill.minions),
    minionSkills: list(skill.minionSkills),
  };
}

// PoB colour codes: ^0-^9, or ^x then a hex colour. ^7 is PoB's normal text.
const COLOUR_CODE = /\^(x[0-9a-fA-F]{6}|[0-9])/g;
const DIGIT_COLOURS: Record<string, string | undefined> = {
  "1": "#ff5050",
  "2": "#50ff50",
  "3": "#6f6fff",
  "4": "#ffff50",
  "5": "#ff50ff",
  "6": "#50ffff",
  "8": "#808080",
  "9": "#606060",
};

function PobText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let colour: string | undefined;
  let last = 0;
  for (const match of text.matchAll(COLOUR_CODE)) {
    const start = match.index ?? 0;
    if (start > last) {
      parts.push(
        <span key={parts.length} style={{ color: colour }}>
          {text.slice(last, start)}
        </span>,
      );
    }
    const code = match[1];
    colour = code.startsWith("x") ? `#${code.slice(1)}` : DIGIT_COLOURS[code];
    last = start + match[0].length;
  }
  if (last < text.length) {
    parts.push(
      <span key={parts.length} style={{ color: colour }}>
        {text.slice(last)}
      </span>,
    );
  }
  return <>{parts}</>;
}
