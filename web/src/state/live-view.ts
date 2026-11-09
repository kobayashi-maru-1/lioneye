import { gemLinksSelector } from "./gem-links";
import { liveCharacterAtom } from "./live-character";
import { processPob } from "./pob/process";
import { urlTreesFor, urlTreesSelector } from "./tree/url-tree";
import { atom } from "jotai";
import { unwrap } from "jotai/utils";

/**
 * The guide shows your live character (the Loadout dropdown's "Live character") rather
 * than the plan's loadout: PoB's numbers, Gear, Gems and Tree. Campaign, the gem list,
 * Notes and the plan's tree progress stay on the plan. Until you pick a loadout again
 * (or the page reloads).
 */
export const liveViewAtom = atom(false);

/** Showing the live character now: picked, and one is set. */
export const viewingLiveAtom = atom(
  (get) => get(liveViewAtom) && get(liveCharacterAtom) !== null,
);

/** The live character's build as the guide reads a PoB code (gem links, trees). */
const livePobAtom = atom((get) => {
  const live = get(liveCharacterAtom);
  if (live === null) return null;
  try {
    return processPob(live.code);
  } catch {
    return null;
  }
});

/** The Gems panel's links: the live character's when viewing it, else the plan's. */
export const viewedGemLinksAtom = atom((get) =>
  get(viewingLiveAtom)
    ? (get(livePobAtom)?.gemLinks ?? [])
    : get(gemLinksSelector),
);

const viewedUrlTreesAsync = atom(async (get) =>
  get(viewingLiveAtom)
    ? urlTreesFor(get(livePobAtom)?.buildTrees ?? null)
    : get(urlTreesSelector),
);

/**
 * The Tree panel's trees: the live character's when viewing it, else the plan's.
 * Unwrapped: switching keeps the last trees while the new ones are worked out, rather than
 * suspending the page (which showed "Loading" and lost the scroll).
 */
export const viewedUrlTreesAtom = unwrap(
  viewedUrlTreesAsync,
  (previous) => previous ?? [],
);
