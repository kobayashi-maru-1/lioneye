import { persistentAtom } from ".";

/** The PoB code of the build you last compared with the guide (your character). */
export const compareCodeAtom = persistentAtom<string | null>(
  "compare-code",
  null,
  0,
);
