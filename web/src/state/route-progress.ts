import { atom } from "jotai";
import { buildToggleState } from "./toggle-state";
import { gemProgressFamily } from "./gem-progress";
import { clearPersistent, getPersistent, NO_MIGRATORS } from "../utility";

const ROUTE_PROGRESS_VERSION = 0;
/** Campaign ticks, by step key (state/route.ts `stepKey`). */
const routeProgressFamily = buildToggleState(
  ROUTE_PROGRESS_VERSION,
  "campaign-progress",
);

/** Before 0.4.7: ticks by the step's place on the page, which gem steps moved. */
const OLD_KEY = "route-progress";

/**
 * Moves ticks saved the old way to step keys, once: the page's steps are laid out as when
 * they were ticked (same gem list), so each old place still names its step.
 */
const moveOldTicksAtom = atom(null, async (get, set) => {
  const before = localStorage.getItem(OLD_KEY);
  const old = getPersistent<string[]>(OLD_KEY, 0, NO_MIGRATORS);
  if (old === null) return;
  if (old.length > 0) {
    const { routeSelector, stepKey } = await import("./route");
    const route = await get(routeSelector);
    // The exe's copy of the guide's data was restored meanwhile (the page reloads with
    // it): leave it to that load.
    if (localStorage.getItem(OLD_KEY) !== before) return;
    const ticked = new Set(old);
    const keys: string[] = [];
    route.sections.forEach((section, sectionIndex) =>
      section.steps.forEach((step, stepIndex) => {
        if (
          step.type === "fragment_step" &&
          ticked.has(`${sectionIndex},${stepIndex}`) &&
          stepKey(step) !== ""
        )
          keys.push(stepKey(step));
      }),
    );
    if (keys.length > 0) set(routeProgressFamily.setMany, keys, true);
  }
  clearPersistent(OLD_KEY);
});

/**
 * A step ticked from the in-game bar's Campaign tooltip: "route:<step key>" or
 * "gem:<gem id>" (components/CampaignTip). Only ever ticks, never unticks.
 */
const tickStepAtom = atom(null, (_get, set, tick: string) => {
  const at = tick.indexOf(":");
  const kind = tick.slice(0, at);
  const key = tick.slice(at + 1);
  if (at < 1 || key === "") return;
  if (kind === "route") set(routeProgressFamily(key), true);
  else if (kind === "gem") set(gemProgressFamily(key), true);
});

export { routeProgressFamily, moveOldTicksAtom, tickStepAtom };
