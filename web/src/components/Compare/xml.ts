// Compare's builds as PoB XML: each side flattened to the sets its loadout uses, Build 1
// matched to Build 2's PoB setup, and the changes toward Build 2 (each a function of the
// build it's applied to, so they stack). Everything comes from diffing the two builds;
// nothing is named by hand. PoB's files are regular enough to edit as text (as pob.codes
// and Path of Building's own importers do), which keeps everything PoB doesn't know about
// untouched.

/** Which set of each kind a loadout uses: places from 1, in the file's order. */
export interface SetPlaces {
  tree: number;
  skills: number;
  items: number;
  config: number;
}

const attr = (tagText: string, name: string) =>
  new RegExp(`\\s${name}="([^"]*)"`).exec(tagText)?.[1];
const unxml = (text: string) =>
  text
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Block {
  text: string;
  start: number;
  end: number;
  /** The opening tag. */
  open: string;
}

/** Every <tag ...>...</tag> (or self-closing) block in `xml`, with its offsets. */
function blocks(xml: string, tag: string): Block[] {
  const re = new RegExp(
    `<${tag}(?=[\\s>/])[^>]*?(?:/>|>[\\s\\S]*?</${tag}>)`,
    "g",
  );
  return [...xml.matchAll(re)].map((m) => ({
    text: m[0],
    start: m.index,
    end: m.index + m[0].length,
    open: /^<[^>]*>/.exec(m[0])![0],
  }));
}
const section = (xml: string, tag: string): Block | undefined =>
  blocks(xml, tag)[0];
const replaceBlock = (xml: string, block: Block, text: string) =>
  xml.slice(0, block.start) + text + xml.slice(block.end);
/** A block's inside, without its own tags. */
const inner = (block: Block, tag: string) =>
  block.text
    .replace(new RegExp(`^<${tag}[^>]*?/>$`), "")
    .replace(new RegExp(`^<${tag}[^>]*>`), "")
    .replace(new RegExp(`</${tag}>$`), "");
const setAttr = (open: string, name: string, value: string) =>
  new RegExp(`\\s${name}="[^"]*"`).test(open)
    ? open.replace(new RegExp(`\\s${name}="[^"]*"`), ` ${name}="${value}"`)
    : open.replace(/^<(\w+)/, `<$1 ${name}="${value}"`);

/**
 * The build with only the sets at `places` (each made the only and active one), so every
 * edit below works on "the" tree, item, skill and config set, and PoB shows those without
 * a loadout. A section without sets (an old file) stays as it is.
 */
export function flatten(xml: string, places: SetPlaces): string {
  const only = (
    sectionTag: string,
    setTag: string,
    activeAttr: string,
    place: number,
    idless = false,
  ) => {
    const sec = section(xml, sectionTag);
    if (!sec) return;
    const sets = blocks(sec.text, setTag);
    if (sets.length === 0) return;
    const set = sets[place - 1] ?? sets[0];
    const head = setAttr(sec.open.replace(/\/>$/, ">"), activeAttr, "1");
    // Outside the sets (Items' <Item>s, a section's own settings): kept.
    let rest = inner(sec, sectionTag);
    for (const other of sets) rest = rest.replace(other.text, () => "");
    const one = idless
      ? set.text
      : set.text.replace(set.open, () => setAttr(set.open, "id", "1"));
    xml = replaceBlock(xml, sec, `${head}${rest}${one}\n</${sectionTag}>`);
  };
  only("Tree", "Spec", "activeSpec", places.tree, true);
  only("Skills", "SkillSet", "activeSkillSet", places.skills);
  only("Items", "ItemSet", "activeItemSet", places.items);
  only("Config", "ConfigSet", "activeConfigSet", places.config);
  return weaponsInUse(xml);
}

/**
 * A build using its second weapon set gets those weapons as Weapon 1 and 2 (and the first
 * set as the swap), with the gems socketed in them, so changes compare the weapons in use.
 */
function weaponsInUse(xml: string): string {
  const set = itemSet(xml);
  if (!set || attr(set.open, "useSecondWeaponSet") !== "true") return xml;
  const swap = (name: string) =>
    name.replace(/^Weapon ([12])( Swap)?(?= Abyssal Socket|$)/, (_, n, isSwap) =>
      isSwap ? `Weapon ${n}` : `Weapon ${n} Swap`,
    );
  const body = set.text
    .replace(set.open, () => setAttr(set.open, "useSecondWeaponSet", "false"))
    .replace(/(<Slot\s[^>]*name=")([^"]*)"/g, (_, head, name) => `${head}${swap(name)}"`);
  xml = replaceBlock(xml, set, body);
  const skills = section(xml, "Skills");
  if (!skills) return xml;
  return replaceBlock(
    xml,
    skills,
    skills.text.replace(/(<Skill\s[^>]*slot=")([^"]*)"/g, (_, head, name) => `${head}${swap(name)}"`),
  );
}

/**
 * The setup of `from` (flattened) in place of `xml`'s: its config, and its party (the
 * party members' buffs PoB keeps in a section of their own).
 */
