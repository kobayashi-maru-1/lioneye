import { interactiveStyles } from "../../styles";
import { AutoProgressStatus } from "../AutoProgress";
import { useJumpToSection } from "../PageSection";
import styles from "./styles.module.css";
import classNames from "classnames";
import React from "react";

export interface JumpTarget {
  id: string;
  label: React.ReactNode;
}

/** Sticky bar of section buttons; each opens its section and scrolls to it. */
export function JumpBar({ targets }: { targets: JumpTarget[] }) {
  const jump = useJumpToSection();
  return (
    <nav className={classNames(styles.jumpBar)} aria-label="Sections">
      {targets.map((target) => (
        <button
          key={target.id}
          className={classNames(styles.jump, interactiveStyles.activeSecondary)}
          onClick={() => jump(target.id)}
        >
          {target.label}
        </button>
      ))}
      <span className={classNames(styles.spacer)} />
      <AutoProgressStatus />
    </nav>
  );
}
