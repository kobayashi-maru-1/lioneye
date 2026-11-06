import { buildDataSelector } from "../../state/build-data";
import { characterLogAtom } from "../../state/character";
import { currentActAtom } from "../../state/current-act";
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
 * The campaign's passive point quests, by act, with their points (PoB's Build.lua acts
 * table: 23, plus 1 for killing all bandits). "/passives" may leave out quests not done.
 */
const PASSIVE_QUESTS: [string, number, number][] = [
  ["The Dweller of the Deep", 1, 1],
  ["The Marooned Mariner", 1, 1],
  ["The Way Forward", 2, 1],
  ["Through Sacred Ground", 2, 1],
  ["Deal with the Bandits", 2, 1],
  ["Victario's Secrets", 3, 1],
  ["Piety's Pets", 3, 1],
  ["An Indomitable Spirit", 4, 1],
  ["In Service to Science", 5, 1],
  ["Kitava's Torments", 5, 1],
  ["The Father of War", 6, 1],
  ["The Puppet Mistress", 6, 1],
  ["The Cloven One", 6, 1],
  ["The Master of a Million Faces", 7, 1],
  ["Queen of Despair", 7, 1],
  ["Kishara's Star", 7, 1],
  ["Love is Dead", 8, 1],
  ["Reflection of Terror", 8, 1],
  ["The Gemling Legion", 8, 1],
  ["Queen of the Sands", 9, 1],
  ["The Ruler of Highgate", 9, 1],
  ["Vilenta's Vengeance", 10, 1],
  ["An End to Hunger", 10, 2],
];

/**
 * Passive quests your character left behind: from an act you've finished, missing from
 * your latest "/passives" list or with fewer points. The bandit quest only counts when you
 * kill all three.
 */
function missedQuestPoints(
  quests: [string, number][],
  act: number | null,
  bandit: string,
): HealthFinding[] {
  if (act === null) return [];
  const got = new Map(quests);
  const missed: HealthFinding[] = [];
  for (const [name, questAct, points] of PASSIVE_QUESTS) {
    if (questAct >= act || (got.get(name) ?? 0) >= points) continue;
    if (name === "Deal with the Bandits" && bandit !== "None") continue;
    const quest = { act: questAct };
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
