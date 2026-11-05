import { persistentAtom } from ".";

/** Your character's level, from the game log's "is now level" lines. */
export interface CharacterLevel {
  level: number;
  name: string;
}

const CHARACTER_LEVEL_VERSION = 0;

/** Null until the log shows a level-up for this build's class; cleared on import. */
export const characterLevelAtom = persistentAtom<CharacterLevel | null>(
  "character-level",
  null,
  CHARACTER_LEVEL_VERSION,
);
