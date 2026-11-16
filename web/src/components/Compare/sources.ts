// What each side of Compare is: your live character, a loadout of the imported build, a
// character from a PoE account's public poe.ninja profile, or a pasted PoB code or link.

import { persistentAtom } from "../../state";
import {
  type ListedCharacter,
  type LiveCharacter,
  fetchLiveCharacter,
  fetchLiveCharacters,
} from "../../state/live-character";

export type SourceKind = "live" | "loadout" | "account" | "pasted";

export const SOURCES: { kind: SourceKind; label: string }[] = [
  { kind: "live", label: "Live" },
  { kind: "loadout", label: "Loadout" },
  { kind: "account", label: "Account" },
  { kind: "pasted", label: "Pasted" },
];

export interface Side {
  kind: SourceKind;
  /** The build's loadout (PoB's name); null: the one it was saved on. */
  loadout: string | null;
  /** Which build the loadout was picked in (buildPrint): another build ignores it. */
  loadoutFor?: string | null;
  /** Account: "Name#1234" and the character's poe.ninja page. */
  account: string | null;
  link: string | null;
  /** Pasted: the PoB code. */
  code: string | null;
}

export const emptySide = (kind: SourceKind): Side => ({
  kind,
  loadout: null,
  loadoutFor: null,
  account: null,
  link: null,
  code: null,
});

/** The old Compare's pasted code and Build 1 choice, carried over once. */
function oldSettings(): { code: string | null; pasted: boolean } {
  const read = (key: string) => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as { value?: unknown }).value : undefined;
    } catch {
      return undefined;
    }
  };
  const code = read("compare-code");
  return {
    code: typeof code === "string" ? code : null,
    pasted: read("compare-source") === "code",
  };
}

function initialSides(): [Side, Side] {
  const old = oldSettings();
  const one = emptySide(old.pasted && old.code ? "pasted" : "live");
  one.code = old.code;
  return [one, emptySide("loadout")];
}

/** Build 1 and Build 2. */
export const compareSidesAtom = persistentAtom<[Side, Side]>(
  "compare-sides",
  initialSides(),
  0,
);

/** PoE accounts added for the Account source. */
export const compareAccountsAtom = persistentAtom<string[]>(
  "compare-accounts",
  [],
  0,
);

// Reads kept for this session: an account's characters, and a character as poe.ninja has
// it. Read again with Refresh.
const characterLists = new Map<string, Promise<ListedCharacter[]>>();
const characters = new Map<string, Promise<LiveCharacter>>();

export function listCharacters(account: string, again = false) {
  const key = account.trim().toLowerCase();
  let list = again ? undefined : characterLists.get(key);
  if (!list) {
    list = fetchLiveCharacters(account.trim());
    characterLists.set(key, list);
    list.catch(() => characterLists.delete(key));
  }
  return list;
}

export function readCharacter(link: string, again = false) {
  let character = again ? undefined : characters.get(link);
  if (!character) {
    character = fetchLiveCharacter(link);
    characters.set(link, character);
    character.catch(() => characters.delete(link));
  }
  return character;
}

/** A short fingerprint of a build's XML, to tell builds apart. */
export function buildPrint(xml: string) {
  let hash = 5381;
  for (let i = 0; i < xml.length; i++) hash = ((hash * 33) ^ xml.charCodeAt(i)) >>> 0;
  return `${xml.length}:${hash.toString(36)}`;
}

/** "KobayashiSRS · 27 Witch · Allflame" */
export const characterLabel = (character: ListedCharacter) =>
  `${character.name} · ${character.level} ${character.class} · ${character.league}`;
