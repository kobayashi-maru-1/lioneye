// Adds item art to the demo data.
// Image URLs come from poe.ninja (uniques, base types, cluster jewels); bases poe.ninja lacks
// (flasks, plain jewels) come from one trade-site listing each. Images are bundled as data URIs
// in images.json, and each gear entry gets an `img` key.
// Usage: node images-prep.js <assetsDir> <league>
const fs = require("fs");
const path = require("path");
const [out, league] = process.argv.slice(2);
const UA = { "User-Agent": "leveling-companion-demo/0.1" };
const dataPath = path.join(out, "companion-data.json");
const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
const { findBase } = require("./trade-query");

const ninja = (t) => JSON.parse(fs.readFileSync(path.join(__dirname, "ninja", t + ".json"), "utf8")).lines;
const uniqueIcon = new Map();
for (const t of ["UniqueWeapon", "UniqueArmour", "UniqueAccessory", "UniqueFlask", "UniqueJewel"]) {
  for (const l of ninja(t)) {
    const k = l.name + "|" + l.baseType;
    // Relic variants use different art; keep the normal one.
    if (!uniqueIcon.has(k) || /relic/i.test(uniqueIcon.get(k).detailsId || "")) uniqueIcon.set(k, l);
  }
}
const baseIcon = new Map();
for (const l of ninja("BaseType")) if (!baseIcon.has(l.name)) baseIcon.set(l.name, l.icon);
for (const l of ninja("ClusterJewel")) if (!baseIcon.has(l.baseType)) baseIcon.set(l.baseType, l.icon);

const allGear = data.loadouts.flatMap((L) => L.gear.concat(L.guardian ? L.guardian.gear : []));
// Two-Stone Ring art depends on its colours: Ruby = Fire, Sapphire = Cold, Topaz = Lightning.
const GEM = { Fire: "Ruby", Cold: "Sapphire", Lightning: "Topaz" };
const twoStone = new Map();
for (const l of ninja("BaseType")) if (l.name === "Two-Stone Ring") twoStone.set(l.icon.split("/").pop().replace(".png", ""), l.icon);
function twoStoneIcon(base) {
  const m = base.match(/^Two-Stone Ring \((\w+)\/(\w+)\)$/);
  if (!m) return "";
  const a = GEM[m[1]], b = GEM[m[2]];
  return twoStone.get(a + b) || twoStone.get(b + a) || "";
}

const plain = (b) => b.replace(/ \([^)]*\)$/, "");
const keyOf = (g) => {
  if (g.rarity === "UNIQUE") return "u|" + (g.trade.query.name || g.name) + "|" + plain(g.base);
  const base = g.base || findBase(g.name) || g.name;
  return base ? "b|" + base : "";
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function tradeIcon(query) {
  const s = await fetch(`https://www.pathofexile.com/api/trade/search/${encodeURIComponent(league)}`, {
    method: "POST", headers: { ...UA, "Content-Type": "application/json" }, body: JSON.stringify({ query: { status: { option: "any" }, ...query } }),
  }).then((r) => r.json());
  if (!s.result || !s.result.length) return "";
  await sleep(2500);
  const f = await fetch(`https://www.pathofexile.com/api/trade/fetch/${s.result[0]}?query=${s.id}`, { headers: UA }).then((r) => r.json());
  return (f.result && f.result[0] && f.result[0].item.icon) || "";
}

(async () => {
  const cachePath = path.join(__dirname, "ninja", "icon-cache.json");
  const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf8")) : {};
  const urls = {};
  const missing = [];
  for (const g of allGear) {
    const k = keyOf(g);
    if (!k || k in urls) continue;
    const [kind, a, b] = k.split("|");
    const hit = kind === "u" ? uniqueIcon.get(a + "|" + b) : null;
    urls[k] = cache[k] || (kind === "u" ? (hit ? hit.icon : "") : baseIcon.get(a) || twoStoneIcon(a) || baseIcon.get(plain(a)) || "");
    if (!urls[k]) missing.push(k);
  }
  console.log("keys", Object.keys(urls).length, "from poe.ninja", Object.keys(urls).length - missing.length, "trade lookups", missing.length);
  for (const k of missing) {
    const [kind, a, b] = k.split("|");
    try {
      urls[k] = await tradeIcon(kind === "u" ? { name: a, type: b } : { type: plain(a) });
    } catch (err) {
      urls[k] = "";
      console.log("  lookup failed", k, err.message);
    }
    console.log(" ", k, urls[k] ? "ok" : "none");
    if (urls[k]) { cache[k] = urls[k]; fs.writeFileSync(cachePath, JSON.stringify(cache)); }
    await sleep(4000);
  }

  const images = {};
  for (const [k, u] of Object.entries(urls)) {
    if (!u) continue;
    try {
      const r = await fetch(u, { headers: UA });
      if (!r.ok) { console.log("  download failed", r.status, k); continue; }
      images[k] = "data:image/png;base64," + Buffer.from(await r.arrayBuffer()).toString("base64");
    } catch (err) {
      console.log("  download failed", k, err.message);
    }
  }
  for (const g of allGear) {
    const k = keyOf(g);
    if (images[k]) g.img = k;
  }
  fs.writeFileSync(path.join(out, "images.json"), JSON.stringify(images));
  fs.writeFileSync(dataPath, JSON.stringify(data));
  const noImg = allGear.filter((g) => !g.img).map((g) => g.name + " (" + (g.base || g.rarity) + ")");
  console.log("images", Object.keys(images).length, "bytes", fs.statSync(path.join(out, "images.json")).size, "items without art", [...new Set(noImg)].join("; ") || "none");
})();