export function withConfig(xml: string, from: string): string {
  for (const tag of ["Config", "Party"]) {
    const source = section(from, tag);
    const target = section(xml, tag);
    if (source)
      xml = target
        ? replaceBlock(xml, target, source.text)
        : xml.replace("</PathOfBuilding>", () => `${source.text}\n</PathOfBuilding>`);
    else if (target) xml = replaceBlock(xml, target, "");
  }
  return xml;
}

// Items --------------------------------------------------------------------------------

/** The one item set of a flattened build, or the Items section itself without sets. */
function itemSet(xml: string): Block | undefined {
  const sec = section(xml, "Items");
  if (!sec) return undefined;
  const set = blocks(sec.text, "ItemSet")[0];
  return set
    ? { ...set, start: sec.start + set.start, end: sec.start + set.end }
    : sec;
}
function itemsById(xml: string) {
  const sec = section(xml, "Items");
  return new Map(
    (sec ? blocks(sec.text, "Item") : []).map((b) => [attr(b.open, "id")!, b.text]),
  );
}
interface SlotRef {
  id: string;
  active: boolean;
}
function slotMap(setText: string) {
  const slots = new Map<string, SlotRef>();
  for (const match of setText.matchAll(/<Slot\s[^>]*>/g))
    slots.set(attr(match[0], "name") ?? "", {
      id: attr(match[0], "itemId") ?? "0",
      active: attr(match[0], "active") === "true",
    });
  return slots;
}
/** An item's text without its tags and the lines that don't change what it does. */
const itemBody = (item: string) =>
  unxml(
    item
      .replace(/^<Item[^>]*>/, "")
      .replace(/<\/Item>$/, "")
      .replace(/<[^>]+>/g, ""),
  )
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !/^(Unique ID|Item Level|LevelReq|Selected Variant|Catalyst|Has Alt Variant|Sockets)/.test(
          line,
        ),
    );
const itemKey = (item: string | undefined) =>
  item ? itemBody(item).join("\n") : "";
/** A unique's name; otherwise its base. */
function itemLabel(item: string | undefined) {
  if (!item) return "Empty";
  const lines = itemBody(item);
  const rarity = /^Rarity: (\w+)/.exec(lines[0] ?? "")?.[1];
  if (rarity === "UNIQUE") return lines[1] ?? "Item";
  if (rarity === "RARE") return lines[2] || lines[1] || "Item";
  return lines[1] || "Item";
}

// Skills -------------------------------------------------------------------------------

interface Gem {
  text: string;
  name: string;
  level: number;
  enabled: boolean;
  support: boolean;
}
interface Group extends Block {
  slot: string;
  enabled: boolean;
  gems: Gem[];
}
/** The one skill set of a flattened build, or the Skills section itself without sets. */
function skillSet(xml: string): Block | undefined {
  const sec = section(xml, "Skills");
  if (!sec) return undefined;
  const set = blocks(sec.text, "SkillSet")[0];
  return set
    ? { ...set, start: sec.start + set.start, end: sec.start + set.end }
    : sec;
}
function groupsOf(setText: string): Group[] {
  return blocks(setText, "Skill").map((b) => ({
    ...b,
    slot: attr(b.open, "slot") ?? "",
    enabled: attr(b.open, "enabled") !== "false",
    gems: [...b.text.matchAll(/<Gem\s[^>]*>/g)].map((m) => ({
      text: m[0],
      name: unxml(attr(m[0], "nameSpec") ?? ""),
      level: Number(attr(m[0], "level") ?? 0),
      enabled: attr(m[0], "enabled") !== "false",
      support:
        /^Support/.test(attr(m[0], "skillId") ?? "") ||
        / Support$/.test(attr(m[0], "nameSpec") ?? ""),
    })),
  }));
}
const activeNames = (group: Group | undefined) =>
  group?.gems.filter((gem) => gem.enabled && !gem.support).map((gem) => gem.name) ??
  [];
const enabledNames = (group: Group | undefined) =>
  group?.gems.filter((gem) => gem.enabled).map((gem) => gem.name) ?? [];

// Path ---------------------------------------------------------------------------------
// Build 1 is first matched to Build 2's PoB setup (Build 2's config and custom mods, its
// skill parts, its unsocketed stand-in groups, and Build 1's skills that only lower PoB's
// numbers), then changed one piece of Build 2 at a time. Each change is a function of the
// build it's applied to, so changes stack.

export type ChangeKind = "Links" | "Gems" | "Gear" | "Tree" | "Sockets";

/** A PoB-only setup difference, matched before the path. */
export interface Fix {
  id: string;
  kind: "Config" | "Skill";
  title: string;
  detail: string;
  /** Kept only when it raises Build 1's DPS (a skill PoB counts against it). */
  test?: boolean;
  apply: (xml: string) => string;
}

/** One piece of Build 2 to try on Build 1. `target`: what its Show opens. */
export interface Change {
  id: string;
  kind: ChangeKind;
  title: string;
  detail: string;
  /** "items" (with `slot`), "skills" or "passives" (no Show). */
  target: string;
  /** The Items row to open, for gear. */
  slot?: string;
  apply: (xml: string) => string;
}

