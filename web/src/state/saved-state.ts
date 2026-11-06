// The guide's browser storage (imported build, progress, layout) and the exe's copy of it
// (log-api/src/saved_state.rs). The exe opens the guide in a browser profile of its own;
// the copy lets a new or fresh profile pick up where the last one left off.
//
// Imported first in main.tsx: `startedFresh` must be read before anything is stored.

/** Which window this is, from the address the exe opened it with. */
export const pageMode: "own" | "migrate" | "other" = (() => {
  const params = new URLSearchParams(location.search);
  if (params.has("migrate")) return "migrate";
  if (params.has("own")) return "own";
  return "other";
})();

/** Nothing was stored when the page started: a new profile, to fill from the exe's copy. */
export const startedFresh = localStorage.length === 0;

/** Everything the guide has stored, as the exe keeps it: key → stored string. */
export function storageSnapshot(): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key === null) continue;
    const value = localStorage.getItem(key);
    if (value !== null) snapshot[key] = value;
  }
  return snapshot;
}

/** Fills storage from the exe's copy. */
export function restoreStorage(snapshot: Record<string, string>) {
  for (const [key, value] of Object.entries(snapshot))
    if (typeof value === "string") localStorage.setItem(key, value);
}
