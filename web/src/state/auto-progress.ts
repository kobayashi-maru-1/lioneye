import { atom } from "jotai";

export type AutoProgressState =
  /** The exe isn't reachable */
  | { kind: "offline" }
  /** The exe is running but hasn't found the game */
  | { kind: "waiting" }
  /** Following this log file */
  | { kind: "watching"; path: string };

export const autoProgressAtom = atom<AutoProgressState>({ kind: "offline" });
