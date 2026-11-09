import { persistentAtom } from ".";
import type { Stats } from "../components/PobStats";
import { atom } from "jotai";

/**
 * Your live character from poe.ninja (log-api/src/ninja-character.rs): the PoB code its
 * character page shows, for Compare and Build health. Kept in sync by LiveCharacterSync.
 */
export interface LiveCharacter {
  /** poe.ninja's data version: changes each time poe.ninja re-reads the character. */
  version: number;
  name: string;
  class: string;
  level: number;
  code: string;
  /** When poe.ninja last saw it change (UTC, ISO 8601). */
  updated: string | null;
}

/** Your PoE account name ("Name#1234"), whose poe.ninja profile lists your characters. */
export const liveAccountAtom = persistentAtom<string | null>(
  "live-character-account",
  null,
  0,
);

/** A character on your poe.ninja profile, for Settings to pick from. */
export interface ListedCharacter {
  name: string;
  level: number;
  class: string;
  league: string;
  leagueUrl: string;
  /** The one you're playing now, as poe.ninja last saw. */
  current: boolean;
}

/** The characters on an account's public poe.ninja profile. */
export async function fetchLiveCharacters(account: string) {
  let response: Response;
  try {
    response = await fetch(
      `/api/ninja/characters?account=${encodeURIComponent(account)}`,
    );
  } catch {
    throw new Error("Lioneye not reached. Retry.");
  }
  if (!response.ok) {
    const text = (await response.text().catch(() => "")).trim();
    throw new Error(text ? `${text}.` : "Not loaded. Retry.");
  }
  return (await response.json()) as ListedCharacter[];
}

/** A listed character's poe.ninja page (what the live character follows). */
export function characterLink(account: string, character: ListedCharacter) {
  const name = account.trim().replace("#", "-");
  return `https://poe.ninja/poe1/profile/${name}/${character.leagueUrl}/character/${character.name}`;
}

/** Your character's poe.ninja page (Settings → Build → Live character). */
export const liveLinkAtom = persistentAtom<string | null>(
  "live-character-link",
  null,
  0,
);

/** The last character read for that link (shown at once on the next start). */
export const liveCharacterAtom = persistentAtom<LiveCharacter | null>(
  "live-character",
  null,
  0,
);

/** Reading it now, or why the last read failed. */
export const liveStatusAtom = atom<
  { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string }
>({ kind: "idle" });

/** Bumped to read the character again now (Refresh). */
export const liveRefreshAtom = atom(0);

/** PoB's numbers for the live character, for Compare and Build health. */
export type LiveStats =
  | { code: string; state: "loading" }
  | { code: string; state: "ready"; stats: Stats }
  | { code: string; state: "error" };

export const liveStatsAtom = atom<LiveStats | null>(null);

/** Compare's Build 1: your live character, or a pasted build. */
export const compareSourceAtom = persistentAtom<"live" | "code">(
  "compare-source",
  "live",
  0,
);

/** What Build health checks: your live character, or the guide's loadout. */
export const healthSourceAtom = persistentAtom<"live" | "plan">(
  "health-source",
  "live",
  0,
);

async function ask<T>(path: string, link: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${path}?link=${encodeURIComponent(link)}`);
  } catch {
    throw new Error("Lioneye not reached. Retry.");
  }
  if (!response.ok) {
    const text = (await response.text().catch(() => "")).trim();
    throw new Error(text ? `${text}.` : "Not read. Retry.");
  }
  return response.json() as Promise<T>;
}

/**
 * Signed in to poe.ninja in Lioneye's poe.ninja window (log-api/src/ninja-window.rs):
 * then Lioneye can ask poe.ninja to re-read your character. Null until asked, or when it
 * couldn't tell.
 */
export const ninjaSignedInAtom = atom<boolean | null>(null);

/**
 * You've used Sign in at least once: only then is the poe.ninja window (a hidden
 * browser) started to check, so nobody who never signs in runs it.
 */
export const ninjaSignInUsedAtom = persistentAtom<boolean>(
  "ninja-sign-in-used",
  false,
  0,
);

/** Whether you're signed in to poe.ninja there (null: couldn't tell). */
export async function fetchNinjaSignedIn(): Promise<boolean | null> {
  try {
    const response = await fetch("/api/ninja/signed-in");
    if (!response.ok) return null;
    return ((await response.json()) as { signedIn: boolean | null }).signedIn;
  } catch {
    return null;
  }
}

/** Opens the poe.ninja window on its account page, to sign in. */
export async function openNinjaSignIn() {
  try {
    const response = await fetch("/api/ninja/sign-in", { method: "POST" });
    return response.ok;
  } catch {
    return false;
  }
}

/** Asks poe.ninja (signed in) to re-read the character now. */
export async function askNinjaRefresh(
  link: string,
): Promise<"asked" | "signed-out" | "too-soon" | "failed"> {
  try {
    const response = await fetch(
      `/api/ninja/refresh?link=${encodeURIComponent(link)}`,
      { method: "POST" },
    );
    if (!response.ok) return "failed";
    return ((await response.json()) as { result: "asked" }).result;
  } catch {
    return "failed";
  }
}

/** The character's current data version on poe.ninja. */
export async function fetchLiveVersion(link: string) {
  return (await ask<{ version: number }>("/api/ninja/version", link)).version;
}

/** The character as poe.ninja has it now. */
export function fetchLiveCharacter(link: string) {
  return ask<LiveCharacter>("/api/ninja/character", link);
}
