import { atom } from "jotai";
import { buildDataSelector } from "./build-data";
import { configSelector } from "./config";
import { requiredGemsSelector } from "./gem";
import { routeFilesSelector } from "./route-files";
import type { RouteData } from "common";
import { persistentAtom, transientAtomFamily } from ".";
import { RESET } from "jotai/utils";
import { atomEffect, observe } from "jotai-effect";
import { gemProgressFamily } from "./gem-progress";
import { routeProgressFamily } from "./route-progress";

/**
 * The zone (edge index) a step belongs to: an enter-step belongs to the zone it enters,
 * any other step to the zone entered before it.
 */
const stepZones = new WeakMap<RouteData.Step, number>();

const baseRouteSelector = atom(async (get) => {
  const { initializeRouteState, parseRoute } = await import("common");

  const routeFiles = await get(routeFilesSelector);
  const buildData = await get(buildDataSelector);

  const routeState = initializeRouteState();

  if (buildData == null || buildData.leagueStart)
    routeState.preprocessorDefinitions.add("LEAGUE_START");

  if (buildData == null || buildData.library)
    routeState.preprocessorDefinitions.add("LIBRARY");

  const bandit = buildData?.bandit || "None";
  switch (bandit) {
    case "None":
      routeState.preprocessorDefinitions.add("BANDIT_KILL");
      break;
    case "Oak":
      routeState.preprocessorDefinitions.add("BANDIT_OAK");
      break;
    case "Kraityn":
      routeState.preprocessorDefinitions.add("BANDIT_KRAITYN");
      break;
    case "Alira":
      routeState.preprocessorDefinitions.add("BANDIT_ALIRA");
      break;
  }

  const route = parseRoute(routeFiles, routeState);
  // Record each step's zone while every step is still present (gems-only mode hides enter-steps).
  let zone = 0;
  for (const section of route.sections)
    for (const step of section.steps) {
      if (step.type === "fragment_step" && step.edgeIndex !== null)
        zone = step.edgeIndex;
      stepZones.set(step, zone);
    }
  return route;
});

export const routeSelector = atom(async (get) => {
  const { buildGemSteps, findCharacterGems, Data } = await import("common");

  const baseRoute = await get(baseRouteSelector);
  const buildData = get(buildDataSelector);
  const settings = get(configSelector);
  const requiredGems = get(requiredGemsSelector);

  if (requiredGems.length == 0) return baseRoute;

  const route: RouteData.Route = { sections: [], edges: baseRoute.edges };
  const questGems: Set<number> = new Set();
  const vendorGems: Set<number> = new Set();

  findCharacterGems(buildData, requiredGems, questGems);

  for (const baseSection of baseRoute.sections) {
    const section: RouteData.Section = {
      name: baseSection.name,
      steps: [],
    };

    for (const baseStep of baseSection.steps) {
      const gemSteps: RouteData.GemStep[] = [];
      if (baseStep.type != "fragment_step") continue;

      for (const part of baseStep.parts) {
        if (typeof part !== "string" && part.type === "quest") {
          gemSteps.push(
            ...buildGemSteps(
              part,
              buildData,
              requiredGems,
              questGems,
              vendorGems,
            ),
          );
        }
      }

      const skipStep = settings.gemsOnly && gemSteps.length === 0;
      if (!skipStep) {
        const searchString = gemSteps
          .map((x) => Data.Gems[x.requiredGem.id].name)
          .join("|");

        let step;
        if (searchString !== "") {
          step = structuredClone(baseStep);
          step.parts.push({
            type: "copy",
            text: `"${searchString}"`,
            side: "tail",
          });
        } else {
          step = baseStep;
        }

        const zone = stepZones.get(baseStep);
        if (zone !== undefined)
          for (const added of [step, ...gemSteps]) stepZones.set(added, zone);
        section.steps.push(step, ...gemSteps);
      }
    }

    if (section.steps.length > 0) route.sections.push(section);
  }

  return route;
});

const ACTIVE_EDGE_VERSION = 0;
/** How many stops ahead a zone change may move the guide (Act 1 doubles back, so the Ledge is 10 past town). */
const MAX_SKIP = 12;
/** Zones from this many recent stops are treated as walking back, not progress. */
const RECENT = 4;
const activeEdgeIndex = persistentAtom("active-edge", [0], ACTIVE_EDGE_VERSION);

export function edgeId(edgeIndex: number) {
  return `edge-${edgeIndex}`;
}

