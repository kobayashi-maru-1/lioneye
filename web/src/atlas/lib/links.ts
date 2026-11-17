import { MAX_BUDGET, type Plan } from "./types.ts";

/**
 * Tree links: our share links (`#t=`), poeatlasplanner.com links (`#p=`), the official
 * pathofexile.com atlas tree links, poeplanner.com atlas links and maxroll.gg planner
 * links (fetched). Decoding never trusts the input: the result goes through normalise()
 * before it's used.
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
  | {
      ok: true;
      kind: "share" | "planner" | "official" | "maxroll" | "poeplanner";
      plan: Plan;
    }
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

/** The newest poeplanner.com atlas format read; its own client refuses newer ones too. */
const POEPLANNER_FORMAT = 5;

/**
 * poeplanner.com atlas links (`/atlas-tree/<code>`, PoE 1): URL-safe base64 of, little
 * endian, u16 format, u16 tree version (its own numbering: 30 is 3.30), a PoE 2 byte
 * (format 5+), u16 count, u16 node ids, then gzipped notes (format 4+, not read). No
 * choices. A code starting with three zero bytes is the official format instead.
 */
function decodePoeplanner(text: string): LinkResult {
  const bytes = fromBase64Url(text);
  if (bytes.length >= 3 && bytes[0] + bytes[1] + bytes[2] === 0) {
    const official = decodeOfficial(text);
    return official.ok ? { ...official, kind: "poeplanner" } : official;
  }
  const u16 = (at: number) => bytes[at] | (bytes[at + 1] << 8);
  if (bytes.length < 6) return { ok: false };
  const format = u16(0);
  if (format < 1 || format > POEPLANNER_FORMAT) return { ok: false };
  let at = 4;
  if (format >= 5 && bytes[at++] !== 0) return { ok: false }; // a PoE 2 atlas
  if (at + 2 > bytes.length) return { ok: false };
  const count = u16(at);
  at += 2;
  if (at + count * 2 > bytes.length) return { ok: false };
  const allocated: string[] = [];
  for (let i = 0; i < count; i++) allocated.push(String(u16(at + i * 2)));
  return {
    ok: true,
    kind: "poeplanner",
    plan: { allocated, choices: {}, budget: MAX_BUDGET },
  };
}

/** A maxroll.gg planner link: its profile id, and the variant `#N` picks (1-based), if any. */
export interface MaxrollLink {
  id: string;
  variant: number | null;
}

/**
 * A maxroll.gg planner link (`https://maxroll.gg/poe/<…-planner>/<id>`, as its farming
 * strategy planner shares them, `#N` for its Nth variant), or null. Its tree isn't in the
 * link: it's fetched by id (fetchMaxroll), only when someone pastes one.
 */
