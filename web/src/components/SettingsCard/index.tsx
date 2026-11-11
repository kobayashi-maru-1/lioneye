import styles from "./styles.module.css";
import classNames from "classnames";
import { useId } from "react";

/**
 * Settings' cards: a section's cards in two columns when there's room (side by side ones
 * the same height), one when narrow.
 */
export function CardGrid({ children }: React.PropsWithChildren) {
  return (
    <div className={classNames(styles.holder)}>
      <div className={classNames(styles.grid)}>{children}</div>
    </div>
  );
}

/** A titled card of setting rows. `wide` spans both columns; `danger` is the resets'. */
export function SettingsCard({
  title,
  aside,
  wide,
  danger,
  children,
}: React.PropsWithChildren<{
  title: string;
  /** At the right of the title bar (a count, a link). */
  aside?: React.ReactNode;
  wide?: boolean;
  danger?: boolean;
}>) {
  const id = useId();
  return (
    <div
      className={classNames(styles.card, {
        [styles.wide]: wide,
        [styles.danger]: danger,
      })}
      role="group"
      aria-labelledby={id}
    >
      <div className={classNames(styles.header)}>
        <h3 id={id} className={classNames(styles.title)}>
          {title}
        </h3>
        {aside !== undefined && aside !== null && aside !== false && (
          <span className={classNames(styles.aside)}>{aside}</span>
        )}
      </div>
      <div className={classNames(styles.body)}>{children}</div>
    </div>
  );
}

/**
 * One setting: its label at the left, the control at the right (the label above it when
 * the card is narrow). `htmlFor` names the control; without it the label is plain text
 * (`labelId` lets a group point at it). An empty label lines buttons up with the controls.
 */
export function SettingRow({
  label,
  htmlFor,
  labelId,
  inline,
  title,
  children,
}: React.PropsWithChildren<{
  label: string;
  htmlFor?: string;
  labelId?: string;
  /** A switch or a plain value: label and control centered on one line, even narrow. */
  inline?: boolean;
  title?: string;
}>) {
  return (
    <div
      className={classNames(styles.row, { [styles.inline]: inline })}
      title={title}
    >
      {htmlFor ? (
        <label
          htmlFor={htmlFor}
          id={labelId}
          className={classNames(styles.label)}
        >
          {label}
        </label>
      ) : (
        <span id={labelId} className={classNames(styles.label)}>
          {label}
        </span>
      )}
      <div className={classNames(styles.control)}>{children}</div>
    </div>
  );
}

/** An on/off setting as a row with a switch. */
export function SwitchRow({
  label,
  checked,
  onChange,
  disabled,
  title,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  title?: string;
}) {
  const id = useId();
  return (
    <SettingRow label={label} htmlFor={id} inline>
      <button
        type="button"
        id={id}
        title={title}
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        className={classNames(styles.switch)}
        onClick={() => onChange(!checked)}
      />
    </SettingRow>
  );
}

/** A setting that picks several of a list: checkboxes in even columns. */
export function CheckGrid({
  labelledBy,
  items,
  onChange,
  disabled,
}: {
  /** Id of the row's label. */
  labelledBy: string;
  items: { id: string; label: string; checked: boolean }[];
  onChange: (id: string, checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset
      className={classNames(styles.checks)}
      disabled={disabled}
      aria-labelledby={labelledBy}
    >
      {items.map((item) => (
        <label key={item.id} className={classNames(styles.check)}>
          <input
            type="checkbox"
            checked={item.checked}
            onChange={(event) => onChange(item.id, event.target.checked)}
          />
          {item.label}
        </label>
      ))}
    </fieldset>
  );
}
