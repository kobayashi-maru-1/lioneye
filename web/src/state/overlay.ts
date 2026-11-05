import { persistentAtom } from ".";
import { atom } from "jotai";

/** Every guide panel that can have a button on the in-game bar, in page order. */
export const OVERLAY_PANELS = [
  { id: "campaign", label: "Campaign" },
  { id: "gear", label: "Gear" },
  { id: "gems", label: "Gems" },
  { id: "trade", label: "Trade" },
  { id: "config", label: "Config" },
  { id: "tree", label: "Tree" },
  { id: "notes", label: "Notes" },
  { id: "search", label: "Search" },
] as const;

export interface OverlaySettings {
  on: boolean;
  /** Panel ids with a button. */
  panels: string[];
}

export const overlaySettingsAtom = persistentAtom<OverlaySettings>(
  "overlay",
  { on: true, panels: ["campaign", "gear", "gems", "tree", "notes"] },
  0,
);

/**
 * The panels the guide page last showed for this build (null before it has shown), so
 * the bar only gets buttons for panels that exist. Unlike the jump bar's list, it stays
 * set on the Settings page.
 */
export const shownPanelsAtom = atom<string[] | null>(null);
