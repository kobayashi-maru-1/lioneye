import { persistentAtom } from ".";

/** The PoB code of the build you last compared with the guide (anyone's build). */
export const compareCodeAtom = persistentAtom<string | null>(
  "compare-code",
  null,
  0,
);
