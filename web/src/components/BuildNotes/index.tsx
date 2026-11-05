import { PobText } from "../PobText";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useMemo } from "react";

/** The Notes text of a PoB export, or null when it has none. */
export function buildNotes(xml: string): string | null {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const text = doc.getElementsByTagName("Notes")[0]?.textContent ?? "";
  const trimmed = text.replace(/^\s*\n|\s+$/g, "");
  return trimmed.length > 0 ? trimmed : null;
}

const LAST_COLOUR = /\^(x[0-9a-fA-F]{6}|[0-9])(?!.*\^(x[0-9a-fA-F]{6}|[0-9]))/s;

/** PoB notes in PoB's colours, line by line. */
export function BuildNotes({ notes }: { notes: string }) {
  // PoB draws the notes as one text, so a colour carries on to the following lines.
  const lines = useMemo(() => {
    let colour = "";
    return notes.split(/\r?\n/).map((line) => {
      const shown = colour + line;
      colour = LAST_COLOUR.exec(line)?.[0] ?? colour;
      return shown;
    });
  }, [notes]);
  return (
    <div className={classNames(styles.notes)}>
      {lines.map((line, i) =>
        line.trim() === "" ? (
          <div key={i} className={classNames(styles.blank)} />
        ) : (
          <div key={i} className={classNames(styles.line)}>
            <PobText text={line} />
          </div>
        ),
      )}
    </div>
  );
}
