import { characterLevelAtom } from "./character-level";
import { pobAtom } from "./pob";
import { pobCodeToXml } from "./pob/process";
import { atom } from "jotai";

/** `] : KobayashiSRS (Witch) is now level 8` (your class, or ascendancy once you have one). */
const LEVEL_LINE = /\] : (.+) \((\w+)\) is now level (\d+)/;

/** Each class's ascendancies, as the log names them after the Labyrinth. */
const ASCENDANCIES: Record<string, string[]> = {
  Witch: ["Necromancer", "Elementalist", "Occultist"],
  Shadow: ["Assassin", "Trickster", "Saboteur"],
  Ranger: ["Deadeye", "Raider", "Pathfinder", "Warden"],
  Duelist: ["Slayer", "Gladiator", "Champion"],
  Marauder: ["Juggernaut", "Berserker", "Chieftain"],
  Templar: ["Inquisitor", "Hierophant", "Guardian"],
  Scion: ["Ascendant", "Reliquarian"],
};

/**
 * The names your character can level up under: the imported build's class and its
 * ascendancies (you may ascend before the build says which). Null without a build (then
 * the first level-up decides).
 */
const buildClassesAtom = atom((get) => {
  const code = get(pobAtom);
  if (code === null) return null;
  try {
    const doc = new DOMParser().parseFromString(
      pobCodeToXml(code),
      "application/xml",
    );
    const className = doc
      .getElementsByTagName("Build")[0]
      ?.getAttribute("className");
    if (!className || className === "None") return null;
    return [className, ...(ASCENDANCIES[className] ?? [])];
  } catch {
    return null;
  }
});

/**
 * Takes a level-up line from the log; true when it was one. Once a level-up is taken, only
 * that character's count until the next import, so a party member never sets your level.
 */
export const levelLineAtom = atom(null, (get, set, line: string) => {
  const match = LEVEL_LINE.exec(line);
  if (!match) return false;
  const [, name, characterClass, level] = match;
  const current = get(characterLevelAtom);
  if (current !== null) {
    if (current.name !== name) return true;
  } else {
    const classes = get(buildClassesAtom);
    if (classes !== null && !classes.includes(characterClass)) return true;
  }
  set(characterLevelAtom, { level: Number(level), name });
  return true;
});
