// Builds demo assets for the Leveling Companion design canvas.
// Usage: node demo-prep.js <repoDir> <pobXml> <outDir>
const fs = require("fs");
const path = require("path");
const { buildQuery, leagues, findBase } = require("./trade-query");
const tradeStats = [];
const [repo, pobPath, out] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });

const J = (p) => JSON.parse(fs.readFileSync(path.join(repo, p), "utf8"));
const gemsDb = J("common/data/json/gems.json");
const quests = J("common/data/json/quests.json");
const areas = J("common/data/json/areas.json");
const tree = J("common/data/tree/3_29.json");
const xml = fs.readFileSync(pobPath, "utf8");

const attr = (tag, a) => {
  const m = tag.match(new RegExp(`\\s${a}="([^"]*)"`));
  return m ? decode(m[1]) : undefined;
};
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const stripColor = (s) => s.replace(/\^x[0-9A-Fa-f]{6}/g, "").replace(/\^\d/g, "");
const ids = (title) => ((title.match(/\{([^}]*)\}/) || [])[1] || "").split(",").map((x) => x.trim()).filter(Boolean);
const clean = (title) => stripColor(title).replace(/\{[^}]*\}/, "").trim();

// ---------- Gem colours ----------
const ATTR_COLOR = { strength: "#e0605a", dexterity: "#6cc070", intelligence: "#6ea3e6" };
const gemByName = {};
for (const g of Object.values(gemsDb)) gemByName[g.name] = g;

// ---------- Loadouts ----------
const block = (tag) => [...xml.matchAll(new RegExp(`<${tag}\\s[^>]*>[\\s\\S]*?</${tag}>`, "g"))].map((m) => m[0]);
const open = (s) => s.match(/^<[^>]*>/)[0];

const specs = block("Spec").map((s) => ({ title: attr(open(s), "title"), nodes: (attr(open(s), "nodes") || "").split(",").filter(Boolean), body: s }));
const skillSets = block("SkillSet").map((s) => ({ title: attr(open(s), "title"), body: s }));
const itemSets = block("ItemSet").map((s) => ({ title: attr(open(s), "title"), id: attr(open(s), "id"), body: s }));
const configSets = [...xml.matchAll(/<ConfigSet\s[^>]*>/g)].map((m) => ({ title: attr(m[0], "title") }));

// Items by id. Header lines ("Quality: 20") and flags ("Corrupted") aren't mods.
const SKIP_HEADER = /^(Crafted|Prefix|Suffix|Quality|LevelReq|Item Level|Unique ID|Selected Alt Variant|Has Alt Variant|Has Variants|Variant|League|Radius|Limited to|Catalyst|CatalystQuality|Armour|Evasion|Energy Shield|Ward|\w*BasePercentile|Cluster Jewel Skill|Cluster Jewel Node Count|Talisman Tier|Item Class|Requires Level)\s*:/;
const SKIP_FLAG = /^(Corrupted|Mirrored|Split|Unidentified|Fractured Item|Synthesised Item|(Shaper|Elder|Crusader|Redeemer|Hunter|Warlord|Searing Exarch|Eater of Worlds) Item|Requires .+)$/;
const items = {};
for (const m of xml.matchAll(/<Item\s[^>]*>([\s\S]*?)<\/Item>/g)) {
  const tag = m[0].match(/^<Item[^>]*>/)[0];
  const id = attr(tag, "id");
  const lines = m[1].split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rarity = (lines[0] || "").replace("Rarity: ", "");
  const named = rarity === "RARE" || rarity === "UNIQUE";
  const name = lines[1];
  const base = named ? lines[2] : rarity === "MAGIC" ? findBase(name) : "";
  let sockets = "";
  let implicits = 0;
  let variant = attr(tag, "variant") || "";
  let i = named ? 3 : 2;
  const mods = [];
  const impl = [];
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("<")) continue;
    const text0 = l.replace(/\{[^}]*\}/g, "").trim();
    if (text0.startsWith("Selected Variant: ")) { variant = text0.slice(18); continue; }
    if (text0.startsWith("Sockets: ")) { sockets = text0.slice(9); continue; }
    if (text0.startsWith("Implicits: ")) { implicits = +text0.slice(11); continue; }
    // Implicit lines come first; count them before any other filter.
    const isImplicit = implicits > 0;
    if (isImplicit) implicits--;
    const vtag = l.match(/\{variant:([\d,]+)\}/);
    if (vtag && variant && !vtag[1].split(",").includes(variant)) continue;
    if (SKIP_HEADER.test(text0) || SKIP_FLAG.test(text0)) continue;
    const range = +((l.match(/\{range:([\d.]+)\}/) || [])[1] || 0.5);
    const text = resolveRanges(text0, range);
    if (!text) continue;
    // Implicits are shown, but trade searches use explicit mods only.
    if (isImplicit) impl.push(text);
    else mods.push({ text, crafted: l.includes("{crafted}") });
  }
  items[id] = { id, name, base, rarity, sockets, mods, implicits: impl };
}

