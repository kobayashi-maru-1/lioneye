// Atlas planner checks (plans/atlas-planner.md section 11). Run from the repo root after
// `npm -w seeding run seed atlas`:  npx tsx --test web/atlas-tests/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { bonuses, combine, mechanicInText } from "../src/atlas/lib/bonuses.ts";
import { ATLAS_NEW_URL, atlasTreeUrl } from "../src/state/atlas.ts";
import {
  buildGraph,
  connected,
  costs,
  emptyPlan,
  fits,
  normalise,
  refundSet,
  route,
} from "../src/atlas/lib/graph.ts";
import {
  HIT_RADIUS,
  LABEL_RADIUS,
  NODE_SIZE,
  hitRadius,
  outerRadius,
  unsetRadius,
} from "../src/atlas/lib/geometry.ts";
import {
  encodeOfficial,
  encodeShare,
  parseLink,
} from "../src/atlas/lib/links.ts";
import {
  mechanicColours,
  mechanicLetters,
  NEIGHBOUR_REACH,
  PALETTE,
} from "../src/atlas/lib/mechanics.ts";
import { kept, recalc } from "../src/atlas/lib/recalc.ts";
import {
  clusterNodes as takeClusterNodes,
  mechanicNodes,
  take,
} from "../src/atlas/lib/take.ts";
import {
  mechanicOf,
  type AtlasData,
  type Plan,
} from "../src/atlas/lib/types.ts";
import {
  exportFile,
  historyReducer,
  importFile,
  newHistory,
  nextPlanName,
  samePlan,
  type History,
} from "../src/atlas/store.ts";

const data: AtlasData = JSON.parse(
  readFileSync(
    new URL("../../common/data/atlas/3_30.json", import.meta.url),
    "utf8",
  ),
);
const graph = buildGraph(data);
const none = new Set<string>();

test("data counts", () => {
  const nodes = Object.values(data.nodes);
  assert.equal(nodes.length, 967); // 966 allocatable + the start (masteries are labels)
  assert.equal(graph.allocatable.size, 966);
  assert.equal(nodes.filter((n) => n.kind === "notable").length, 213);
  assert.equal(nodes.filter((n) => n.kind === "keystone").length, 18);
  assert.equal(nodes.filter((n) => n.choices).length, 31);
  // 149 masteries, less group 7: The Searing Exarch's mastery with no passives.
  assert.equal(data.labels.length, 148);
  assert.equal(
    data.labels.filter((l) => data.mechanics[l.m] === "The Searing Exarch")
      .length,
    1,
  );
  const groups = new Set(Object.values(data.nodes).map((n) => n.g));
  assert.ok(data.labels.every((l) => groups.has(l.g)));
  assert.equal(data.edges.length, 1050);
  assert.equal(data.edges.filter((e) => !e.hidden).length, 1048);
  assert.equal(data.mechanics.length, 38);
  assert.equal(nodes.filter((n) => n.m < 0 && n.kind !== "start").length, 173);
  assert.equal(data.start, "29045");
  assert.equal(data.totalPoints, 150);
});

test("stat text is plain and loose notables join their cluster", () => {
  const lines = Object.values(data.nodes).flatMap((n) => [
    ...n.stats,
    ...(n.reminder ?? []),
    ...(n.choices?.flatMap((c) => c.stats) ?? []),
  ]);
  assert.equal(lines.filter((l) => /\[[^\]]*\]/.test(l)).length, 0);
  assert.equal(data.mechanics[data.nodes["45404"].a!], "Betrayal");
  assert.equal(data.nodes["45404"].m, -1);
});

test("mechanic node counts", () => {
  const expected: Record<string, number> = {
    Mercenaries: 40,
    Strongboxes: 39,
    Ultimatum: 36,
    Breach: 35,
    Essence: 34,
    Ritual: 34,
    "Settlers of Kalguur": 34,
    "Rogue Exiles": 34,
    Blight: 33,
    Maps: 33,
    "Sacred Flora": 33,
    Abyss: 33,
    Expedition: 31,
    Shrines: 30,
    Legion: 29,
    Incursion: 28,
    Torment: 27,
    Bestiary: 26,
    Threads: 25,
    Betrayal: 24,
    "The Eater of Worlds": 17,
    "Atlas Memories": 14,
    "Rare Monsters": 11,
    "Unique Monsters": 11,
    "Atlas Anomalies": 10,
    "Divination Cards": 10,
    Beyond: 8,
    "Magic Monsters": 8,
    Mirage: 8,
    Delirium: 8,
    "Viridian Wildwood": 8,
    Sentinels: 8,
    Gold: 7,
    "The Searing Exarch": 6,
    Conquerors: 6,
    Synthesis: 6,
    "The Shaper and Elder": 5,
    Labyrinth: 4,
  };
  const counts: Record<string, number> = {};
  for (const n of Object.values(data.nodes))
    if (n.m >= 0)
      counts[data.mechanics[n.m]] = (counts[data.mechanics[n.m]] ?? 0) + 1;
  assert.deepEqual(counts, expected);
});

test("positions", () => {
  const near = (id: string, x: number, y: number) => {
    assert.ok(
      Math.abs(data.nodes[id].x - x) <= 0.011,
      `${id} x ${data.nodes[id].x}`,
    );
    assert.ok(
      Math.abs(data.nodes[id].y - y) <= 0.011,
      `${id} y ${data.nodes[id].y}`,
    );
  };
  near("31", -2758.59, -4383.38);
  near("121", 6374.21, -9414.46);
  near("1733", -1829.61, -11556.78);
  near("29045", 42.53, -6724.81);
});

