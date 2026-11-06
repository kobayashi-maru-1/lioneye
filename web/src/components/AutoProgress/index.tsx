import { useAtomValue, useSetAtom } from "jotai";
import { useAtomCallback } from "jotai/utils";
import { useCallback, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { bossesKilledBy } from "../../state/boss-kills";
import {
  OVERLAY_PANELS,
  overlayCampaignAtom,
  overlayGemsAtom,
  overlaySettingsAtom,
  shownPanelsAtom,
} from "../../state/overlay";
import { activeEdgeAtom, bossKillAtom, edgeId } from "../../state/route";
import {
  migrateProfile,
  fingerprint,
  markSynced,
  ownWindow,
  pageMode,
  syncedFingerprint,
  restoreStorage,
  startedFresh,
  storageSnapshot,
  takeReset,
} from "../../state/saved-state";
import { pageSectionId, useJumpToSection } from "../PageSection";
import { autoProgressAtom } from "../../state/auto-progress";
import { levelLineAtom } from "../../state/level-lines";
import useWebSocket, { ReadyState } from "react-use-websocket-lite";
import classNames from "classnames";
import styles from "./styles.module.css";

// The local exe serves the page and the auto-progress socket from the same address.
const AUTO_PROGRESS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

export function useAutoProgress() {
  const write = useSetAtom(activeEdgeAtom);
  const takeLevelLine = useSetAtom(levelLineAtom);
  const bossKilled = useSetAtom(bossKillAtom);
  const setState = useSetAtom(autoProgressAtom);

  const jump = useJumpFromGame();

  const { readyState, sendMessage } = useWebSocket({
    url: AUTO_PROGRESS_URL,
    shouldReconnect: true,
    reconnectInterval: 1000,
    onMessage(event) {
      if (typeof event.data !== "string" || restoring) return;
      // The exe's copy of the guide's saved data (sent first on connect).
      if (event.data.startsWith("state:")) {
        takeSavedState(event.data.slice("state:".length), sendMessage);
        return;
      }
      // A window opened only to send its profile's data to the exe does nothing else.
      if (pageMode === "migrate") return;
      // A button on the in-game bar.
      if (event.data.startsWith("jump:")) {
        jump(event.data.slice("jump:".length));
        return;
      }
      // A new exe (an update) serves a new guide: reload to get it.
      if (event.data.startsWith("build:")) {
        if (seenBuild !== null && seenBuild !== event.data) location.reload();
        seenBuild = event.data;
        return;
      }
      // The bar's settings and tooltips, for the bar itself.
      if (event.data.startsWith("overlay:") || event.data.startsWith("tips:"))
        return;
      if (event.data.startsWith("status:")) {
        const [status, path] = event.data.slice("status:".length).split("|");
        setState(
          status === "watching"
            ? { kind: "watching", path: path ?? "" }
            : { kind: "waiting" },
        );
        return;
      }
      // Level-ups set your level, boss death lines tick their step; zone changes move
      // the route.
      if (takeLevelLine(event.data)) return;
      const bosses = bossesKilledBy(event.data);
      if (bosses !== null) {
        bossKilled(bosses);
        return;
      }
      write(event.data);
    },
  });

  useEffect(() => {
    if (readyState !== ReadyState.OPEN) setState({ kind: "offline" });
  }, [readyState]);

  // Tell the exe this is a guide page (a bar button with no guide open waits for one),
  // and send the bar's settings whenever they or the build's panels change.
  const settings = useAtomValue(overlaySettingsAtom);
  const shown = useAtomValue(shownPanelsAtom);
  const talks = readyState === ReadyState.OPEN && pageMode !== "migrate";
  useEffect(() => {
    if (talks) sendMessage("guide");
  }, [talks]);
  // The guide's own window keeps the exe's copy of its data current.
  useEffect(() => {
    if (!talks || pageMode !== "own") return;
    const timer = setInterval(() => uploadSavedState(sendMessage), 5000);
    return () => clearInterval(timer);
  }, [talks]);
  // Links out of the guide's own window (trade, wiki) open in your last-used Edge
  // profile, where you're signed in, through the exe.
  useEffect(() => {
    if (!talks || !ownWindow) return;
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || (event.button !== 0 && event.button !== 1))
        return;
      const link =
        event.target instanceof Element
          ? event.target.closest<HTMLAnchorElement>("a[href]:not([download])")
          : null;
      if (!link) return;
      const url = new URL(link.href, location.href);
      if (url.origin === location.origin) return;
      if (url.protocol !== "https:" && url.protocol !== "http:") return;
      event.preventDefault();
      sendMessage(`open:${url.href}`);
    };
    // Capture: before any link's own handler can stop the click (Daily Layout does).
    document.addEventListener("click", onClick, true);
    document.addEventListener("auxclick", onClick, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("auxclick", onClick, true);
    };
  }, [talks]);
  useEffect(() => {
    if (!talks) return;
    const buttons =
      shown === null
        ? undefined
        : OVERLAY_PANELS.filter(
            (panel) =>
              settings.panels.includes(panel.id) && shown.includes(panel.id),
          ).map(({ id, label }) => ({ id, label }));
    sendMessage(`overlay:${JSON.stringify({ on: settings.on, buttons })}`);
  }, [talks, settings, shown]);
  // The bar's tooltips: the Gems panel's set and Campaign's next steps.
  const gems = useAtomValue(overlayGemsAtom);
  useEffect(() => {
    if (talks && gems !== undefined)
      sendMessage(`tip:gems:${JSON.stringify(gems)}`);
  }, [talks, gems]);
  const campaign = useAtomValue(overlayCampaignAtom);
  useEffect(() => {
    if (talks && campaign !== undefined)
      sendMessage(`tip:campaign:${JSON.stringify(campaign)}`);
  }, [talks, campaign]);
}

