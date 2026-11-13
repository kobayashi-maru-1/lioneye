import { Loading } from "../../components/Loading";
import { useReachable } from "../../utility/use-reachable";
import styles from "../Strats/styles.module.css";
import classNames from "classnames";
import { useState } from "react";

/** Atlas Route, an independent atlas tree planner (not open source; framed as it is). */
export const ATLAS_PLANNER_URL = "https://poeatlasplanner.com/";

/**
 * The Atlas page: the atlas tree planner live in a frame. The planner keeps its draft and
 * saved trees in its own browser storage, which inside this frame belongs to Lioneye (kept
 * across restarts, apart from the same site opened in a normal tab). Its Share tree button
 * writes to the clipboard (clipboard-write).
 */
export default function AtlasContainer() {
  const [attempt, setAttempt] = useState(0);
  const status = useReachable(ATLAS_PLANNER_URL, attempt);

  if (status === "offline") {
    return (
      <div className={classNames(styles.offline)}>
        <span>Not loaded. Check your connection.</span>
        <button
          className={classNames(styles.retry)}
          onClick={() => setAttempt((n) => n + 1)}
        >
          Retry
        </button>
      </div>
    );
  }

  if (status === "checking") return <Loading />;

  return (
    <div className={classNames(styles.page)}>
      <iframe
        className={classNames(styles.frame)}
        title="Atlas"
        src={ATLAS_PLANNER_URL}
        // allow-same-origin keeps the planner's own storage (its saved trees).
        // allow-forms and allow-modals for its save and replace prompts.
        // No allow-top-navigation: it can't move the app window elsewhere.
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox"
        allow="clipboard-write"
      />
    </div>
  );
}
