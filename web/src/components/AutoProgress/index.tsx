import { useAtomValue, useSetAtom } from "jotai";
import { useAtomCallback } from "jotai/utils";
import { useCallback, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { bossesKilledBy } from "../../state/boss-kills";
import {
  OVERLAY_PANELS,
  overlayGemsAtom,
  overlaySettingsAtom,
  shownPanelsAtom,
} from "../../state/overlay";
import { activeEdgeAtom, bossKillAtom, edgeId } from "../../state/route";
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
      if (typeof event.data !== "string") return;
      // A button on the in-game bar.
      if (event.data.startsWith("jump:")) {
        jump(event.data.slice("jump:".length));
        return;
      }
      // The bar's settings and Gems tooltip, for the bar itself.
      if (event.data.startsWith("overlay:") || event.data.startsWith("gems:"))
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
  useEffect(() => {
    if (readyState === ReadyState.OPEN) sendMessage("guide");
  }, [readyState]);
  useEffect(() => {
    if (readyState !== ReadyState.OPEN) return;
    const buttons =
      shown === null
        ? undefined
        : OVERLAY_PANELS.filter(
            (panel) =>
              settings.panels.includes(panel.id) && shown.includes(panel.id),
          ).map(({ id, label }) => ({ id, label }));
    sendMessage(`overlay:${JSON.stringify({ on: settings.on, buttons })}`);
  }, [readyState, settings, shown]);
  // The Gems panel's set, for the bar's Gems tooltip.
  const gems = useAtomValue(overlayGemsAtom);
  useEffect(() => {
    if (readyState === ReadyState.OPEN)
      sendMessage(`gems:${JSON.stringify(gems)}`);
  }, [readyState, gems]);
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
