// PoB colour codes in text (notes, set names): ^0-^9, or ^x then a hex colour. ^7 is PoB's
// normal text. No React here: the in-game bar (web/src/overlay) uses it too.

const COLOUR_CODE = /\^(x[0-9a-fA-F]{6}|[0-9])/g;
const DIGIT_COLOURS: Record<string, string | undefined> = {
  "1": "#ff5050",
  "2": "#50ff50",
  "3": "#6f6fff",
  "4": "#ffff50",
  "5": "#ff50ff",
  "6": "#50ffff",
  "8": "#808080",
  "9": "#606060",
};
const LAST_COLOUR = /\^(x[0-9a-fA-F]{6}|[0-9])(?!.*\^(x[0-9a-fA-F]{6}|[0-9]))/s;

/** PoB text without its colour codes ("^2Act 1" → "Act 1"). */
export function stripPob(text: string) {
  return text.replace(COLOUR_CODE, "");
}

/** A run of PoB text in one colour (undefined: normal text). */
export interface PobSpan {
  text: string;
  colour?: string;
}

/** PoB text split into runs by its colour codes. */
export function pobSpans(text: string): PobSpan[] {
  const spans: PobSpan[] = [];
  let colour: string | undefined;
  let last = 0;
  for (const match of text.matchAll(COLOUR_CODE)) {
    const start = match.index ?? 0;
    if (start > last) spans.push({ text: text.slice(last, start), colour });
    const code = match[1];
    colour = code.startsWith("x") ? `#${code.slice(1)}` : DIGIT_COLOURS[code];
    last = start + match[0].length;
  }
  if (last < text.length) spans.push({ text: text.slice(last), colour });
  return spans;
}

/**
 * PoB notes as lines, each starting with the colour it carries on from the lines before
 * (PoB draws the notes as one text, so a colour runs on to the following lines).
 */
export function notesLines(notes: string) {
  let colour = "";
  return notes.split(/\r?\n/).map((line) => {
    const shown = colour + line;
    colour = LAST_COLOUR.exec(line)?.[0] ?? colour;
    return shown;
  });
}
