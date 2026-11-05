import { persistentAtom } from ".";

/**
 * The main skill you picked on the Stats tab, remembered by skill gem so it stays
 * the same across loadouts (PoB itself keeps only a group number). Cleared on import.
 */
export interface MainSkillPick {
  /** PoB's id of the active skill, e.g. "SummonRagingSpirit". */
  id: string;
  /** Group label, group position and skill position it was picked from; break ties. */
  label?: string;
  group?: number;
  skill?: number;
  part?: string;
  minion?: string;
  minionSkill?: string;
}

const MAIN_SKILL_VERSION = 0;

export const mainSkillPickAtom = persistentAtom<MainSkillPick | null>(
  "main-skill",
  null,
  MAIN_SKILL_VERSION,
);
