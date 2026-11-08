import { persistentAtom } from ".";
import type { PobEditor } from "./pob/file";
import { atom } from "jotai";

export type SettingsTab = "app" | "build" | "route";

/**
 * A section a link asks Settings to open at (the guide's empty Import opens Build), used
 * once. Otherwise Settings opens at the top.
 */
export const settingsTabAtom = atom<SettingsTab | null>(null);

/** Which PoB Edit and Desktop PoB open (Settings' Editor, in Build). */
export const pobEditorAtom = persistentAtom<PobEditor>(
  "pob-editor",
  "community",
  0,
);

/** The Route section's gem list: open until you fold it, then as you left it. */
export const gemListOpenAtom = persistentAtom<boolean>(
  "settings-gems-open",
  true,
  0,
);