test("routes from an empty tree", () => {
  assert.equal(route(graph, none, "45404")!.length, 13);
  const cost = costs(graph, none);
  const all = [...graph.allocatable];
  assert.ok(
    all.every((id) => cost.has(id)),
    "every node reachable",
  );
  assert.equal(Math.max(...all.map((id) => cost.get(id)!)), 21);
  // Every route's length is its cost, and it ends at the target.
  for (const id of all) {
    const path = route(graph, none, id)!;
    assert.equal(path.length, cost.get(id));
    assert.equal(path.at(-1), id);
  }
});

test("routes are stable and connected", () => {
  const a = route(graph, none, "45404")!;
  assert.deepEqual(route(graph, none, "45404"), a);
  const allocated = new Set(a);
  assert.equal(connected(graph, allocated).size, allocated.size);
  assert.deepEqual(route(graph, allocated, "45404"), []);
});

test("gateways route through their twin when cheaper", () => {
  for (const [x, y] of [
    ["17000", "13842"],
    ["2017", "54197"],
  ]) {
    const toX = new Set(route(graph, none, x)!);
    const viaTwin = route(graph, toX, y)!;
    assert.equal(viaTwin.length, 1, `${y} is one step from ${x}`);
  }
});

test("refund removes everything beyond and never disconnects", () => {
  const path = route(graph, none, "45404")!;
  const allocated = new Set(path);
  const middle = path[5];
  const removed = refundSet(graph, allocated, middle);
  assert.deepEqual([...removed].sort(), path.slice(5).sort());
  const rest = new Set([...allocated].filter((id) => !removed.has(id)));
  assert.equal(connected(graph, rest).size, rest.size);
});

test("normalise drops unknown and cut-off nodes, bad choices and budgets", () => {
  const path = route(graph, none, "45404")!;
  const plan: Plan = {
    allocated: [...path.slice(1), "99999999", data.start],
    choices: { "45404": 55878, [path[0]]: 1 },
    budget: 500,
  };
  const out = normalise(graph, data, plan);
  assert.deepEqual(out.allocated, []); // path[0] missing cuts everything off
  assert.equal(out.budget, 150);
  const full = normalise(graph, data, {
    allocated: path,
    choices: { "45404": 55878 },
    budget: 0,
  });
  assert.equal(full.allocated.length, 13);
  assert.deepEqual(full.choices, { "45404": 55878 });
  assert.equal(full.budget, 1);
  const badChoice = normalise(graph, data, {
    allocated: path,
    choices: { "45404": 1 },
    budget: 50,
  });
  assert.deepEqual(badChoice.choices, {});
});

test("normalise survives anything stored or linked", () => {
  for (const junk of [
    null,
    undefined,
    {},
    { allocated: "x" },
    { allocated: [1, null, {}], choices: null, budget: "big" },
    { choices: { __proto__: 1 } },
  ]) {
    const out = normalise(graph, data, junk as never);
    assert.deepEqual(out, { allocated: [], choices: {}, budget: 150 });
  }
});

test("a truncated official link adds no made-up choice", () => {
  // version 6, class 0, asc 0, 1 node (45404), no clusters, 1 pair but only 3 of its 4 bytes
  const bytes = [0, 0, 0, 6, 0, 0, 1, 0xb1, 0x5c, 0, 1, 0x12, 0x00, 0xab];
  const text = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const r = parseLink(
    `https://www.pathofexile.com/fullscreen-atlas-skill-tree/${text}`,
  );
  assert.ok(r.ok);
  assert.deepEqual(r.plan.choices, {});
});

test("budget blocks a route past it", () => {
  // Spend 13 points, then route to the dearest node from there: a budget one short of the
  // total blocks it, the exact total allows it.
  const first = new Set(route(graph, none, "45404")!);
  const cost = costs(graph, first);
  const target = [...graph.allocatable].sort(
    (a, b) => cost.get(b)! - cost.get(a)!,
  )[0];
  const r = route(graph, first, target)!;
  const total = first.size + r.length;
  assert.equal(fits(first.size, r.length, total), true);
  assert.equal(fits(first.size, r.length, total - 1), false);
  assert.equal(fits(29, 21, 50), true);
  assert.equal(fits(30, 21, 50), false);
});

test("share link round-trips nodes, choices and budget", () => {
  const path = route(graph, none, "45404")!;
  const plan: Plan = {
    allocated: path,
    choices: { "45404": 5301 },
    budget: 77,
  };
  const back = parseLink(
    `https://x.github.io/lioneye/atlas/#${encodeShare(plan, data.version)}`,
  );
  assert.ok(back.ok && back.kind === "share");
  const out = normalise(graph, data, back.plan);
  assert.deepEqual(
    out.allocated,
    [...path].sort((a, b) => Number(a) - Number(b)),
  );
  assert.deepEqual(out.choices, { "45404": 5301 });
  assert.equal(out.budget, 77);
});

test("undo and redo restore exact plans with choices", () => {
  const path = route(graph, none, "45404")!;
  const a: Plan = { allocated: [], choices: {}, budget: 150 };
  const b: Plan = { allocated: path, choices: {}, budget: 150 };
  const c: Plan = { allocated: path, choices: { "45404": 5301 }, budget: 150 };
  const d: Plan = { allocated: path, choices: { "45404": 5301 }, budget: 90 };
  let h: History = newHistory(a, null);
  for (const plan of [b, c, d]) h = historyReducer(h, { type: "apply", plan });
  assert.equal(historyReducer(h, { type: "apply", plan: d }), h);
  h = historyReducer(h, { type: "undo" });
  assert.deepEqual(h.plan, c);
  h = historyReducer(h, { type: "undo" });
  assert.deepEqual(h.plan, b);
  h = historyReducer(h, { type: "redo" });
  assert.deepEqual(h.plan, c);
  h = historyReducer(h, { type: "redo" });
  assert.deepEqual(h.plan, d);
  assert.equal(historyReducer(h, { type: "redo" }), h);
});