// "(50-66)" with range 0.707 -> "61"
function resolveRanges(text, r) {
  return text.replace(/\((-?[\d.]+)-(-?[\d.]+)\)/g, (_, a, b) => {
    const lo = +a, hi = +b;
    const dp = Math.max((a.split(".")[1] || "").length, (b.split(".")[1] || "").length);
    const v = lo + (hi - lo) * r;
    return dp ? v.toFixed(dp) : String(Math.round(v));
  });
}

const SLOT_ORDER = ["Weapon 1", "Helmet", "Weapon 2", "Body Armour", "Gloves", "Boots", "Amulet", "Ring 1", "Ring 2", "Ring 3", "Belt",
  "Weapon 1 Swap", "Weapon 2 Swap", "Flask 1", "Flask 2", "Flask 3", "Flask 4", "Flask 5", "Graft 1", "Graft 2"];
const ABYSS = /^(.+) Abyssal Socket \d+$/;
// Skill groups, including self-closing <Skill ... /> placeholders (those have no gems).
const SKILL_RE = /<Skill\s[^>]*?(?:\/>|>[\s\S]*?<\/Skill>)/g;
const GUARDIAN_SLOTS = ["Weapon 1", "Weapon 2", "Helmet", "Body Armour", "Gloves", "Boots"];

function parseSkills(body) {
  return [...body.matchAll(SKILL_RE)].map((m) => {
    const tag = m[0].match(/^<Skill[^>]*>/)[0];
    const gems = [...m[0].matchAll(/<Gem\s[^>]*>/g)].map((g) => {
      const name = attr(g[0], "nameSpec");
      const gemId = attr(g[0], "gemId") || "";
      const db = gemsDb[gemId] || gemByName[name] || gemByName[name.replace(/^Vaal /, "")];
      const support = /SupportGem/.test(gemId) || (db && db.is_support) || false;
      return {
        name,
        level: +attr(g[0], "level"),
        quality: +attr(g[0], "quality"),
        color: (db && ATTR_COLOR[db.primary_attribute]) || "#d8d8d8",
        support,
      };
    });
    return {
      label: stripColor(attr(tag, "label") || "").replace(/\s+/g, " ").trim(),
      slot: attr(tag, "slot") || "",
      enabled: attr(tag, "enabled") !== "false",
      gems,
    };
  }).filter((s) => s.gems.length);
}

// Display shows 4 mods; the trade query uses all of them.
// mods: the first 4 for cards; allMods: everything, for the details panel.
function gearEntry(slot, it, extra) {
  const t = buildQuery(it, slot);
  tradeStats.push({ slot, name: it.name, rarity: it.rarity, matched: t.matched, total: t.total });
  const all = it.mods.map((m) => m.text);
  return Object.assign({ slot, itemId: it.id, name: it.name, base: it.base, rarity: it.rarity, sockets: it.sockets, implicits: it.implicits, mods: all.slice(0, 4), allMods: all, trade: t.query }, extra);
}

// Gear slots, plus abyss jewels (slot "Jewel", host = the item they sit in).
function parseItems(body) {
  const slots = [];
  const abyss = [];
  for (const m of body.matchAll(/<Slot\s[^>]*>/g)) {
    const name = attr(m[0], "name");
    const id = attr(m[0], "itemId");
    if (!id || id === "0" || !items[id]) continue;
    const ab = name.match(ABYSS);
    if (ab) abyss.push({ host: ab[1], id });
    else if (SLOT_ORDER.includes(name)) slots.push(gearEntry(name, items[id]));
  }
  slots.sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot));
  // Keep abyss jewels only when their host slot holds an item.
  const hosts = new Set(slots.map((s) => s.slot));
  for (const a of abyss) if (hosts.has(a.host)) slots.push(gearEntry("Jewel", items[a.id], { host: a.host }));
  return slots;
}

