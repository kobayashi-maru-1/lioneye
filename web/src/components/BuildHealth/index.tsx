import { missedQuestsAtom, passivesStaleAtom } from "../../state/quest-points";
import { jumpTargetsAtom } from "../AppBar";
import { PageSection, useJumpToSection } from "../PageSection";
import { type HealthFinding, usePobStats } from "../PobStats";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useAtomValue } from "jotai";
import { useMemo } from "react";

/** The panel each finding's link jumps to. */
const PANELS: Record<string, string> = {
  gear: "Gear",
  tree: "Tree",
  gems: "Gems",
  config: "Config",
  campaign: "Campaign",
};

/**
 * PoB Redux's Build Health for the shown loadout: what to look at, with Redux's own rules
 * (run in the exe's PoB, pob-host.lua), each linked to the panel that fixes it.
 */
export function BuildHealthPanel() {
  const pob = usePobStats();
  const stats = pob?.stats ?? null;
  const jump = useJumpToSection();
  // Only panels on the page (a build's Tree or Gems panel can be missing).
  const targets = useAtomValue(jumpTargetsAtom);
  const present = new Set(targets.map((target) => target.id));
  // Never the old loadout's findings under the new loadout's name.
  const pobHealth = stats !== null && !pob?.error ? stats.health : null;
  // Missed quest points from your character's "/passives" list, read from the game's log.
  // (state/quest-points; the bar's Campaign badge shows the same.)
  // Not typed yet, or older than your act: ask for it.
  const passivesStale = useAtomValue(passivesStaleAtom);
  const missedQuests = useAtomValue(missedQuestsAtom);
  const missed = useMemo(
    () =>
      missedQuests.map(({ name, act }): HealthFinding => ({
        severity: "medium",
        message: `Missed quest point: ${name}`,
        fix: `Act ${act}. Go back and finish it.`,
        panel: "campaign",
      })),
    [missedQuests],
  );
  const health =
    pobHealth === null && missed.length === 0
      ? null
      : [...missed, ...(pobHealth ?? [])];
  // PoB's own state, when it hasn't answered (shown with the quest findings too).
  const pobStatus =
    pobHealth === null
      ? pob?.error
        ? "Health unavailable"
        : "Calculating"
      : null;

  return (
    <PageSection
      id="health"
      title="Build health"
      actions={
        health && (
          <span className={classNames(styles.summary)}>
            {health.length === 0 ? "No issues" : `${health.length} to check`}
          </span>
        )
      }
    >
      {pobStatus && <p className={classNames(styles.empty)}>{pobStatus}</p>}
      {health !== null && health.length > 0 && (
        <ul
          className={classNames(styles.findings, {
            [styles.stale]: pob?.loading,
          })}
        >
          {health.map((finding, i) => (
            <Finding
              key={i}
              finding={finding}
              onJump={
                finding.panel && present.has(finding.panel) ? jump : undefined
              }
            />
          ))}
        </ul>
      )}
      {passivesStale && (
        <p className={classNames(styles.note)}>
          Type /passives in game to check quest points.
        </p>
      )}
    </PageSection>
  );
}

function Finding({
  finding,
  onJump,
}: {
  finding: HealthFinding;
  onJump?: (id: string) => void;
}) {
  const panel = onJump && finding.panel ? PANELS[finding.panel] : undefined;
  return (
    <li className={classNames(styles.finding)}>
      <span
        className={classNames(styles.dot, styles[finding.severity])}
        aria-label={`${finding.severity} severity`}
        role="img"
      />
      <span className={classNames(styles.text)}>
        <span className={classNames(styles.message)}>{finding.message}</span>
        {finding.fix && (
          <span className={classNames(styles.fix)}>{finding.fix}</span>
        )}
      </span>
      {panel && finding.panel && (
        <button
          className={classNames(styles.link)}
          onClick={() => onJump?.(finding.panel!)}
        >
          {panel} →
        </button>
      )}
    </li>
  );
}
