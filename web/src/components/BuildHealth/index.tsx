import {
  healthSourceAtom,
  liveCharacterAtom,
  liveStatsAtom,
} from "../../state/live-character";
import { missedQuestsAtom, passivesStaleAtom } from "../../state/quest-points";
import { liveSummary } from "../LiveCharacter";
import { PanelSelect } from "../PanelSelect";
import { jumpTargetsAtom } from "../AppBar";
import { PageSection, useJumpToSection } from "../PageSection";
import { type HealthFinding, usePobStats } from "../PobStats";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useAtom, useAtomValue } from "jotai";
import { useMemo } from "react";

/** The panel each finding's link jumps to. */
const PANELS: Record<string, string> = {
  gear: "Gear",
  tree: "Tree",
  gems: "Gems",
  config: "Config",
  campaign: "Campaign",
};

/** What the panel checks, when a live character is set. */
const SOURCES = [
  { value: "live", label: "Live" },
  { value: "plan", label: "Plan" },
] as const;

/**
 * PoB Redux's Build Health: what to look at, with Redux's own rules (run in the exe's
 * PoB, pob-host.lua). It checks your live character from poe.ninja when one is set (Live),
 * else the guide's shown loadout (Plan), whose findings link to the panel that fixes them.
 */
export function BuildHealthPanel() {
  const pob = usePobStats();
  const jump = useJumpToSection();
  // Only panels on the page (a build's Tree or Gems panel can be missing).
  const targets = useAtomValue(jumpTargetsAtom);
  const present = new Set(targets.map((target) => target.id));
  const live = useAtomValue(liveCharacterAtom);
  const liveStats = useAtomValue(liveStatsAtom);
  const [source, setSource] = useAtom(healthSourceAtom);
  const onLive = live !== null && source === "live";
  const liveAnswer = onLive && liveStats?.code === live.code ? liveStats : null;
  // Never the old loadout's findings under the new loadout's name.
  const planHealth = pob?.stats != null && !pob.error ? pob.stats.health : null;
  const pobHealth = onLive
    ? liveAnswer?.state === "ready"
      ? liveAnswer.stats.health
      : null
    : planHealth;
  const pobFailed = onLive ? liveAnswer?.state === "error" : !!pob?.error;
  const pobLoading = onLive ? liveAnswer?.state !== "ready" : !!pob?.loading;
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
      ? pobFailed
        ? "Health unavailable"
        : "Calculating"
      : null;

  return (
    <PageSection
      id="health"
      title="Build health"
      actions={
        <>
          {live !== null && (
            <PanelSelect
              label="Check"
              options={SOURCES.map((option) => option.label)}
              value={source === "live" ? 0 : 1}
              onChange={(i) => setSource(SOURCES[i].value)}
            />
          )}
          {health && (
            <span className={classNames(styles.summary)}>
              {health.length === 0 ? "No issues" : `${health.length} to check`}
            </span>
          )}
        </>
      }
    >
      {onLive && <p className={classNames(styles.note)}>{liveSummary(live)}</p>}
      {pobStatus && <p className={classNames(styles.empty)}>{pobStatus}</p>}
      {health !== null && health.length > 0 && (
        <ul
          className={classNames(styles.findings, {
            // Plan: dim while PoB works, as before. Live: only over an earlier answer.
            [styles.stale]: onLive
              ? pobLoading && pobHealth !== null
              : pobLoading,
          })}
        >
          {health.map((finding, i) => (
            <Finding
              key={i}
              finding={finding}
              onJump={
                // The guide's panels show the plan: live findings only link to Campaign.
                finding.panel &&
                present.has(finding.panel) &&
                (!onLive || finding.panel === "campaign")
                  ? jump
                  : undefined
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
