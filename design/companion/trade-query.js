// Builds official trade site queries for PoB items.
// Uniques: name + base. Magic, normal, rare: base or slot category plus explicit mods,
// each with a minimum of about 80% of the PoB value.
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "trade-data");
const statsData = JSON.parse(fs.readFileSync(path.join(dir, "stats.json"), "utf8")).result;
const itemsData = JSON.parse(fs.readFileSync(path.join(dir, "items.json"), "utf8")).result;

const SHARE = 0.8;

// Stat text -> every trade id with that text, per group.
const byText = {};
for (const g of statsData) {
  const m = new Map();
  for (const e of g.entries) {
    if (!m.has(e.text)) m.set(e.text, []);
    m.get(e.text).push(e.id);
  }
  byText[g.id] = m;
}

// Base types (longest first so "Divine Life Flask" beats "Life Flask") and unique names.
const BASES = [];
const UNIQUES = [];
for (const g of itemsData) {
  if (!["accessory", "armour", "flask", "jewel", "weapon", "graft"].includes(g.id)) continue;
  for (const e of g.entries) {
    if (e.name) UNIQUES.push(e.name);
    else if (e.type) BASES.push(e.type);
  }
}
BASES.sort((a, b) => b.length - a.length);
UNIQUES.sort((a, b) => b.length - a.length);
const findBase = (name) => BASES.find((b) => name.includes(b)) || "";
// PoB names some bases by variant ("Two-Stone Ring (Fire/Cold)"); the trade site uses the plain name.
const tradeBase = (base) => (base || "").replace(/ \([^)]*\)$/, "");
// PoB lets you rename items ("Elegant Hubris 140860; 1; ..."): keep the known unique name it starts with.
const findUnique = (name) => UNIQUES.find((u) => name === u || name.startsWith(u + " ") || name.startsWith(u + ";")) || "";

const CATEGORY = {
  Helmet: "armour.helmet", "Body Armour": "armour.chest", Gloves: "armour.gloves", Boots: "armour.boots",
  Amulet: "accessory.amulet", "Ring 1": "accessory.ring", "Ring 2": "accessory.ring", "Ring 3": "accessory.ring", Belt: "accessory.belt",
};

// Weapon slots: category from the base name when it's clear, otherwise the exact base.
const WEAPON_CATEGORY = [
  [/Wand$/, "weapon.wand"], [/Sceptre$/, "weapon.sceptre"], [/Shield$/, "armour.shield"], [/Quiver$/, "armour.quiver"],
  [/Bow$/, "weapon.bow"], [/Claw$/, "weapon.claw"], [/Dagger$/, "weapon.dagger"], [/(Foil|Rapier|Spike)$/, "weapon.onesword"],
];
const weaponCategory = (base) => (WEAPON_CATEGORY.find(([re]) => re.test(base)) || [])[1];

// Which stats are local depends on the item: defences on armour and shields, attack stats on weapons.
const LOCAL_DEFENCE = /(Armour|Evasion Rating|Energy Shield|Ward|Chance to Block)/;
const LOCAL_WEAPON = /(Attack Speed|Accuracy Rating|Critical Strike Chance|Adds # to # \w+ Damage|increased Physical Damage|Leeched as)/;
function localKind(slot, base) {
  if (["Helmet", "Body Armour", "Gloves", "Boots"].includes(slot)) return LOCAL_DEFENCE;
  if (!slot.startsWith("Weapon")) return null;
  if (/Shield$/.test(base)) return LOCAL_DEFENCE;
  if (/Quiver$/.test(base)) return null;
  return LOCAL_WEAPON;
}

// Drawbacks (flask downsides, trigger costs): required as a mod, never as a target value.
const DRAWBACK = /(reduced Amount Recovered|less Duration|reduced Duration|more Cost|reduced Recovery rate)/;

const NUM = /[+-]?\d+(?:\.\d+)?/g;

// Small whole numbers (gem levels, flask charges) stay exact.
function minOf(v) {
  if (Number.isInteger(v) && v < 5) return v;
  const m = v * SHARE;
  return Number.isInteger(v) ? Math.floor(m) : Math.floor(m * 100) / 100;
}

// One mod line -> a list of trade ids plus a value filter, or null when the trade site has no matching stat.
function statFilter(mod, slot, base) {
  const raw = mod.text.match(NUM) || [];
  const nums = raw.map(Number);
  const template = mod.text.replace(NUM, (s) => (s[0] === "+" ? "+#" : "#"));
  const signedTemplate = mod.text.replace(NUM, (s) => (s[0] === "+" || s[0] === "-" ? "+#" : "#"));
  const tries = [];
  for (const t of new Set([template, signedTemplate, template.replace(/# Charges\b/, "# Charge")])) tries.push([t, 1]);
  if (/\breduced\b/.test(template)) tries.push([template.replace(/\breduced\b/, "increased"), -1]);
  if (/\bless\b/.test(template)) tries.push([template.replace(/\bless\b/, "more"), -1]);

  const local = localKind(slot, base);
  const groups = mod.crafted ? ["crafted", "explicit"] : ["explicit"];
  for (const [t, sign] of tries) {
    const variants = local && local.test(t) ? [t + " (Local)", t] : [t];
    for (const g of groups) {
      for (const v of variants) {
        const ids = byText[g].get(v);
        if (!ids) continue;
        let value;
        if (nums.length && !DRAWBACK.test(mod.text)) {
          const val = (nums.reduce((a, b) => a + b, 0) / nums.length) * sign;
          value = val >= 0 ? { min: minOf(val) } : { max: -minOf(-val) };
        }
        return { ids, value };
      }
    }
  }
  return null;
}

// item: { name, base, rarity, mods: [{text, crafted}] }, slot: PoB slot name.
// Returns { query, matched, total }.
function buildQuery(item, slot) {
  const q = { status: { option: "online" } };
  let matched = 0;
  let total = 0;
  if (item.rarity === "UNIQUE") {
    const name = findUnique(item.name);
    if (name) q.name = name;
    q.type = tradeBase(item.base);
  } else {
    const base = tradeBase(item.rarity === "RARE" ? item.base : item.rarity === "NORMAL" ? item.name : findBase(item.name));
    const cat = CATEGORY[slot] || (slot.startsWith("Weapon") && item.rarity === "RARE" ? weaponCategory(base) : undefined);
    q.filters = { type_filters: { filters: { rarity: { option: "nonunique" } } } };
    if (cat) q.filters.type_filters.filters.category = { option: cat };
    else if (base) q.type = base;
    const and = [];
    const anyOf = [];
    const seen = new Set();
    for (const m of item.mods) {
      total++;
      const f = statFilter(m, slot, base);
      if (!f || seen.has(f.ids[0])) continue;
      seen.add(f.ids[0]);
      matched++;
      const filters = f.ids.map((id) => (f.value ? { id, value: f.value } : { id }));
      // Same text under several ids: any one of them counts.
      if (filters.length === 1) and.push(filters[0]);
      else anyOf.push({ type: "count", value: { min: 1 }, filters });
    }
    const stats = [];
    if (and.length) stats.push({ type: "and", filters: and });
    stats.push(...anyOf);
    if (stats.length) q.stats = stats;
  }
  return { query: { query: q, sort: { price: "asc" } }, matched, total };
}

const leagues = () =>
  JSON.parse(fs.readFileSync(path.join(dir, "leagues.json"), "utf8")).result.filter((l) => l.realm === "pc").map((l) => l.id);

module.exports = { buildQuery, leagues, findBase };
