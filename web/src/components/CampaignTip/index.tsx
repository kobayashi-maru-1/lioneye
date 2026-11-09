import { gemProgressFamily } from "../../state/gem-progress";
import { gemRegex } from "../../state/gem-regex";
import {
  CAMPAIGN_TIP_STEPS,
  type OverlaySearch,
  type OverlayStep,
  overlayCampaignAtom,
} from "../../state/overlay";
import { missedQuestsAtom } from "../../state/quest-points";
import {
  activeEdgeAtom,
  routeSelector,
  stepKey,
  stepZone,
} from "../../state/route";
import { routeProgressFamily } from "../../state/route-progress";
import { stepParts } from "../../state/step-text";
import { Data, type RouteData } from "common";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { useEffect, useMemo } from "react";

/**
 * Keeps the in-game bar's Campaign tooltip up to date: the next few unfinished steps after
 * your current zone's own line, and the quest points your character missed (from your
 * latest /passives). Mounted with the app (not the guide page), so it follows zone changes
 * while you're on Settings too. Renders nothing.
 */
export function CampaignTip() {
  const route = useAtomValue(routeSelector);
  const nextStepsAtom = useMemo(() => nextSteps(route), [route]);
  const steps = useAtomValue(nextStepsAtom);
  const missed = useAtomValue(missedQuestsAtom);
  const vendorAtom = useMemo(() => vendorStop(route), [route]);
  // As JSON, so an unrelated tick doesn't send the tooltip again.
  const search = useAtomValue(vendorAtom);
  const setTip = useSetAtom(overlayCampaignAtom);
  useEffect(
    () =>
      setTip({
        steps,
        missed,
        ...(search ? { search: JSON.parse(search) as OverlaySearch } : {}),
      }),
    [steps, missed, search],
  );
  return null;
}

/** Every gem's name, for the search's unique pieces. */
const ALL_GEM_NAMES = Object.values(Data.Gems).map((gem) => gem.name);

/**
 * The Campaign tooltip's vendor search: the gems to buy at your next vendor stop. From
 * your zone on, the first unticked gem to buy and every one after it until the route
 * leaves town: a zone after the gems' that isn't a town (quest rewards are picked from
 * the reward window, so they're left out). By the steps' zones, so it works in gems-only
 * mode too, which drops the zone lines. JSON ({ text, count, total }), or "" with none.
 */
function vendorStop(route: RouteData.Route) {
  return atom((get) => {
    const active = get(activeEdgeAtom)[0];
    const isTown = (zone: number) =>
      Data.Areas[route.edges[zone]]?.is_town_area === true;
    let firstZone: number | null = null;
    const names: string[] = [];
    stops: for (const section of route.sections) {
      for (const step of section.steps) {
        const zone = stepZone(step);
        if (zone === null || zone < active) continue;
        // Past the stop: a zone after the gems' town that isn't a town.
        if (firstZone !== null)
          for (let z = firstZone + 1; z <= zone; z++)
            if (!isTown(z)) break stops;
        if (
          step.type !== "gem_step" ||
          step.rewardType !== "vendor" ||
          get(gemProgressFamily(step.requiredGem.id))
        )
          continue;
        const name = Data.Gems[step.requiredGem.id]?.name;
        if (!name) continue;
        names.push(name);
        firstZone ??= zone;
      }
    }
    if (names.length === 0) return "";
    const { regex, count, total } = gemRegex(names, ALL_GEM_NAMES);
    return count > 0 ? JSON.stringify({ text: regex, count, total }) : "";
  });
}

function nextSteps(route: RouteData.Route) {
  return atom((get) => {
    const active = get(activeEdgeAtom)[0];
    // Before your zone's line is found (a new route), start from the top.
    const hasActive = route.sections.some((section) =>
      section.steps.some(
        (step) => step.type === "fragment_step" && step.edgeIndex === active,
      ),
    );
    let started = !hasActive;
    const steps: OverlayStep[] = [];
    for (const [sectionIndex, section] of route.sections.entries()) {
      for (const [stepIndex, step] of section.steps.entries()) {
        if (!started) {
          if (step.type !== "fragment_step" || step.edgeIndex !== active)
            continue;
          started = true;
          // Your zone's own line ("➞ The Coast") is where you are, not next. The route's
          // first step is the exception: it's a task (Hillock), not a zone line.
          if (sectionIndex !== 0 || stepIndex !== 0) continue;
        }
        const done =
          step.type === "fragment_step"
            ? get(routeProgressFamily(stepKey(step)))
            : get(gemProgressFamily(step.requiredGem.id));
        if (done) continue;
        // What the bar's checkbox ticks for this step.
        const key = step.type === "fragment_step" ? stepKey(step) : "";
        const tick =
          step.type === "fragment_step"
            ? key !== ""
              ? `route:${key}`
              : undefined
            : `gem:${step.requiredGem.id}`;
        steps.push({ parts: stepParts(step), ...(tick ? { tick } : {}) });
        if (steps.length === CAMPAIGN_TIP_STEPS) return steps;
      }
    }
    return steps;
  });
}
