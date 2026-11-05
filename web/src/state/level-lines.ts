import { characterLevelAtom } from "./character-level";
import { pobAtom } from "./pob";
import { pobCodeToXml } from "./pob/process";
import { atom } from "jotai";

/** `] : KobayashiSRS (Witch) is now level 8` (your class, or ascendancy once you have one). */
const LEVEL_LINE = /\] : (.+) \((\w+)\) is now level (\d+)/;

/**
 * The imported build's class and ascendancy, to tell your level-ups from a party
 * member's. Null without a build (then every level-up counts).
 */
const buildClassesAtom = atom((get) => {
  const code = get(pobAtom);
  if (code === null) return null;
  try {
    const doc = new DOMParser().parseFromString(
      pobCodeToXml(code),
      "application/xml",
    );
    const build = doc.getElementsByTagName("Build")[0];
    const names = [
      build?.getAttribute("className"),
      build?.getAttribute("ascendClassName"),
    ].filter((name): name is string => !!name && name !== "None");
    return names.length > 0 ? names : null;
  } catch {
    return null;
  }
});

/** Takes a level-up line from the log; true when it was one. */
export const levelLineAtom = atom(null, (get, set, line: string) => {
  const match = LEVEL_LINE.exec(line);
  if (!match) return false;
  const [, name, characterClass, level] = match;
  const classes = get(buildClassesAtom);
  if (classes !== null && !classes.includes(characterClass)) return true;
  set(characterLevelAtom, { level: Number(level), name });
  return true;
});
