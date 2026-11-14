import type { Plan } from "./lib/types.ts";

/** The plan with its undo and redo stacks (whole plans). */
export interface History {
  plan: Plan;
  past: Plan[];
  future: Plan[];
}

export type HistoryAction =
  { type: "apply"; plan: Plan } | { type: "undo" } | { type: "redo" };

const LIMIT = 200;

const same = (a: Plan, b: Plan) =>
  a.budget === b.budget &&
  a.allocated.length === b.allocated.length &&
  a.allocated.every((id, i) => id === b.allocated[i]) &&
  JSON.stringify(a.choices) === JSON.stringify(b.choices);

export function historyReducer(state: History, action: HistoryAction): History {
  switch (action.type) {
    case "apply":
      if (same(state.plan, action.plan)) return state;
      return {
        plan: action.plan,
        past: [...state.past, state.plan].slice(-LIMIT),
        future: [],
      };
    case "undo": {
      const previous = state.past.at(-1);
      if (!previous) return state;
      return {
        plan: previous,
        past: state.past.slice(0, -1),
        future: [state.plan, ...state.future],
      };
    }
    case "redo": {
      const [next, ...rest] = state.future;
      if (!next) return state;
      return { plan: next, past: [...state.past, state.plan], future: rest };
    }
  }
}

/** Local storage (this browser only); every access guarded, as storage can be off. */
const DRAFT_KEY = "lioneye-atlas-draft";
const SAVED_KEY = "lioneye-atlas-saved";

export interface SavedPlan {
  id: string;
  name: string;
  plan: Plan;
  /** ISO time it was saved or renamed. */
  at: string;
}

function read<T>(key: string, fallback: T): T {
  try {
    const text = localStorage.getItem(key);
    return text === null ? fallback : (JSON.parse(text) as T);
  } catch {
    return fallback;
  }
}

/** False when storage is full or off: the plan then only lives until the page closes. */
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** Stored text is untrusted (another page on this site, an older version): it goes through
 *  normalise() before use. */
export const readDraft = () => read<unknown>(DRAFT_KEY, null);
export const writeDraft = (plan: Plan) => write(DRAFT_KEY, plan);

const isPlanLike = (v: unknown): v is Plan =>
  typeof v === "object" && v !== null && Array.isArray((v as Plan).allocated);

export function readSaved(): SavedPlan[] {
  const list = read<unknown>(SAVED_KEY, []);
  return Array.isArray(list)
    ? list.filter(
        (p): p is SavedPlan =>
          typeof p === "object" &&
          p !== null &&
          typeof (p as SavedPlan).id === "string" &&
          typeof (p as SavedPlan).name === "string" &&
          isPlanLike((p as SavedPlan).plan),
      )
    : [];
}

export const writeSaved = (list: SavedPlan[]) => write(SAVED_KEY, list);

/** Clears this planner's storage (the page's Reset after a crash). */
export function clearStorage() {
  try {
    localStorage.removeItem(DRAFT_KEY);
    localStorage.removeItem(SAVED_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** Imports: a file over 1 MB or with more than 500 plans isn't read. */
export const IMPORT_MAX_BYTES = 1_000_000;
const IMPORT_MAX_PLANS = 500;

export const newId = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** The Export file: every saved plan, for another browser or Lioneye's Atlas tab. */
export const EXPORT_FORMAT = "lioneye-atlas-plans";

export function exportFile(list: SavedPlan[]) {
  return JSON.stringify(
    {
      format: EXPORT_FORMAT,
      version: 1,
      plans: list.map(({ name, plan, at }) => ({ name, plan, at })),
    },
    null,
    1,
  );
}

/** An Export file's plans (not yet normalised), or null when it isn't one. */
export function importFile(
  text: string,
): { name: string; plan: Plan }[] | null {
  try {
    const value = JSON.parse(text);
    if (value?.format !== EXPORT_FORMAT || !Array.isArray(value.plans))
      return null;
    return value.plans
      .slice(0, IMPORT_MAX_PLANS)
      .filter(
        (p: unknown) =>
          typeof p === "object" &&
          p !== null &&
          typeof (p as { name?: unknown }).name === "string" &&
          isPlanLike((p as { plan?: unknown }).plan),
      )
      .map((p: { name: string; plan: Plan }) => ({
        name: p.name.slice(0, 60),
        plan: p.plan,
      }));
  } catch {
    return null;
  }
}