const SLOT_ORDER = [
  "Weapon 1",
  "Weapon 2",
  "Helmet",
  "Body Armour",
  "Gloves",
  "Boots",
  "Amulet",
  "Ring 1",
  "Ring 2",
  "Ring 3",
  "Belt",
];
const FLASKS = ["Flask 1", "Flask 2", "Flask 3", "Flask 4", "Flask 5"];
const slug = (text: string) => text.replace(/\W+/g, "-");

const decode = (text: string) =>
  unxml(
    text
      .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
      .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))),
  );
const escapeXml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Config ----

/** Custom modifier blocks (and the older single input) in a config. */
const MODS_RE =
  /<CustomModifierBlock\b[^>]*?(?:\/>|>[\s\S]*?<\/CustomModifierBlock>)|<Input\s[^>]*name="customMods"[^>]*\/>/g;
/** The custom modifier lines a build's config applies. */
function modLines(xml: string): string[] {
  const config = section(xml, "Config")?.text ?? "";
  return (config.match(MODS_RE) ?? [])
    .flatMap((block) => {
      if (block.startsWith("<Input")) return decode(attr(block, "string") ?? "").split(/\r?\n/);
      const open = /^<[^>]*>/.exec(block)![0];
      if (attr(open, "enabled") === "false") return [];
      return decode(block.slice(open.length).replace(/<\/CustomModifierBlock>$/, "")).split(/\r?\n/);
    })
    .map((line) => line.trim())
    .filter(Boolean);
}
/** The older single custom mods input as a block: PoB ignores that input once a set has blocks. */
const asBlock = (block: string) =>
  block.startsWith("<Input")
    ? `<CustomModifierBlock enabled="true" title="Default">${escapeXml(decode(attr(block, "string") ?? ""))}</CustomModifierBlock>`
    : block;
/** `blocks` added to the build's (one) config set, its own older input turned into a block. */
function addToConfig(xml: string, blocks: string[]): string {
  if (blocks.length === 0) return xml;
  const text = blocks.map(asBlock).join("\n");
  const sec = section(xml, "Config");
  if (!sec) return xml.replace("</PathOfBuilding>", () => `<Config>\n${text}\n</Config>\n</PathOfBuilding>`);
  const own = sec.text.replace(MODS_RE, (block) => asBlock(block));
  const body = /<\/ConfigSet>/.test(own)
    ? own.replace(/<\/ConfigSet>(?![\s\S]*<\/ConfigSet>)/, () => `${text}\n</ConfigSet>`)
    : /\/>$/.test(sec.open) && own === sec.open
      ? own.replace(/\/>$/, () => `>\n${text}\n</Config>`)
      : own.replace(/<\/Config>$/, () => `${text}\n</Config>`);
  return replaceBlock(xml, sec, body);
}

// Skills ----

/** `xml` with its (one) skill set rewritten by `edit`. */
function editSkills(xml: string, edit: (setText: string) => string) {
  const set = skillSet(xml);
  return set ? replaceBlock(xml, set, edit(set.text)) : xml;
}
/** `setText` with group `index` (from 0) rewritten by `edit`. */
function editGroup(setText: string, index: number, edit: (group: Group) => string) {
  const group = groupsOf(setText)[index];
  return group ? setText.slice(0, group.start) + edit(group) + setText.slice(group.end) : setText;
}
const groupsIn = (xml: string) => groupsOf(skillSet(xml)?.text ?? "");
/** Every gem name enabled in an enabled group. */
const namesIn = (groups: Group[]) =>
  new Set(groups.filter((g) => g.enabled).flatMap((g) => enabledNames(g)));
/** A group PoB counts without a socket: a guide's stand-in (not a skill an item grants). */
const standIn = (group: Group) =>
  !group.slot && group.enabled && !/\ssource="/.test(group.open) && activeNames(group).length > 0;

/**
 * The place (from 1) in a flattened build's skill set of PoB's main group `live`. PoB's own
 * list leaves out groups an unequipped item grants, so its place can be lower than the
 * group's in the file: the group with the main skill's gem (`skillId`, PoB's granted effect
 * id), the first at or after `live` when several have it.
 */
export function mainGroupIn(xml: string, skillId: string | null, live: number | null): number | null {
  if (live === null || !skillId) return live;
  const places = groupsIn(xml)
    .map((g, i) =>
      g.enabled &&
      [...g.text.matchAll(/<Gem\s[^>]*>/g)].some(
        (m) => attr(m[0], "enabled") !== "false" && (attr(m[0], "skillId") === skillId || attr(m[0], "variantId") === skillId),
      )
        ? i + 1
        : 0,
    )
    .filter((place) => place > 0);
  return places.find((place) => place >= live) ?? places[0] ?? live;
}

/** The skill choices PoB keeps on a gem (which part, how many stages). */
const PART_ATTRS = ["skillPart", "skillPartCalcs", "skillStageCount", "skillStageCountCalcs"];

