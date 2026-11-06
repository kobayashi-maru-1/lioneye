import { persistentAtom } from ".";
import { atom } from "jotai";

export type SettingsTab = "app" | "build" | "route";

/**
 * A tab a link asks Settings to open on (the guide's empty Import opens Build), used once.
 * Otherwise Settings opens on its first tab.
 */
export const settingsTabAtom = atom<SettingsTab | null>(null);

/** The Route tab's gem list: open until you fold it, then as you left it. */
export const gemListOpenAtom = persistentAtom<boolean>(
  "settings-gems-open",
  true,
  0,
);