// Animate Guardian: the gem names the item set the guardian wears.
function guardianSet(skillBody) {
  if (!skillBody) return null;
  let found = null;
  for (const sk of skillBody.matchAll(SKILL_RE)) {
    const groupOn = attr(sk[0].match(/^<Skill[^>]*>/)[0], "enabled") !== "false";
    for (const g of sk[0].matchAll(/<Gem\s[^>]*>/g)) {
      if (attr(g[0], "skillId") !== "AnimateGuardian") continue;
      const set = itemSets.find((s) => s.id === attr(g[0], "skillMinionItemSet"));
      if (!set) continue;
      const enabled = groupOn && attr(g[0], "enabled") !== "false";
      // Prefer an enabled gem; a disabled one still shows, marked off.
      if (!found || (enabled && !found.enabled)) {
        found = { title: clean(set.title), enabled, gear: parseItems(set.body).filter((x) => GUARDIAN_SLOTS.includes(x.slot)) };
      }
    }
  }
  return found;
}

// One card per jewel: PoB can list the same item in several sockets.
function dedupeJewels(gear) {
  const seen = new Set();
  return gear.filter((g) => {
    if (g.slot !== "Jewel") return true;
    if (seen.has(g.itemId)) return false;
    seen.add(g.itemId);
    return true;
  });
}

// Jewels socketed into allocated tree nodes.
function parseJewels(specBody, allocated) {
  const out = [];
  const seen = new Set();
  for (const m of specBody.matchAll(/<Socket\s[^>]*>/g)) {
    const node = attr(m[0], "nodeId");
    const id = attr(m[0], "itemId");
    if (!id || id === "0" || !items[id] || !allocated.has(node) || seen.has(id)) continue;
    seen.add(id);
    out.push(gearEntry("Jewel", items[id]));
  }
  return out;
}

// Loadout order follows the specs.
const nodeInfo = tree.graphs[0].nodes;
const loadouts = specs.map((spec, i) => {
  const id = ids(spec.title)[0];
  const skill = skillSets.find((s) => ids(s.title).includes(id));
  const item = itemSets.find((s) => ids(s.title).includes(id));
  const config = configSets.find((s) => ids(s.title).includes(id));
  const prev = i > 0 ? new Set(specs[i - 1].nodes) : new Set();
  const cur = new Set(spec.nodes);
  const added = spec.nodes.filter((n) => !prev.has(n));
  const removed = [...prev].filter((n) => !cur.has(n));
  const name = clean(spec.title);
  const pts = (name.match(/(\d+) pts/) || [])[1];
  const pick = (list) => list.map((n) => nodeInfo[n]).filter((n) => n && (n.k === "Notable" || n.k === "Keystone"));
  return {
    id,
    name: name.replace(/ - \d+ pts$/, ""),
    points: pts ? +pts : spec.nodes.filter((n) => nodeInfo[n] && nodeInfo[n].k !== "Mastery").length,
    act: (name.match(/^Acts? ([\d-]+)/) || [])[1] || "",
    group: id[0] === "a" ? "Leveling" : id[0] === "s" ? "SRS" : "HRoC",
    skillSet: skill ? clean(skill.title) : "",
    itemSet: item ? clean(item.title) : "",
    configSet: config ? clean(config.title) : "",
    skills: skill ? parseSkills(skill.body) : [],
    gear: dedupeJewels((item ? parseItems(item.body) : []).concat(parseJewels(spec.body, cur))),
    guardian: guardianSet(skill && skill.body),
    newNotables: pick(added).map((n) => ({ name: n.text, kind: n.k, stats: n.stats.slice(0, 2) })),
    removedNotables: pick(removed).map((n) => ({ name: n.text, kind: n.k })),
    added: added.length,
    removed: removed.length,
  };
});

// ---------- Notes ----------
const notes = stripColor(decode((xml.match(/<Notes>([\s\S]*?)<\/Notes>/) || [, ""])[1])).replace(/\r/g, "").trim();

