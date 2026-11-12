import { stratsJumpAtom, stratsSectionsAtom } from "../../state/strats";
import { AutoProgressStatus } from "../AutoProgress";
import { useJumpToSection } from "../PageSection";
import styles from "./styles.module.css";
import classNames from "classnames";
import { atom, useAtomValue, useSetAtom } from "jotai";
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
 * folded and scrolls to it); elsewhere, the way back to the guide, and on Strats a button
 * per cheat-sheet section. Strats and Settings right after them, and the auto-progress
 * pill at the right.
 */
export function AppBar() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const targets = useAtomValue(jumpTargetsAtom);
  const jump = useJumpToSection();
  const stratsSections = useAtomValue(stratsSectionsAtom);
  const setStratsJump = useSetAtom(stratsJumpAtom);
  const onGuide = pathname === "/";
  const onStrats = pathname === "/strats";

  return (
    <nav className={classNames(styles.bar)} aria-label="Main">
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
        <>
          <button
            className={classNames(styles.button)}
            onClick={() => navigate("/")}
          >
            <FiArrowLeft aria-hidden />
            Guide
          </button>
          {onStrats &&
            stratsSections.map((section) => (
              <button
                key={section.id}
                className={classNames(styles.button)}
                onClick={() => setStratsJump({ id: section.id })}
              >
                {section.label}
              </button>
            ))}
        </>
      )}
      <button
        className={classNames(styles.button, { [styles.active]: onStrats })}
        aria-current={onStrats ? "page" : undefined}
        onClick={() => navigate("/strats")}
      >
        Strats
      </button>
      <button
        className={classNames(styles.button, styles.icon, {
          [styles.active]: pathname === "/settings" || pathname === "/build",
        })}
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
