import { usePobStats } from "../PobStats";
import { PobText } from "../PobText";
import styles from "./styles.module.css";
import classNames from "classnames";
import { Fragment } from "react";

/** The config options the shown loadout sets in PoB, with PoB's labels. */
export function ConfigList() {
  const stats = usePobStats()?.stats;
  if (!stats) return <p className={classNames(styles.empty)}>Calculating</p>;
  if (stats.config.length === 0)
    return <p className={classNames(styles.empty)}>PoB defaults</p>;

  return (
    <div className={classNames(styles.config)}>
      {stats.config.map((row, i) =>
        "section" in row ? (
          <h3 key={i} className={classNames(styles.section)}>
            {row.section}
          </h3>
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
    </div>
  );
}
