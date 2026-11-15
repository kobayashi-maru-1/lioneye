import type { Plan } from "./lib/types.ts";

/**
 * A plan and the saved plan it was being edited as (null for a new plan). `session` groups
 * the steps since a Load or an opened link: saving moves the whole session to the save,
 * the way an editor's undo carries on in the new document after Save as.
 */
export interface Step {
  plan: Plan;
  current: string | null;
  session: number;
}

/** The plan with its undo and redo stacks (whole plans, each with its save, so undoing a
 *  Load or an opened link goes back to the save that was open). */
export interface History extends Step {
  past: Step[];
  future: Step[];
  /** The last session number handed out. */
  sessions: number;
}

export const newHistory = (
  plan: Plan,
  current: string | null,
  past: Step[] = [],
): History => {
  const sessions = past.reduce((n, s) => Math.max(n, s.session), 0) + 1;
  return { plan, current, session: sessions, past, future: [], sessions };
};

export type HistoryAction =
  /** A new plan; `current` starts a new session on that save (left out: same session). */
  | { type: "apply"; plan: Plan; current?: string | null }
  /** The open save changes without a step (saved, saved as, deleted): the session's
   *  steps move with it. */
  | { type: "current"; current: string | null }
  | { type: "undo" }
  | { type: "redo" };

const LIMIT = 200;

const same = (a: Plan, b: Plan) =>
  a.budget === b.budget &&
  a.allocated.length === b.allocated.length &&
  a.allocated.every((id, i) => id === b.allocated[i]) &&
  JSON.stringify(a.choices) === JSON.stringify(b.choices);

export function historyReducer(state: History, action: HistoryAction): History {
  const step = (): Step => ({
    plan: state.plan,
    current: state.current,
    session: state.session,
  });
  switch (action.type) {
    case "apply": {
      const fresh = action.current !== undefined;
      const current =
        action.current === undefined ? state.current : action.current;
      const session = fresh ? state.sessions + 1 : state.session;
      const sessions = Math.max(state.sessions, session);
      if (same(state.plan, action.plan))
        return current === state.current
          ? state
          : // A Load is a new action even on the same plan: Redo can't leave it.
            { ...state, current, session, sessions, future: [] };
      return {
        plan: action.plan,
        current,
        session,
        sessions,
        past: [...state.past, step()].slice(-LIMIT),
        future: [],
      };
    }
    case "current": {
      if (action.current === state.current) return state;
      const move = (s: Step) =>
        s.session === state.session ? { ...s, current: action.current } : s;
      return {
        ...state,
        current: action.current,
        past: state.past.map(move),
        future: state.future.map(move),
      };
    }
    case "undo": {
      const previous = state.past.at(-1);
      if (!previous) return state;
      return {
        ...state,
        ...previous,
        past: state.past.slice(0, -1),
        future: [step(), ...state.future],
      };
    }
    case "redo": {
      const [next, ...rest] = state.future;
      if (!next) return state;
      return { ...state, ...next, past: [...state.past, step()], future: rest };
    }
  }
}

/** Local storage (this browser only); every access guarded, as storage can be off. */
const DRAFT_KEY = "lioneye-atlas-draft";
const SAVED_KEY = "lioneye-atlas-saved";
/** The id of the saved plan being edited, so a reload stays on it. */
const CURRENT_KEY = "lioneye-atlas-current";

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

export function readCurrent(): string | null {
  const id = read<unknown>(CURRENT_KEY, null);
  return typeof id === "string" ? id : null;
}
export const writeCurrent = (id: string | null) => write(CURRENT_KEY, id);

/** Same nodes (in any order), budget and choices: a saved plan with no changes. */
export function samePlan(a: Plan, b: Plan) {
  if (a.budget !== b.budget || a.allocated.length !== b.allocated.length)
    return false;
  const nodes = new Set(a.allocated);
  if (!b.allocated.every((id) => nodes.has(id))) return false;
  const ca = Object.entries(a.choices).filter(([, v]) => v !== undefined);
  const cb = Object.entries(b.choices).filter(([, v]) => v !== undefined);
  return ca.length === cb.length && ca.every(([k, v]) => b.choices[k] === v);
}

/** Clears this planner's storage (the page's Reset after a crash). */
export function clearStorage() {
  try {
    localStorage.removeItem(DRAFT_KEY);
    localStorage.removeItem(SAVED_KEY);
    localStorage.removeItem(CURRENT_KEY);
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
