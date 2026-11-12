import type { ClusterNode, GearItem, TreeExtras } from "../PobStats";
import type { SkillTree } from "common";

/** Node sizes as the tree draws them (state/tree/svg.ts); a socket is notable-sized. */
const RADIUS: Record<string, number> = {
  Keystone: 75,
  Notable: 60,
  Socket: 60,
  Normal: 40,
};
const CLASS: Record<string, string> = {
  Keystone: "keystone",
  Notable: "notable",
  Socket: "notable",
  Normal: "normal",
};
/** The jewel marker: a ring just outside the socket, in the jewel's rarity colour. */
const JEWEL_MARKER_RADIUS = 95;

/** What the tree adds from PoB: SVG to put under and over it, and the extra highlights. */
export interface ExtrasDrawing {
  /** Under the tree: the jewels' radius rings. */
  under: string;
  /** Over the tree: cluster passives and their links, then the jewel markers. */
  over: string;
  nodesActive: string[];
  nodesAdded: string[];
  nodesRemoved: string[];
  connectionsActive: string[];
  connectionsAdded: string[];
  connectionsRemoved: string[];
}

/**
 * Draws PoB's extras for the shown tree. `current` and `previous` are the passives taken
 * in the shown tree and in what it's compared with (the set before, or your character);
 * cluster passives count by their ids, like the tree's own.
 */
export function drawExtras(
  extras: TreeExtras | null,
  previousExtras: TreeExtras | null,
  current: Set<string>,
  previous: Set<string>,
  nodeLookup: SkillTree.NodeLookup,
  items: Record<string, GearItem>,
  rarityColour: (rarity: string | undefined) => string,
  /** Compared with your character (from the log) rather than the set before. */
  againstCharacter: boolean,
): ExtrasDrawing {
  const drawing: ExtrasDrawing = {
    under: "",
    over: "",
    nodesActive: [],
    nodesAdded: [],
    nodesRemoved: [],
    connectionsActive: [],
    connectionsAdded: [],
    connectionsRemoved: [],
  };
  if (!extras) return drawing;

  const taken = new Set(current);
  for (const node of extras.cluster.nodes)
    if (node.alloc) taken.add(String(node.id));
  const before = new Set(previous);
  for (const node of previousExtras?.cluster.nodes ?? [])
    if (node.alloc) before.add(String(node.id));

  // Rings (Thread of Hope's has a hole: two circles, filled even-odd).
  let rings = "";
  for (const jewel of extras.jewels) {
    for (const ring of jewel.rings) {
      if (ring.inner) {
        rings += `<path d="${circlePath(ring.x, ring.y, ring.outer)} ${circlePath(ring.x, ring.y, ring.inner)}" fill-rule="evenodd"/>\n`;
      } else {
        rings += `<circle cx="${ring.x}" cy="${ring.y}" r="${ring.outer}"/>\n`;
      }
    }
  }
  if (rings) drawing.under = `<g class="rings">\n${rings}</g>\n`;

  // Cluster passives: the tree data doesn't have them; PoB placed them. The set before's
  // taken ones from a jewel this set doesn't have are drawn too, to show them removed.
  const shown = new Map<string, ClusterNode>();
  for (const node of extras.cluster.nodes) shown.set(String(node.id), node);
  for (const node of previousExtras?.cluster.nodes ?? [])
    if (node.alloc && !shown.has(String(node.id)))
      shown.set(String(node.id), node);
  // Your character: the log doesn't list cluster passives, so the taken ones show as
  // taken, neither to take nor off the guide.
  const mark = (now: boolean, then: boolean, lists: string[][], id: string) => {
    const [active, added, removed] = lists;
    if (againstCharacter) {
      if (now) active.push(id);
    } else if (now && then) active.push(id);
    else if (now) added.push(id);
    else if (then) removed.push(id);
  };
  let nodes = "";
  for (const [id, node] of shown) {
    if (nodeLookup[id] !== undefined || RADIUS[node.kind] === undefined)
      continue;
    nodes += `<circle cx="${node.x}" cy="${node.y}" id="n${id}" r="${RADIUS[node.kind]}" class="${CLASS[node.kind]}"/>\n`;
    mark(
      taken.has(id),
      before.has(id),
      [drawing.nodesActive, drawing.nodesAdded, drawing.nodesRemoved],
      id,
    );
  }
  let links = "";
  const linked = new Set<string>();
  for (const link of [
    ...extras.cluster.links,
    ...(previousExtras?.cluster.links ?? []),
  ]) {
    const a = String(link.a);
    const b = String(link.b);
    const id = `${a}-${b}`;
    if (linked.has(id)) continue;
    const from = shown.get(a) ?? nodeLookup[a];
    const to = shown.get(b) ?? nodeLookup[b];
    if (!from || !to) continue;
    linked.add(id);
    links += link.r
      ? `<path d="M ${from.x} ${from.y} A ${link.r} ${link.r} 0 0 ${link.cw ? 1 : 0} ${to.x} ${to.y}" id="c${id}"/>\n`
      : `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" id="c${id}"/>\n`;
    mark(
      taken.has(a) && taken.has(b),
      before.has(a) && before.has(b),
      [
        drawing.connectionsActive,
        drawing.connectionsAdded,
        drawing.connectionsRemoved,
      ],
      id,
    );
  }
  if (links || nodes)
    drawing.over += `<g class="connections">\n${links}</g>\n<g class="nodes">\n${nodes}</g>\n`;

  // Jewel markers, in the jewel's rarity colour.
  let markers = "";
  for (const jewel of extras.jewels) {
    const item = items[String(jewel.item)];
    if (!item) continue;
    markers += `<circle cx="${jewel.x}" cy="${jewel.y}" r="${JEWEL_MARKER_RADIUS}" style="stroke: ${rarityColour(item.rarity)}"/>\n`;
  }
  if (markers) drawing.over += `<g class="jewels">\n${markers}</g>\n`;

  return drawing;
}

/** Style for the rings and jewel markers, scoped to the tree's style id. */
export function extrasStyle(styleId: string) {
  return `
#${styleId} .rings > * {
  fill: hsla(200, 60%, 60%, 0.06);
  stroke: hsla(200, 60%, 65%, 0.35);
  stroke-width: 12;
  pointer-events: none;
}

#${styleId} .jewels > * {
  fill: none;
  stroke-width: 22;
  pointer-events: none;
}`;
}

/** A full circle as path data (two arcs), for a ring with a hole. */
function circlePath(x: number, y: number, r: number) {
  return `M ${x - r} ${y} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0 Z`;
}