// ---------- Route ----------
const DIRS = ["→", "↗", "↑", "↖", "←", "↙", "↓", "↘"];
const dirArrow = (deg) => DIRS[Math.round((((+deg % 360) + 360) % 360) / 45) % 8];
const COLORS = { text: "", area: "#e8c872", kill: "#e0605a", quest: "#6cc070", wp: "#6ea3e6", item: "#d8b4fe", note: "#9aa0aa" };
function segs(line) {
  const out = [];
  let rest = line.replace(/\s#(?!sub).*$/, "");
  const re = /\{([a-z_]+)(?:\|([^}]*))?\}/g;
  let last = 0, m;
  const push = (t, kind = "text") => { if (t) out.push({ t, c: COLORS[kind] || "" }); };
  while ((m = re.exec(rest))) {
    push(rest.slice(last, m.index));
    const [kind, arg = ""] = [m[1], m[2]];
    const a = arg.split("|");
    switch (kind) {
      case "enter": push((areas[a[0]] || {}).name || a[0], "area"); break;
      case "area": push((areas[a[0]] || {}).name || a[0], "area"); break;
      case "kill": push(a[0], "kill"); break;
      case "quest": push((quests[a[0]] || {}).name || a[0], "quest"); break;
      case "quest_text": push(a[0], "item"); break;
      case "waypoint": push(a[0] ? "Waypoint ➞ " : "Waypoint", "wp"); if (a[0]) push((areas[a[0]] || {}).name || a[0], "area"); break;
      case "waypoint_get": push("Waypoint", "wp"); break;
      case "logout": push("Logout", "wp"); break;
      case "generic": push(a[0], "item"); break;
      case "arena": push(a[0], "area"); break;
      case "dir": push(dirArrow(a[0])); break;
      case "trial": push("Trial of Ascendancy", "quest"); break;
      case "crafting": push("Crafting recipe", "item"); break;
      case "portal": push(a[0] === "set" ? "Portal" : "Use portal", "wp"); break;
      case "ascend": push("Ascend", "quest"); break;
      default: push(a[a.length - 1] || kind);
    }
    last = re.lastIndex;
  }
  push(rest.slice(last));
  return out;
}
const route = [];
for (let act = 1; act <= 10; act++) {
  const lines = fs.readFileSync(path.join(repo, `common/data/routes/act-${act}.txt`), "utf8").split(/\r?\n/);
  const steps = [];
  const stack = [];
  const active = () => stack.every(Boolean);
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith("#ifdef")) { stack.push(!l.includes("LEAGUE_START")); continue; }
    if (l.startsWith("#ifndef")) { stack.push(l.includes("LEAGUE_START")); continue; }
    if (l.startsWith("#endif")) { stack.pop(); continue; }
    if (!active() || l.startsWith("#section")) continue;
    if (l.startsWith("#sub")) {
      if (steps.length) steps[steps.length - 1].subs.push(l.replace(/^#sub\s*/, "").replace(/\{dir\|(\d+)\}/g, (_, d) => dirArrow(d)).replace(/\{[a-z_]+\|?([^}]*)\}/g, "$1"));
      continue;
    }
    if (l.startsWith("#")) continue;
    steps.push({ segs: segs(l), subs: [] });
  }
  route.push({ act, steps });
}

// ---------- Tree SVGs (one per loadout, cropped to its nodes, base tree included) ----------
const main = tree.graphs[0];
const R = { Normal: 26, Notable: 46, Keystone: 64, Jewel: 40, Mastery: 0 };
const edgePath = (c) => {
  const a = main.nodes[c.a], b = main.nodes[c.b];
  if (c.s && c.s.r) return `M${a.x} ${a.y}A${c.s.r} ${c.s.r} 0 0 ${c.s.w === "CW" ? 1 : 0} ${b.x} ${b.y}`;
  return `M${a.x} ${a.y}L${b.x} ${b.y}`;
};
const realEdges = main.connections.filter((c) => main.nodes[c.a] && main.nodes[c.b] && main.nodes[c.a].k !== "Mastery" && main.nodes[c.b].k !== "Mastery");

function box(nodeIds) {
  const pts = nodeIds.map((n) => main.nodes[n]).filter(Boolean);
  const pad = 700, minSize = 7000, target = 4 / 3;
  let minX = Math.min(...pts.map((p) => p.x)) - pad, maxX = Math.max(...pts.map((p) => p.x)) + pad;
  let minY = Math.min(...pts.map((p) => p.y)) - pad, maxY = Math.max(...pts.map((p) => p.y)) + pad;
  const grow = (lo, hi, size) => { const c = (lo + hi) / 2; return [c - size / 2, c + size / 2]; };
  if (maxX - minX < minSize) [minX, maxX] = grow(minX, maxX, minSize);
  const w = maxX - minX, h = maxY - minY;
  if (w / h < target) [minX, maxX] = grow(minX, maxX, h * target); else [minY, maxY] = grow(minY, maxY, w / target);
  return { minX, minY, maxX, maxY };
}

