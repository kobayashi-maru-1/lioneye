import { useAtomValue, useSetAtom } from "jotai";
import { useEffect } from "react";
import { bossesKilledBy } from "../../state/boss-kills";
import { activeEdgeAtom, bossKillAtom } from "../../state/route";
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

  const { readyState } = useWebSocket({
    url: AUTO_PROGRESS_URL,
    shouldReconnect: true,
    reconnectInterval: 1000,
    onMessage(event) {
      if (typeof event.data !== "string") return;
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