/**
 * Build 2's PoB setup for Build 1, in order: its config (Build 1's own custom mods kept),
 * its custom mods, its skill parts for gems both use outside the main group, and its
 * stand-in groups (unsocketed, a gem Build 1 hasn't).
 */
export function setupFixes(
  one: string,
  two: string,
  oneMain: number | null,
  twoMain: number | null,
): Fix[] {
  const out: Fix[] = [];
  const settings = (xml: string) =>
    new Map(
      [...(section(xml, "Config")?.text ?? "").matchAll(/<Input\s[^>]*>/g)]
        .filter((m) => attr(m[0], "name") !== "customMods")
        .map((m) => [attr(m[0], "name") ?? m[0], m[0].replace(/\s*\/?>$/, "")]),
    );
  const mine = settings(one);
  const theirs = settings(two);
  const changed = [...new Set([...mine.keys(), ...theirs.keys()])].filter(
    (name) => mine.get(name) !== theirs.get(name),
  ).length;
  const party = (xml: string) => section(xml, "Party")?.text ?? "";
  if (changed > 0 || party(one) !== party(two))
    out.push({
      id: "config",
      kind: "Config",
      title: "Settings",
      detail: changed ? `${changed} differ` : "Party only",
      apply: (xml) => {
        const own = (section(xml, "Config")?.text ?? "").match(MODS_RE) ?? [];
        let next = withConfig(xml, two);
        const sec = section(next, "Config");
        if (sec) next = replaceBlock(next, sec, sec.text.replace(MODS_RE, ""));
        return addToConfig(next, own);
      },
    });

  const ownLines = new Set(modLines(one));
  const extra = modLines(two).filter((line) => !ownLines.has(line));
  if (extra.length)
    out.push({
      id: "mods",
      kind: "Config",
      title: "Custom mods",
      detail: `${extra.length} line${extra.length > 1 ? "s" : ""}`,
      apply: (xml) => {
        const have = new Set(modLines(xml));
        const lines = modLines(two).filter((line) => !have.has(line));
        return lines.length
          ? addToConfig(xml, [
              `<CustomModifierBlock enabled="true" title="Build 2">${escapeXml(lines.join("\n"))}</CustomModifierBlock>`,
            ])
          : xml;
      },
    });

  const oneGroups = groupsIn(one);
  const twoGroups = groupsIn(two);
  const outside = (groups: Group[], main: number | null) =>
    groups.filter((g, i) => g.enabled && i !== (main ?? 0) - 1);
  const theirGems = new Map<string, Gem>();
  for (const g of outside(twoGroups, twoMain))
    for (const gem of g.gems) if (gem.enabled && !theirGems.has(gem.name)) theirGems.set(gem.name, gem);
  const done = new Set<string>();
  for (const g of outside(oneGroups, oneMain))
    for (const gem of g.gems) {
      const their = theirGems.get(gem.name);
      if (!gem.enabled || !their || done.has(gem.name)) continue;
      const differ = PART_ATTRS.filter(
        (a) => attr(their.text, a) !== undefined && attr(their.text, a) !== attr(gem.text, a),
      );
      if (differ.length === 0) continue;
      done.add(gem.name);
      const stages = differ.every((a) => a.startsWith("skillStage"));
      out.push({
        id: "part-" + slug(gem.name),
        kind: "Skill",
        title: gem.name,
        detail: stages ? "Stages as Build 2" : "Skill part as Build 2",
        apply: (xml) =>
          editSkills(xml, (set) => {
            const groups = groupsOf(set);
            // Last group first, so earlier offsets stay right.
            for (let i = groups.length - 1; i >= 0; i--) {
              if (!groups[i].enabled || i === (oneMain ?? 0) - 1) continue;
              set = editGroup(set, i, (group) =>
                group.text.replace(/<Gem\s[^>]*>/g, (tag) => {
                  if (unxml(attr(tag, "nameSpec") ?? "") !== gem.name) return tag;
                  for (const a of differ) tag = setAttr(tag, a, attr(their.text, a)!);
                  return tag;
                }),
              );
            }
            return set;
          }),
      });
    }

  const have = namesIn(oneGroups);
  for (const [j, g] of twoGroups.entries()) {
    if (!standIn(g) || activeNames(g).some((name) => have.has(name))) continue;
    const text = g.text.replace(/\sslot="[^"]*"/, "");
    out.push({
      id: `group-${j}-` + slug(activeNames(g).join("-")),
      kind: "Skill",
      title: activeNames(g).join(", "),
      detail: "Unsocketed in Build 2",
      apply: (xml) =>
        editSkills(xml, (set) => set.replace(/<\/(SkillSet|Skills)>$/, (_, tag: string) => `${text}\n</${tag}>`)),
    });
  }
  return out;
}

/**
 * Build 1's skills Build 2 hasn't, each to try switched off: PoB can count a skill against
 * the main one (Holy Relic's Nova triggered by the fastest attack, a movement skill), so one
 * that raises the DPS when off is left out.
 */
