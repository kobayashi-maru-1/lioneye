import { jumpTargetsAtom } from "../AppBar";
import { PageSection, useJumpToSection } from "../PageSection";
import { type HealthFinding, usePobStats } from "../PobStats";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useAtomValue } from "jotai";

/** The panel each finding's link jumps to. */
const PANELS: Record<string, string> = {
  gear: "Gear",
  tree: "Tree",
  gems: "Gems",
  config: "Config",
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
  const health = stats !== null && !pob?.error ? stats.health : null;

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
