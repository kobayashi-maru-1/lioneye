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

/** Item art from poe.ninja: unique name → icon, base type → icon. */
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
          ).then((results) => {
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