export const activeEdgeAtom = atom(
  (get) => get(activeEdgeIndex),
  async (get, set, value: string | typeof RESET) => {
    if (value === RESET) {
      set(activeEdgeIndex, RESET);
      return;
    }

    const route = await get(routeSelector);
    const edges = route.edges;
    const activeIndex = get(activeEdgeAtom)[0];
    const nextEdgeIndex = activeIndex + 1;
    const nextAreaId = edges[nextEdgeIndex];

    // Moving on ticks the zone just left, including its own "➞ zone" line.
    // Zones skipped in between stay open. Ticks are only added, never removed.
    const isTown = (edge: number) => edges[edge]?.endsWith("_town") ?? false;
    const advance = (to: number) => {
      set(activeEdgeIndex, [to]);

      // Arriving in town may be a trip to sell mid-zone, so the zone waits until
      // you leave town; leaving town then ticks it with the town (and any town before).
      // The route's final town is never left, so arriving there ticks at once.
      const zones = new Set<number>();
      if (!isTown(to) || to === edges.length - 1) {
        let edge = activeIndex;
        zones.add(edge);
        while (edge > 0 && isTown(edge)) zones.add(--edge);
      }
      const lastZone = zones.size > 0 ? Math.max(...zones) : -1;

      // A gem can have steps in several zones (quest, then vendor) sharing one flag:
      // tick it only once its last step is behind you.
      const gemLastZone = new Map<string, number>();
      for (const section of route.sections)
        for (const step of section.steps)
          if (step.type === "gem_step")
            gemLastZone.set(
              step.requiredGem.id,
              Math.max(
                gemLastZone.get(step.requiredGem.id) ?? -1,
                stepZones.get(step) ?? -1,
              ),
            );

      const routeKeys: string[] = [];
      const gemKeys: string[] = [];
      route.sections.forEach((section, sectionIndex) =>
        section.steps.forEach((step, stepIndex) => {
          const zone = stepZones.get(step);
          if (zone === undefined) return;
          if (step.type === "fragment_step") {
            // A zone's own line ("➞ The Climb") belongs to that zone: it ticks when you leave.
            if (zones.has(zone))
              routeKeys.push([sectionIndex, stepIndex].toString());
          } else if (
            zones.has(zone) &&
            (gemLastZone.get(step.requiredGem.id) ?? zone) <= lastZone
          ) {
            gemKeys.push(step.requiredGem.id);
          }
        }),
      );
      if (routeKeys.length > 0)
        set(routeProgressFamily.setMany, routeKeys, true);
      if (gemKeys.length > 0) set(gemProgressFamily.setMany, gemKeys, true);
    };

    let messageAreaId = null;
    const matches = /Generating level \d+ area "(.*?)"/.exec(value);
    if (matches !== null) {
      messageAreaId = matches[1];
    }
    if (messageAreaId === null) return;

    if (nextAreaId === messageAreaId) {
      advance(nextEdgeIndex);
      return;
    }

    // Waypoint jumps and skipped zones: move to the next visit of this zone a few stops ahead.
    // Towns and the labyrinth are visited off-route, so they only count as the very next stop.
    if (
      messageAreaId.endsWith("_town") ||
      messageAreaId === "Labyrinth_Airlock"
    )
      return;
    // Coming back into the current zone (portal, death) or walking back to a zone
    // just left (a hub like the Crossroads) isn't progress.
    const recent = edges.slice(
      Math.max(0, nextEdgeIndex - RECENT),
      nextEdgeIndex,
    );
    if (recent.includes(messageAreaId)) return;
    const ahead = edges.slice(nextEdgeIndex + 1, nextEdgeIndex + 1 + MAX_SKIP);
    const offset = ahead.indexOf(messageAreaId);
    if (offset !== -1) {
      advance(nextEdgeIndex + 1 + offset);
    }
  },
);

/** How far (in stops) a boss's step may be from where you are to tick on its death line. */
const BOSS_RANGE = 3;

/**
 * Ticks the step that kills one of `bosses` when the log says it died (state/boss-kills):
 * the open "kill" step nearest the zone you're in, within BOSS_RANGE stops, so a line that
 * also plays elsewhere (a map) ticks nothing.
 */
export const bossKillAtom = atom(null, async (get, set, bosses: string[]) => {
  const route = await get(routeSelector);
  const here = get(activeEdgeIndex)[0];
  let best: { key: string; distance: number } | null = null;
  route.sections.forEach((section, sectionIndex) =>
    section.steps.forEach((step, stepIndex) => {
      if (step.type !== "fragment_step") return;
      const kills = step.parts.some(
        (part) =>
          typeof part !== "string" &&
          part.type === "kill" &&
          bosses.includes(part.value),
      );
      if (!kills) return;
      const key = [sectionIndex, stepIndex].toString();
      if (get(routeProgressFamily(key))) return;
      const zone = stepZones.get(step);
      if (zone === undefined) return;
      const distance = Math.abs(zone - here);
      if (distance > BOSS_RANGE) return;
      if (best === null || distance < best.distance) best = { key, distance };
    }),
  );
  if (best !== null)
    set(routeProgressFamily((best as { key: string }).key), true);
});

export const nextEdgeAtom = transientAtomFamily((param: number | null) => {
  if (param === null) return atom(null, () => {});
  return atom(
    (get) => get(activeEdgeAtom)[0] + 1 == param,
    (_get, set) => {
      set(activeEdgeIndex, [param]);
    },
  );
});

/**
 * False while the page's Campaign section is off screen, so a zone change doesn't pull
 * you away from the tree or notes you jumped to.
 */
export const campaignInViewAtom = atom(true);

const scrollBehaviour = atom<ScrollBehavior | null>("instant");
export const scrollToActiveEdgeEffect = atomEffect((get, set) => {
  const behavior = get(scrollBehaviour);
  if (behavior === null) {
    return;
  }
  if (!get.peek(campaignInViewAtom)) {
    set(scrollBehaviour, null);
    return;
  }

  const edgeIndex = get.peek(activeEdgeIndex);
  const element = document.getElementById(edgeId(edgeIndex[0]));

  if (element) {
    requestAnimationFrame(() => {
      element.scrollIntoView({
        behavior: behavior,
        block: "start",
        inline: "nearest",
      });
    });

    set(scrollBehaviour, null);
  }
});

observe((get, set) => {
  const behavior = get(activeEdgeIndex)[0] === 0 ? "instant" : "smooth";
  set(scrollBehaviour, (prev) => prev ?? behavior);
});
