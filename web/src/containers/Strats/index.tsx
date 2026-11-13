import { Loading } from "../../components/Loading";
import { atlasTreeUrl, type AtlasTreeState } from "../../state/atlas";
import {
  readSections,
  STRATS_ORIGIN,
  STRATS_URL,
  type StratsSection,
} from "../../state/strats";
import { useReachable, type Reachable } from "../../utility/use-reachable";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

type Status = Reachable | "missing";

/** How long the framed page gets to load and list its sections before it counts as missing. */
const LIST_WAIT_MS = 15000;

/**
 * The League page (the route and code keep its old name, Strats): the page from GitHub
 * Pages with the cheat sheet, builds and trade searches, live in a frame, under its own bar of section
 * buttons. The page lists its sections for that bar, scrolls when one is picked, and hands
 * its links over to open in your Edge profile (all by postMessage); atlas tree links open
 * in the Atlas tab instead. Its copy buttons write to the clipboard themselves
 * (clipboard-write).
 */
export default function StratsContainer() {
  const frame = useRef<HTMLIFrameElement>(null);
  const [sections, setSections] = useState<StratsSection[]>([]);
  const [listed, setListed] = useState(false);
  const [missing, setMissing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const reachable = useReachable(STRATS_URL, attempt);
  const status: Status = missing ? "missing" : reachable;
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    setMissing(false);
    setListed(false);
    setSections([]);
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
    const timer = setTimeout(() => setMissing(true), LIST_WAIT_MS);
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
        const url = clickedLink(data.url, frame.current);
        if (url === null) return;
        // An atlas tree (Atlas trees section): open it in the Atlas tab.
        const tree = atlasTreeUrl(url.href);
        if (tree !== null) {
          const state: AtlasTreeState = { tree };
          navigateRef.current("/atlas", { state });
        } else openInEdge(url);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const jumpTo = (id: string) =>
    frame.current?.contentWindow?.postMessage(
      { type: "strats-jump", id },
      STRATS_ORIGIN,
    );

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
    <div className={classNames(styles.page)}>
      <nav className={classNames(styles.sections)} aria-label="League">
        {sections.map((section) => (
          <button
            key={section.id}
            className={classNames(styles.section)}
            onClick={() => jumpTo(section.id)}
          >
            {section.label}
          </button>
        ))}
      </nav>
      <iframe
        ref={frame}
        className={classNames(styles.frame)}
        title="League"
        src={STRATS_URL}
        // allow-same-origin keeps the frame's real origin, which the message checks need.
        // No allow-top-navigation: the sheet can't move the app window elsewhere.
        sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        // Its Copy code / Copy link buttons (only write, never read the clipboard).
        allow="clipboard-write"
        onLoad={onFrameLoad}
      />
    </div>
  );
}

/**
 * How long a click counts as a click: Chromium's user activation lasts 5 s. One link per
 * gap means one link per click, since the exe's handler doesn't use up the activation.
 */
const OPEN_GAP_MS = 5000;
let lastOpen = Number.NEGATIVE_INFINITY;

/**
 * A link the sheet handed over, if it may open: only right after a real click, with the
 * frame focused (a click inside the frame activates this page too and focuses the frame),
 * and https only. So a changed sheet can't open links or switch tabs on load, or open a
 * pile of tabs: at most one link per click. (It could still focus itself right after a
 * click on a bar button and open one link then; accepted, Nov 2026.)
 */
function clickedLink(href: string, frame: HTMLIFrameElement | null) {
  if (!navigator.userActivation?.isActive) return null;
  if (frame === null || document.activeElement !== frame) return null;
  const now = performance.now();
  if (now - lastOpen < OPEN_GAP_MS) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  lastOpen = now;
  return url;
}

/**
 * Opens a link from the sheet the way the guide's own links open: a click on a link here
 * is picked up by AutoProgress, which hands it to the exe (your signed-in Edge profile).
 * Outside the exe's window it opens in a new tab.
 */
function openInEdge(url: URL) {
  const link = document.createElement("a");
  link.href = url.href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
}
