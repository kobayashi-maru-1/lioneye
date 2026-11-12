import { atom } from "jotai";

/** The league cheat sheet, published from strats/ to GitHub Pages (strats.yml). */
export const STRATS_URL = "https://kobayashi-maru-1.github.io/lioneye/strats/";
export const STRATS_ORIGIN = new URL(STRATS_URL).origin;

export interface StratsSection {
  id: string;
  label: string;
}

/** The Strats page's sections, as the page itself lists them, for the bar's jump buttons. */
export const stratsSectionsAtom = atom<StratsSection[]>([]);

/** The section the bar asked to jump to: a new object per click, so the same one can repeat. */
export const stratsJumpAtom = atom<{ id: string } | null>(null);

const SECTION_ID = /^[A-Za-z0-9_-]{1,40}$/;

/** Keeps only well-formed entries from the framed page's list (it's another origin). */
export function readSections(value: unknown): StratsSection[] {
  if (!Array.isArray(value)) return [];
  const sections: StratsSection[] = [];
  const seen = new Set<string>();
  for (const entry of value.slice(0, 12)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, label } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !SECTION_ID.test(id) || seen.has(id))
      continue;
    if (typeof label !== "string") continue;
    const text = label.trim().slice(0, 24);
    if (text.length === 0) continue;
    seen.add(id);
    sections.push({ id, label: text });
  }
  return sections;
}