test("undo after a Load goes back to the save that was open", () => {
  const path = route(graph, none, "45404")!;
  const a: Plan = { allocated: [], choices: {}, budget: 150 };
  const b: Plan = { allocated: path, choices: {}, budget: 150 };
  let h: History = newHistory(a, "A");
  h = historyReducer(h, { type: "apply", plan: b, current: "B" });
  assert.equal(h.current, "B");
  h = historyReducer(h, { type: "undo" });
  assert.deepEqual([h.plan, h.current], [a, "A"]);
  h = historyReducer(h, { type: "redo" });
  assert.deepEqual([h.plan, h.current], [b, "B"]);
  // An edit keeps the open save; switching saves on the same plan adds no step.
  h = historyReducer(h, { type: "apply", plan: a });
  assert.equal(h.current, "B");
  const steps = h.past.length;
  h = historyReducer(h, { type: "apply", plan: b });
  h = historyReducer(h, { type: "undo" });
  h = historyReducer(h, { type: "apply", plan: a, current: "C" });
  assert.deepEqual(
    [h.current, h.past.length, h.future.length],
    ["C", steps, 0],
  );
  h = historyReducer(h, { type: "current", current: null });
  assert.deepEqual([h.current, h.past.length], [null, steps]);
});

test("saving moves the session's steps to the save, not earlier sessions", () => {
  const path = route(graph, none, "45404")!;
  const p = (n: number): Plan => ({
    allocated: path.slice(0, n),
    choices: {},
    budget: 150,
  });
  let h: History = newHistory(p(0), "A");
  h = historyReducer(h, { type: "apply", plan: p(1) }); // edit A
  h = historyReducer(h, { type: "apply", plan: p(2), current: null }); // open a link
  h = historyReducer(h, { type: "apply", plan: p(3) }); // edit it
  h = historyReducer(h, { type: "current", current: "B" }); // save it as B
  h = historyReducer(h, { type: "undo" });
  assert.deepEqual([h.plan, h.current], [p(2), "B"]);
  h = historyReducer(h, { type: "undo" });
  assert.deepEqual([h.plan, h.current], [p(1), "A"]);
  h = historyReducer(h, { type: "redo" });
  h = historyReducer(h, { type: "redo" });
  assert.deepEqual([h.plan, h.current], [p(3), "B"]);
});

test("Export then Import restores saved plans", () => {
  const path = route(graph, none, "45404")!;
  const list = [
    {
      id: "x1",
      name: "Maps",
      plan: { allocated: path, choices: { "45404": 5301 }, budget: 120 },
      at: "2026-11-14T00:00:00.000Z",
    },
    {
      id: "x2",
      name: "Empty",
      plan: { allocated: [], choices: {}, budget: 150 },
      at: "2026-11-14T00:00:00.000Z",
    },
  ];
  const back = importFile(exportFile(list));
  assert.deepEqual(
    back,
    list.map(({ name, plan }) => ({ name, plan })),
  );
  assert.equal(importFile("{}"), null);
  assert.equal(importFile("not json"), null);
});

test("official link decodes and re-encodes", () => {
  const link =
    "https://www.pathofexile.com/fullscreen-atlas-skill-tree/AAAABgAAEQmdLrszg0GMW9lqJH0dkX2xXLH7xgzJqtdN4cHuzPJN-toAAA==";
  const ids = [
    2461, 11963, 13187, 16780, 23513, 27172, 32029, 37245, 45404, 45563, 50700,
    51626, 55117, 57793, 61132, 62029, 64218,
  ].map(String);
  const back = parseLink(link);
  assert.ok(back.ok && back.kind === "official");
  assert.deepEqual(back.plan.allocated, ids);
  assert.equal(encodeOfficial(ids), link);
});

test("an opened official link leaves its choice node unset until picked", () => {
  const back = parseLink(
    "https://www.pathofexile.com/fullscreen-atlas-skill-tree/AAAABgAAEQmdLrszg0GMW9lqJH0dkX2xXLH7xgzJqtdN4cHuzPJN-toAAA==",
  );
  assert.ok(back.ok);
  const plan = normalise(graph, data, back.plan);
  assert.equal(plan.allocated.length, 17);
  const b = bonuses(data, plan);
  assert.deepEqual(b.unset, [{ id: "45404", name: "Secrets Unveiled" }]);
  const picked = bonuses(data, { ...plan, choices: { "45404": 5301 } });
  assert.deepEqual(picked.unset, []);
});

test("Share's official link re-opens to the same nodes", () => {
  const path = route(graph, none, "45404")!;
  const more = route(graph, new Set(path), "64218") ?? [];
  const ids = [...path, ...more];
  const back = parseLink(encodeOfficial(ids));
  assert.ok(back.ok && back.kind === "official");
  assert.deepEqual(
    normalise(graph, data, back.plan).allocated,
    [...new Set(ids)].sort((a, b) => Number(a) - Number(b)),
  );
});

// The League page's three trees as poeatlasplanner links (its cards until Nov 2026).
const plannerLinks = readFileSync(
  new URL("./poeatlasplanner-links.txt", import.meta.url),
  "utf8",
)
  .split(/\r?\n/)
  .filter(Boolean);

test("poeatlasplanner links open with their point counts", () => {
  assert.equal(plannerLinks.length, 3);
  const points = plannerLinks.map((l) => {
    const r = parseLink(l);
    assert.ok(r.ok && r.kind === "planner");
    return normalise(graph, data, r.plan).allocated.length;
  });
  assert.deepEqual(points, [64, 150, 109]);
});

test("other text is not a link", () => {
  for (const s of [
    "",
    "hello",
    "https://example.com/#x=1",
    "#t=@@@",
    "#p=bm90IGpzb24",
  ])
    assert.equal(parseLink(s).ok, false, s);
});

