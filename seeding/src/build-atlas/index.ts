import { ANGLES_16, ANGLES_40 } from "../build-tree/tree.js";
import fetch from "cross-fetch";

/**
 * The Atlas passive tree for the standalone Atlas planner (web/atlas.html): GGG's official
 * export, pinned by commit (tags can move). 3.30.0c: same tree version as 3.30.0, with two
 * new notables (27261, 53484) and the Legion cluster placed where the game draws it.
 * Only the data is read; the export's sprites and assets are never used.
 */
const ATLAS_TREE_JSON = {
  "3_30": {
    version: "3.30.0",
    source:
      "https://raw.githubusercontent.com/grindinggear/atlastree-export/24bd611b33fb727c0d1264185599fdd973d02d2d/data.json",
  },
};

interface RawNode {
  skill?: number;
  name?: string;
  stats?: string[];
  group?: number;
  orbit?: number;
  orbitIndex?: number;
  out?: string[];
  in?: string[];
  isNotable?: boolean;
  isKeystone?: boolean;
  isMastery?: boolean;
  isWormhole?: boolean;
  reminderText?: string[];
  isMultipleChoiceVariant?: boolean;
  variantEffects?: { effect: number; stats: string[] }[];
  connections?: { to: string; orbit: number; orbitX: number; orbitY: number }[];
}

interface RawData {
  nodes: Record<string, RawNode>;
  groups: Record<string, { x: number; y: number; nodes: string[] }>;
  constants: { skillsPerOrbit: number[]; orbitRadii: number[] };
  points: { totalPoints: number };
}

/** The slim file the planner loads (web/src/atlas/lib/types.ts mirrors it). */
export interface AtlasFile {
  version: string;
  source: string;
  start: string;
  totalPoints: number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** Mechanic names, sorted; nodes and labels refer to them by index. */
  mechanics: string[];
  nodes: Record<string, AtlasFileNode>;
  edges: AtlasFileEdge[];
  /** A cluster's label, at its mastery: one per mastery (group). */
  labels: { x: number; y: number; m: number; g: string }[];
}

interface AtlasFileNode {
  name: string;
  kind: "start" | "small" | "notable" | "keystone";
  x: number;
  y: number;
  /** Group id. */
  g: string;
  /** Mechanic index, -1 for travel nodes (a group without a mastery). */
  m: number;
  /** A travel notable or keystone's cluster: the one mechanic its neighbours have. */
  a?: number;
  stats: string[];
  reminder?: string[];
  /** A choice node's options: the player picks exactly one. */
  choices?: { effect: number; stats: string[] }[];
  gateway?: true;
}

interface AtlasFileEdge {
  a: string;
  b: string;
  /** An arc: radius and SVG sweep flag (the shorter way round). */
  arc?: { r: number; sweep: 0 | 1 };
  /** A gateway pair: routed through, never drawn. */
  hidden?: true;
}

/** GGG's in-game link markup to plain text: "[Thread|Threads]" → "Threads", "[Mirage]" → "Mirage". */
const plain = (line: string) =>
  line
    .replace(/\[([^\]|]+)\|([^\]]+)\]/g, "$2")
    .replace(/\[([^\]|]+)\]/g, "$1");
const plainAll = (lines: string[] | undefined) => (lines ?? []).map(plain);

const DEG = Math.PI / 180;
const round2 = (n: number) => Math.round(n * 100) / 100;

function orbitAngle(skillsPerOrbit: number, orbitIndex: number) {
  if (skillsPerOrbit === 16) return ANGLES_16[orbitIndex] * DEG;
  if (skillsPerOrbit === 40) return ANGLES_40[orbitIndex] * DEG;
  return ((Math.PI * 2) / skillsPerOrbit) * orbitIndex;
}

function position(data: RawData, node: RawNode) {
  const group = data.groups[String(node.group)];
  const orbit = node.orbit ?? 0;
  const radius = data.constants.orbitRadii[orbit];
  const angle = orbitAngle(
    data.constants.skillsPerOrbit[orbit],
    node.orbitIndex ?? 0,
  );
  return {
    x: group.x + radius * Math.sin(angle),
    y: group.y - radius * Math.cos(angle),
  };
}

/** The shorter arc from a to b around (cx, cy): SVG sweep flag 1 runs clockwise on screen. */
function sweepFlag(
  cx: number,
  cy: number,
  a: { x: number; y: number },
  b: { x: number; y: number },
): 0 | 1 {
  const angleA = Math.atan2(a.y - cy, a.x - cx);
  const angleB = Math.atan2(b.y - cy, b.x - cx);
  let delta = angleB - angleA;
  while (delta <= -Math.PI) delta += Math.PI * 2;
  while (delta > Math.PI) delta -= Math.PI * 2;
  return delta > 0 ? 1 : 0;
}

