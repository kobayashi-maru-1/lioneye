// Atlas planner checks (plans/atlas-planner.md section 11). Run from the repo root after
// `npm -w seeding run seed atlas`:  npx tsx --test web/atlas-tests/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { bonuses, combine } from "../src/atlas/lib/bonuses.ts";
import {
  buildGraph,
  connected,
  costs,
  fits,
  normalise,
  refundSet,
  route,
} from "../src/atlas/lib/graph.ts";
import {
  encodeOfficial,
  encodeShare,
  parseLink,
} from "../src/atlas/lib/links.ts";
import {
  mechanicColours,
  mechanicLetters,
} from "../src/atlas/lib/mechanics.ts";
import type { AtlasData, Plan } from "../src/atlas/lib/types.ts";
import {
  exportFile,
  historyReducer,
  importFile,
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
  assert.equal(data.labels.length, 149);
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
  let h: History = { plan: a, past: [], future: [] };
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

test("League page poeatlasplanner links open with their point counts", () => {
  const html = readFileSync(
    new URL("../../strats/index.html", import.meta.url),
    "utf8",
  );
  const links = [
    ...html.matchAll(/https:\/\/poeatlasplanner\.com\/#p=[A-Za-z0-9_-]+/g),
  ].map((m) => m[0]);
  assert.equal(links.length, 3);
  const points = links.map((l) => {
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
  const path = route(graph, none, "45404")!;
  const b = bonuses(data, {
    allocated: path,
    choices: { "45404": 5301 },
    budget: 150,
  });
  assert.ok(
    b.choices.some((c) => c.id === "45404" && c.stats[0].includes("Allflames")),
  );
});

test("colours: touching mechanics differ; letters are unique", () => {
  const colours = mechanicColours(data);
  for (const { a, b } of data.edges) {
    const ma = data.nodes[a].m;
    const mb = data.nodes[b].m;
    if (ma >= 0 && mb >= 0 && ma !== mb)
      assert.notEqual(colours[ma], colours[mb]);
  }
  const letters = mechanicLetters(data.mechanics);
  assert.equal(new Set(letters).size, letters.length, letters.join(" "));
});
