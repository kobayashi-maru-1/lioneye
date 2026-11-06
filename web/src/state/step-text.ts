import { Data, type Fragments, type RouteData } from "common";

/**
 * A piece of a route step as plain text, for places that can't show the guide's rich
 * steps (the in-game bar's Campaign tooltip). `kind` picks the colour, as in the guide.
 */
export interface StepPart {
  text: string;
  kind?:
    "area" | "enemy" | "quest" | "questText" | "waypoint" | "trial" | "gem";
}

const ARROWS = ["↑", "↗", "→", "↘", "↓", "↙", "←", "↖"];

function areaName(id: string) {
  const area = Data.Areas[id];
  return area ? area.map_name || area.name : id;
}

/** One fragment of a step as text, like the guide's Fragment component shows it. */
export function fragmentParts(fragment: Fragments.AnyFragment): StepPart[] {
  if (typeof fragment === "string") return [{ text: fragment }];
  switch (fragment.type) {
    case "kill":
      return [{ text: fragment.value, kind: "enemy" }];
    case "arena":
      return [{ text: fragment.value, kind: "area" }];
    case "area":
    case "enter":
      return [{ text: areaName(fragment.areaId), kind: "area" }];
    case "logout":
      return [
        { text: "Logout ➞ " },
        { text: areaName(fragment.areaId), kind: "area" },
      ];
    case "waypoint":
    case "waypoint_get":
      return [{ text: "Waypoint", kind: "waypoint" }];
    case "waypoint_use": {
      const dst = Data.Areas[fragment.dstAreaId];
      const src = Data.Areas[fragment.srcAreaId];
      const act =
        dst && src && dst.act !== src.act && dst.id !== "Labyrinth_Airlock"
          ? ` - Act ${dst.act}`
          : "";
      return [
        { text: "Waypoint", kind: "waypoint" },
        { text: " ➞ " },
        { text: areaName(fragment.dstAreaId), kind: "area" },
        ...(act ? [{ text: act }] : []),
      ];
    }
    case "portal_use":
      return [
        { text: "Portal", kind: "waypoint" },
        { text: " ➞ " },
        { text: areaName(fragment.dstAreaId), kind: "area" },
      ];
    case "portal_set":
      return [{ text: "Portal", kind: "waypoint" }];
    case "quest":
      return [
        { text: Data.Quests[fragment.questId]?.name ?? "", kind: "quest" },
      ];
    case "quest_text":
      return [{ text: fragment.value, kind: "questText" }];
    case "generic":
      return [{ text: fragment.value }];
    case "reward_quest":
      return [{ text: "Take " }, { text: fragment.item }];
    case "reward_vendor":
      return [{ text: "Buy " }, { text: fragment.item }];
    case "trial":
      return [{ text: "Trial of Ascendancy", kind: "trial" }];
    case "ascend":
      return [{ text: "Ascend", kind: "trial" }];
    case "crafting":
      return [{ text: `Crafting: ${fragment.crafting_recipes.join(", ")}` }];
    case "dir":
      return [{ text: ARROWS[fragment.dirIndex] ?? "" }];
    case "copy":
      return [];
  }
  return [];
}

/** A route step as text: a step's fragments, or a gem to take or buy and from whom. */
export function stepParts(step: RouteData.Step): StepPart[] {
  if (step.type === "fragment_step") return step.parts.flatMap(fragmentParts);
  const gem = Data.Gems[step.requiredGem.id];
  const quest =
    step.questId === undefined ? undefined : Data.Quests[step.questId];
  const offer =
    step.rewardOfferId === undefined
      ? undefined
      : quest?.reward_offers[step.rewardOfferId];
  const npc =
    step.rewardType === "quest"
      ? offer?.quest_npc
      : offer?.vendor[step.requiredGem.id]?.npc;
  return [
    { text: step.rewardType === "quest" ? "Take " : "Buy " },
    { text: gem?.name ?? step.requiredGem.id, kind: "gem" },
    ...(npc ? [{ text: ` · ${npc}` }] : []),
  ];
}
