import { displaySetName } from "../../state/current-act";
import { stripPob } from "../PobText";
import styles from "./styles.module.css";
import classNames from "classnames";

interface PanelSelectProps {
  /** Accessible name, e.g. "Tree set". */
  label: string;
  /** Set titles; PoB colour codes and loadout links ("{a1}") are left out when shown. */
  options: string[];
  value: number;
  onChange: (index: number) => void;
  className?: string;
}

/** pob.codes-style dropdown for picking a set or loadout. */
export function PanelSelect({
  label,
  options,
  value,
  onChange,
  className,
}: PanelSelectProps) {
  return (
    <select
      className={classNames(styles.select, className)}
      aria-label={label}
      title={displaySetName(stripPob(options[value] ?? ""))}
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
      onClick={(event) => event.stopPropagation()}
    >
      {options.map((option, i) => (
        <option key={i} value={i}>
          {displaySetName(stripPob(option))}
        </option>
      ))}
    </select>
  );
}
