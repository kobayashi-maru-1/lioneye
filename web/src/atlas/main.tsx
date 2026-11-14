// The standalone Atlas planner (plans/atlas-planner.md), published at
// https://kobayashi-maru-1.github.io/lioneye/atlas/. No exe, no proxy: a static page that
// keeps its plans in this browser's local storage.
import "../index.css";
import { App } from "./App.tsx";
import type { AtlasData } from "./lib/types.ts";
import { clearStorage } from "./store.ts";
import { formStyles } from "../styles";
import styles from "./atlas.module.css";
import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { ErrorBoundary } from "react-error-boundary";

/** If the page breaks (say, on stored data it can't read): reload, or start clean. */
function Broken() {
  const [confirming, setConfirming] = useState(false);
  if (confirming)
    return (
      <div className={styles.broken} role="alert">
        <div>Clear all plans?</div>
        <div className={styles.brokenNote}>
          Removes the draft and every saved plan.
        </div>
        <div className={formStyles.groupLeft}>
          <button
            className={formStyles.formButton}
            onClick={() => {
              clearStorage();
              location.reload();
            }}
          >
            Clear all
          </button>
          <button
            className={formStyles.formButton}
            onClick={() => setConfirming(false)}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  return (
    <div className={styles.broken} role="alert">
      <div>Planner stopped.</div>
      <div className={formStyles.groupLeft}>
        <button
          className={formStyles.formButton}
          onClick={() => location.reload()}
        >
          Reload
        </button>
        <button
          className={formStyles.formButton}
          onClick={() => setConfirming(true)}
        >
          Clear plans
        </button>
      </div>
    </div>
  );
}

function Root() {
  const [data, setData] = useState<AtlasData | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    import("../../../common/data/atlas/3_30.json")
      .then((m) => setData(m.default as unknown as AtlasData))
      .catch(() => setFailed(true));
  }, []);
  if (failed)
    return <div className={styles.loading}>Not loaded. Reload the page.</div>;
  if (!data) return <div className={styles.loading}>Loading</div>;
  return (
    <ErrorBoundary FallbackComponent={Broken}>
      <App data={data} />
    </ErrorBoundary>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
