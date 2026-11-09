import { liveCharacterAtom } from "../../state/live-character";
import { liveViewAtom } from "../../state/live-view";
import type { MainSkillPick } from "../../state/main-skill";
import { formStyles } from "../../styles";
import { liveSummary } from "../LiveCharacter";
import { PanelSelect } from "../PanelSelect";
import { type SkillState, usePobStats } from "../PobStats";
import { PobText, stripPob } from "../PobText";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useAtomValue, useSetAtom } from "jotai";

/** The Loadout dropdown's first entry when a live character is set (Settings → Build). */
const LIVE_OPTION = "Live character";

/** PoB's "Minion:" / "Player:" lines become pob.codes-style headings. */
const HEADING = /^(minion|player):?$/i;

/**
 * Path of Building's sidebar: the Loadout dropdown, then the shown loadout's main skill
 * and stats, in pob.codes' striped rows. Reads the page's PobStatsProvider.
 */
export function StatsViewer() {
  const pob = usePobStats();
  const live = useAtomValue(liveCharacterAtom);
  const setLiveView = useSetAtom(liveViewAtom);
  if (pob === null || (pob.xml === null && !pob.live)) {
    return pob?.unreadable ? (
      <p className={classNames(styles.status)}>Build unreadable. Re-import.</p>
    ) : null;
  }
  const { stats, loading, error, retry, titles, index, setIndex } = pob;
  // With a live character: "Live character" first, then the plan's loadouts (or "Plan"
  // for a build without them).
  const planOptions = titles.length > 0 ? titles : ["Plan"];
  const options = live ? [LIVE_OPTION, ...planOptions] : titles;
  const offset = live ? 1 : 0;

  return (
    <div className={classNames(styles.stats)}>
      {/* The loadout everything on the page shows; it follows your level or act. */}
      {options.length > 0 && (
        <>
          <h2 className={classNames(styles.heading)}>Loadout</h2>
          <PanelSelect
            className={classNames(styles.loadout)}
            label="Loadout"
            options={options}
            value={pob.live ? 0 : index + offset}
            onChange={(i) => {
              if (live && i === 0) {
                setLiveView(true);
                return;
              }
              setLiveView(false);
              if (titles.length > 0) setIndex(i - offset);
            }}
          />
          {pob.live && live && (
            <p className={classNames(styles.liveNote)}>{liveSummary(live)}</p>
          )}
        </>
      )}
      <h2 className={classNames(styles.heading)}>Stats</h2>
      {/* The live character is calculated with PoB's own main skill. */}
      {!pob.live && stats?.skill && stats.skill.groups.length > 0 && (
        <SkillPicker
          state={stats.skill}
          fallback={pob.fallback}
          disabled={loading}
          onPick={pob.setPick}
        />
      )}
      {error !== null && (
        <div className={classNames(styles.status)} title={error}>
          Stats failed
          <button
            className={classNames(formStyles.formButton, styles.retry)}
            onClick={retry}
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
              HEADING.test(stripPob(row.text).trim()) ? (
                <h3 key={i} className={classNames(styles.subheading)}>
                  {stripPob(row.text).trim().replace(/:$/, "")}
                </h3>
              ) : (
                <div key={i} className={classNames(styles.text)}>
                  <PobText text={row.text} />
                </div>
              )
            ) : (
              <div key={i} className={classNames(styles.row)}>
                <span className={classNames(styles.label)}>
                  <PobText text={row.label} />
                </span>
                <span className={classNames(styles.value)}>
                  <PobText text={row.value} />
                </span>
              </div>
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
        skill: state.skill,
        part: at(state.parts, state.part),
        minion: at(state.minions, state.minion),
        minionSkill: at(state.minionSkills, state.minionSkill),
      }
    : null;

  // A group alone picks that group's own main skill, as PoB does.
  const pickGroup = (
    group: number,
    skill = state.groupMain[group - 1] ?? 1,
  ) => {
    const ids = state.groupSkills[group - 1] ?? [];
    const id = ids[skill - 1] ?? ids[0];
    if (id)
      onPick({
        id,
        label: state.groups[group - 1],
        group,
        skill: ids[skill - 1] ? skill : 1,
      });
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
          {stripPob(option)}
        </option>
      ))}
    </select>
  );
}
