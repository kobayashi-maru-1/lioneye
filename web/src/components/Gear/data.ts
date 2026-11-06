import { persistentAtom } from "../../state";
import { useAtom } from "jotai";
import { useEffect, useState } from "react";

/**
 * Trade site and poe.ninja data, fetched through the exe (/api/data, cached there) once
 * per page load and shared by every Gear panel render.
 */
const requests = new Map<string, Promise<unknown>>();

function getData<T>(name: string, params: Record<string, string> = {}) {
  const query = new URLSearchParams(params).toString();
  const url = `/api/data/${name}${query ? `?${query}` : ""}`;
  let request = requests.get(url) as Promise<T> | undefined;
  if (!request) {
    request = fetch(url).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json() as Promise<T>;
    });
    // A failed download is tried again next time it's asked for.
    request.catch(() => requests.delete(url));
    requests.set(url, request);
  }
  return request;
}

/** The value a promise settles to; undefined while loading or after it fails. */
function usePromise<T>(make: () => Promise<T> | null, key: string) {
  const [state, setState] = useState<{ key: string; value: T } | null>(null);
  useEffect(() => {
    let live = true;
    make()
      ?.then((value) => live && setState({ key, value }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [key]);
  return state?.key === key ? state.value : undefined;
}

interface LeaguesData {
  result: { id: string; realm: string }[];
}

/** PC trade leagues, the current challenge league first (as the trade site lists them). */
export function useLeagues() {
  return usePromise(
    () =>
      getData<LeaguesData>("trade-leagues")
        .then((data) =>
          data.result
            .filter((league) => league.realm === "pc")
            .map((l) => l.id),
        )
        // Offline with nothing cached: Standard still gives Trade links (and art, if cached).
        .catch(() => ["Standard"]),
    "leagues",
  );
}

interface NinjaData {
  lines: {
    name: string;
    baseType?: string;
    icon?: string;
    /** Influence or variant ("Elder/Warlord"); plain bases have none. */
    variant?: string;
  }[];
}

const NINJA_TYPES = [
  "UniqueWeapon",
  "UniqueArmour",
  "UniqueAccessory",
  "UniqueFlask",
  "UniqueJewel",
  "BaseType",
];

/** RePoE's base item list (base_items.json), keyed by metadata id. */
type RepoeBases = Record<
  string,
  {
    name?: string;
    release_state?: string;
    visual_identity?: { dds_file?: string };
  }
>;

/** GGG's image server; a base's art is its .dds path as .png under it. */
const POE_IMAGES = "https://web.poecdn.com/image/";

/** Item art: unique name → icon (poe.ninja), base type → icon (RePoE, else poe.ninja). */
export interface Art {
  uniques: Map<string, string>;
  bases: Map<string, string>;
}

export function useArt(league: string | null) {
  return usePromise<Art>(
    () =>
      league === null
        ? null
        : Promise.allSettled(
            NINJA_TYPES.map((type) =>
              getData<NinjaData>("ninja", { league, type }),
            ),
          ).then(async (results) => {
            const art: Art = { uniques: new Map(), bases: new Map() };
            // Plain bases win over influenced ones (their art has no influence marks).
            const plain = new Set<string>();
            results.forEach((result, i) => {
              if (result.status !== "fulfilled") return;
              const target =
                NINJA_TYPES[i] === "BaseType" ? "bases" : "uniques";
              for (const line of result.value.lines ?? []) {
                if (!line.icon) continue;
                // The base-type list names the base in `name` (no baseType).
                const key =
                  target === "bases" ? (line.baseType ?? line.name) : line.name;
                if (!key) continue;
                const isPlain = target === "uniques" || !line.variant;
                if (art[target].has(key) && (plain.has(key) || !isPlain))
                  continue;
                art[target].set(key, line.icon);
                if (isPlain) plain.add(key);
              }
            });
            // Every base's own art (flasks and leveling bases too), from the game's art
            // paths on GGG's image server. poe.ninja's base art stays as the fallback.
            const repoe = await getData<RepoeBases>("repoe-bases").catch(
              () => null,
            );
            const fromRepoe = new Set<string>();
            const fromLegacy = new Set<string>();
            for (const base of Object.values(repoe ?? {})) {
              const dds = base.visual_identity?.dds_file;
              if (!base.name || !dds || base.release_state === "unreleased")
                continue;
              // The first released entry of a name wins over legacy ones.
              const released = base.release_state === "released";
              if (fromRepoe.has(base.name)) continue;
              if (!released && fromLegacy.has(base.name)) continue;
              (released ? fromRepoe : fromLegacy).add(base.name);
              art.bases.set(
                base.name,
                `${POE_IMAGES}${dds.replace(/\.dds$/i, ".png")}`,
              );
            }
            return art;
          }),
    `art|${league}`,
  );
}

export interface TradeStatsData {
  result: { id: string; entries: { id: string; text: string }[] }[];
}

export interface TradeItemsData {
  result: { id: string; entries: { name?: string; type: string }[] }[];
}

/** The trade site's stat and item lists, for Trade buttons. */
export function useTradeData() {
  return usePromise(
    () =>
      Promise.all([
        getData<TradeStatsData>("trade-stats"),
        getData<TradeItemsData>("trade-items"),
      ]).then(([stats, items]) => ({ stats, items })),
    "trade",
  );
}

/** The trade league for Trade buttons, item art and the Trade List; saved per browser. */
const tradeLeagueAtom = persistentAtom<string | null>("gear-league", null, 0);

/** The league in use (yours if it's still listed, else the current challenge league). */
export function useTradeLeague() {
  const leagues = useLeagues();
  const [saved, setLeague] = useAtom(tradeLeagueAtom);
  const league =
    saved !== null && (!leagues || leagues.includes(saved))
      ? saved
      : (leagues?.[0] ?? null);
  return { league, leagues, setLeague };
}

/** Trade search settings, shared by every Trade button and the Trade List. */
export interface TradeOptions {
  /** "securable": instant buyout; "online": in person; "any": any listing. */
  status: "securable" | "online" | "any";
  /** Each mod's minimum, as a share of the build's value (0.5-1). */
  valueShare: number;
  /** Share of an item's matched mods a listing must have (0.5-1). */
  modShare: number;
  /** Gem level searched: the build's ("default", also when unset), 1, max or max + 1. */
  gemLevel?: GemLevelOverride;
  /** Gem quality searched: the build's when unset, else this minimum. */
  gemQuality?: number | null;
}

export type GemLevelOverride = "default" | "1" | "max" | "max+1";

export const DEFAULT_TRADE_OPTIONS: TradeOptions = {
  status: "securable",
  valueShare: 0.8,
  modShare: 0.7,
};

const tradeOptionsAtom = persistentAtom<TradeOptions>(
  "trade-options",
  DEFAULT_TRADE_OPTIONS,
  0,
);

export function useTradeOptions() {
  return useAtom(tradeOptionsAtom);
}

/** A gem's top level without corruption, from PoB's gem data (20 unless listed). */
export function gemMaxLevel(
  levels: Record<string, number> | undefined,
  gemId: string,
) {
  return levels?.[gemId] ?? 20;
}