/** The exe's build this page was served by (its first "build:" message). */
let seenBuild: string | null = null;

/** The own window has the exe's copy (and restored it if it started fresh): it may upload. */
let savedStateReady = false;
/** What was last uploaded, so only changes are sent. */
let uploaded = "";

/**
 * The exe's copy of the guide's saved data arrived ("null" before anything was saved):
 * - a window opened to move an old profile's data sends what that profile has;
 * - a window the exe opened loads the copy and reloads when it started with nothing stored,
 *   or when another browser saved it since this one last did (Settings picks the browser).
 */
function takeSavedState(json: string, send: (message: string) => void) {
  if (pageMode === "migrate") {
    // "<profile id>\n<storage>": the exe matches it to the profile it opened.
    send(`state-offer:${migrateProfile}\n${JSON.stringify(storageSnapshot())}`);
    return;
  }
  if (pageMode !== "own" || savedStateReady || restoring) return;
  // Reset from the error page: start empty, and the upload replaces the exe's copy.
  if (takeReset()) {
    savedStateReady = true;
    return;
  }
  let saved: Record<string, string> | null = null;
  try {
    saved = JSON.parse(json) as Record<string, string> | null;
  } catch {
    saved = null;
  }
  const synced = syncedFingerprint();
  // The own window from before fingerprints: its data is the copy's (it uploaded it).
  const behind = synced === null ? !ownWindow : synced !== fingerprint(json);
  if (
    saved !== null &&
    Object.keys(saved).length > 0 &&
    (startedFresh || behind)
  ) {
    try {
      restoreStorage(saved);
    } catch {
      // Storage full or blocked: leave it empty rather than upload part of the copy.
      localStorage.clear();
      return;
    }
    markSynced(json);
    restoring = true;
    location.reload();
    return;
  }
  if (saved !== null) markSynced(json);
  savedStateReady = true;
}

/** Storage was filled from the exe's copy and the page is reloading: ignore the rest. */
let restoring = false;

function uploadSavedState(send: (message: string) => void) {
  if (!savedStateReady) return;
  const snapshot = JSON.stringify(storageSnapshot());
  if (snapshot === uploaded) return;
  uploaded = snapshot;
  send(`state:${snapshot}`);
  markSynced(snapshot);
}

/**
 * Jumps to a panel for the in-game bar: from Settings, back to the guide first. Campaign
 * goes to your current step rather than the panel's top.
 */
function useJumpFromGame() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const jumpToSection = useJumpToSection();
  const scrollToStep = useAtomCallback(
    useCallback((get) => {
      const element = document.getElementById(edgeId(get(activeEdgeAtom)[0]));
      element?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, []),
  );
  return useCallback(
    (id: string) => {
      const go = () => {
        jumpToSection(id);
        // Once the panel has opened.
        if (id === "campaign") setTimeout(scrollToStep, 50);
      };
      if (pathname === "/") go();
      else {
        navigate("/");
        // The guide page loads lazily: jump once its panel is there (up to 5 s).
        let tries = 0;
        const wait = () => {
          if (document.getElementById(pageSectionId(id))) go();
          else if (++tries < 50) setTimeout(wait, 100);
        };
        wait();
      }
    },
    [pathname, navigate, jumpToSection, scrollToStep],
  );
}

const LABELS = {
  offline: "Offline",
  waiting: "Waiting",
  watching: "Auto",
} as const;

const TITLES = {
  offline: "Auto-progress is off: exile-leveling.exe isn't running.",
  waiting: "Auto-progress is waiting for Path of Exile to start.",
  watching: "Auto-progress is following ",
} as const;

/** Small status pill: green when the log is being followed. */
export function AutoProgressStatus() {
  const state = useAtomValue(autoProgressAtom);
  const title =
    state.kind === "watching"
      ? TITLES.watching + state.path
      : TITLES[state.kind];

  return (
    <span
      className={classNames(styles.status, styles[state.kind])}
      title={title}
      role="status"
    >
      <span className={classNames(styles.dot)} aria-hidden />
      {LABELS[state.kind]}
    </span>
  );
}