export function offTests(one: string, two: string, oneMain: number | null): Fix[] {
  const theirs = namesIn(groupsIn(two));
  const out: Fix[] = [];
  groupsIn(one).forEach((g, i) => {
    if (!g.enabled || i === (oneMain ?? 0) - 1) return;
    const lone = activeNames(g).filter((name) => !theirs.has(name));
    if (lone.length === 0) return;
    out.push({
      id: `off-${i}-` + slug(`${g.slot || "group"}-${lone[0]}`),
      kind: "Skill",
      title: lone.join(", "),
      detail: "Switched off",
      test: true,
      apply: (xml) =>
        editSkills(xml, (set) =>
          editGroup(set, i, (group) => group.text.replace(group.open, () => setAttr(group.open, "enabled", "false"))),
        ),
    });
  });
  return out;
}

// Sockets ----

/** An item mod that gives gems something by their socket's color (Dialla's Malefaction). */
const COLOR_MOD = /Socketed in (Red|Green|Blue) Sockets/i;
function itemInSlot(xml: string, slot: string) {
  const ref = slotMap(itemSet(xml)?.text ?? "").get(slot);
  return ref && ref.id !== "0" ? itemsById(xml).get(ref.id) : undefined;
}
/** An item's socket colors in order (R, G, B, W), abyssal sockets left out. */
function socketColors(item: string) {
  const line = /Sockets:\s*([^<\r\n]*)/.exec(item)?.[1] ?? "";
  return [...line.toUpperCase().replace(/[^RGBWA]/g, "")].filter((c) => c !== "A");
}
/**
 * The gems in socket order, each wanted gem in a socket of the color it has in Build 2
 * (a white one does too), the rest in their order in the sockets left.
 */
function arrange(gems: Gem[], colors: string[], want: Map<string, string>): Gem[] {
  const out: (Gem | undefined)[] = gems.map(() => undefined);
  const rest: Gem[] = [];
  const free = (color: string) => out.findIndex((g, k) => g === undefined && colors[k] === color);
  for (const gem of gems) {
    const color = want.get(gem.name);
    let at = color === undefined ? -1 : free(color);
    if (at < 0 && color !== undefined) at = free("W");
    if (at < 0) rest.push(gem);
    else out[at] = gem;
  }
  return out.map((g) => g ?? rest.shift()!);
}
/** Group `index` of `xml` with its gems in the sockets `want` asks for, when its item has a color mod. */
function settle(xml: string, index: number, want: Map<string, string> | null) {
  if (!want) return xml;
  return editSkills(xml, (set) =>
    editGroup(set, index, (group) => {
      const item = itemInSlot(xml, group.slot);
      if (!item || !COLOR_MOD.test(item)) return group.text;
      const order = arrange(group.gems, socketColors(item), want);
      let k = 0;
      return group.text.replace(/<Gem\s[^>]*>/g, () => order[k++].text);
    }),
  );
}

// Changes ----

/**
 * The changes from Build 1 (`one`, already on Build 2's setup) toward Build 2 (`two`), each
 * applied to whatever build it's given: each gear slot that differs (weapons as a pair
 * around a two-hander, flasks as a set), the whole tree with its jewels, gem swaps and added
 * supports in groups the builds share (the main skill's by `oneMain`/`twoMain`, PoB's group
 * places from 1; `twoMain` null when Build 2 hasn't Build 1's skill), gems in Build 2's
 * socket colors, supports unlinked in the main skill's item, and higher gem levels.
 */
