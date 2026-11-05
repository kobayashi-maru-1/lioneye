// Prints the loadout structure of a PoB XML export.
const fs = require("fs");
const s = fs.readFileSync(process.argv[2], "utf8");

const tags = (name) => [...s.matchAll(new RegExp(`<${name}\\s[^>]*>`, "g"))].map((m) => m[0]);
const attr = (tag, a) => (tag.match(new RegExp(`\\s${a}="([^"]*)"`)) || [])[1];

for (const t of ["Tree", "Spec", "Skills", "SkillSet", "Items", "ItemSet", "Config", "ConfigSet"]) {
  const list = tags(t);
  console.log(`== ${t} (${list.length})`);
  for (const tag of list) {
    const keep = ["id", "title", "activeSpec", "activeSkillSet", "activeItemSet", "activeConfigSet", "treeVersion", "useSecondWeaponSet"];
    const parts = keep.map((k) => [k, attr(tag, k)]).filter(([, v]) => v !== undefined);
    console.log("  " + parts.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" "));
  }
}

// Skills per skill set: socket group label, slot, gems
const skillSets = [...s.matchAll(/<SkillSet\s[^>]*>([\s\S]*?)<\/SkillSet>/g)];
for (const ss of skillSets.slice(0, 3)) {
  console.log(`\n== SkillSet ${attr(ss[0], "title")}`);
  for (const sk of ss[1].matchAll(/<Skill\s[^>]*>([\s\S]*?)<\/Skill>/g)) {
    const gems = [...sk[1].matchAll(/<Gem\s[^>]*>/g)].map((g) => `${attr(g[0], "nameSpec")} ${attr(g[0], "level")}/${attr(g[0], "quality")}`);
    console.log(`  [${attr(sk[0], "slot") || "-"}] ${(attr(sk[0], "label") || "").replace(/\^x?[0-9A-Fa-f]{1,6}/g, "")}: ${gems.join(", ")}`);
  }
}

// Items per item set: slot -> item name
const items = Object.fromEntries([...s.matchAll(/<Item\s[^>]*>([\s\S]*?)<\/Item>/g)].map((m) => {
  const lines = m[1].trim().split(/\r?\n/).map((l) => l.trim());
  const rarity = (lines[0] || "").replace("Rarity: ", "");
  return [attr(m[0], "id"), `${lines[1]}${rarity === "RARE" || rarity === "UNIQUE" ? " (" + lines[2] + ")" : ""} [${rarity}]`];
}));
const itemSets = [...s.matchAll(/<ItemSet\s[^>]*>([\s\S]*?)<\/ItemSet>/g)];
for (const is of itemSets.slice(0, 2)) {
  console.log(`\n== ItemSet ${attr(is[0], "title")}`);
  for (const sl of is[1].matchAll(/<Slot\s[^>]*>/g)) {
    const id = attr(sl[0], "itemId");
    if (id && id !== "0") console.log(`  ${attr(sl[0], "name")}: ${items[id]}`);
  }
}
