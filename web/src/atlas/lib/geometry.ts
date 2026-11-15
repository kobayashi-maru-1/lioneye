import type { AtlasData } from "./types.ts";

type Kind = AtlasData["nodes"][string]["kind"];

/**
 * Circle sizes in tree units, fitted to the layout: the closest small pair is 87 apart,
 * notable–small 158, notable–notable 162, and cluster passives sit 162 from their label.
 */
export const NODE_SIZE: Record<Kind, { dot: number; ring?: number }> = {
  start: { dot: 150 },
  small: { dot: 42 },
  notable: { dot: 54, ring: 70 },
  keystone: { dot: 73, ring: 95 },
};

/** A cluster's letter badge. */
export const LABEL_RADIUS = 80;

/** The click target around a node, larger than a small node's dot. */
export const HIT_RADIUS = 60;

/** The widest circle a node always draws (its ring, else its dot). */
export function outerRadius(kind: Kind): number {
  const size = NODE_SIZE[kind];
  return size.ring ?? size.dot;
}

/** The dashed ring on an unset choice: just outside the node, clear of its label. */
export function unsetRadius(kind: Kind): number {
  return outerRadius(kind) + 8;
}

export function hitRadius(kind: Kind): number {
  return Math.max(HIT_RADIUS, outerRadius(kind));
}
