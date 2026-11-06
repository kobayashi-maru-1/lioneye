import { type ConfigRow, usePobStats } from "../PobStats";
import { PobText } from "../PobText";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useMemo } from "react";

interface ConfigListProps {
  /** The config set's changed options, from PoB; undefined until PoB has answered. */
  rows?: ConfigRow[];
}

/** A config set's changed options in pob.codes-style framed boxes, one per PoB section. */
export function ConfigList({ rows }: ConfigListProps) {
  const pob = usePobStats();
  const sections = useMemo(() => {
    const sections: {
      name: string;
      rows: Exclude<ConfigRow, { section: string }>[];
    }[] = [];
    for (const row of rows ?? []) {
      if ("section" in row) sections.push({ name: row.section, rows: [] });
      else {
        if (sections.length === 0) sections.push({ name: "", rows: [] });
        sections[sections.length - 1].rows.push(row);
      }
    }
    return sections;
  }, [rows]);

  // Like the stats: no rows from another loadout under a failed one.
  if (pob?.error || pob?.unreadable)
    return <p className={classNames(styles.empty)}>Config unavailable</p>;
  if (rows === undefined)
    return <p className={classNames(styles.empty)}>Calculating</p>;
  if (sections.length === 0)
    return <p className={classNames(styles.empty)}>PoB defaults</p>;

  return (
    <div className={classNames(styles.config)}>
      {sections.map((section, i) => (
        <fieldset key={i} className={classNames(styles.box)}>
          {section.name && (
            <legend className={classNames(styles.legend)}>
              {section.name}
            </legend>
          )}
          {section.rows.map((row, j) =>
            "group" in row ? (
              <div key={j} className={classNames(styles.group)}>
                {row.group}
              </div>
            ) : "mod" in row ? (
              // A line PoB doesn't apply (a # note, an unknown mod, a group off) is dimmed.
              <div
                key={j}
                className={classNames(styles.mod, {
                  [styles.skipped]: row.off,
                })}
              >
                <PobText text={row.mod} />
              </div>
            ) : (
              <div key={j} className={classNames(styles.row)}>
                <span className={classNames(styles.label)}>
                  <PobText text={row.label.replace(/[:?]\s*$/, "")} />
                </span>
                <span className={classNames(styles.value)}>
                  {row.check ? (
                    row.value === "Yes" ? (
                      "✓"
                    ) : (
                      "✗"
                    )
                  ) : (
                    <PobText text={row.value} />
                  )}
                </span>
              </div>
            ),
          )}
        </fieldset>
      ))}
    </div>
  );
}
