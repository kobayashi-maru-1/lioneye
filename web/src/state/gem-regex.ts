// A search for the game's vendor and stash windows that highlights the gems you still
// need: for each, the shortest piece of its name no other gem's name has, joined with "|".
// The search box ignores case and matches an item's whole text, so pieces that are also
// common gem text (tags like "Fire", labels like "Level") are skipped.

/** The game's search box takes this many characters. */
export const SEARCH_LIMIT = 50;

/** Pieces shorter than this match too much other item text. */
const MIN_PIECE = 3;

/** Text on most gems besides their name: tags, property labels, the usual description. */
const GEM_TEXT = [
  "support",
  "supports",
  "supported",
  "increased",
  "reduced",
  "added",
  "deals",
  "from",
  "with",
  "more",
  "less",
  "chance",
  "skills",
  "enemies",
  "converted",
  "maximum",
  "minimum",
  "while",
  "when",
  "hits",
  "gain",
  "life",
  "mana",
  "base",
  "attack",
  "spell",
  "aoe",
  "area",
  "projectile",
  "fire",
  "cold",
  "lightning",
  "chaos",
  "physical",
  "elemental",
  "duration",
  "minion",
  "totem",
  "trap",
  "mine",
  "aura",
  "curse",
  "hex",
  "mark",
  "movement",
  "travel",
  "blink",
  "channelling",
  "melee",
  "strike",
  "slam",
  "bow",
  "warcry",
  "guard",
  "brand",
  "herald",
  "golem",
  "link",
  "orb",
  "nova",
  "trigger",
  "vaal",
  "critical",
  "arcane",
  "stance",
  "retaliation",
  "exceptional",
  "prismatic",
  "blessing",
  "banner",
  "chaining",
  "intelligence",
  "strength",
  "dexterity",
  "skill gem",
  "level",
  "quality",
  "experience",
  "requires",
  "mana cost",
  "cost",
  "reservation",
  "cast time",
  "cooldown",
  "damage",
  "effectiveness",
  "place into an item socket",
  "right colour",
  "right click to remove",
  "increased area of effect",
  "reduced area of effect",
  "area of effect",
  "chance to",
  "converted to",
  "on death",
  "instead",
  "instant",
  "unless",
];

/** Short linking words: a piece starting with one is stat text ("to poison", "of effect"). */
const LINKING = new Set([
  "of",
  "to",
  "on",
  "and",
  "the",
  "in",
  "for",
  "a",
  "an",
  "with",
]);

/** The gem's name as the search sees it. */
const norm = (name: string) => name.toLowerCase();

/** Only letters, digits, spaces, apostrophes and hyphens: nothing the regex reads. */
const PLAIN = /^[a-z0-9 '-]+$/;

/**
 * Names that are never beside the gems you buy: Vaal and Awakened gems (no vendor sells
 * them) and the data's placeholders ("[UNUSED] …", "NewPunishment", "...").
 */
const NOT_SOLD = /^(vaal |awakened |\[|new ?[a-z]|\.+$)/;

/** Per list of all names: the other names to compare with, and pieces worked out. */
const lists = new WeakMap<
  readonly string[],
  { names: string[]; pieces: Map<string, string> }
>();

function listFor(allNames: readonly string[]) {
  let list = lists.get(allNames);
  if (!list) {
    list = {
      names: [...new Set(allNames.map(norm))].filter(
        (name) => !NOT_SOLD.test(name),
      ),
      pieces: new Map(),
    };
    lists.set(allNames, list);
  }
  return list;
}

/**
 * The piece of `name` that the fewest other gems' names have (none, for most gems), then
 * without a space or apostrophe, then the shortest. A piece starts at the start of a word
 * ("Added Fire" gives "fire"-ish pieces, never "ed f", which "increased fire" in other
 * gems' text would match), has at least MIN_PIECE letters of the last word it reaches
 * into, and isn't common gem text. Gems whose whole name is in others' ("Arc" in "Arctic
 * Armour") get the piece that lights up the fewest others.
 */
export function gemPiece(name: string, allNames: readonly string[]) {
  const key = norm(name);
  const list = listFor(allNames);
  const cached = list.pieces.get(key);
  if (cached !== undefined) return cached;
  const others = list.names.filter((other) => other !== key);
  let best: { piece: string; rank: number[] } | null = null;
  for (let start = 0; start < key.length; start++) {
    if (start > 0 && key[start - 1] !== " ") continue;
    if (LINKING.has(key.slice(start).split(" ")[0])) continue;
    for (let end = start + MIN_PIECE; end <= key.length; end++) {
      const piece = key.slice(start, end);
      if (piece.endsWith(" ") || !PLAIN.test(piece)) continue;
      // Words before the last are whole (it starts at a word); the last may be cut.
      if (piece.slice(piece.lastIndexOf(" ") + 1).length < MIN_PIECE) continue;
      if (GEM_TEXT.some((text) => text.includes(piece))) continue;
      const rank = [
        others.filter((other) => other.includes(piece)).length,
        /[ ']/.test(piece) ? 1 : 0,
        piece.length,
      ];
      if (best === null || before(rank, best.rank)) best = { piece, rank };
    }
  }
  const piece = best?.piece ?? key.replace(/[^a-z0-9 '-]/g, ".");
  list.pieces.set(key, piece);
  return piece;
}

/** True when rank `a` sorts before `b` (element by element). */
function before(a: number[], b: number[]) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/** The search for these pieces: joined with "|", in quotes when one has a space. */
function search(pieces: string[]) {
  const joined = pieces.join("|");
  return pieces.some((piece) => piece.includes(" ")) ? `"${joined}"` : joined;
}

/**
 * The search for `wanted` (gem names, soonest needed first): as many as fit the search
 * box, in that order. `count` is how many it covers.
 */
export function gemRegex(
  wanted: readonly string[],
  allNames: readonly string[],
  limit = SEARCH_LIMIT,
) {
  const pieces: string[] = [];
  let count = 0;
  const names = [...new Set(wanted.map(norm))];
  for (const name of names) {
    // A piece already in the search covers this gem too.
    if (!pieces.some((piece) => name.includes(piece))) {
      const piece = gemPiece(name, allNames);
      if (search([...pieces, piece]).length > limit) break;
      pieces.push(piece);
    }
    count++;
  }
  return { regex: search(pieces), count, total: names.length };
}
