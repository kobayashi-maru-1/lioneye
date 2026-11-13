import { AutoProgressStatus } from "../AutoProgress";
import { useJumpToPanel } from "../PageSection";
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
 * The app's one bar, pinned at the top, the same on every page: a button per guide panel
 * (opens it if folded and scrolls to it; from another page, back to the guide first),
 * then League, Atlas and Settings, and the auto-progress pill at the right. Before the guide
 * has listed its panels (the app opened on another page), a Guide button instead.
 */
export function AppBar() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const targets = useAtomValue(jumpTargetsAtom);
  const jump = useJumpToPanel();
  const onStrats = pathname === "/strats";
  const onAtlas = pathname === "/atlas";
  const onSettings = pathname === "/settings" || pathname === "/build";

  return (
    <nav className={classNames(styles.bar)} aria-label="Main">
      {targets.length > 0 ? (
        targets.map((target) => (
          <button
            key={target.id}
            className={classNames(styles.button)}
            onClick={() => jump(target.id)}
          >
            {target.label}
          </button>
        ))
      ) : pathname !== "/" ? (
        <button
          className={classNames(styles.button)}
          onClick={() => navigate("/")}
        >
          <FiArrowLeft aria-hidden />
          Guide
        </button>
      ) : null}
      <button
        className={classNames(styles.button, { [styles.active]: onStrats })}
        aria-current={onStrats ? "page" : undefined}
        onClick={() => navigate("/strats")}
      >
        League
      </button>
      <button
        className={classNames(styles.button, { [styles.active]: onAtlas })}
        aria-current={onAtlas ? "page" : undefined}
        onClick={() => navigate("/atlas")}
      >
        Atlas
      </button>
      <button
        className={classNames(styles.button, styles.icon, {
          [styles.active]: onSettings,
        })}
        aria-current={onSettings ? "page" : undefined}
        aria-label="Settings"
        title="Settings"
        onClick={() => navigate("/settings")}
      >
        <FiSettings aria-hidden />
      </button>
      <span className={classNames(styles.spacer)} />
      <AutoProgressStatus />
    </nav>
  );
}