test("bonuses sum identical lines", () => {
  const lines = combine([
    { line: "2% increased Maps found in your Maps", node: "1" },
    { line: "2% increased Maps found in your Maps", node: "2" },
    { line: "3% increased Maps found in your Maps", node: "3" },
    { line: "Maps have 1 to 2 extra things", node: "4" },
    { line: "Maps have 1 to 2 extra things", node: "5" },
    {
      line: "Tier 1-15 Maps found have 5% chance to become 1 tier higher",
      node: "6",
    },
    {
      line: "Tier 1-15 Maps found have 5% chance to become 1 tier higher",
      node: "7",
    },
  ]);
  assert.deepEqual(
    lines.map((l) => [l.text, l.count, l.nodes.length]),
    [
      ["7% increased Maps found in your Maps", 1, 3],
      ["Maps have 1 to 2 extra things", 2, 2],
      ["Tier 1-15 Maps found have 10% chance to become 1 tier higher", 1, 2],
    ],
  );
});

test("bonuses: a chosen effect shows once, under its mechanic", () => {
  const path = route(graph, none, "45404")!;
  const b = bonuses(data, {
    allocated: path,
    choices: { "45404": 5301 },
    budget: 150,
  });
  const all = b.groups.flatMap((g) =>
    g.lines.map((l) => ({ m: g.mechanic, text: l.text })),
  );
  const chosen = all.filter((l) => l.text.startsWith("Secrets Unveiled: "));
  assert.equal(chosen.length, 1);
  assert.ok(chosen[0].text.includes("Allflames"));
  assert.equal(data.mechanics[chosen[0].m], "Betrayal");
});

test("bonuses: travel lines go to the mechanic they name", () => {
  const sixMaps = Object.entries(data.nodes)
    .filter(
      ([, n]) =>
        n.m < 0 &&
        n.a === undefined &&
        n.stats.length === 1 &&
        n.stats[0] === "2% increased Maps found in your Maps",
    )
    .map(([id]) => id)
    .slice(0, 6);
  assert.equal(sixMaps.length, 6);
  const b = bonuses(data, { allocated: sixMaps, choices: {}, budget: 150 });
  assert.equal(b.groups.length, 1);
  assert.equal(data.mechanics[b.groups[0].mechanic], "Maps");
  assert.deepEqual(
    b.groups[0].lines.map((l) => l.text),
    ["12% increased Maps found in your Maps"],
  );
  const names = data.mechanics;
  const is = (line: string, name: string | null) =>
    assert.equal(
      mechanicInText(line, names),
      name === null ? -1 : names.indexOf(name),
      line,
    );
  is("3% increased Threads found in your Maps", "Threads");
  is("3% increased number of Magic Monsters in your Maps", "Magic Monsters");
  is("You can only apply one type of Thread to your Maps", "Threads");
  is(
    "75% chance for Threads found in your Maps to be converted to Gold",
    "Threads",
  );
  is(
    "Divination Cards found in your Maps are from two random other Maps",
    "Divination Cards",
  );
  is(
    "50% chance to spawn a Searing Exarch Altar when the Influence of The Searing Exarch first appears in your Maps",
    "The Searing Exarch",
  );
  is("Breach Encounters in your Maps are always", "Breach");
  is("Sacred Fauna in your Maps have 50% more Life", "Sacred Flora");
  is(
    "If there are fewer than 50 monsters remaining in your Maps, Final Map Bosses are Empowered by Wildwood Wisps",
    "Viridian Wildwood",
  );
  is("Red Beasts in your Maps have 10% chance to be Rare", "Bestiary");
  is("Tormented Spirits in your Maps have 25% more Life", "Torment");
  is("certain Essences in your Maps are corrupted", "Essence");
  is("1% increased Pack Size in your Maps", null);
  is(
    "Defeating a Map Boss while Witnessed by The Maven has 1% chance to count as also Witnessing an additional random Map Boss",
    null,
  );
});

test("colours: neighbouring clusters differ; letters are unique", () => {
  const colours = mechanicColours(data);
  let pairs = 0;
  for (const p of data.labels)
    for (const q of data.labels)
      if (p.m !== q.m && Math.hypot(p.x - q.x, p.y - q.y) < NEIGHBOUR_REACH) {
        pairs++;
        assert.notEqual(
          colours[p.m],
          colours[q.m],
          `${data.mechanics[p.m]} / ${data.mechanics[q.m]}`,
        );
      }
  assert.ok(pairs > 100);
  // Every cluster's nearest other cluster is well inside the reach.
  for (const p of data.labels) {
    const nearest = Math.min(
      ...data.labels
        .filter((q) => q.m !== p.m)
        .map((q) => Math.hypot(p.x - q.x, p.y - q.y)),
    );
    assert.ok(nearest < NEIGHBOUR_REACH / 2);
  }
  assert.ok(new Set(colours).size <= PALETTE.length);
  const letters = mechanicLetters(data.mechanics);
  assert.equal(new Set(letters).size, letters.length, letters.join(" "));
});

test("no node circle meets another node or a label disc", () => {
  const nodes = Object.entries(data.nodes);
  const clashes: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const [aId, a] = nodes[i];
    // A choice node can show its unset ring, so it needs that much room.
    const aR = a.choices ? unsetRadius(a.kind) : outerRadius(a.kind);
    for (let j = i + 1; j < nodes.length; j++) {
      const [bId, b] = nodes[j];
      const bR = b.choices ? unsetRadius(b.kind) : outerRadius(b.kind);
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < aR + bR) clashes.push(`${aId}/${bId} ${d.toFixed(0)}`);
    }
    for (const label of data.labels) {
      const d = Math.hypot(a.x - label.x, a.y - label.y);
      if (d < aR + LABEL_RADIUS) clashes.push(`${aId}/label ${label.g}`);
    }
  }
  assert.deepEqual(clashes, []);
});

