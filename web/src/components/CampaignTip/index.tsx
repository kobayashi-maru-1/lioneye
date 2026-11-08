import { gemProgressFamily } from "../../state/gem-progress";
import {
  CAMPAIGN_TIP_STEPS,
  type OverlayStep,
  overlayCampaignAtom,
} from "../../state/overlay";
import { activeEdgeAtom, routeSelector, stepKey } from "../../state/route";
import { routeProgressFamily } from "../../state/route-progress";
import { stepParts } from "../../state/step-text";
import type { RouteData } from "common";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { useEffect, useMemo } from "react";

/**
 * Keeps the in-game bar's Campaign tooltip up to date: the next few unfinished steps after
 * your current zone's own line. Mounted with the app (not the guide page), so it follows
 * zone changes while you're on Settings too. Renders nothing.
 */
export function CampaignTip() {
  const route = useAtomValue(routeSelector);
  const nextStepsAtom = useMemo(() => nextSteps(route), [route]);
  const steps = useAtomValue(nextStepsAtom);
  const setTip = useSetAtom(overlayCampaignAtom);
  useEffect(() => setTip(steps), [steps]);
  return null;
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
