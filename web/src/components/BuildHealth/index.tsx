import { jumpTargetsAtom } from "../AppBar";
import { format } from "../BuildHeader/headline";
import { useJumpToSection } from "../PageSection";
import { type Defences, type HealthFinding, usePobStats } from "../PobStats";
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
 * PoB Redux's Build Health and Defences cards for the shown loadout: what to look at
 * (checked for the loadout's level in the exe, pob-host.lua) and the largest hits it survives.
 */
export function BuildHealth() {
  const pob = usePobStats();
  const stats = pob?.stats ?? null;
  const jump = useJumpToSection();
  // Only panels on the page (a build's Tree or Gems panel can be missing).
  const targets = useAtomValue(jumpTargetsAtom);
  const present = new Set(targets.map((target) => target.id));
  // Never the old loadout's findings under the new loadout's name.
  if (stats === null || pob?.error) return null;
  const { health, defences } = stats;

  return (
    <div className={classNames({ [styles.stale]: pob?.loading })}>
      <section className={classNames(styles.card)}>
        <h2 className={classNames(styles.heading)}>
          Build health
          <span className={classNames(styles.summary)}>
            {health.length === 0 ? "No issues" : `${health.length} to check`}
          </span>
        </h2>
        {health.length > 0 && (
          <ul className={classNames(styles.findings)}>
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
      </section>
      {defences && <DefencesCard defences={defences} />}
    </div>
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

const HITS: { key: keyof Defences; label: string; colour: string }[] = [
  { key: "physical", label: "Physical", colour: "#dad5cd" },
  { key: "fire", label: "Fire", colour: "#e05030" },
  { key: "cold", label: "Cold", colour: "#5aa0e0" },
  { key: "lightning", label: "Lightning", colour: "#e8d050" },
  { key: "chaos", label: "Chaos", colour: "#d060c0" },
];

function DefencesCard({ defences }: { defences: Defences }) {
  const percent = (value?: number) =>
    value === undefined ? undefined : `${format(value)}%`;
  const rows: [string, string | undefined][] = [
    [
      "Armour",
      defences.armour === undefined ? undefined : format(defences.armour),
    ],
    [
      "Evasion",
      defences.evasion === undefined ? undefined : format(defences.evasion),
    ],
    ["Block", percent(defences.block)],
    ["Spell block", percent(defences.spellBlock)],
    [
      "Life regen",
      defences.lifeRegen === undefined
        ? undefined
        : `${format(defences.lifeRegen)}/s`,
    ],
    [
      "Mana regen",
      defences.manaRegen === undefined
        ? undefined
        : `${format(defences.manaRegen)}/s`,
    ],
    [
      "Movement speed",
      defences.movementSpeed === undefined
        ? undefined
        : `${defences.movementSpeed >= 1 ? "+" : ""}${format((defences.movementSpeed - 1) * 100)}%`,
    ],
  ];
  return (
    <section className={classNames(styles.card)}>
      <h2 className={classNames(styles.heading)}>
        Defenses
        <span className={classNames(styles.summary)}>Max hit</span>
      </h2>
      <div className={classNames(styles.hits)}>
        {HITS.map(({ key, label, colour }) => (
          <div key={key} className={classNames(styles.hit)}>
            <span
              className={classNames(styles.hitLabel)}
              style={{ color: colour }}
            >
              {label}
            </span>
            <span className={classNames(styles.hitValue)}>
              {defences[key] === undefined ? "–" : format(defences[key]!)}
            </span>
          </div>
        ))}
      </div>
      <dl className={classNames(styles.rows)}>
        {rows
          .filter(([, value]) => value !== undefined)
          .map(([label, value]) => (
            <div key={label} className={classNames(styles.row)}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>
    </section>
  );
}
