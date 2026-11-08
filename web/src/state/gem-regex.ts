// A search for the game's vendor and stash windows that highlights the gems you still
// need: for each, the shortest piece of its name no other gem's name has, joined with "|".
// The search box ignores case, matches an item's whole text line by line, and reads `^`
// and `$` as a line's start and end (as poe.re's gem search relies on). Pieces that are
// also common gem text (tags like "Fire", labels like "Level") are skipped.

/** The game's search box takes this many characters. */
export const SEARCH_LIMIT = 50;

/** Pieces shorter than this match too much other item text. */
const MIN_PIECE = 4;

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
 * Whether a piece matches a line of text: the game's search reads `^` and `$` as the
 * start and end of a line, and the gem's name is a line of its own.
 */
export function pieceMatches(piece: string, line: string) {
  const head = piece.startsWith("^");
  const tail = piece.endsWith("$");
  const core = piece.slice(head ? 1 : 0, tail ? -1 : undefined);
  if (head && tail) return line === core;
  if (head) return line.startsWith(core);
  if (tail) return line.endsWith(core);
  return line.includes(core);
}

/**
 * The piece of `name` that the fewest other gems' names match (none, for most gems),
 * then without a space or apostrophe, then the shortest. A piece starts at the start of a
 * word ("Added Fire" gives "fire"-ish pieces, never "ed f", which "increased fire" in
 * other gems' text would match), not at a linking word, has at least MIN_PIECE letters of
 * the last word it reaches into, and isn't common gem text. At the name's start or end it
 * may be anchored there (`^`, `$`, as poe.re's gem search does): "Arc" becomes "arc$",
 * which "Arctic Armour" doesn't match.
 */
export function gemPiece(name: string, allNames: readonly string[]) {
  const key = norm(name);
  const list = listFor(allNames);
  const cached = list.pieces.get(key);
  if (cached !== undefined) return cached;
  const others = list.names.filter((other) => other !== key);
  let best: { piece: string; rank: number[] } | null = null;
  const consider = (piece: string) => {
    const rank = [
      others.filter((other) => pieceMatches(piece, other)).length,
      /[ ']/.test(piece) ? 1 : 0,
      piece.length,
    ];
    if (best === null || before(rank, best.rank)) best = { piece, rank };
  };
  for (let start = 0; start < key.length; start++) {
    if (start > 0 && key[start - 1] !== " ") continue;
    if (LINKING.has(key.slice(start).split(" ")[0])) continue;
    for (let end = start + 1; end <= key.length; end++) {
      const core = key.slice(start, end);
      if (core.endsWith(" ") || !PLAIN.test(core)) continue;
      const whole = start === 0 && end === key.length;
      // Words before the last are whole (it starts at a word); the last may be cut. The
      // whole name, anchored, is safe however short ("^arc$").
      if (!whole && core.slice(core.lastIndexOf(" ") + 1).length < MIN_PIECE)
        continue;
      // Common gem text, as the piece would meet it in other gems' lines.
      if (!GEM_TEXT.some((text) => text.includes(core))) consider(core);
      if (start === 0 && !GEM_TEXT.some((text) => text.startsWith(core)))
        consider(`^${core}`);
      if (end === key.length && !GEM_TEXT.some((text) => text.endsWith(core)))
        consider(`${core}$`);
      if (whole) consider(`^${core}$`);
    }
  }
  const piece = best?.piece ?? `^${key.replace(/[^a-z0-9 '-]/g, ".")}$`;
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
    if (!pieces.some((piece) => pieceMatches(piece, name))) {
      const piece = gemPiece(name, allNames);
      if (search([...pieces, piece]).length > limit) break;
      pieces.push(piece);
    }
    count++;
  }
  return { regex: search(pieces), count, total: names.length };
}