test("click targets are larger than small dots and clear of labels", () => {
  assert.ok(HIT_RADIUS > NODE_SIZE.small.dot);
  for (const [id, node] of Object.entries(data.nodes)) {
    for (const label of data.labels)
      assert.ok(
        Math.hypot(node.x - label.x, node.y - label.y) >
          hitRadius(node.kind) + LABEL_RADIUS,
        `${id}/label ${label.g}`,
      );
  }
});

test("samePlan: node order doesn't matter; budget, nodes and choices do", () => {
  const base: Plan = { budget: 100, allocated: ["1", "2", "3"], choices: {} };
  assert.ok(samePlan(base, { ...base, allocated: ["3", "1", "2"] }));
  assert.ok(!samePlan(base, { ...base, budget: 99 }));
  assert.ok(!samePlan(base, { ...base, allocated: ["1", "2", "4"] }));
  assert.ok(!samePlan(base, { ...base, allocated: ["1", "2"] }));
  const chosen = { ...base, choices: { "2": 7 } };
  assert.ok(!samePlan(base, chosen));
  assert.ok(!samePlan(chosen, { ...base, choices: { "2": 8 } }));
  assert.ok(samePlan(chosen, { ...chosen, choices: { "2": 7 } }));
});

test("bonuses leave gateways out", () => {
  const gateways = Object.entries(data.nodes).filter(([, n]) => n.gateway);
  assert.ok(gateways.length > 0);
  const [gate] = gateways[0];
  const path = route(graph, none, gate);
  assert.ok(path?.includes(gate));
  const b = bonuses(data, {
    allocated: path,
    choices: {},
    budget: 150,
  });
  for (const group of b.groups)
    for (const line of group.lines) {
      assert.ok(!/^Connects to /.test(line.text), line.text);
      assert.ok(!line.nodes.includes(gate));
    }
});

test("a new plan's default name is the first free Plan number", () => {
  assert.equal(nextPlanName([]), "Plan 1");
  assert.equal(nextPlanName([{ name: "Draft Nov 15, 05:28 AM" }]), "Plan 1");
  assert.equal(
    nextPlanName([{ name: "Plan 1" }, { name: "Plan 3" }]),
    "Plan 2",
  );
  assert.equal(
    nextPlanName([{ name: "Plan 2" }, { name: "Plan 1" }]),
    "Plan 3",
  );
});

// Recalc. A plan built the slow way: each target routed from the plan so far, in order.
function routedPlan(targets: string[]): Plan {
  const allocated = new Set<string>();
  for (const t of targets)
    for (const id of route(graph, allocated, t) ?? []) allocated.add(id);
  return { allocated: [...allocated], choices: {}, budget: 150 };
}

/** The fewest points joining every kept node to the start, found for sure (Dreyfus-Wagner
 *  over the kept parts; for checking Recalc on small plans only). */
function exactPoints(keep: Set<string>): number {
  const parts: Set<string>[] = [];
  const seen = new Set<string>();
  for (const id of [data.start, ...keep]) {
    if (seen.has(id)) continue;
    const part = new Set([id]);
    const queue = [id];
    for (let h = 0; h < queue.length; h++)
      for (const n of graph.neighbours.get(queue[h])!)
        if (keep.has(n) && !part.has(n)) (part.add(n), queue.push(n));
    part.forEach((n) => seen.add(n));
    parts.push(part);
  }
  const ids = [...graph.neighbours.keys()];
  const w = (id: string) => (keep.has(id) || id === data.start ? 0 : 1);
  const k = parts.length;
  const dp: Map<string, number>[] = [];
  const relax = (m: Map<string, number>) => {
    // Dijkstra with 0/1 node weights, as a bucket queue.
    const buckets: string[][] = [];
    for (const [id, d] of m) (buckets[d] ??= []).push(id);
    for (let d = 0; d < buckets.length; d++)
      for (const id of buckets[d] ?? []) {
        if (m.get(id)! < d) continue;
        for (const n of graph.neighbours.get(id)!) {
          const nd = d + w(n);
          if (nd < (m.get(n) ?? Infinity)) {
            m.set(n, nd);
            (buckets[nd] ??= []).push(n);
          }
        }
      }
  };
  for (let i = 0; i < k; i++) {
    const m = new Map<string, number>();
    for (const id of parts[i]) m.set(id, 0);
    relax(m);
    dp[1 << i] = m;
  }
  for (let mask = 1; mask < 1 << k; mask++) {
    if ((mask & (mask - 1)) === 0) continue;
    const m = new Map<string, number>();
    for (let sub = (mask - 1) & mask; sub > 0; sub = (sub - 1) & mask) {
      if (sub < (mask ^ sub)) continue;
      const a = dp[sub];
      const b = dp[mask ^ sub];
      for (const id of ids) {
        const v = a.get(id)! + b.get(id)! - w(id);
        if (v < (m.get(id) ?? Infinity)) m.set(id, v);
      }
    }
    relax(m);
    dp[mask] = m;
  }
  return keep.size + dp[(1 << k) - 1].get(data.start)!;
}

const clusterNodes = Object.entries(data.nodes)
  .filter(([id, n]) => n.m >= 0 && id !== data.start)
  .map(([id]) => id)
  .sort((a, b) => Number(a) - Number(b));
function pick(seed: number, count: number) {
  let s = seed;
  const next = () => (s = (s * 1103515245 + 12345) % 2147483648);
  return Array.from(
    { length: count },
    () => clusterNodes[next() % clusterNodes.length],
  );
}
const travelSmall = Object.entries(data.nodes)
  .filter(
    ([, n]) => n.m < 0 && n.a === undefined && n.kind === "small" && !n.choices,
  )
  .map(([id]) => id)
  .sort((a, b) => Number(a) - Number(b));
/** A plan with real waste: targets reached by way of pathing nodes (not kept), plus a few
 *  pathing nodes added next to the plan (spurs and loops). */
