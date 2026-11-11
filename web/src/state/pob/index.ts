import type { RouteData } from "common";
import { persistentAtom } from "..";
import { atom } from "jotai";
import { RESET } from "jotai/utils";
import { buildDataSelector } from "../build-data";
import { requiredGemsSelector } from "../gem";
import { gemProgressFamily } from "../gem-progress";
import { buildTreesSelector } from "../tree/build-tree";
import { gemLinksSelector } from "../gem-links";
import { pobCodeToXml, processPob } from "./process";
import { readBuildFile, xmlToPobCode } from "./file";
import { toast } from "react-toastify";
import { routeProgressFamily } from "../route-progress";
import { sectionCollapseFamily } from "../section-collapse";
import { activeEdgeAtom } from "../route";
import { mainSkillPickAtom } from "../main-skill";
import { pageSectionCollapseFamily } from "../page-section-collapse";
import { characterLevelAtom } from "../character-level";

const POB_CODE_VERSION = 0;

const pobCodeAtom = persistentAtom<string | null>(
  "pob-code",
  null,
  POB_CODE_VERSION,
);

/**
 * The PoB build file the build came from (Open, or Edit on a pasted code), watched for
 * saves in PoB; null for a pasted code.
 */
const pobFileAtom = persistentAtom<string | null>("pob-file", null, 0);
export const pobFileSelector = atom((get) => get(pobFileAtom));

/**
 * Which build is loaded: changes on load and unload, not when PoB saves the same build
 * again, so the page keeps its loadout and numbers through a refresh. Stored, so another
 * guide window loading a build counts as a different build here too.
 */
const buildIdAtom = persistentAtom("pob-build-id", 0, 0);
export const buildIdSelector = atom((get) => get(buildIdAtom));

/** The build in a PoB code, or null when it can't be read (processPob throws on some). */
function readPob(code: string) {
  try {
    return processPob(code);
  } catch {
    return null;
  }
}

export interface PobData {
  buildData: RouteData.BuildData;
  requiredGems: RouteData.RequiredGem[];
  buildTrees: RouteData.BuildTree[];
  gemLinks: RouteData.GemLinkGroup[];
}

/**
 * The build's PoB code. Setting it loads a different build (`loadBuildAtom` without a
 * file); RESET unloads it. Neither touches your progress: see the reset atoms below.
 */
export const pobAtom = atom(
  (get) => get(pobCodeAtom),
  (_get, set, value: string | typeof RESET) => {
    if (value === RESET) set(unloadBuildAtom);
    else set(loadBuildAtom, value, null);
  },
);

/**
 * A different build (pasted, or opened from a file): its PoB data, and the gem list,
 * class and bandit it starts with. Progress, place and level stay. False when the code
 * isn't a build.
 */
export const loadBuildAtom = atom(
  null,
  (get, set, code: string, file: string | null) => {
    const pob = readPob(code);
    if (pob === null) return false;
    // League start and library are your choices, not the build's.
    const { leagueStart, library } = get(buildDataSelector);
    set(buildDataSelector, { ...pob.buildData, leagueStart, library });
    set(requiredGemsSelector, pob.requiredGems);
    set(buildTreesSelector, pob.buildTrees);
    set(gemLinksSelector, pob.gemLinks);
    set(pobCodeAtom, code);
    set(pobFileAtom, file);
    set(buildIdAtom, (id) => id + 1);
    // The pick is a skill of the old build.
    set(mainSkillPickAtom, RESET);
    return true;
  },
);

/**
 * The same build, saved again in PoB (its linked file changed): only what comes from PoB
 * (stats, tree, gear, links). Your gem list, class and bandit stay as they are.
 */
export const refreshBuildAtom = atom(null, (_get, set, code: string) => {
  const pob = readPob(code);
  if (pob === null) return false;
  set(buildTreesSelector, pob.buildTrees);
  set(gemLinksSelector, pob.gemLinks);
  set(pobCodeAtom, code);
  return true;
});

/**
 * Reads the linked file again (PoB saved it, or the guide just connected) and refreshes
 * the build when it changed. A file gone missing leaves the build as it is.
 */
export const refreshFromFileAtom = atom(null, async (get, set) => {
  const file = get(pobFileAtom);
  if (file === null) return;
  let xml: string;
  try {
    xml = (await readBuildFile(file)).xml;
  } catch (error) {
    console.warn(`PoB file not read: ${file}`, error);
    return;
  }
  // Linked to another file (or unloaded, or nothing loaded) while reading.
  if (get(pobFileAtom) !== file) return;
  const code = get(pobCodeAtom);
  if (code === null || sameXml(code, xml)) return;
  if (set(refreshBuildAtom, xmlToPobCode(xml))) toast.success("Build updated");
  else console.warn(`PoB file not a readable build: ${file}`);
});

function sameXml(code: string, xml: string) {
  try {
    return pobCodeToXml(code) === xml;
  } catch {
    return false;
  }
}

/** What the stored gem links hold; bumped when processPob adds to them (1: gems off). */
const GEM_LINKS_FORMAT = 1;
const gemLinksFormatAtom = persistentAtom("gem-links-format", 0, 0);

/** Gem links stored by an older Lioneye: read once more from the loaded build's code. */
export const upgradeGemLinksAtom = atom(null, (get, set) => {
  if (get(gemLinksFormatAtom) >= GEM_LINKS_FORMAT) return;
  const code = get(pobCodeAtom);
  const pob = code === null ? null : readPob(code);
  if (pob !== null) set(gemLinksSelector, pob.gemLinks);
  set(gemLinksFormatAtom, GEM_LINKS_FORMAT);
});

/** Links the loaded build to the file it was saved as (Edit on a pasted code). */
export const linkBuildFileAtom = atom(
  null,
  (get, set, file: string, code: string) => {
    // Unloaded or replaced while it was being saved: nothing to link.
    if (get(pobCodeAtom) !== code) return false;
    set(pobFileAtom, file);
    return true;
  },
);

/** No build: its code, file, tree, links and gem list go. Progress stays. */
export const unloadBuildAtom = atom(null, (_get, set) => {
  set(pobCodeAtom, RESET);
  set(pobFileAtom, null);
  set(buildIdAtom, (id) => id + 1);
  set(buildTreesSelector, RESET);
  set(gemLinksSelector, RESET);
  // An empty list, not RESET: that would clear your gem ticks too.
  set(requiredGemsSelector, []);
  set(mainSkillPickAtom, RESET);
});

/** A new run of the campaign: its ticks, your place on it and your level. */
export const resetCampaignAtom = atom(null, (_get, set) => {
  set(routeProgressFamily.clear);
  set(sectionCollapseFamily.clear);
  set(activeEdgeAtom, RESET);
  // Your level comes back from the next level-up in the log.
  set(characterLevelAtom, RESET);
  // A new campaign starts open.
  set(pageSectionCollapseFamily("campaign"), false);
});

/** The gem ticks (quest rewards and buys). */
export const resetGemsAtom = atom(null, (_get, set) => {
  set(gemProgressFamily.clear);
});
