import { RESET } from "jotai/utils";
import { gemProgressFamily } from "./gem-progress";
import type { RouteData } from "common";
import { atom } from "jotai";
import { persistentAtom } from ".";

const REQUIRED_GEMS_VERSION = 0;

const requiredGemsAtom = persistentAtom<RouteData.RequiredGem[]>(
  "required-gems",
  [],
  REQUIRED_GEMS_VERSION,
);

export const requiredGemsSelector = atom(
  (get) => {
    return get(requiredGemsAtom);
  },
  (_get, set, newValue: RouteData.RequiredGem[] | typeof RESET) => {
    set(requiredGemsAtom, newValue);

    if (newValue === RESET) {
      set(gemProgressFamily.clear);
    }
  },
);

/** The gem list's gems you haven't ticked as got, in the list's order (soonest first). */
export const gemsToGetSelector = atom((get) =>
  get(requiredGemsSelector)
    .filter((gem) => !get(gemProgressFamily(gem.id)))
    .map((gem) => gem.id),
);
