import { persistentAtom } from ".";

export type SettingsTab = "build" | "route" | "app";

/** The Settings tab you were on, so Settings opens there again. */
export const settingsTabAtom = persistentAtom<SettingsTab>(
  "settings-tab",
  "build",
  0,
);
