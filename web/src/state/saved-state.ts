// The guide's browser storage (imported build, progress, layout) and the exe's copy of it
// (log-api/src/saved-state.rs). The exe opens the guide in a browser profile of its own;
// the copy lets a new or fresh profile pick up where the last one left off.
//
// Imported first in main.tsx: `startedFresh` must be read before anything is stored.

const params = new URLSearchParams(location.search);

/**
 * Which window this is, from the address the exe opened it with. "own": a window the exe
 * opened, in whichever browser Settings picks; it keeps the exe's copy of the guide's data.
 */
export const pageMode: "own" | "migrate" | "other" = params.has("migrate")
  ? "migrate"
  : params.has("own")
    ? "own"
    : "other";

/** The guide's own window ("?own"), not another browser picked in Settings ("?own=edge"). */
export const ownWindow = params.get("own") === "";

/** In a "migrate" window: the old profile it was opened in ("edge:Default"). */
export const migrateProfile = params.get("migrate") ?? "";

const RESET_KEY = "exile-leveling-reset";

/** The error page's reset: the next load starts empty instead of loading the exe's copy. */
export function markReset() {
  try {
    sessionStorage.setItem(RESET_KEY, "1");
  } catch {
    // No session storage: the reset then restores the copy, as before.
  }
}

/** True once after markReset. */
export function takeReset() {
  try {
    const reset = sessionStorage.getItem(RESET_KEY) !== null;
    sessionStorage.removeItem(RESET_KEY);
    return reset;
  } catch {
    return false;
  }
}

/**
 * The fingerprint of the exe's copy this browser last loaded or uploaded. Another browser
 * (picked in Settings) may have saved since: then this one loads the exe's copy instead of
 * sending its older data. Not part of the copy itself.
 */
const SYNCED_KEY = "exile-leveling-synced";

/** Nothing was stored when the page started: a new profile, to fill from the exe's copy. */
export const startedFresh = localStorage.length === 0;

/** A short fingerprint of the copy as sent (FNV-1a). */
export function fingerprint(json: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/** The fingerprint this browser last synced, or null (none yet). */
export function syncedFingerprint() {
  return localStorage.getItem(SYNCED_KEY);
}

/** Records the copy this browser now matches, by its fingerprint. */
export function markSyncedAs(fingerprint: string) {
  try {
    localStorage.setItem(SYNCED_KEY, fingerprint);
  } catch {
    // Storage full: the next start compares again.
  }
}

export function markSynced(json: string) {
  markSyncedAs(fingerprint(json));
}

const RESTORED_KEY = "exile-leveling-restored";

/**
 * Once per session: true the first time (and remembers it). A window that loaded the
 * exe's copy and still looks behind (its fingerprint couldn't be stored) doesn't reload again.
 */
export function firstRestore() {
  try {
    if (sessionStorage.getItem(RESTORED_KEY) !== null) return false;
    sessionStorage.setItem(RESTORED_KEY, "1");
  } catch {
    // No session storage: allow it, as before.
  }
  return true;
}

/** Everything the guide has stored, as the exe keeps it: key → stored string. */
export function storageSnapshot(): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key === null || key === SYNCED_KEY) continue;
    const value = localStorage.getItem(key);
    if (value !== null) snapshot[key] = value;
  }
  return snapshot;
}

/** Replaces storage with the exe's copy. */
export function restoreStorage(snapshot: Record<string, string>) {
  localStorage.clear();
  for (const [key, value] of Object.entries(snapshot))
    if (typeof value === "string") localStorage.setItem(key, value);
}