export function maxrollLink(input: string): MaxrollLink | null {
  const match =
    /^https:\/\/(?:www\.)?maxroll\.gg\/poe\/[a-z-]*planner\/([A-Za-z0-9]{4,16})\/?(?:\?[^#]*)?(?:#(.*))?$/.exec(
      input.trim(),
    );
  if (!match) return null;
  const n = /^[1-9][0-9]?$/.test(match[2] ?? "") ? Number(match[2]) : null;
  return { id: match[1], variant: n };
}

/** The largest maxroll profile read: a tree is a few kB, a full build profile far less. */
const MAXROLL_MAX_BYTES = 2_000_000;

/**
 * A maxroll profile (the planners API's JSON) as a plan: a variant (`variant`, 1-based,
 * else the active one), its active atlas step, that step's allocated ids and its picks
 * (`masteries`: node → effect). Not a PoE profile, or no atlas tree in it: { ok: false }.
 */
export function decodeMaxroll(
  json: unknown,
  variant: number | null = null,
): LinkResult {
  if (typeof json !== "object" || json === null) return { ok: false };
  const profile = json as { game?: unknown; data?: unknown };
  if (profile.game !== "poe" || typeof profile.data !== "string")
    return { ok: false };
  let data: { profiles?: unknown; activeProfile?: unknown } | null;
  try {
    data = JSON.parse(profile.data) as typeof data;
  } catch {
    return { ok: false };
  }
  if (!Array.isArray(data?.profiles)) return { ok: false };
  const pick = <T>(list: T[], at: unknown): T | undefined =>
    list[Number.isInteger(at) ? (at as number) : 0] ?? list[0];
  // maxroll's names: a profile holds variants (its #N); a variant's atlas holds steps.
  const chosen = pick(
    data.profiles,
    variant !== null && variant <= data.profiles.length
      ? variant - 1
      : data.activeProfile,
  ) as { atlas?: { variants?: unknown; active?: unknown } } | undefined;
  const steps = chosen?.atlas?.variants;
  if (!Array.isArray(steps)) return { ok: false };
  const step = pick(steps, chosen?.atlas?.active) as
    { history?: unknown; masteries?: unknown } | undefined;
  if (!isIdList(step?.history) || step.history.length === 0)
    return { ok: false };
  const choices: Record<string, number> = {};
  if (typeof step.masteries === "object" && step.masteries !== null)
    for (const [node, effect] of Object.entries(step.masteries))
      if (Number.isInteger(effect)) choices[node] = effect as number;
  return {
    ok: true,
    kind: "maxroll",
    plan: {
      allocated: step.history.map(String),
      choices,
      budget: MAX_BUDGET,
    },
  };
}

/** A response body as text, or null past `max` bytes (stops reading there). */
async function cappedText(response: Response, max: number) {
  if (Number(response.headers.get("content-length") ?? 0) > max) return null;
  if (!response.body) return null;
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Fetches a maxroll profile and reads its tree: one request, no cookies, no referrer, cut
 * off after 10 seconds, after 2 MB, or when `signal` aborts. "failed" when it can't be
 * fetched; { ok: false } when it holds no tree.
 */
export async function fetchMaxroll(
  link: MaxrollLink,
  signal?: AbortSignal,
): Promise<LinkResult | "failed"> {
  // One controller for the timeout and the caller's signal (no AbortSignal.timeout/any,
  // which older Safari lacks).
  const stop = new AbortController();
  const abort = () => stop.abort();
  const timer = setTimeout(abort, 10_000);
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort);
  let text: string | null;
  try {
    const response = await fetch(
      `https://planners.maxroll.gg/profiles/poe/${encodeURIComponent(link.id)}`,
      {
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: stop.signal,
      },
    );
    if (!response.ok) return "failed";
    text = await cappedText(response, MAXROLL_MAX_BYTES);
  } catch {
    return "failed";
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
  if (text === null) return "failed";
  try {
    return decodeMaxroll(JSON.parse(text), link.variant);
  } catch {
    return { ok: false };
  }
}

/** What Open makes of pasted text: a plan, or why not (`reason` absent: not a tree link). */
export type OpenResult = LinkResult | { ok: false; reason: "failed" | "empty" };

/**
 * Open's reader: a maxroll link is fetched (until `signal` aborts); anything else goes
 * through parseLink.
 */
export async function readLink(
  text: string,
  signal?: AbortSignal,
): Promise<OpenResult> {
  const link = maxrollLink(text);
  if (link === null) return parseLink(text);
  const result = await fetchMaxroll(link, signal);
  if (result === "failed") return { ok: false, reason: "failed" };
  return result.ok ? result : { ok: false, reason: "empty" };
}

/** Reads a pasted link (or just its fragment). Anything else: { ok: false }. */
export function parseLink(input: string): LinkResult {
  const text = input.trim();
  try {
    const official = /atlas-skill-tree\/([A-Za-z0-9_\-+/=]+)/.exec(text);
    if (official) return decodeOfficial(official[1]);
    const poeplanner =
      /^https?:\/\/(?:www\.)?poeplanner\.com\/atlas-tree\/([A-Za-z0-9_\-=]+)\/?(?:[?#].*)?$/.exec(
        text,
      );
    if (poeplanner) return decodePoeplanner(poeplanner[1]);
    const share = /(?:^|[#&])t=([A-Za-z0-9_\-+/=]+)/.exec(text);
    if (share) return decodeShare(share[1]);
    const planner = /(?:^|[#&])p=([A-Za-z0-9_\-+/=]+)/.exec(text);
    if (planner) return decodePlanner(planner[1]);
  } catch {
    return { ok: false };
  }
  return { ok: false };
}