export function changes(
  one: string,
  two: string,
  oneMain: number | null,
  twoMain: number | null,
): Change[] {
  const out: Change[] = [];
  const add = (change: Change) => out.push(change);

  // ---- Gear ----
  const twoItems = itemsById(two);
  const twoSlots = slotMap(itemSet(two)?.text ?? "");
  const baseItems = itemsById(one);
  const baseSlots = slotMap(itemSet(one)?.text ?? "");
  const itemIn = (slots: Map<string, SlotRef>, items: Map<string, string>, name: string) => {
    const slot = slots.get(name);
    return slot && slot.id !== "0" ? items.get(slot.id) : undefined;
  };
  /** Build 2's items `ids` copied into `xml` with new ids past every id it has. */
  const withItems = (xml: string, ids: string[]) => {
    const offset =
      Math.max(0, ...[...itemsById(xml).keys()].map(Number).filter(Number.isFinite)) + 1000;
    const copies = [...new Set(ids)].map((id) =>
      twoItems.get(id)!.replace(/(<Item\s[^>]*id=")(\d+)"/, (_, head, n) => `${head}${Number(n) + offset}"`),
    );
    return {
      offset,
      xml: copies.length ? xml.replace(/(<Items[^>]*>)/, (head) => `${head}\n${copies.join("\n")}`) : xml,
    };
  };
  /** Build 2's items for these slots (and their abyssal jewels) in `xml`'s item set. */
  const swapSlots = (xml: string, slots: string[]) => {
    const ownSlots = slotMap(itemSet(xml)?.text ?? "");
    const under = (name: string, slot: string) => name === slot || name.startsWith(slot + " Abyssal Socket");
    const names = [...new Set([...twoSlots.keys(), ...ownSlots.keys()])].filter((name) =>
      slots.some((slot) => under(name, slot)),
    );
    const ids = names
      .map((name) => twoSlots.get(name)?.id)
      .filter((id): id is string => !!id && id !== "0" && twoItems.has(id));
    const copied = withItems(xml, ids);
    xml = copied.xml;
    const set = itemSet(xml);
    if (!set) return xml;
    let body = set.text;
    for (const name of names) {
      const theirs = twoSlots.get(name);
      const newId =
        theirs && theirs.id !== "0" && twoItems.has(theirs.id) ? String(Number(theirs.id) + copied.offset) : "0";
      // Flasks count only when ticked "in use": ticked when either build uses that slot
      // (a Mageblood build ticks few; the other ticks what it drinks).
      const on = theirs?.active || (/^Flask \d$/.test(name) && newId !== "0" && ownSlots.get(name)?.active);
      const slot = `<Slot ${on ? 'active="true" ' : ""}itemId="${newId}" itemPbURL="" name="${name}"/>`;
      const re = new RegExp(`<Slot\\s[^>]*name="${escapeRe(name)}"[^>]*/>`);
      body = re.test(body)
        ? body.replace(re, () => slot)
        : set.text.startsWith("<Items")
          ? body.replace(/<\/Items>$/, () => `${slot}\n</Items>`)
          : body.replace(/<\/ItemSet>$/, () => `${slot}\n</ItemSet>`);
    }
    return replaceBlock(xml, set, body);
  };

  const slotKey = (slots: Map<string, SlotRef>, items: Map<string, string>, name: string) => {
    const own = itemKey(itemIn(slots, items, name));
    const abyss = [...slots.keys()]
      .filter((n) => n.startsWith(name + " Abyssal Socket"))
      .map((n) => itemKey(itemIn(slots, items, n)))
      .sort();
    return own + "\n" + abyss.join("\n");
  };
  const differs = (name: string) => slotKey(twoSlots, twoItems, name) !== slotKey(baseSlots, baseItems, name);
  const has = (slots: Map<string, SlotRef>, items: Map<string, string>, name: string) =>
    !!itemIn(slots, items, name);
  const abyssNote = (name: string) => {
    const counts = new Map<string, number>();
    for (const n of twoSlots.keys()) {
      if (!n.startsWith(name + " Abyssal Socket")) continue;
      const item = itemIn(twoSlots, twoItems, n);
      if (!item) continue;
      const base = itemLabel(item).replace(/ Jewel$/, "");
      counts.set(base, (counts.get(base) ?? 0) + 1);
    }
    return [...counts].map(([base, n]) => ` · ${n > 1 ? n + " " : ""}${base}`).join("");
  };
  const slotNames = [...new Set([...twoSlots.keys(), ...baseSlots.keys()])].filter(
    (n) => !/Swap|Abyssal Socket|^Flask /.test(n),
  );
  const gearSlots = [
    ...SLOT_ORDER.filter((s) => slotNames.includes(s)),
    ...slotNames.filter((s) => !SLOT_ORDER.includes(s)).sort(),
  ];
  // Weapons go as a pair when either side has an empty off hand (a two-hander).
  const weaponPair =
    ["Weapon 1", "Weapon 2"].some(differs) &&
    (!has(twoSlots, twoItems, "Weapon 2") || !has(baseSlots, baseItems, "Weapon 2"));
  if (weaponPair && has(twoSlots, twoItems, "Weapon 1")) {
    const names = ["Weapon 1", "Weapon 2"]
      .filter((s) => has(twoSlots, twoItems, s))
      .map((s) => itemLabel(itemIn(twoSlots, twoItems, s)));
    add({
      id: "gear-weapons",
      kind: "Gear",
      title: "Weapons",
      detail: names.join(" + "),
      target: "items",
      slot: "Weapon 1",
      apply: (xml) => swapSlots(xml, ["Weapon 1", "Weapon 2"]),
    });
  }
  for (const slot of gearSlots) {
    if (weaponPair && /^Weapon [12]$/.test(slot)) continue;
    if (!differs(slot) || !has(twoSlots, twoItems, slot)) continue;
    add({
      id: "gear-" + slug(slot),
      kind: "Gear",
      title: slot,
      detail: itemLabel(itemIn(twoSlots, twoItems, slot)) + abyssNote(slot),
      target: "items",
      slot,
      apply: (xml) => swapSlots(xml, [slot]),
    });
  }
  // Flasks go as a set: builds order them differently.
  const flaskNames = (slots: Map<string, SlotRef>) => [...slots.keys()].filter((n) => /^Flask \d$/.test(n));
  const flaskKeys = (slots: Map<string, SlotRef>, items: Map<string, string>) =>
    flaskNames(slots)
      .map((n) => (slots.get(n)!.active ? "on:" : "off:") + itemKey(itemIn(slots, items, n)))
      .filter((k) => !/:$/.test(k))
      .sort()
      .join("\n\n");
  if (
    flaskKeys(twoSlots, twoItems) !== flaskKeys(baseSlots, baseItems) &&
    flaskNames(twoSlots).some((n) => has(twoSlots, twoItems, n))
  ) {
    const mine = new Set(
      flaskNames(baseSlots)
        .map((n) => itemIn(baseSlots, baseItems, n))
        .filter((item): item is string => !!item)
        .map(itemKey),
    );
    const theirs = flaskNames(twoSlots).filter((n) => has(twoSlots, twoItems, n));
    const fresh = theirs.filter((n) => !mine.has(itemKey(itemIn(twoSlots, twoItems, n))));
    add({
      id: "gear-flasks",
      kind: "Gear",
      title: "Flasks",
      detail: fresh.length ? `${fresh.length} differ` : "Toggles differ",
      target: "items",
      slot: fresh[0] ?? theirs[0],
      apply: (xml) => swapSlots(xml, FLASKS),
    });
  }

  // ---- Tree: Build 2's tree with its jewels, when either differs ----
  const oneSpec = section(one, "Spec");
  const twoSpec = section(two, "Spec");
  if (oneSpec && twoSpec) {
    const nodesOf = (spec: Block) => (attr(spec.open, "nodes") ?? "").split(",").filter(Boolean).sort().join();
    const jewelsOf = (spec: Block, items: Map<string, string>) =>
      [...spec.text.matchAll(/<Socket\s[^>]*>/g)]
        .map((m) => m[0])
        .filter((s) => attr(s, "itemId") !== "0")
        .map((s) => attr(s, "nodeId") + ":" + itemKey(items.get(attr(s, "itemId") ?? "")))
        .sort();
    const jewels = jewelsOf(twoSpec, twoItems);
    if (nodesOf(oneSpec) !== nodesOf(twoSpec) || jewels.join("\n") !== jewelsOf(oneSpec, baseItems).join("\n")) {
      const ids = [...twoSpec.text.matchAll(/<Socket\s[^>]*itemId="(\d+)"/g)]
        .map((m) => m[1])
        .filter((id) => id !== "0" && twoItems.has(id));
      add({
        id: "tree",
        kind: "Tree",
        title: "Whole tree",
        detail: jewels.length ? `${jewels.length} jewel${jewels.length > 1 ? "s" : ""}` : "No jewels",
        target: "passives",
        apply: (xml) => {
          const copied = withItems(xml, ids);
          const spec = twoSpec.text.replace(/(<Socket\s[^>]*itemId=")(\d+)"/g, (_, head, n) =>
            n === "0" || !twoItems.has(n) ? `${head}0"` : `${head}${Number(n) + copied.offset}"`,
          );
          const own = section(copied.xml, "Spec");
          return own ? replaceBlock(copied.xml, own, spec) : copied.xml;
        },
      });
    }
  }

  // ---- Skills ----
  const oneGroups = groupsIn(one);
  const twoGroups = groupsIn(two);
  if (oneGroups.length === 0 || twoGroups.length === 0) return out;
  const live = (g: Group) => g.enabled && enabledNames(g).length > 0;
  const mainI = oneMain === null ? -1 : oneMain - 1;
  const mainJ = twoMain === null ? -1 : twoMain - 1;

  // Groups the builds share: the main skill's, then each of Build 1's with the socketed
  // group of Build 2's it shares most gems with (two, or one in the same slot).
  const pairs: { i: number; theirs: Group }[] = [];
  const used = new Set<number>([mainJ]);
  if (oneGroups[mainI] && twoGroups[mainJ]) pairs.push({ i: mainI, theirs: twoGroups[mainJ] });
  oneGroups.forEach((g, i) => {
    if (i === mainI || !live(g)) return;
    let best = -1;
    let bestShared = 0;
    twoGroups.forEach((t, j) => {
      if (used.has(j) || !live(t) || !t.slot) return;
      const shared = enabledNames(t).filter((name) => enabledNames(g).includes(name)).length;
      if (shared > bestShared) {
        best = j;
        bestShared = shared;
      }
    });
    if (best >= 0 && (bestShared >= 2 || twoGroups[best].slot === g.slot)) {
      used.add(best);
      pairs.push({ i, theirs: twoGroups[best] });
    }
  });

  for (const { i, theirs } of pairs) {
    const mine = oneGroups[i];
    const mineNames = enabledNames(mine);
    const theirNames = enabledNames(theirs);
    // Where Build 2 socketed each gem, when its item gives gems something by color.
    const theirItem = itemInSlot(two, theirs.slot);
    const want =
      theirItem && COLOR_MOD.test(theirItem)
        ? new Map(
            theirs.gems
              .map((gem, k) => [gem.name, socketColors(theirItem)[k]] as const)
              .filter((pair): pair is readonly [string, string] => pair[1] !== undefined),
          )
        : null;
    const where = mine.slot || activeNames(mine)[0] || "Group";
    const plus = theirs.gems.filter((gem) => gem.enabled && !mineNames.includes(gem.name));
    const minus = mine.gems.filter((gem) => gem.enabled && !theirNames.includes(gem.name));
    const extra: Gem[] = [];
    for (const support of [true, false]) {
      const p = plus.filter((gem) => gem.support === support);
      const m = minus.filter((gem) => gem.support === support);
      p.forEach((gem, k) => {
        const old = m[k];
        if (!old) {
          extra.push(gem);
          return;
        }
        add({
          id: `swap-${i}-${slug(old.name)}-${slug(gem.name)}`,
          kind: support ? "Links" : "Gems",
          title: gem.name,
          detail: `In place of ${old.name}`,
          target: "skills",
          apply: (xml) =>
            settle(
              editSkills(xml, (set) =>
                editGroup(set, i, (group) => {
                  const found = group.gems.find((m) => m.enabled && m.name === old.name);
                  return found ? group.text.replace(found.text, () => gem.text) : group.text;
                }),
              ),
              i,
              want,
            ),
        });
      });
    }
    // A gem Build 2 links that Build 1's group has room for.
    extra.slice(0, Math.max(0, theirNames.length - mineNames.length)).forEach((gem) =>
      add({
        id: `add-${i}-${slug(gem.name)}`,
        kind: gem.support ? "Links" : "Gems",
        title: gem.name,
        detail: `Added to ${where}`,
        target: "skills",
        apply: (xml) =>
          settle(
            editSkills(xml, (set) =>
              editGroup(set, i, (group) =>
                group.gems.some((m) => m.enabled && m.name === gem.name)
                  ? group.text
                  : group.text.replace(/<\/Skill>$/, () => gem.text + "\n</Skill>"),
              ),
            ),
            i,
            want,
          ),
      }),
    );
    // Build 1's gems moved to the socket colors Build 2 uses.
    const ownItem = itemInSlot(one, mine.slot);
    if (want && ownItem && COLOR_MOD.test(ownItem)) {
      const order = arrange(mine.gems, socketColors(ownItem), want);
      if (order.some((gem, k) => gem !== mine.gems[k]))
        add({
          id: `sockets-${i}-` + slug(where),
          kind: "Sockets",
          title: where,
          detail: "Colors as Build 2",
          target: "skills",
          apply: (xml) => settle(xml, i, want),
        });
    }
  }

  // Unlinked supports: a group of only supports in the main skill's item supports nothing
  // (its sockets aren't linked to the skill). Linking them is a change whatever Build 2 does.
  const mainGroup = oneGroups[mainI];
  if (mainGroup?.slot) {
    const linked = new Set<string>();
    oneGroups.forEach((group, index) => {
      if (group === mainGroup || !group.enabled || group.slot !== mainGroup.slot) return;
      if (group.gems.some((gem) => gem.enabled && !gem.support)) return;
      for (const support of group.gems) {
        if (!support.enabled || !support.support) continue;
        if (enabledNames(mainGroup).includes(support.name) || linked.has(support.name)) continue;
        linked.add(support.name);
        add({
          id: "unlinked-" + slug(support.name),
          kind: "Links",
          title: `${support.name} link`,
          detail: `Unlinked in ${group.slot}`,
          target: "skills",
          apply: (xml) =>
            editSkills(xml, (set) => {
              const g = groupsOf(set)[index];
              const gem = g?.gems.find((m) => m.name === support.name && m.enabled);
              if (!g || !gem) return set;
              set = set.slice(0, g.start) + g.text.replace(gem.text, "") + set.slice(g.end);
              return editGroup(set, mainI, (main) => main.text.replace(/<\/Skill>$/, () => gem.text + "\n</Skill>"));
            }),
        });
      }
    });
  }

  // Gem levels: every gem both use that Build 2 has at a higher level (the top 20).
  const levels = (groups: Group[]) => {
    const map = new Map<string, number>();
    for (const g of groups)
      if (g.enabled)
        for (const gem of g.gems) if (gem.enabled) map.set(gem.name, Math.max(map.get(gem.name) ?? 0, gem.level));
    return map;
  };
  const theirLevels = levels(twoGroups);
  const ups = [...levels(oneGroups)]
    .filter(([name, level]) => (theirLevels.get(name) ?? 0) > level)
    .map(([name, from]) => ({ name, from, to: theirLevels.get(name)! }))
    .sort((a, b) => b.to - b.from - (a.to - a.from))
    .slice(0, 20);
  for (const up of ups)
    add({
      id: "gem-" + slug(up.name),
      kind: "Gems",
      title: up.name,
      detail: `Lvl ${up.from} → ${up.to}`,
      target: "skills",
      apply: (xml) =>
        editSkills(xml, (set) =>
          set.replace(/<Gem\s[^>]*>/g, (tag) =>
            unxml(attr(tag, "nameSpec") ?? "") === up.name ? tag.replace(/\slevel="\d+"/, ` level="${up.to}"`) : tag,
          ),
        ),
    });

  return out;
}

/** The active skill names of a flattened build's group (place from 1), for the header. */
export function mainSkillNames(xml: string, group: number | null) {
  const set = skillSet(xml);
  if (!set || group === null) return [];
  return activeNames(groupsOf(set.text)[group - 1]);
}
