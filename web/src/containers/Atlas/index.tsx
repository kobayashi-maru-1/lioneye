import { Loading } from "../../components/Loading";
import {
  ATLAS_NEW_URL,
  ATLAS_OLD_URL,
  atlasTreeUrl,
  type AtlasPlanner,
  type AtlasRouteState,
} from "../../state/atlas";
import { useReachable } from "../../utility/use-reachable";
import stratsStyles from "../Strats/styles.module.css";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

const PLANNERS: { id: AtlasPlanner; label: string }[] = [
  { id: "new", label: "New" },
  { id: "old", label: "Old" },
];

/**
 * The Atlas page: two atlas tree planners, each live in a frame, under a bar to pick one.
 * New (ours, from GitHub Pages) opens first; Old (poeatlasplanner.com) loads the first time
 * it's picked, so trees saved there can still be opened (its Share tree link opens in New).
 * Each planner keeps its draft and saved trees in its own browser storage, which inside
 * these frames belongs to Lioneye (kept across restarts, apart from the same site opened in
 * a normal tab). A tree link clicked on the League page comes in as the route's state and
 * opens in New; otherwise New opens on its draft.
 */
export default function AtlasContainer() {
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as AtlasRouteState | null;
  // A tree opens once: its history entry is then marked seen, so Back/Forward or the
  // window's own reload don't open it over the plan again.
  const [tree, setTree] = useState(() =>
    state?.seen ? null : atlasTreeUrl(state?.tree),
  );
  // Every visit starts on New.
  const [planner, setPlanner] = useState<AtlasPlanner>("new");
  const [oldOpened, setOldOpened] = useState(false);
  const mountKey = useRef(location.key);

  useEffect(() => {
    if (state?.seen) return;
    // Atlas in the top bar while already here: New on its draft, as on any visit.
    if (location.key !== mountKey.current) {
      setTree(null);
      setPlanner("new");
    }
    if (state?.tree !== undefined) {
      const seen: AtlasRouteState = { seen: true };
      navigate(location.pathname, { replace: true, state: seen });
    }
  }, [location.key]);

  const pick = (id: AtlasPlanner) => {
    setPlanner(id);
    if (id === "old") setOldOpened(true);
  };

  return (
    <div className={classNames(stratsStyles.page)}>
      <nav className={classNames(styles.tabs)} aria-label="Atlas planners">
        {PLANNERS.map(({ id, label }) => (
          <button
            key={id}
            className={classNames(styles.tab, {
              [styles.active]: planner === id,
            })}
            aria-pressed={planner === id}
            onClick={() => pick(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className={classNames(styles.frames)}>
        <PlannerFrame
          // A new src that differs only in its #fragment wouldn't reload the planner.
          key={tree ?? ATLAS_NEW_URL}
          check={ATLAS_NEW_URL}
          src={tree ?? ATLAS_NEW_URL}
          title="Atlas planner"
          shown={planner === "new"}
          // allow-same-origin keeps the planner's own storage (its plans).
          // allow-downloads for Export. No popups: it opens no other pages.
          // No allow-top-navigation: it can't move the app window elsewhere.
          sandbox="allow-scripts allow-same-origin allow-downloads"
        />
        {oldOpened && (
          <PlannerFrame
            check={ATLAS_OLD_URL}
            src={ATLAS_OLD_URL}
            title="Atlas Route"
            shown={planner === "old"}
            // allow-same-origin keeps the planner's own storage (its saved trees).
            // allow-forms and allow-modals for its save and replace prompts.
            // No allow-top-navigation: it can't move the app window elsewhere.
            sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox"
          />
        )}
      </div>
    </div>
  );
}

interface PlannerFrameProps {
  /** The address checked before framing (a frame can't report a failed load). */
  check: string;
  src: string;
  title: string;
  /** Hidden planners keep their size and state, so switching back finds them as left. */
  shown: boolean;
  sandbox: string;
}

function PlannerFrame({
  check,
  src,
  title,
  shown,
  sandbox,
}: PlannerFrameProps) {
  const [attempt, setAttempt] = useState(0);
  const status = useReachable(check, attempt);

  return (
    // inert as well: a hidden planner's own script can't take focus or keys.
    <div
      className={classNames(styles.slot, { [styles.hidden]: !shown })}
      inert={!shown}
    >
      {status === "offline" ? (
        <div className={classNames(stratsStyles.offline)}>
          <span>Not loaded. Check your connection.</span>
          <button
            className={classNames(stratsStyles.retry)}
            onClick={() => setAttempt((n) => n + 1)}
          >
            Retry
          </button>
        </div>
      ) : status === "checking" ? (
        <Loading />
      ) : (
        <iframe
          className={classNames(stratsStyles.frame, styles.frame)}
          title={title}
          src={src}
          sandbox={sandbox}
          // Share copies its link (only write, never read the clipboard).
          allow="clipboard-write"
        />
      )}
    </div>
  );
}
