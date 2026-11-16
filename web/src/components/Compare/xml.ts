// Compare's builds as PoB XML: each side flattened to the sets its loadout uses, Build 2
// on Build 1's config, and the gaps: Build 1 with one piece of Build 2 swapped in at a
// time. Every gap comes from diffing the two builds; nothing is named by hand. PoB's
// files are regular enough to edit as text (as pob.codes and Path of Building's own
// importers do), which keeps everything PoB doesn't know about untouched.

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
 * set as the swap), with the gems socketed in them, so gaps compare the weapons in use.
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

// Gaps ---------------------------------------------------------------------------------

export type GapKind = "Links" | "Gems" | "Gear" | "Tree" | "Config";

/** One gap: Build 1 with one piece of Build 2. `target`: what its Show opens. */
export interface Variant {
  id: string;
  kind: GapKind;
  title: string;
  detail: string;
  /** What its Show opens: "items" (with `slot`) or "skills"; "passives" and "config" have no Show. */
  target: string;
  /** The Items row to open, for gear. */
  slot?: string;
  xml: string;
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

/**
 * The gaps between two flattened builds, each a build of its own for PoB: Build 1 (`one`)
 * with one piece of Build 2 (`two`) at a time. `oneMain` and `twoMain` are the main skill's
 * socket groups (places from 1, PoB's); `twoMain` is null when Build 2 hasn't Build 1's
 * skill (then no link or support gaps: the skills aren't the same).
 */
export function variants(
  one: string,
  two: string,
  oneMain: number | null,
  twoMain: number | null,
): Variant[] {
  const out: Variant[] = [];
  const gap = (v: Variant) => out.push(v);

  // Build 2's config on Build 1: how much of the difference is the setup, not the build.
  const settings = (xml: string) =>
    new Map(
      // Settings, not PoB's placeholders (the defaults it shows).
      [...(section(xml, "Config")?.text ?? "").matchAll(/<Input\s[^>]*>/g)].map(
        (m) => [attr(m[0], "name") ?? m[0], m[0].replace(/\s*\/?>$/, "")],
      ),
    );
  const mine = settings(one);
  const theirs = settings(two);
  const changed = [...new Set([...mine.keys(), ...theirs.keys()])].filter(
    (name) => mine.get(name) !== theirs.get(name),
  ).length;
  const setup = (xml: string) =>
    (section(xml, "Config")?.text ?? "") + (section(xml, "Party")?.text ?? "");
  if (setup(two) !== setup(one))
    gap({
      id: "config",
      kind: "Config",
      title: "All config",
      detail: changed
        ? `${changed} differ`
        : section(two, "Config")?.text === section(one, "Config")?.text
          ? "Party"
          : "Custom mods",
      target: "config",
      xml: withConfig(one, two),
    });

  // ---- Gear ----
  const oneItems = itemsById(one);
  const twoItems = itemsById(two);
  const oneSlots = slotMap(itemSet(one)?.text ?? "");
  const twoSlots = slotMap(itemSet(two)?.text ?? "");
  const itemIn = (
    slots: Map<string, SlotRef>,
    items: Map<string, string>,
    name: string,
  ) => {
    const slot = slots.get(name);
    return slot && slot.id !== "0" ? items.get(slot.id) : undefined;
  };
  // New ids for Build 2's items in Build 1, past every id it has.
  const offset =
    Math.max(0, ...[...oneItems.keys()].map(Number).filter(Number.isFinite)) +
    1000;
  const copyItem = (id: string) =>
    twoItems
      .get(id)!
      .replace(/(<Item\s[^>]*id=")(\d+)"/, (_, head, n) => `${head}${Number(n) + offset}"`);
  const addItems = (xml: string, ids: string[]) =>
    xml.replace(
      /(<Items[^>]*>)/,
      (head) => `${head}\n${[...new Set(ids)].map(copyItem).join("\n")}`,
    );

  /** Build 2's items for these slots (and their abyssal jewels) in Build 1's item set. */
  const swapSlots = (xml: string, slots: string[]) => {
    const under = (name: string, slot: string) =>
      name === slot || name.startsWith(slot + " Abyssal Socket");
    const names = [...new Set([...twoSlots.keys(), ...oneSlots.keys()])].filter(
      (name) => slots.some((slot) => under(name, slot)),
    );
    const ids = names
      .map((name) => twoSlots.get(name)?.id)
      .filter((id): id is string => !!id && id !== "0" && twoItems.has(id));
    xml = addItems(xml, ids);
    const set = itemSet(xml);
    if (!set) return xml;
    let body = set.text;
    for (const name of names) {
      const theirs = twoSlots.get(name);
      const newId =
        theirs && theirs.id !== "0" && twoItems.has(theirs.id)
          ? String(Number(theirs.id) + offset)
          : "0";
      // Flasks count only when ticked "in use": ticked when either build uses that slot
      // (a Mageblood build ticks few; the other ticks what it drinks).
      const on =
        theirs?.active ||
        (/^Flask \d$/.test(name) && newId !== "0" && oneSlots.get(name)?.active);
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

  const slotKey = (
    slots: Map<string, SlotRef>,
    items: Map<string, string>,
    name: string,
  ) => {
    const own = itemKey(itemIn(slots, items, name));
    const abyss = [...slots.keys()]
      .filter((n) => n.startsWith(name + " Abyssal Socket"))
      .map((n) => itemKey(itemIn(slots, items, n)))
      .sort();
    return own + "\n" + abyss.join("\n");
  };
  const differs = (name: string) =>
    slotKey(twoSlots, twoItems, name) !== slotKey(oneSlots, oneItems, name);
  const has = (
    slots: Map<string, SlotRef>,
    items: Map<string, string>,
    name: string,
  ) => !!itemIn(slots, items, name);
  const abyssNote = (name: string) => {
    const counts = new Map<string, number>();
    for (const n of twoSlots.keys()) {
      if (!n.startsWith(name + " Abyssal Socket")) continue;
      const item = itemIn(twoSlots, twoItems, n);
      if (!item) continue;
      const base = itemLabel(item).replace(/ Jewel$/, "");
      counts.set(base, (counts.get(base) ?? 0) + 1);
    }
    return [...counts]
      .map(([base, n]) => ` · ${n > 1 ? n + " " : ""}${base}`)
      .join("");
  };
  const slotNames = [...new Set([...twoSlots.keys(), ...oneSlots.keys()])].filter(
    (n) => !/Swap|Abyssal Socket|^Flask /.test(n),
  );
  const gearSlots = [
    ...SLOT_ORDER.filter((s) => slotNames.includes(s)),
    ...slotNames.filter((s) => !SLOT_ORDER.includes(s)).sort(),
  ];
  // Weapons go as a pair when either side has an empty off hand (a two-hander).
  const weaponPair =
    ["Weapon 1", "Weapon 2"].some(differs) &&
    (!has(twoSlots, twoItems, "Weapon 2") || !has(oneSlots, oneItems, "Weapon 2"));
  const gearGaps: string[] = [];
  if (weaponPair && has(twoSlots, twoItems, "Weapon 1")) {
    const names = ["Weapon 1", "Weapon 2"]
      .filter((s) => has(twoSlots, twoItems, s))
      .map((s) => itemLabel(itemIn(twoSlots, twoItems, s)));
    gearGaps.push("Weapon 1", "Weapon 2");
    gap({
      id: "gear-weapons",
      kind: "Gear",
      title: "Weapons",
      detail: names.join(" + "),
      target: "items",
      slot: "Weapon 1",
      xml: swapSlots(one, ["Weapon 1", "Weapon 2"]),
    });
  }
  for (const slot of gearSlots) {
    if (weaponPair && /^Weapon [12]$/.test(slot)) continue;
    if (!differs(slot) || !has(twoSlots, twoItems, slot)) continue;
    gearGaps.push(slot);
    gap({
      id: "gear-" + slug(slot),
      kind: "Gear",
      title: slot,
      detail: itemLabel(itemIn(twoSlots, twoItems, slot)) + abyssNote(slot),
      target: "items",
      slot,
      xml: swapSlots(one, [slot]),
    });
  }
  // Flasks go as a set: builds order them differently.
  const flaskNames = (slots: Map<string, SlotRef>) =>
    [...slots.keys()].filter((n) => /^Flask \d$/.test(n));
  const flaskKeys = (slots: Map<string, SlotRef>, items: Map<string, string>) =>
    flaskNames(slots)
      .map((n) => (slots.get(n)!.active ? "on:" : "off:") + itemKey(itemIn(slots, items, n)))
      .filter((k) => !/:$/.test(k))
      .sort()
      .join("\n\n");
  if (
    flaskKeys(twoSlots, twoItems) !== flaskKeys(oneSlots, oneItems) &&
    flaskNames(twoSlots).some((n) => has(twoSlots, twoItems, n))
  ) {
    const mine = new Set(
      flaskNames(oneSlots)
        .map((n) => itemIn(oneSlots, oneItems, n))
        .filter((item): item is string => !!item)
        .map(itemKey),
    );
    const theirs = flaskNames(twoSlots).filter((n) => has(twoSlots, twoItems, n));
    const fresh = theirs.filter((n) => !mine.has(itemKey(itemIn(twoSlots, twoItems, n))));
    gearGaps.push(...FLASKS);
    gap({
      id: "gear-flasks",
      kind: "Gear",
      title: "Flasks",
      detail: fresh.length ? `${fresh.length} differ` : "Toggles differ",
      target: "items",
      slot: fresh[0] ?? theirs[0],
      xml: swapSlots(one, FLASKS),
    });
  }
  // All gear at once: one-slot swaps don't add up (Mageblood needs its flasks; capped
  // resistances overlap).
  const gearRows = out.filter((v) => v.kind === "Gear").length;
  if (gearRows >= 2)
    gap({
      id: "gear-all",
      kind: "Gear",
      title: "All gear",
      detail: `${gearRows} swaps`,
      target: "items",
      xml: swapSlots(one, [...new Set(gearGaps)]),
    });

  // ---- Tree: Build 2's tree with its jewels, when either differs ----
  const oneSpec = section(one, "Spec");
  const twoSpec = section(two, "Spec");
  if (oneSpec && twoSpec) {
    const nodesOf = (spec: Block) =>
      (attr(spec.open, "nodes") ?? "").split(",").filter(Boolean).sort().join();
    const jewelsOf = (spec: Block, items: Map<string, string>) =>
      [...spec.text.matchAll(/<Socket\s[^>]*>/g)]
        .map((m) => m[0])
        .filter((s) => attr(s, "itemId") !== "0")
        .map((s) => attr(s, "nodeId") + ":" + itemKey(items.get(attr(s, "itemId") ?? "")))
        .sort();
    const jewels = jewelsOf(twoSpec, twoItems);
    if (
      nodesOf(oneSpec) !== nodesOf(twoSpec) ||
      jewels.join("\n") !== jewelsOf(oneSpec, oneItems).join("\n")
    ) {
      const ids = [...twoSpec.text.matchAll(/<Socket\s[^>]*itemId="(\d+)"/g)]
        .map((m) => m[1])
        .filter((id) => id !== "0" && twoItems.has(id));
      const spec = twoSpec.text.replace(
        /(<Socket\s[^>]*itemId=")(\d+)"/g,
        (_, head, n) =>
          n === "0" || !twoItems.has(n) ? `${head}0"` : `${head}${Number(n) + offset}"`,
      );
      let xml = addItems(one, ids);
      xml = replaceBlock(xml, section(xml, "Spec")!, spec);
      gap({
        id: "tree",
        kind: "Tree",
        title: "Whole tree",
        detail: jewels.length
          ? `${jewels.length} jewel${jewels.length > 1 ? "s" : ""}`
          : "No jewels",
        target: "passives",
        xml,
      });
    }
  }

  // ---- Skills ----
  const oneSet = skillSet(one);
  const twoSet = skillSet(two);
  if (!oneSet || !twoSet || oneMain === null) return out;
  const oneGroups = groupsOf(oneSet.text);
  const twoGroups = groupsOf(twoSet.text);
  const mainIndex = oneMain - 1;
  const oneGroup = oneGroups[mainIndex];
  const twoGroup = twoMain === null ? undefined : twoGroups[twoMain - 1];
  /** Build 1 with its skill set rewritten by `edit`. */
  const editSkills = (edit: (setText: string) => string) => {
    const set = skillSet(one)!;
    return replaceBlock(one, set, edit(set.text));
  };
  const groupAt = (setText: string, index: number) => groupsOf(setText)[index];
  /** `setText` with `gemText` added at the end of the main group. */
  const addToMain = (setText: string, gemText: string) => {
    const main = groupAt(setText, mainIndex);
    return (
      setText.slice(0, main.start) +
      main.text.replace(/<\/Skill>$/, () => gemText + "\n</Skill>") +
      setText.slice(main.end)
    );
  };

  if (oneGroup && twoGroup) {
    // Main links: Build 2's main group in place of Build 1's (gems both have keep Build 1's
    // level; levels have their own rows). A lone added support has its own row below.
    const plus = enabledNames(twoGroup).filter((n) => !enabledNames(oneGroup).includes(n));
    const minus = enabledNames(oneGroup).filter((n) => !enabledNames(twoGroup).includes(n));
    if (plus.length + minus.length > 1 || minus.length > 0)
      gap({
        id: "links-main",
        kind: "Links",
        title: "Main links",
        detail: [...plus.map((n) => "+" + n), ...minus.map((n) => "−" + n)].join(" · "),
        target: "skills",
        xml: editSkills((set) => {
          const group = groupAt(set, mainIndex);
          let text = group.text;
          for (const gem of group.gems) if (minus.includes(gem.name)) text = text.replace(gem.text, "");
          const add = twoGroup.gems
            .filter((gem) => gem.enabled && plus.includes(gem.name))
            .map((gem) => gem.text)
            .join("\n");
          text = text.replace(/<\/Skill>$/, () => add + "\n</Skill>");
          return set.slice(0, group.start) + text + set.slice(group.end);
        }),
      });
  }

  // Unlinked supports: a group of only supports in the main skill's item supports nothing
  // (its sockets aren't linked to the skill). Linking them is a gap whatever Build 2 does.
  const linked = new Set<string>();
  if (oneGroup?.slot)
    oneGroups.forEach((group, index) => {
      if (group === oneGroup || !group.enabled || group.slot !== oneGroup.slot) return;
      if (group.gems.some((gem) => gem.enabled && !gem.support)) return;
      for (const support of group.gems) {
        if (!support.enabled || !support.support) continue;
        if (enabledNames(oneGroup).includes(support.name) || linked.has(support.name)) continue;
        linked.add(support.name);
        gap({
          id: "unlinked-" + slug(support.name),
          kind: "Links",
          title: `${support.name} link`,
          detail: `Unlinked in ${group.slot}`,
          target: "skills",
          xml: editSkills((set) => {
            const g = groupAt(set, index);
            const gem = g.gems.find((m) => m.name === support.name)!;
            set = set.slice(0, g.start) + g.text.replace(gem.text, "") + set.slice(g.end);
            return addToMain(set, gem.text);
          }),
        });
      }
    });

  // Link one support: Build 2's main group has a support Build 1's lacks, and Build 1's
  // group has room. Moves the gem if Build 1 has it elsewhere.
  if (
    oneGroup &&
    twoGroup &&
    enabledNames(oneGroup).length < enabledNames(twoGroup).length
  )
    for (const support of twoGroup.gems) {
      if (!support.enabled || !support.support) continue;
      if (enabledNames(oneGroup).includes(support.name) || linked.has(support.name)) continue;
      const elsewhere = oneGroups.findIndex(
        (g) => g !== oneGroup && g.gems.some((m) => m.name === support.name && m.enabled),
      );
      gap({
        id: "link-" + slug(support.name),
        kind: "Links",
        title: `${support.name} link`,
        detail:
          elsewhere >= 0
            ? `From ${oneGroups[elsewhere].slot || "another"} group`
            : `New · Lvl ${support.level}`,
        target: "skills",
        xml: editSkills((set) => {
          let gemText = support.text;
          if (elsewhere >= 0) {
            const g = groupAt(set, elsewhere);
            const gem = g.gems.find((m) => m.name === support.name && m.enabled)!;
            gemText = gem.text;
            set = set.slice(0, g.start) + g.text.replace(gem.text, "") + set.slice(g.end);
          }
          return addToMain(set, gemText);
        }),
      });
    }

  // Gem levels: every gem both use that Build 2 has at a higher level (the top 20).
  const levels = (groups: Group[]) => {
    const map = new Map<string, number>();
    for (const g of groups)
      if (g.enabled)
        for (const gem of g.gems)
          if (gem.enabled) map.set(gem.name, Math.max(map.get(gem.name) ?? 0, gem.level));
    return map;
  };
  const theirLevels = levels(twoGroups);
  const ups = [...levels(oneGroups)]
    .filter(([name, level]) => (theirLevels.get(name) ?? 0) > level)
    .map(([name, from]) => ({ name, from, to: theirLevels.get(name)! }))
    .sort((a, b) => b.to - b.from - (a.to - a.from))
    .slice(0, 20);
  for (const up of ups)
    gap({
      id: "gem-" + slug(up.name),
      kind: "Gems",
      title: up.name,
      detail: `Lvl ${up.from} → ${up.to}`,
      target: "skills",
      xml: editSkills((set) =>
        set.replace(/<Gem\s[^>]*>/g, (tag) =>
          unxml(attr(tag, "nameSpec") ?? "") === up.name
            ? tag.replace(/\slevel="\d+"/, ` level="${up.to}"`)
            : tag,
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
