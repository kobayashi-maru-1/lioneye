import { persistentAtom } from ".";
import type { MissedQuest } from "./quest-points";
import type { StepPart } from "./step-text";
import type { TreeTip } from "./tree/next-points";
import { atom } from "jotai";

/** Every guide panel that can have a button on the in-game bar, in page order. */
export const OVERLAY_PANELS = [
  { id: "campaign", label: "Campaign" },
  { id: "gear", label: "Gear" },
  { id: "gems", label: "Gems" },
  { id: "trade", label: "Trade" },
  { id: "config", label: "Config" },
  { id: "tree", label: "Tree" },
  { id: "health", label: "Health" },
  { id: "notes", label: "Notes" },
  { id: "search", label: "Search" },
] as const;

export interface OverlaySettings {
  on: boolean;
  /** Panel ids with a button. */
  panels: string[];
  /** NEW_PANELS already put on this bar once (untick one and it stays off). */
  added?: string[];
  /** The Tree tooltip opens with the game's passive tree; unset is on. */
  autoTree?: boolean;
}

/** Panels newer than many saved bars: each goes on a saved bar once. */
const NEW_PANELS = ["health"];

export const overlaySettingsAtom = persistentAtom<OverlaySettings>(
  "overlay",
  {
    on: true,
    panels: ["campaign", "gear", "gems", "tree", "health", "notes"],
    added: NEW_PANELS,
  },
  0,
);

/** Saved settings with the new panels they haven't had yet; the same object when none. */
export function withNewPanels(settings: OverlaySettings): OverlaySettings {
  const added = settings.added ?? [];
  const fresh = NEW_PANELS.filter((id) => !added.includes(id));
  if (fresh.length === 0) return settings;
  return {
    ...settings,
    panels: [
      ...settings.panels,
      ...fresh.filter((id) => !settings.panels.includes(id)),
    ],
    added: [...added, ...fresh],
  };
}

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
  groups: { label?: string; slot?: string; gems: OverlayGem[] }[];
  /**
   * A vendor or stash search for the set's gems still unticked on the gem list
   * (state/gem-regex.ts): `count` of `total` fit. Absent when there are none.
   */
  search?: OverlaySearch;
  /** Where the set is among the build's skill sets (the tooltip's ‹ › arrows). */
  index?: number;
  count?: number;
}

/** A gem search for the bar's copy icon (state/gem-regex.ts): `count` of `total` fit. */
export interface OverlaySearch {
  text: string;
  count: number;
  total: number;
}

/**
 * Set by the Gems panel and sent to the exe for the bar; null when the build has no gem
 * links. Undefined until the Gems panel has shown (a guide opened on Settings), so that
 * page doesn't clear the set another guide page sent.
 */
export const overlayGemsAtom = atom<OverlayGems | null | undefined>(undefined);

/**
 * Set by the Tree panel for the bar's Tree tooltip: your tree and the guide's next points
 * for the set the panel shows. Undefined until the panel has worked it out.
 */
export const overlayTreeAtom = atom<TreeTip | undefined>(undefined);

/**
 * The bar's Tree tooltip arrows, added up (+1 each ›, -1 each ‹): the Tree panel steps its
 * set by however much this moved since it last looked, so presses that arrive together
 * all count.
 */
export const treeStepAtom = atom(0);

/** The bar's Gems tooltip arrows, added up the same way, for the Gems panel's set. */
export const gemsStepAtom = atom(0);

/** How many upcoming steps the bar's Campaign tooltip shows. */
export const CAMPAIGN_TIP_STEPS = 3;

/** A step in the bar's Campaign tooltip. */
export interface OverlayStep {
  parts: StepPart[];
  /**
   * What its checkbox ticks: "route:<step key>" or "gem:<gem id>" (state/route-progress
   * tickStepAtom). Absent for a step without a key.
   */
  tick?: string;
}

/**
 * The bar's Campaign tooltip: the next unfinished route steps after your current zone,
 * and the quest points your character missed (a count on the button, the list above the
 * steps).
 */
export interface OverlayCampaign {
  steps: OverlayStep[];
  missed: MissedQuest[];
  /** The gems to buy at your next vendor stop (the copy icon). Absent with none. */
  search?: OverlaySearch;
}

/** Undefined until the guide page has worked it out. */
export const overlayCampaignAtom = atom<OverlayCampaign | undefined>(undefined);

/** An item as the in-game bar's Gear tooltip shows it: its name and PoB's mods. */
export interface OverlayItem {
  slot: string;
  name: string;
  /** The base type, when the name isn't it (rares, uniques). */
  base?: string;
  /** Its rarity's colour. */
  colour: string;
  enchant: string[];
  implicit: string[];
  /** Explicit mods; crafted ones marked. */
  explicit: { text: string; crafted?: boolean }[];
}

/** The item set the Gear panel shows, for the in-game bar's Gear tooltip. */
export interface OverlayGear {
  title: string;
  items: OverlayItem[];
}

/** A Build health finding as the in-game bar's Health tooltip shows it. */
export interface OverlayFinding {
  severity: "high" | "medium" | "low";
  message: string;
  fix?: string;
  /** A missed quest point: the bar's Campaign icon shows these, so Health's colour leaves them out. */
  campaign?: boolean;
}

/** What the Build health panel shows, for the in-game bar's Health tooltip. */
export interface OverlayHealth {
  /** "Live" or "Plan": what it checks, when a live character is set. */
  source?: string;
  /** PoB's state while it hasn't answered ("Calculating", "Health unavailable"). */
  status?: string;
  findings: OverlayFinding[];
  /** Your /passives list is missing or older than your act. */
  passivesStale: boolean;
  /** The findings are PoB's earlier answer; it's working on a new one. */
  stale?: boolean;
}

/**
 * Set by the Build health panel. Undefined until the panel has shown, so a guide opened on
 * Settings doesn't clear what another page sent.
 */
export const overlayHealthAtom = atom<OverlayHealth | undefined>(undefined);

/**
 * Set by the Gear panel; null when the build has no gear. Undefined until the Gear panel
 * has shown, so a guide opened on Settings doesn't clear what another page sent.
 */
export const overlayGearAtom = atom<OverlayGear | null | undefined>(undefined);
