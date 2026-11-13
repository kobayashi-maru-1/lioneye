import { useAppInfo } from "../../state/app-info";
import upstream from "../../upstream.json";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useCallback, useEffect, useState } from "react";
import { FiDownload, FiRefreshCw } from "react-icons/fi";

const REPO = "kobayashi-maru-1/lioneye";

/** How old the exe's answer may get: 6 h, and 1 h when the window gets focus. */
const RECHECK = 6 * 60 * 60 * 1000;
const RECHECK_ON_FOCUS = 60 * 60 * 1000;
/** How often to read the exe's answer (cheap: GitHub is asked only past `RECHECK`), so an
 * update found or started from the tray shows here too. */
const POLL = 15 * 1000;
/** While installing: how often to look for a failure (success restarts the exe). */
const POLL_INSTALL = 1000;
/** Installing and the exe gone this long: it didn't come back. */
const INSTALL_GONE = 60 * 1000;

/** The exe's view of the latest release (log-api/src/update.rs). */
interface UpdateView {
  /** Only when newer than this exe. */
  latest: { tag: string; url: string } | null;
  state: "idle" | "installing" | "failed";
  error?: string;
  /** The last check didn't reach GitHub (exe 0.4.54 and later). */
  checkFailed?: boolean;
}

/** The check button's result, shown beside it for `CHECK_SHOWN` ms. */
type CheckResult = "checking" | "current" | "failed" | null;
const CHECK_SHOWN = 4000;

/** The exe's answer; it asks GitHub when its last answer is older than `maxAge` ms. */
function fetchUpdate(maxAge?: number): Promise<UpdateView | null> {
  const query =
    maxAge === undefined ? "" : `?maxAge=${Math.round(maxAge / 1000)}`;
  return fetch(`/api/update${query}`)
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
}

/**
 * PoB Redux-style status line at the bottom of the window: the app's version, the bundled
 * Path of Building's, the date of the merged exile-leveling route data, a newer release
 * when there is one (its page, and an icon that installs it), and links. Beside the
 * version, a button checks GitHub now and says how it went for a few seconds.
 */
export function Footer() {
  const { info } = useAppInfo();
  const [update, setUpdate] = useState<UpdateView | null>(null);
  // On load, every 15 s, and on focus: the guide can stay open for days. The exe asks
  // GitHub at most every 6 h (every hour on focus); the tray shows the same.
  useEffect(() => {
    if (!info) return;
    let live = true;
    const check = (maxAge?: number) =>
      fetchUpdate(maxAge).then((found) => live && found && setUpdate(found));
    check(RECHECK);
    const timer = window.setInterval(() => check(RECHECK), POLL);
    const onFocus = () => check(RECHECK_ON_FOCUS);
    window.addEventListener("focus", onFocus);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [info?.version]);
  // Installing (from here or the tray): watch for a failure. On success the new exe starts
  // and the page reloads itself (AutoProgress); an exe gone for a minute didn't come back.
  const installing = update?.state === "installing";
  useEffect(() => {
    if (!installing) return;
    let live = true;
    let lastSeen = Date.now();
    let timer = 0;
    // Each poll after the last answer, so slow answers never pile up.
    const poll = () =>
      fetchUpdate().then((found) => {
        if (!live) return;
        if (found) {
          lastSeen = Date.now();
          setUpdate(found);
        } else if (Date.now() - lastSeen > INSTALL_GONE) {
          setUpdate(
            (current) =>
              current && {
                ...current,
                state: "failed",
                error: "Lioneye not reached",
              },
          );
          return;
        }
        timer = window.setTimeout(poll, POLL_INSTALL);
      });
    timer = window.setTimeout(poll, POLL_INSTALL);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [installing]);
  // The check button: ask GitHub now (the exe allows one check a minute).
  const [checkResult, setCheckResult] = useState<CheckResult>(null);
  useEffect(() => {
    if (checkResult !== "current" && checkResult !== "failed") return;
    const timer = window.setTimeout(() => setCheckResult(null), CHECK_SHOWN);
    return () => window.clearTimeout(timer);
  }, [checkResult]);
  const checkNow = useCallback(() => {
    setCheckResult("checking");
    fetchUpdate(0).then((found) => {
      // Only what the check found: an install started meanwhile keeps its state.
      if (found)
        setUpdate((current) =>
          current
            ? {
                ...current,
                latest: found.latest,
                checkFailed: found.checkFailed,
              }
            : found,
        );
      setCheckResult(
        found === null || found.checkFailed
          ? "failed"
          : found.latest
            ? null
            : "current",
      );
    });
  }, []);
  const install = useCallback(() => {
    const failed = (error: string) =>
      setUpdate((current) => current && { ...current, state: "failed", error });
    setUpdate((current) => current && { ...current, state: "installing" });
    fetch("/api/update", { method: "POST" })
      .then(async (response) => {
        if (response.ok) setUpdate((await response.json()) as UpdateView);
        else
          failed(response.status === 409 ? "No update" : "Install not started");
      })
      .catch(() => failed("Lioneye not reached"));
  }, []);
  // Room for it at the bottom of the page (index.css).
  useEffect(() => {
    if (!info) return;
    const root = document.documentElement.style;
    root.setProperty("--footer-height", "1.4rem");
    return () => {
      root.removeProperty("--footer-height");
    };
  }, [info !== null]);

  if (!info) return null;
  // Says it restarts: the bar and guide reload, so not mid-fight.
  const installTitle =
    update?.state !== "failed"
      ? "Install and restart"
      : update.error
        ? `Not updated: ${update.error}. Click to retry.`
        : "Not updated. Click to retry.";
  return (
    <footer className={classNames(styles.footer)}>
      <span className={classNames(styles.version)}>
        <span title={info.commit ? `Build ${info.commit}` : undefined}>
          Lioneye {info.version}
          {info.commit && ` (${info.commit})`}
        </span>
        <button
          className={classNames(styles.check, {
            [styles.checking]: checkResult === "checking",
          })}
          onClick={checkNow}
          disabled={checkResult === "checking" || installing}
          title="Check updates"
          aria-label="Check updates"
        >
          <FiRefreshCw />
        </button>
        {checkResult === "checking" && <span>Checking…</span>}
        {checkResult === "current" && <span>Up to date</span>}
        {checkResult === "failed" && <span>Not checked. Retry.</span>}
      </span>
      <span title="Path of Building Community, bundled">
        PoB {info.pob.replace(/^v/, "")}
      </span>
      <span
        title={`exile-leveling ${upstream.exileLeveling.commit.slice(0, 7)}`}
      >
        Route {upstream.exileLeveling.date}
      </span>
      {update?.latest && (
        <span className={classNames(styles.update)}>
          <a href={update.latest.url} target="_blank" rel="noreferrer">
            Update {update.latest.tag.replace(/^v/, "")}
          </a>
          {installing ? (
            <span>Updating…</span>
          ) : (
            <button
              className={classNames(styles.install)}
              onClick={install}
              title={installTitle}
              aria-label={installTitle}
            >
              <FiDownload />
            </button>
          )}
        </span>
      )}
      <span className={classNames(styles.links)}>
        <a href={`https://github.com/${REPO}`} target="_blank" rel="noreferrer">
          GitHub
        </a>
        <a
          href={`https://github.com/${REPO}#credits`}
          target="_blank"
          rel="noreferrer"
        >
          Credits
        </a>
      </span>
    </footer>
  );
}
