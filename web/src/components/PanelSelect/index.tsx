import { displaySetName } from "../../state/current-act";
import { stripPob } from "../PobText";
import styles from "./styles.module.css";
import classNames from "classnames";

interface PanelSelectProps {
  /** Accessible name, e.g. "Tree set". */
  label: string;
  /** Set titles; PoB colour codes and loadout links ("{a1}") are left out when shown. */
  options: string[];
  /** The chosen index; -1 shows `placeholder`, so choosing any option (even the one it
   * names) calls onChange — for pickers that jump rather than select. */
  value: number;
  onChange: (index: number) => void;
  placeholder?: string;
  className?: string;
}

/** pob.codes-style dropdown for picking a set or loadout. */
export function PanelSelect({
  label,
  options,
  value,
  onChange,
  placeholder,
  className,
}: PanelSelectProps) {
  const shown = value >= 0 ? options[value] : placeholder;
  return (
    <select
      className={classNames(styles.select, className)}
      aria-label={label}
      title={displaySetName(stripPob(shown ?? ""))}
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
      onClick={(event) => event.stopPropagation()}
    >
      {value < 0 && (
        <option value={-1} hidden>
          {displaySetName(stripPob(placeholder ?? ""))}
        </option>
      )}
      {options.map((option, i) => (
        <option key={i} value={i}>
          {displaySetName(stripPob(option))}
        </option>
      ))}
    </select>
  );
}
