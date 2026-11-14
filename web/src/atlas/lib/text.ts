import type { AtlasNode } from "./types.ts";

/** A node kind's label. */
export const KIND: Record<AtlasNode["kind"], string> = {
  start: "Start",
  small: "Small",
  notable: "Notable",
  keystone: "Keystone",
};

/** A stat line on one line (GGG breaks some across two). */
export const flat = (line: string) => line.replace(/\s*\n\s*/g, " ");

/** Node ids in number order. */
export const byId = (a: string, b: string) => Number(a) - Number(b);
