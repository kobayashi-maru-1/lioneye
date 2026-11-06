import { buildDataSelector } from "../../state/build-data";
import { characterLogAtom } from "../../state/character";
import { currentActAtom } from "../../state/current-act";
import { jumpTargetsAtom } from "../AppBar";
import { PageSection, useJumpToSection } from "../PageSection";
import { type HealthFinding, usePobStats } from "../PobStats";
import styles from "./styles.module.css";
import classNames from "classnames";
import { Data } from "common";
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

/** Quests by the name "/passives" lists them under. */
const QUESTS_BY_NAME = new Map(
  Object.values(Data.Quests).map((quest) => [quest.name, quest]),
);

/**
 * Passive quests your character left behind: in your latest "/passives" list with no
 * point, from an act you've finished. The bandit quest only counts when you kill all three.
 */
function missedQuestPoints(
  quests: [string, number][],
  act: number | null,
  bandit: string,
): HealthFinding[] {
  if (act === null) return [];
  const missed: HealthFinding[] = [];
  for (const [name, points] of quests) {
    const quest = QUESTS_BY_NAME.get(name);
    if (points > 0 || quest === undefined || Number(quest.act) >= act) continue;
    if (name === "Deal with the Bandits" && bandit !== "None") continue;
    missed.push({
      severity: "medium",
      message: `Missed quest point: ${name}`,
      fix: `Act ${quest.act}. Go back and finish it.`,
      panel: "campaign",
    });
  }
  return missed;
}

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
  const character = useAtomValue(characterLogAtom);
  const act = useAtomValue(currentActAtom);
  const bandit = useAtomValue(buildDataSelector).bandit;
  const missed = useMemo(
    () =>
      character?.quests ? missedQuestPoints(character.quests, act, bandit) : [],
    [character?.quests, act, bandit],
  );
  const health =
    pobHealth === null && missed.length === 0
      ? null
      : [...missed, ...(pobHealth ?? [])];

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
      {health === null ? (
        <p className={classNames(styles.empty)}>
          {pob?.error ? "Health unavailable" : "Calculating"}
        </p>
      ) : (
        health.length > 0 && (
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
        )
      )}
      {character && !character.quests && (
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
