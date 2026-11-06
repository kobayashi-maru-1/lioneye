import { persistentAtom } from ".";
import type { StepPart } from "./step-text";
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

/** A gem as the in-game bar's Gems tooltip shows it. */
export interface OverlayGem {
  name: string;
  /** Its colour (red, green, blue, white). */
  colour: string;
  /** The group's active skills; supports are indented. */
  primary: boolean;
  level?: number;
  quality?: number;
}

/** The skill set the Gems panel shows, for the in-game bar's Gems tooltip. */
export interface OverlayGems {
  title: string;
  groups: { label?: string; gems: OverlayGem[] }[];
}

/**
 * Set by the Gems panel and sent to the exe for the bar; null when the build has no gem
 * links. Undefined until the Gems panel has shown (a guide opened on Settings), so that
 * page doesn't clear the set another guide page sent.
 */
export const overlayGemsAtom = atom<OverlayGems | null | undefined>(undefined);

/** How many upcoming steps the bar's Campaign tooltip shows. */
export const CAMPAIGN_TIP_STEPS = 3;

/**
 * The next unfinished route steps after your current zone, for the bar's Campaign
 * tooltip. Undefined until the guide page has worked them out.
 */
export const overlayCampaignAtom = atom<StepPart[][] | undefined>(undefined);
