import { AutoProgressStatus } from "../AutoProgress";
import { useJumpToSection } from "../PageSection";
import styles from "./styles.module.css";
import classNames from "classnames";
import { atom, useAtomValue } from "jotai";
import { FiArrowLeft, FiSettings } from "react-icons/fi";
import { useLocation, useNavigate } from "react-router-dom";

export interface JumpTarget {
  id: string;
  label: string;
}

/** The guide page's panels, set by the page, for the bar's jump buttons. */
export const jumpTargetsAtom = atom<JumpTarget[]>([]);

/**
 * The app's one bar, pinned at the top: on the guide, a button per panel (opens it if
 * folded and scrolls to it); elsewhere, the way back to the guide. Always the auto-progress
 * pill and Settings.
 */
export function AppBar() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const targets = useAtomValue(jumpTargetsAtom);
  const jump = useJumpToSection();
  const onGuide = pathname === "/";

  return (
    <nav className={classNames(styles.bar)} aria-label="Sections">
      {onGuide ? (
        targets.map((target) => (
          <button
            key={target.id}
            className={classNames(styles.button)}
            onClick={() => jump(target.id)}
          >
            {target.label}
          </button>
        ))
      ) : (
        <button
          className={classNames(styles.button)}
          onClick={() => navigate("/")}
        >
          <FiArrowLeft aria-hidden />
          Guide
        </button>
      )}
      <span className={classNames(styles.spacer)} />
      <AutoProgressStatus />
      <button
        className={classNames(styles.button, styles.icon, {
          [styles.active]: pathname === "/settings",
        })}
        aria-label="Settings"
        title="Settings"
        onClick={() => navigate("/settings")}
      >
        <FiSettings aria-hidden />
      </button>
    </nav>
  );
}
