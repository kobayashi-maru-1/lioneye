import React from "react";

// PoB colour codes: ^0-^9, or ^x then a hex colour. ^7 is PoB's normal text.
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

/** PoB text without its colour codes ("^2Act 1" → "Act 1"). */
export function stripPob(text: string) {
  return text.replace(COLOUR_CODE, "");
}

/** PoB text in PoB's colours. */
export function PobText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let colour: string | undefined;
  let last = 0;
  for (const match of text.matchAll(COLOUR_CODE)) {
    const start = match.index ?? 0;
    if (start > last) {
      parts.push(
        <span key={parts.length} style={{ color: colour }}>
          {text.slice(last, start)}
        </span>,
      );
    }
    const code = match[1];
    colour = code.startsWith("x") ? `#${code.slice(1)}` : DIGIT_COLOURS[code];
    last = start + match[0].length;
  }
  if (last < text.length) {
    parts.push(
      <span key={parts.length} style={{ color: colour }}>
        {text.slice(last)}
      </span>,
    );
  }
  return <>{parts}</>;
}
