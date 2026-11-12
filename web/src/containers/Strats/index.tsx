import { Loading } from "../../components/Loading";
import {
  readSections,
  STRATS_ORIGIN,
  STRATS_URL,
  stratsJumpAtom,
  stratsSectionsAtom,
} from "../../state/strats";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useAtom, useSetAtom } from "jotai";
import { useEffect, useRef, useState } from "react";

type Status = "checking" | "online" | "offline" | "missing";

/** How long the reachability check may take before it counts as offline. */
const CHECK_WAIT_MS = 10000;
/** How long the framed page gets to load and list its sections before it counts as missing. */
const LIST_WAIT_MS = 15000;

/**
 * The league cheat sheet from GitHub Pages, live in a frame. The page lists its sections
 * for the bar's jump buttons, scrolls when one is picked, and hands its links over to
 * open in your Edge profile (all by postMessage).
 */
export default function StratsContainer() {
  const frame = useRef<HTMLIFrameElement>(null);
  const setSections = useSetAtom(stratsSectionsAtom);
  const [jump, setJump] = useAtom(stratsJumpAtom);
  const [status, setStatus] = useState<Status>("checking");
  const [listed, setListed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // A frame can't report a failed load across origins, so check the page is reachable first.
  useEffect(() => {
    const abort = new AbortController();
    let current = true;
    // A hung connection (captive portal) counts as offline.
    const timer = setTimeout(() => abort.abort(), CHECK_WAIT_MS);
    setStatus("checking");
    setListed(false);
    fetch(STRATS_URL, {
      method: "HEAD",
      mode: "no-cors",
      cache: "no-store",
      signal: abort.signal,
    }).then(
      () => current && setStatus("online"),
      () => current && setStatus("offline"),
    );
    return () => {
      current = false;
      clearTimeout(timer);
      abort.abort();
    };
  }, [attempt]);

  // Reachable but silent (GitHub's 404 page, a broken publish): say so instead.
  const onFrameLoad = () => {
    frame.current?.contentWindow?.postMessage(
      { type: "strats-list" },
      STRATS_ORIGIN,
    );
  };
  useEffect(() => {
    if (status !== "online" || listed) return;
    const timer = setTimeout(() => setStatus("missing"), LIST_WAIT_MS);
    return () => clearTimeout(timer);
  }, [status, listed]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== STRATS_ORIGIN) return;
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as {
        type?: unknown;
        sections?: unknown;
        url?: unknown;
      } | null;
      if (data?.type === "strats-sections") {
        setSections(readSections(data.sections));
        setListed(true);
      } else if (data?.type === "strats-open" && typeof data.url === "string") {
        openLink(data.url);
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      setSections([]);
      setJump(null);
    };
  }, []);

  useEffect(() => {
    if (jump === null) return;
    frame.current?.contentWindow?.postMessage(
      { type: "strats-jump", id: jump.id },
      STRATS_ORIGIN,
    );
  }, [jump]);

  if (status === "offline" || status === "missing") {
    return (
      <div className={classNames(styles.offline)}>
        <span>
          {status === "offline"
            ? "Not loaded. Check your connection."
            : "Not loaded. Retry later."}
        </span>
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
    <iframe
      ref={frame}
      className={classNames(styles.frame)}
      title="Strats"
      src={STRATS_URL}
      // allow-same-origin keeps the frame's real origin, which the message checks need.
      // No allow-top-navigation: the sheet can't move the app window elsewhere.
      sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      onLoad={onFrameLoad}
    />
  );
}

/**
 * Opens a link from the sheet the way the guide's own links open: a click on a link here
 * is picked up by AutoProgress, which hands it to the exe (your signed-in Edge profile).
 * Outside the exe's window it opens in a new tab.
 */
function openLink(href: string) {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return;
  }
  if (url.protocol !== "https:") return;
  const link = document.createElement("a");
  link.href = url.href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
}
