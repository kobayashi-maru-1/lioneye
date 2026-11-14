/** The atlas data file built by `npm -w seeding run seed atlas` (seeding/src/build-atlas). */
export interface AtlasData {
  version: string;
  source: string;
  start: string;
  totalPoints: number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** Mechanic names, sorted; nodes and labels refer to them by index. */
  mechanics: string[];
  nodes: Record<string, AtlasNode>;
  edges: AtlasEdge[];
  /** A cluster's label at its mastery: one per mastery group. */
  labels: AtlasLabel[];
}

export interface AtlasNode {
  name: string;
  kind: "start" | "small" | "notable" | "keystone";
  x: number;
  y: number;
  /** Group id. */
  g: string;
  /** Mechanic index; -1 for travel nodes. */
  m: number;
  /** A travel notable or keystone's cluster: the one mechanic its neighbours have. */
  a?: number;
  stats: string[];
  reminder?: string[];
  /** A choice node's options: exactly one is picked. */
  choices?: AtlasChoice[];
  gateway?: true;
}

export interface AtlasChoice {
  effect: number;
  stats: string[];
}

export interface AtlasEdge {
  a: string;
  b: string;
  arc?: { r: number; sweep: 0 | 1 };
  /** A gateway pair: routed through, never drawn. */
  hidden?: true;
}

export interface AtlasLabel {
  x: number;
  y: number;
  m: number;
  g: string;
}

/** A plan: allocated nodes (the start is implicit), choice picks and the point budget. */
export interface Plan {
  allocated: string[];
  choices: Record<string, number>;
  budget: number;
}

export const MAX_BUDGET = 150;

/** The mechanic a node shows as: its group's, else the cluster it hangs off; -1 for travel. */
export const mechanicOf = (node: AtlasNode) =>
  node.m >= 0 ? node.m : (node.a ?? -1);