function wastefulPlan(
  seed: number,
  targets: number,
  detours: number,
  extra: number,
) {
  let s = seed;
  const next = () => (s = (s * 1103515245 + 12345) % 2147483648);
  const order: string[] = [];
  for (let i = 0; i < Math.max(targets, detours); i++) {
    if (i < detours) order.push(travelSmall[next() % travelSmall.length]);
    if (i < targets) order.push(clusterNodes[next() % clusterNodes.length]);
  }
  const plan = routedPlan(order);
  const set = new Set(plan.allocated);
  for (let i = 0; i < extra; i++) {
    const edge = [...set]
      .flatMap((id) => graph.neighbours.get(id)!)
      .filter(
        (n) => !set.has(n) && n !== data.start && travelSmall.includes(n),
      );
    if (edge.length) set.add(edge[next() % edge.length]);
  }
  return { ...plan, allocated: [...set] };
}
function checkRecalc(before: Plan) {
  const after = recalc(graph, data, before);
  const keep = kept(data, before);
  const set = new Set(after.allocated);
  assert.equal(set.size, after.allocated.length, "no duplicates");
  assert.ok(!set.has(data.start), "the start isn't allocated");
  assert.ok(
    [...keep].every((id) => set.has(id)),
    "keeps every kept node",
  );
  assert.equal(connected(graph, set).size, set.size, "joined to the start");
  assert.ok(after.allocated.length <= before.allocated.length, "never more");
  return after;
}

test("recalc: kept nodes are cluster nodes, notables, keystones and choice nodes", () => {
  const travelSmall = Object.entries(data.nodes).find(
    ([, n]) => n.m < 0 && n.a === undefined && n.kind === "small" && !n.choices,
  )![0];
  const travelKeystone = Object.entries(data.nodes).find(
    ([, n]) => n.m < 0 && n.kind === "keystone",
  )![0];
  const travelChoice = Object.entries(data.nodes).find(
    ([, n]) => n.m < 0 && n.choices,
  )![0];
  const keep = kept(data, {
    allocated: [travelSmall, travelKeystone, travelChoice, clusterNodes[0]],
    choices: {},
    budget: 150,
  });
  assert.deepEqual(
    [...keep].sort(),
    [travelKeystone, travelChoice, clusterNodes[0]].sort(),
  );
});

test("recalc removes detours, spurs and loops, matching the exact answer", () => {
  let changed = 0;
  let misses = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const plan = wastefulPlan(seed, 1 + (seed % 3), 1 + (seed % 2), seed % 4);
    const keep = kept(data, plan);
    const after = checkRecalc(plan);
    const exact = exactPoints(keep);
    // The search may miss the best by a point on rare plans; never by more, never below.
    assert.ok(after.allocated.length >= exact, `seed ${seed} below exact`);
    assert.ok(after.allocated.length <= exact + 1, `seed ${seed}`);
    if (after.allocated.length > exact) misses += 1;
    if (after.allocated.length < plan.allocated.length) changed += 1;
  }
  assert.ok(misses <= 2, `${misses} misses`);
  assert.ok(changed >= 40, `only ${changed} of 60 plans changed`);
});

test("recalc: plans with nothing to remove come back as they are", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const plan = routedPlan(pick(seed, 1));
    assert.strictEqual(recalc(graph, data, plan), plan, `seed ${seed}`);
  }
});

test("recalc: big plans stay valid, fast and stable", () => {
  for (const seed of [11, 12, 13]) {
    const plan = routedPlan(pick(seed, 24));
    const t0 = performance.now();
    const after = checkRecalc(plan);
    const ms = performance.now() - t0;
    assert.ok(ms < 2000, `${Math.round(ms)} ms`);
    assert.deepEqual(
      recalc(graph, data, plan),
      after,
      "same plan, same result",
    );
    assert.equal(
      recalc(graph, data, after).allocated.length,
      after.allocated.length,
      "a second Recalc finds nothing more",
    );
    console.log(
      `recalc seed ${seed}: ${plan.allocated.length} -> ${after.allocated.length} points in ${Math.round(ms)} ms`,
    );
  }
});

test("recalc keeps choices, and hardens loose input", () => {
  const choice = Object.entries(data.nodes).find(
    ([, n]) => n.choices && n.m >= 0,
  )!;
  const plan = routedPlan([travelSmall[40], choice[0]]);
  plan.choices = { [choice[0]]: choice[1].choices![0].effect };
  const after = checkRecalc(plan);
  assert.ok(after.allocated.length < plan.allocated.length, "the detour went");
  assert.deepEqual(after.choices, plan.choices);
  // Not normalised: a kept node off on its own is joined, never dropped; the start is
  // never counted.
  const stray = clusterNodes.find((id) => route(graph, none, id)!.length > 12)!;
  const loose = routedPlan([clusterNodes[3]]);
  const withStray = {
    ...loose,
    allocated: [...loose.allocated, stray, data.start],
  };
  const fixed = recalc(graph, data, withStray);
  assert.ok(fixed.allocated.includes(stray));
  assert.ok(!fixed.allocated.includes(data.start));
  assert.equal(
    connected(graph, new Set(fixed.allocated)).size,
    fixed.allocated.length,
  );
});

