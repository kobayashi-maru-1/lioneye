import { useAppInfo } from "../../state/app-info";
import upstream from "../../upstream.json";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useEffect, useState } from "react";

const REPO = "kobayashi-maru-1/lioneye";

/** "v0.4.1" is newer than "0.4.0". */
export function newer(tag: string, version: string) {
  const parts = (v: string) =>
    v.replace(/^v/, "").split(/[.-]/).slice(0, 3).map(Number);
  const [a, b] = [parts(tag), parts(version)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

/** How often a running guide asks GitHub again: every 6 h, and on focus after an hour. */
const RECHECK = 6 * 60 * 60 * 1000;
const RECHECK_ON_FOCUS = 60 * 60 * 1000;

/** The latest release on GitHub, asked at most once per `maxAge`; null when it can't be read. */
let latest: Promise<{ tag: string; url: string } | null> | null = null;
let checkedAt = 0;
function latestRelease(maxAge = RECHECK) {
  if (latest !== null && Date.now() - checkedAt < maxAge) return latest;
  checkedAt = Date.now();
  latest = fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
    .then((response) => (response.ok ? response.json() : null))
    .then((release) =>
      release && typeof release.tag_name === "string"
        ? { tag: release.tag_name as string, url: release.html_url as string }
        : null,
    )
    .catch(() => null);
  return latest;
}

/**
 * PoB Redux-style status line at the bottom of the window: the app's version, the bundled
 * Path of Building's, the date of the merged exile-leveling route data, a newer release
 * when there is one, and links. Exe only (the hosted site has no versions to show).
 */
export function Footer() {
  const { info } = useAppInfo();
  const [update, setUpdate] = useState<{ tag: string; url: string } | null>(
    null,
  );
  // On load, every 6 h, and when the window gets focus after an hour without a check: the
  // guide can stay open for days.
  useEffect(() => {
    if (!info) return;
    let live = true;
    const check = (maxAge?: number) =>
      latestRelease(maxAge).then(
        (release) =>
          live &&
          release &&
          newer(release.tag, info.version) &&
          setUpdate(release),
      );
    check();
    const timer = window.setInterval(() => check(RECHECK - 60_000), RECHECK);
    const onFocus = () => check(RECHECK_ON_FOCUS);
    window.addEventListener("focus", onFocus);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [info?.version]);
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
  return (
    <footer className={classNames(styles.footer)}>
      <span title={info.commit ? `Build ${info.commit}` : undefined}>
        Lioneye {info.version}
        {info.commit && ` (${info.commit})`}
      </span>
      <span title="Path of Building Community, bundled">
        PoB {info.pob.replace(/^v/, "")}
      </span>
      <span
        title={`exile-leveling ${upstream.exileLeveling.commit.slice(0, 7)}`}
      >
        Route {upstream.exileLeveling.date}
      </span>
      {update && (
        <a
          className={classNames(styles.update)}
          href={update.url}
          target="_blank"
          rel="noreferrer"
        >
          Update {update.tag.replace(/^v/, "")}
        </a>
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
