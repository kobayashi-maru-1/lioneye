import { characterLevelAtom } from "../../state/character-level";
import { PanelSelect } from "../PanelSelect";
import { type Headline, usePobStats } from "../PobStats";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useAtomValue } from "jotai";

/** Whole numbers from 100 up, one decimal below, with thousands separators. */
function format(value: number) {
  return value.toLocaleString("en-US", {
    maximumFractionDigits: Math.abs(value) >= 100 ? 0 : 1,
  });
}

/**
 * pob.codes-style card above the guide: the build's title, its headline numbers for
 * the shown loadout, and the Loadout dropdown (which follows your act).
 */
export function BuildHeader() {
  const pob = usePobStats();
  // Your level from the game log; the title keeps the level PoB calculates at.
  const characterLevel = useAtomValue(characterLevelAtom);
  if (pob === null || pob.stats === null) return null;
  const { titles, index, setIndex, error, loading } = pob;
  const headline = pob.stats.headline ?? {};
  // Never the old loadout's numbers under the new loadout's name.
  const numbersShown = error === null;

  return (
    <section className={classNames(styles.header)}>
      <div className={classNames(styles.titleRow)}>
        <h1 className={classNames(styles.title)}>
          {title(headline)}
          {headline.level !== undefined && (
            <span className={classNames(styles.level)}>
              {" "}
              (Level {headline.level})
            </span>
          )}
        </h1>
        {titles.length > 0 && (
          <PanelSelect
            className={classNames(styles.loadout)}
            label="Loadout"
            options={titles}
            value={index}
            onChange={setIndex}
          />
        )}
      </div>
      {/* Your level is from the log, so it shows even when PoB's numbers can't. */}
      {!numbersShown && characterLevel !== null && (
        <div className={classNames(styles.numbers)}>
          <Stat
            label="Char lvl"
            value={characterLevel.level}
            colour="#d7c08d"
          />
        </div>
      )}
      {numbersShown && (
        <div
          className={classNames(styles.numbers, { [styles.stale]: loading })}
        >
          <Stat
            label="Char lvl"
            value={characterLevel?.level}
            colour="#d7c08d"
          />
          <Stat label="Life" value={headline.life} colour="#e05030" />
          <Stat label="ES" value={headline.es} colour="#88ffff" />
          <Stat label="Mana" value={headline.mana} colour="#7070ff" />
          <Stat label="eHP" value={headline.ehp} />
          <Stat label="DPS" value={headline.dps} colour="#e8c060" />
          <span className={classNames(styles.number)}>
            <span className={classNames(styles.label)}>Res:</span>
            <Resist value={headline.fire} colour="#b97123" />
            {" / "}
            <Resist value={headline.cold} colour="#3f6db3" />
            {" / "}
            <Resist value={headline.lightning} colour="#adaa47" />
            {" / "}
            <Resist value={headline.chaos} colour="#d02090" />
          </span>
        </div>
      )}
    </section>
  );
}

function title({ skill, class: className, ascendancy }: Headline) {
  const who = ascendancy ? `${ascendancy} (${className})` : (className ?? "");
  return [skill, who].filter(Boolean).join(" / ");
}

function Stat({
  label,
  value,
  colour,
}: {
  label: string;
  value?: number;
  colour?: string;
}) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return (
    <span className={classNames(styles.number)}>
      <span className={classNames(styles.label)}>{label}:</span>
      <span className={classNames(styles.value)} style={{ color: colour }}>
        {format(value)}
      </span>
    </span>
  );
}

function Resist({ value, colour }: { value?: number; colour: string }) {
  return (
    <span className={classNames(styles.value)} style={{ color: colour }}>
      {typeof value === "number" && Number.isFinite(value)
        ? `${format(value)}%`
        : "–"}
    </span>
  );
}
