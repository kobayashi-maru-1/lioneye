import { MAX_BUDGET, type Plan } from "./types.ts";

/**
 * Tree links: our share links (`#t=`), poeatlasplanner.com links (`#p=`) and the official
 * pathofexile.com atlas tree links. Decoding never trusts the input: the result goes
 * through normalise() before it's used.
 */

const SHARE_FORMAT = 1;

function toBase64Url(bytes: Uint8Array, padded: boolean) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const text = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_");
  return padded ? text : text.replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const clean = text
    .trim()
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]*$/.test(clean)) throw new Error("not base64");
  const binary = atob(clean + "=".repeat((4 - (clean.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

const encodeJson = (value: unknown) =>
  toBase64Url(new TextEncoder().encode(JSON.stringify(value)), false);
const decodeJson = (text: string): unknown =>
  JSON.parse(new TextDecoder().decode(fromBase64Url(text)));

const sortedIds = (ids: string[]) =>
  [...new Set(ids)]
    .map(Number)
    .filter(Number.isInteger)
    .sort((a, b) => a - b);

/** Our share fragment: `t=` + base64url of [format, treeVersion, budget, ids, choices]. */
export function encodeShare(plan: Plan, treeVersion: string) {
  const choices = Object.entries(plan.choices)
    .map(([node, effect]) => [Number(node), effect])
    .sort((a, b) => a[0] - b[0]);
  return `t=${encodeJson([SHARE_FORMAT, treeVersion, plan.budget, sortedIds(plan.allocated), choices])}`;
}

/** The official atlas tree link's bytes: version 6, class, ascendancy, ids, two empty counts. */
export function encodeOfficial(ids: string[]) {
  const list = sortedIds(ids).filter((id) => id > 0 && id < 65536);
  if (list.length > 255) throw new Error("too many nodes");
  const bytes = new Uint8Array(7 + list.length * 2 + 2);
  bytes.set([0, 0, 0, 6, 0, 0, list.length]);
  list.forEach((id, i) => {
    bytes[7 + i * 2] = id >> 8;
    bytes[8 + i * 2] = id & 0xff;
  });
  return `https://www.pathofexile.com/fullscreen-atlas-skill-tree/${toBase64Url(bytes, true)}`;
}

export type LinkResult =
  | { ok: true; kind: "share" | "planner" | "official"; plan: Plan }
  | { ok: false };

const isIdList = (v: unknown): v is (number | string)[] =>
  Array.isArray(v) &&
  v.every((x) => typeof x === "number" || typeof x === "string");

function choicePairs(v: unknown): Record<string, number> {
  const choices: Record<string, number> = {};
  if (!Array.isArray(v)) return choices;
  for (const pair of v)
    if (
      Array.isArray(pair) &&
      pair.length === 2 &&
      Number.isInteger(Number(pair[1]))
    )
      choices[String(pair[0])] = Number(pair[1]);
  return choices;
}

function budgetOf(v: unknown) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : MAX_BUDGET;
}

function decodeShare(text: string): LinkResult {
  const value = decodeJson(text);
  if (!Array.isArray(value) || value[0] !== SHARE_FORMAT || !isIdList(value[3]))
    return { ok: false };
  return {
    ok: true,
    kind: "share",
    plan: {
      allocated: value[3].map(String),
      choices: choicePairs(value[4]),
      budget: budgetOf(value[2]),
    },
  };
}

/** poeatlasplanner.com: [schema, version, revision, budget, ids, [[node, effect], …]]. */
function decodePlanner(text: string): LinkResult {
  const value = decodeJson(text);
  if (!Array.isArray(value) || !isIdList(value[4])) return { ok: false };
  return {
    ok: true,
    kind: "planner",
    plan: {
      allocated: value[4].map(String),
      choices: choicePairs(value[5]),
      budget: budgetOf(value[3]),
    },
  };
}

/** pathofexile.com: u32 version, class, ascendancy, count, u16 ids, cluster count, then
 *  (if present) a count of (effect, node) u16 pairs, as the passive tree stores masteries. */
function decodeOfficial(text: string): LinkResult {
  const bytes = fromBase64Url(text);
  if (bytes.length < 7) return { ok: false };
  const version =
    (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
  if (version < 4 || version > 6) return { ok: false };
  const count = bytes[6];
  if (bytes.length < 7 + count * 2) return { ok: false };
  const allocated: string[] = [];
  for (let i = 0; i < count; i++)
    allocated.push(String((bytes[7 + i * 2] << 8) | bytes[8 + i * 2]));
  const choices: Record<string, number> = {};
  let at = 7 + count * 2;
  if (at < bytes.length) {
    at += 1 + bytes[at] * 2; // cluster nodes: none on the atlas
    if (at < bytes.length) {
      const pairs = bytes[at];
      for (let i = 0; i < pairs && at + 5 + i * 4 <= bytes.length; i++) {
        const o = at + 1 + i * 4;
        const effect = (bytes[o] << 8) | bytes[o + 1];
        const node = (bytes[o + 2] << 8) | bytes[o + 3];
        choices[String(node)] = effect;
      }
    }
  }
  return {
    ok: true,
    kind: "official",
    plan: { allocated, choices, budget: MAX_BUDGET },
  };
}

/** Reads a pasted link (or just its fragment). Anything else: { ok: false }. */
export function parseLink(input: string): LinkResult {
  const text = input.trim();
  try {
    const official = /atlas-skill-tree\/([A-Za-z0-9_\-+/=]+)/.exec(text);
    if (official) return decodeOfficial(official[1]);
    const share = /(?:^|[#&])t=([A-Za-z0-9_\-+/=]+)/.exec(text);
    if (share) return decodeShare(share[1]);
    const planner = /(?:^|[#&])p=([A-Za-z0-9_\-+/=]+)/.exec(text);
    if (planner) return decodePlanner(planner[1]);
  } catch {
    return { ok: false };
  }
  return { ok: false };
}
