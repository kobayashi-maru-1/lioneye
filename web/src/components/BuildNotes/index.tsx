import { notesLines, stripPob } from "../../state/pob/colour";
import { PobText } from "../PobText";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useMemo } from "react";

/** The Notes text of a PoB export, or null when it has none. */
export function buildNotes(xml: string): string | null {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const text = doc.getElementsByTagName("Notes")[0]?.textContent ?? "";
  // PoB saves the notes indented under <Notes>: drop that, and trailing space.
  const trimmed = text.replace(/^\s+|\s+$/g, "");
  return stripPob(trimmed).trim().length > 0 ? trimmed : null;
}

/** PoB notes in PoB's colours, line by line. */
export function BuildNotes({ notes }: { notes: string }) {
  const lines = useMemo(() => notesLines(notes), [notes]);
  return (
    <div className={classNames(styles.notes)}>
      {lines.map((line, i) =>
        // A blank line still carries the colour from the lines before it.
        stripPob(line).trim() === "" ? (
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