export function buildAtlas(data: RawData, version: string, source: string) {
  const startId = data.nodes.root?.out?.[0];
  if (!startId) throw new Error("atlas export: no root node");

  // A group's mechanic is the name of its (one) mastery. A group with only its mastery
  // (3.30's group 7, "The Searing Exarch") has nothing to plan: no label, not counted.
  const withPassives = new Set<string>();
  for (const [id, node] of Object.entries(data.nodes))
    if (id !== "root" && !node.isMastery && node.group !== undefined)
      withPassives.add(String(node.group));
  const masteryOf = new Map<string, RawNode>();
  for (const node of Object.values(data.nodes))
    if (
      node.isMastery &&
      node.group !== undefined &&
      withPassives.has(String(node.group))
    )
      masteryOf.set(String(node.group), node);
  const mechanics = [
    ...new Set([...masteryOf.values()].map((m) => m.name ?? "")),
  ]
    .filter((name) => name !== "")
    .sort((a, b) => a.localeCompare(b));
  const mechanicIndex = new Map(mechanics.map((name, i) => [name, i]));

  const exact = new Map<string, { x: number; y: number }>();
  const nodes: AtlasFile["nodes"] = {};
  const bounds = {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  };
  for (const [id, node] of Object.entries(data.nodes)) {
    if (id === "root" || node.isMastery || node.group === undefined) continue;
    const pos = position(data, node);
    exact.set(id, pos);
    const mastery = masteryOf.get(String(node.group));
    const kind: AtlasFileNode["kind"] =
      id === startId
        ? "start"
        : node.isKeystone
          ? "keystone"
          : node.isNotable
            ? "notable"
            : "small";
    nodes[id] = {
      name: node.name ?? "",
      kind,
      x: round2(pos.x),
      y: round2(pos.y),
      g: String(node.group),
      m: mastery ? (mechanicIndex.get(mastery.name ?? "") ?? -1) : -1,
      stats: plainAll(node.stats),
      ...(node.reminderText?.length
        ? { reminder: plainAll(node.reminderText) }
        : {}),
      ...(node.isMultipleChoiceVariant && node.variantEffects?.length
        ? {
            choices: node.variantEffects.map((v) => ({
              effect: v.effect,
              stats: plainAll(v.stats),
            })),
          }
        : {}),
      ...(node.isWormhole ? { gateway: true as const } : {}),
    };
    bounds.minX = Math.min(bounds.minX, pos.x);
    bounds.minY = Math.min(bounds.minY, pos.y);
    bounds.maxX = Math.max(bounds.maxX, pos.x);
    bounds.maxY = Math.max(bounds.maxY, pos.y);
  }

  // One undirected edge per `out` entry (root skipped, each pair once).
  const edges: AtlasFileEdge[] = [];
  const seen = new Set<string>();
  for (const [id, node] of Object.entries(data.nodes)) {
    if (!(id in nodes)) continue;
    for (const to of node.out ?? []) {
      if (!(to in nodes)) continue;
      const key = id < to ? `${id}|${to}` : `${to}|${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const other = data.nodes[to];
      const edge: AtlasFileEdge = { a: id, b: to };
      const a = exact.get(id)!;
      const b = exact.get(to)!;
      if (node.isWormhole && other.isWormhole) edge.hidden = true;
      else if (
        node.group === other.group &&
        node.orbit === other.orbit &&
        (node.orbit ?? 0) > 0
      ) {
        const group = data.groups[String(node.group)];
        edge.arc = {
          r: data.constants.orbitRadii[node.orbit ?? 0],
          sweep: sweepFlag(group.x, group.y, a, b),
        };
      } else {
        // A curved link with its own centre; drawn straight if the radii don't agree.
        const link =
          node.connections?.find((c) => c.to === to) ??
          other.connections?.find((c) => c.to === id);
        if (link) {
          const ra = Math.hypot(a.x - link.orbitX, a.y - link.orbitY);
          const rb = Math.hypot(b.x - link.orbitX, b.y - link.orbitY);
          if (Math.abs(ra - rb) / Math.max(ra, rb) < 0.02)
            edge.arc = {
              r: round2((ra + rb) / 2),
              sweep: sweepFlag(link.orbitX, link.orbitY, a, b),
            };
        }
      }
      edges.push(edge);
    }
  }

  // A notable or keystone in a group of its own (no mastery) that hangs off one cluster
  // (every neighbour with a mechanic has the same one): shown as part of that cluster.
  const neighbours = new Map<string, string[]>();
  for (const e of edges) {
    neighbours.set(e.a, [...(neighbours.get(e.a) ?? []), e.b]);
    neighbours.set(e.b, [...(neighbours.get(e.b) ?? []), e.a]);
  }
  for (const [id, node] of Object.entries(nodes)) {
    if (node.m >= 0 || (node.kind !== "notable" && node.kind !== "keystone"))
      continue;
    const near = new Set(
      (neighbours.get(id) ?? []).map((n) => nodes[n].m).filter((m) => m >= 0),
    );
    if (near.size === 1) node.a = [...near][0];
  }

  const labels: AtlasFile["labels"] = [];
  for (const [group, mastery] of masteryOf) {
    const m = mechanicIndex.get(mastery.name ?? "");
    if (m === undefined) continue; // a mastery without a name names nothing
    const pos = position(data, mastery);
    labels.push({ x: round2(pos.x), y: round2(pos.y), m, g: group });
  }

  const file: AtlasFile = {
    version,
    source,
    start: startId,
    totalPoints: data.points.totalPoints,
    bounds: {
      minX: round2(bounds.minX),
      minY: round2(bounds.minY),
      maxX: round2(bounds.maxX),
      maxY: round2(bounds.maxY),
    },
    mechanics,
    nodes,
    edges,
    labels,
  };
  return file;
}

export async function buildAtlases() {
  const result = [];
  for (const [name, { version, source }] of Object.entries(ATLAS_TREE_JSON)) {
    const response = await fetch(source);
    if (!response.ok)
      throw new Error(`atlas export: ${response.status} for ${source}`);
    const data: RawData = await response.json();
    result.push({ name, atlas: buildAtlas(data, version, source) });
  }
  return result;
}