test("Atlas tab: tree links open in New, fragment only", () => {
  const ours =
    "https://kobayashi-maru-1.github.io/lioneye/atlas/#t=WzEsIjMuMzAuMCJd";
  assert.equal(atlasTreeUrl(ours), ours);
  // Atlas Route links move onto New's address.
  assert.equal(
    atlasTreeUrl("https://poeatlasplanner.com/#p=WzEsIjMuMzAuMCJd"),
    `${ATLAS_NEW_URL}#p=WzEsIjMuMzAuMCJd`,
  );
  // Plain base64 too, which New's Open reads as well.
  assert.equal(
    atlasTreeUrl("https://poeatlasplanner.com/#p=ab+c/d=="),
    `${ATLAS_NEW_URL}#p=ab+c/d==`,
  );
  // Credentials, queries and other paths never reach the frame.
  assert.equal(
    atlasTreeUrl("https://a:b@poeatlasplanner.com/x?y=1#p=abc"),
    `${ATLAS_NEW_URL}#p=abc`,
  );
  for (const bad of [
    null,
    42,
    "",
    "not a url",
    "http://poeatlasplanner.com/#p=abc",
    "https://kobayashi-maru-1.github.io/lioneye/strats/#t=abc",
    "https://kobayashi-maru-1.github.io.evil.example/lioneye/atlas/#t=abc",
    "https://poeatlasplanner.com/",
    "https://poeatlasplanner.com/#p=abc&x=<script>",
    "https://poeatlasplanner.com/#q=abc",
    "https://www.pathofexile.com/fullscreen-atlas-skill-tree/AAAABgAA",
  ])
    assert.equal(atlasTreeUrl(bad), null, String(bad));
});

test("League page: tree links open in New with their point counts", () => {
  const page = readFileSync(
    new URL("../../strats/index.html", import.meta.url),
    "utf8",
  );
  const section = page.slice(
    page.indexOf('id="atlas-trees"'),
    page.indexOf("</section>", page.indexOf('id="atlas-trees"')),
  );
  const cards = [
    ...section.matchAll(
      /<a class="t" href="([^"]+)"[^>]*>([^<]+)<\/a>.*?(\d+) points/g,
    ),
  ];
  assert.equal(cards.length, 3);
  cards.forEach(([, href, title, points], i) => {
    const url = atlasTreeUrl(href);
    assert.ok(url, title);
    const link = parseLink(new URL(url).hash);
    assert.ok(link.ok && link.kind === "share", title);
    const plan = normalise(graph, data, link.plan);
    assert.equal(plan.allocated.length, Number(points), title);
    assert.equal(plan.allocated.length, link.plan.allocated.length, title);
    // The same tree as the poeatlasplanner link it replaced: nodes, choices, budget.
    const before = parseLink(plannerLinks[i]);
    assert.ok(before.ok);
    assert.deepEqual(plan, normalise(graph, data, before.plan), title);
  });
});

test("take: a whole mechanic, cheapest, one step; again refunds it", () => {
  const breach = data.mechanics.indexOf("Breach");
  const targets = mechanicNodes(data, breach);
  assert.equal(targets.length, 35);
  const empty: Plan = { allocated: [], choices: {}, budget: 150 };
  const r = take(graph, data, empty, targets, 150);
  assert.ok(r.kind === "allocate");
  const got = new Set(r.plan.allocated);
  assert.ok(targets.every((id) => got.has(id)));
  assert.equal(r.points, r.plan.allocated.length);
  assert.equal(connected(graph, got).size, got.size, "joined to the start");
  assert.equal(new Set(r.plan.allocated).size, r.plan.allocated.length);
  // No worse than allocating its nodes one by one (the click route).
  assert.ok(r.points <= routedPlan(targets).allocated.length);
  // Close to what Recalc (a search over many joins) finds for the same nodes.
  const best = recalc(graph, data, r.plan).allocated.length;
  assert.ok(r.points <= best + 3, `${r.points} vs ${best}`);
  // Again: refunded, with the paths only it needed.
  const back = take(graph, data, r.plan, targets, 150);
  assert.ok(back.kind === "refund");
  assert.deepEqual(back.plan.allocated, []);
  assert.equal(back.points, r.points);
});

test("take: over budget allocates nothing and says the cost", () => {
  const breach = data.mechanics.indexOf("Breach");
  const targets = mechanicNodes(data, breach);
  const plan: Plan = { allocated: [], choices: {}, budget: 20 };
  const r = take(graph, data, plan, targets, 20);
  assert.ok(r.kind === "over");
  assert.equal(r.left, 20);
  assert.ok(r.needs > 20);
  // The same count the allocation would spend.
  const free = take(graph, data, plan, targets, 150);
  assert.ok(free.kind === "allocate");
  assert.equal(r.needs, free.points);
});

test("take: partly allocated tops up; existing nodes stay", () => {
  const incursion = data.mechanics.indexOf("Incursion");
  const targets = mechanicNodes(data, incursion);
  const plan = normalise(graph, data, routedPlan(targets.slice(0, 3)));
  const withChoice = Object.keys(data.nodes).find(
    (id) => data.nodes[id].choices,
  );
  const base = normalise(graph, data, {
    ...plan,
    allocated: [...plan.allocated, ...routedPlan([withChoice!]).allocated],
    choices: { [withChoice!]: data.nodes[withChoice!].choices![0].effect },
  });
  const r = take(graph, data, base, targets, 150);
  assert.ok(r.kind === "allocate");
  assert.ok(base.allocated.every((id) => r.plan.allocated.includes(id)));
  assert.deepEqual(r.plan.choices, base.choices);
  assert.equal(r.points, r.plan.allocated.length - base.allocated.length);
});

test("take: one cluster is its group plus its travel notables", () => {
  for (const label of data.labels) {
    const nodes = takeClusterNodes(graph, data, label.g);
    assert.ok(nodes.length > 0, label.g);
    for (const id of nodes) {
      const n = data.nodes[id];
      assert.ok(n.g === label.g || (n.m < 0 && n.a === label.m), id);
    }
  }
  // The clusters of a mechanic together are the mechanic.
  for (let m = 0; m < data.mechanics.length; m++) {
    const fromClusters = new Set(
      data.labels
        .filter((l) => l.m === m)
        .flatMap((l) => takeClusterNodes(graph, data, l.g)),
    );
    const all = mechanicNodes(data, m);
    assert.ok(
      all.every((id) => fromClusters.has(id)),
      data.mechanics[m],
    );
  }
});

