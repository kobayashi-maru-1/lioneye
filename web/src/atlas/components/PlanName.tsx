import type { SavedPlan } from "../store.ts";
import styles from "../atlas.module.css";
import { formStyles } from "../../styles";
import classNames from "classnames";
import { useEffect, useRef, useState } from "react";

const MAX_NAME = 60;

/**
 * The plan's name and Save, at the start of the toolbar.
 * A new plan: a name box; Save adds it to Saved.
 * A saved plan: its name as text (a dot when changed); Save updates it, and clicking the
 * name edits it in place, which saves a copy under the new name (Save as).
 */
export function PlanName({
  current,
  dirty,
  empty,
  defaultName,
  onSave,
}: {
  /** The saved plan being edited, or null for a new plan. */
  current: SavedPlan | null;
  dirty: boolean;
  /** No nodes allocated: a new plan can't be saved yet. */
  empty: boolean;
  defaultName: string;
  /** Saves the current plan: over `current` (null), or as a new save with this name.
   *  False when storage refused it. */
  onSave: (name: string | null) => boolean;
}) {
  const [typed, setTyped] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  // After Enter or Escape, focus goes back to the name (the box it was in is gone).
  const nameButton = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (editing !== null || !refocus.current) return;
    refocus.current = false;
    nameButton.current?.focus();
  }, [editing, current]);

  if (current === null) {
    const save = () => {
      if (empty) return;
      if (!onSave(typed.trim().slice(0, MAX_NAME) || defaultName)) return;
      setTyped("");
      // The box becomes the name: keep keyboard focus on it.
      refocus.current = true;
    };
    return (
      <span className={styles.planName}>
        <input
          className={classNames(formStyles.formInput, styles.nameInput)}
          placeholder="Name"
          aria-label="Plan name"
          maxLength={MAX_NAME}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
        />
        <button
          className={formStyles.formButton}
          onClick={save}
          disabled={empty}
        >
          Save
        </button>
      </span>
    );
  }

  // Save as: a new name saves a copy and stays on it; the same name (or none) saves over
  // this one when it has changes.
  const commit = () => {
    const next = (editing ?? "").trim().slice(0, MAX_NAME);
    setEditing(null);
    if (next && next !== current.name) onSave(next);
    else if (dirty) onSave(null);
  };
  return (
    <span className={styles.planName}>
      {editing === null ? (
        <button
          ref={nameButton}
          className={styles.nameText}
          title="Save as"
          aria-label={`${current.name}${dirty ? ", unsaved" : ""}, save as`}
          onClick={() => setEditing(current.name)}
        >
          <span className={styles.nameLabel}>{current.name}</span>
          {dirty && (
            <span
              className={styles.dirtyDot}
              role="img"
              aria-label="Unsaved"
              title="Unsaved"
            />
          )}
        </button>
      ) : (
        <input
          className={classNames(formStyles.formInput, styles.nameInput)}
          aria-label="Save as"
          maxLength={MAX_NAME}
          autoFocus
          onFocus={(e) => e.target.select()}
          value={editing}
          onChange={(e) => setEditing(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              refocus.current = true;
              commit();
            } else if (e.key === "Escape") {
              refocus.current = true;
              setEditing(null);
            }
          }}
          // Leaving the box without Enter or Save keeps the save as it was.
          onBlur={() => setEditing(null)}
        />
      )}
      <button
        className={formStyles.formButton}
        // While renaming, keep the box focused so the click saves under the new name.
        onMouseDown={(e) => editing !== null && e.preventDefault()}
        onClick={() => (editing !== null ? commit() : onSave(null))}
        disabled={editing === null && !dirty}
      >
        Save
      </button>
    </span>
  );
}