specs.forEach((spec, i) => {
  const id = loadouts[i].id;
  const cur = new Set(spec.nodes);
  const prev = i > 0 ? new Set(specs[i - 1].nodes) : new Set();
  const b = box([...cur, ...prev]);
  const inBox = (p) => p && p.x > b.minX - 300 && p.x < b.maxX + 300 && p.y > b.minY - 300 && p.y < b.maxY + 300;
  const usable = realEdges.filter((c) => inBox(main.nodes[c.a]) || inBox(main.nodes[c.b]));
  const vb = `${Math.round(b.minX)} ${Math.round(b.minY)} ${Math.round(b.maxX - b.minX)} ${Math.round(b.maxY - b.minY)}`;
  const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">${body}</svg>`;
  const baseNodes = Object.values(main.nodes).filter((n) => inBox(n) && n.k !== "Mastery")
    .map((n) => `<circle cx="${n.x}" cy="${n.y}" r="${R[n.k] || 26}"/>`).join("");
  const base = `<path d="${usable.map(edgePath).join("")}" fill="none" stroke="#2c313b" stroke-width="14"/>` +
    `<g fill="#1d2129" stroke="#3a404c" stroke-width="8">${baseNodes}</g>`;
  const edgesIn = (set, other) => usable.filter((c) => set.has(c.a) && set.has(c.b) && (!other || !(other.has(c.a) && other.has(c.b))));
  const kept = usable.filter((c) => cur.has(c.a) && cur.has(c.b) && prev.has(c.a) && prev.has(c.b));
  const added = edgesIn(cur).filter((c) => !(prev.has(c.a) && prev.has(c.b)));
  const removedSet = new Set([...prev].filter((n) => !cur.has(n)));
  const removedEdges = usable.filter((c) => prev.has(c.a) && prev.has(c.b) && (removedSet.has(c.a) || removedSet.has(c.b)));
  const circles = (list, fill, stroke) => list.map((n) => main.nodes[n]).filter((n) => n && n.k !== "Mastery")
    .map((n) => `<circle cx="${n.x}" cy="${n.y}" r="${R[n.k] || 26}" fill="${fill}" stroke="${stroke}" stroke-width="10"/>`).join("");
  fs.writeFileSync(path.join(out, `tree-${id}.svg`), svg(base +
    `<path d="${removedEdges.map(edgePath).join("")}" fill="none" stroke="#e0605a" stroke-width="14" stroke-dasharray="40 30" opacity="0.8"/>` +
    `<path d="${kept.map(edgePath).join("")}" fill="none" stroke="#a8874a" stroke-width="18"/>` +
    `<path d="${added.map(edgePath).join("")}" fill="none" stroke="#7fd3ff" stroke-width="22"/>` +
    circles([...removedSet], "#1d2129", "#e0605a") +
    circles(spec.nodes.filter((n) => prev.has(n)), "#a8874a", "#d9b870") +
    circles(spec.nodes.filter((n) => !prev.has(n)), "#7fd3ff", "#d6f1ff")));
});

const data = {
  build: {
    className: attr(xml.match(/<Build\s[^>]*>/)[0], "className"),
    ascendancy: attr(xml.match(/<Build\s[^>]*>/)[0], "ascendClassName"),
    title: "Necro SRS → HRoC",
  },
  loadouts,
  notes,
  route,
  leagues: leagues(),
};
fs.writeFileSync(path.join(out, "companion-data.json"), JSON.stringify(data));
const tm = tradeStats.filter((t) => t.rarity !== "UNIQUE");
console.log("trade: items", tradeStats.length, "non-unique", tm.length, "mods matched", tm.reduce((a, t) => a + t.matched, 0), "of", tm.reduce((a, t) => a + t.total, 0));
console.log("loadouts:", loadouts.map((l) => `${l.id}:${l.name}(${l.points}pts,+${l.added}/-${l.removed},skills ${l.skills.length},gear ${l.gear.length})`).join(" | "));
console.log("route steps:", route.map((r) => r.steps.length).join(","));
for (const f of fs.readdirSync(out)) console.log(f, fs.statSync(path.join(out, f)).size);