/** Checks a refund of `targets` from `plan`: they're gone, `keep` all stays, joined up. */
function checkRefund(
  plan: Plan,
  targets: string[],
  keep: string[],
  what: string,
) {
  const r = take(graph, data, plan, targets, 150);
  assert.ok(r.kind === "refund", what);
  const left = new Set(r.plan.allocated);
  assert.equal(left.size, r.plan.allocated.length, `${what}: no duplicates`);
  assert.ok(!targets.some((id) => left.has(id)), `${what}: targets gone`);
  const lost = keep.filter((id) => !left.has(id));
  assert.deepEqual(lost, [], `${what}: kept`);
  assert.equal(connected(graph, left).size, left.size, `${what}: joined`);
  const before = new Set(plan.allocated);
  assert.equal(
    r.points,
    plan.allocated.filter((id) => !left.has(id)).length,
    `${what}: count`,
  );
  assert.equal(
    r.rerouted,
    r.plan.allocated.filter((id) => !before.has(id)).length,
    `${what}: rerouted count`,
  );
  for (const [id, effect] of Object.entries(plan.choices))
    if (left.has(id))
      assert.equal(r.plan.choices[id], effect, `${what}: choice`);
  return r;
}

test("take: refunding a mechanic never drops another taken after it", () => {
  // Strongboxes then Mercenaries: Mercenaries was routed through Strongboxes.
  const sb = data.mechanics.indexOf("Strongboxes");
  const me = data.mechanics.indexOf("Mercenaries");
  const a = take(graph, data, emptyPlan(), mechanicNodes(data, sb), 150);
  assert.ok(a.kind === "allocate");
  const b = take(graph, data, a.plan, mechanicNodes(data, me), 150);
  assert.ok(b.kind === "allocate");
  const r = checkRefund(
    b.plan,
    mechanicNodes(data, sb),
    mechanicNodes(data, me),
    "Strongboxes",
  );
  assert.ok(r.kind === "refund" && r.rerouted > 0, "routed around");
  // A sweep of pairs (every 13th, in a fixed order), both orders.
  const n = data.mechanics.length;
  for (let x = 0; x < n; x++)
    for (let y = 0; y < n; y++) {
      if (x === y || (x * n + y) % 13 !== 0) continue;
      const first = take(graph, data, emptyPlan(), mechanicNodes(data, x), 150);
      if (first.kind !== "allocate") continue;
      const both = take(graph, data, first.plan, mechanicNodes(data, y), 150);
      if (both.kind !== "allocate") continue;
      checkRefund(
        both.plan,
        mechanicNodes(data, x),
        mechanicNodes(data, y).filter(
          (id) => !mechanicNodes(data, x).includes(id),
        ),
        `${data.mechanics[x]} after ${data.mechanics[y]}`,
      );
    }
});

test("take: a refund keeps clusters the plan holds, and their small nodes", () => {
  // A whole cluster held, then a mechanic taken and refunded beside it.
  for (const label of data.labels) {
    if (Number(label.g) % 9 !== 0) continue;
    const cluster = takeClusterNodes(graph, data, label.g);
    const held = take(graph, data, emptyPlan(), cluster, 150);
    if (held.kind !== "allocate") continue;
    for (let m = 0; m < data.mechanics.length; m += 5) {
      if (m === label.m) continue;
      const more = take(graph, data, held.plan, mechanicNodes(data, m), 150);
      if (more.kind !== "allocate") continue;
      checkRefund(
        more.plan,
        mechanicNodes(data, m),
        cluster,
        `${data.mechanics[m]} beside ${label.g}`,
      );
    }
  }
  // A cluster refunded on its own leaves its mechanic's other clusters.
  const ess = data.mechanics.indexOf("Essence");
  const all = take(graph, data, emptyPlan(), mechanicNodes(data, ess), 150);
  assert.ok(all.kind === "allocate");
  for (const label of data.labels.filter((l) => l.m === ess)) {
    const one = takeClusterNodes(graph, data, label.g);
    const others = mechanicNodes(data, ess).filter((id) => !one.includes(id));
    checkRefund(all.plan, one, others, `Essence cluster ${label.g}`);
  }
});

test("take: a refund keeps picked choices on the nodes it keeps", () => {
  const withChoice = Object.keys(data.nodes).find(
    (id) => data.nodes[id].choices && mechanicOf(data.nodes[id]) >= 0,
  )!;
  const m = mechanicOf(data.nodes[withChoice]);
  const other = (m + 1) % data.mechanics.length;
  const a = take(graph, data, emptyPlan(), mechanicNodes(data, m), 150);
  assert.ok(a.kind === "allocate");
  const picked = {
    ...a.plan,
    choices: { [withChoice]: data.nodes[withChoice].choices![0].effect },
  };
  const b = take(graph, data, picked, mechanicNodes(data, other), 150);
  assert.ok(b.kind === "allocate");
  assert.deepEqual(b.plan.choices, picked.choices, "allocating keeps choices");
  const r = checkRefund(
    b.plan,
    mechanicNodes(data, other),
    mechanicNodes(data, m),
    "other",
  );
  assert.ok(r.kind === "refund");
  assert.deepEqual(r.plan.choices, picked.choices);
  // Refunding the choice node's own mechanic drops its pick.
  const back = take(graph, data, picked, mechanicNodes(data, m), 150);
  assert.ok(back.kind === "refund");
  assert.equal(back.plan.choices[withChoice], undefined);
});

test("take: refunding Atlas Anomalies keeps a held Mercenaries cluster", () => {
  const cluster = takeClusterNodes(graph, data, "195");
  assert.ok(cluster.includes("9314"));
  const held = take(graph, data, emptyPlan(), cluster, 150);
  assert.ok(held.kind === "allocate");
  const aa = data.mechanics.indexOf("Atlas Anomalies");
  const more = take(graph, data, held.plan, mechanicNodes(data, aa), 150);
  assert.ok(more.kind === "allocate");
  checkRefund(more.plan, mechanicNodes(data, aa), cluster, "Atlas Anomalies");
});
