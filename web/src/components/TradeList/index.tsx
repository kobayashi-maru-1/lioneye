import { gemLinksSelector } from "../../state/gem-links";
import {
  artFor,
  copyItem,
  ItemArt,
  itemName,
  ItemTooltip,
  RARITY_COLOURS,
} from "../Gear";
import {
  type GemLevelOverride,
  gemMaxLevel,
  type TradeOptions,
  useArt,
  useTradeData,
  useTradeLeague,
  useTradeOptions,
} from "../Gear/data";
import {
  gemTradeUrl,
  tradeIndex,
  tradeSearch,
  wikiUrl,
} from "../Gear/trade-query";
import { GemTooltip } from "../GemLinkViewer";
import { PageSection } from "../PageSection";
import { PanelSelect } from "../PanelSelect";
import { type GearItem, useLoadoutSets, usePobStats } from "../PobStats";
import { Popover, usePopover } from "../Popover";
import styles from "./styles.module.css";
import classNames from "classnames";
import { Data, type RouteData } from "common";
import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { FaRegClipboard } from "react-icons/fa";
import { MdCircle } from "react-icons/md";

const STATUS: { value: TradeOptions["status"]; label: string }[] = [
  { value: "securable", label: "Instant Buyout" },
  { value: "online", label: "In Person" },
  { value: "any", label: "Any" },
];

/** pob.codes' Gem level override: the build's level, 1, the gem's top level or one more. */
const GEM_LEVELS: { value: GemLevelOverride; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "1", label: "1" },
  { value: "max", label: "Max" },
  { value: "max+1", label: "Max+1" },
];

/** pob.codes' Gem quality override: the build's quality, else this minimum. */
const GEM_QUALITIES: (number | null)[] = [null, 0, 10, 20, 23];

/** The match sliders: 50% to 100% in steps of 5%, a tick every 10%. */
const SHARES = Array.from({ length: 11 }, (_, i) => 0.5 + i * 0.05);

/** A hovered or pinned row: an item of the gear, or a gem. */
type Shown =
  { kind: "item"; item: GearItem } | { kind: "gem"; link: RouteData.GemLink };

const RARITY_NAMES: Record<string, string> = {
  NORMAL: "Normal",
  MAGIC: "Magic",
  RARE: "Rare",
  UNIQUE: "Unique",
  RELIC: "Relic",
};

/**
 * pob.codes' Trade List: a trade search for every item of the loadout's gear and every
 * gem of its skill set, with the league, search type and how close a match must be.
 */
export function TradeListPanel() {
  const stats = usePobStats()?.stats ?? null;
  const gear = stats?.gear ?? null;
  const lists = stats?.lists ?? null;
  const sets = useLoadoutSets();
  const gemLinks = useAtomValue(gemLinksSelector);
  const { league, leagues, setLeague } = useTradeLeague();
  const [options, setOptions] = useTradeOptions();
  const art = useArt(league);
  const trade = useTradeData();
  const popover = usePopover<Shown>();
  const maxLevels = stats?.gemMaxLevels;
  const index = useMemo(
    () => (trade ? tradeIndex(trade.stats, trade.items) : null),
    [trade],
  );

  const slots = gear?.sets[lists ? lists.active.items - 1 : 0]?.slots ?? [];
  const jewels = gear?.treeJewels[lists ? lists.active.tree - 1 : 0] ?? [];
  const items = [
    ...slots.map((s) => ({ slot: s.slot, id: s.item })),
    ...jewels.map((j) => ({ slot: "Jewel", id: j.item })),
  ];

  // The loadout's skill set (else the first), every gem once.
  const gems = useMemo(() => {
    const titles = [...new Set(gemLinks.map((link) => link.title))];
    const title =
      sets?.skills && titles.includes(sets.skills) ? sets.skills : titles[0];
    const seen = new Set<string>();
    return gemLinks
      .filter((link) => link.title === title)
      .flatMap((link) => [...link.primaryGems, ...link.secondaryGems])
      .filter(
        (gem) => !seen.has(gem.id) && !!seen.add(gem.id) && !!Data.Gems[gem.id],
      )
      .sort((a, b) => Data.Gems[a.id].name.localeCompare(Data.Gems[b.id].name));
  }, [gemLinks, sets?.skills]);

  const percent = (value: number) => `${Math.round(value * 100)}%`;
  // The nearest stop, so a value saved off the 5% grid still shows.
  const share = (value: number) =>
    SHARES.reduce(
      (best, stop, i) =>
        Math.abs(stop - value) < Math.abs(SHARES[best] - value) ? i : best,
      0,
    );
  const shown = popover.state;

  return (
    <PageSection id="trade" title="Trade List">
      {shown && (
        <Popover
          anchor={shown.anchor}
          pinned={shown.pinned}
          onClose={popover.close}
        >
          {shown.value.kind === "item" ? (
            <ItemTooltip item={shown.value.item} />
          ) : (
            <GemTooltip gemLink={shown.value.link} />
          )}
        </Popover>
      )}
      <div className={classNames(styles.controls)}>
        <Slider
          label="Min mods"
          title="Share of an item's mods a listing must have"
          stops={SHARES.map(percent)}
          index={share(options.modShare)}
          tickEvery={2}
          onChange={(i) => setOptions({ ...options, modShare: SHARES[i] })}
        />
        <Slider
          label="Min values"
          title="Each mod's minimum, as a share of the build's"
          stops={SHARES.map(percent)}
          index={share(options.valueShare)}
          tickEvery={2}
          onChange={(i) => setOptions({ ...options, valueShare: SHARES[i] })}
        />
        <Slider
          label="Gem level"
          title="Max: the gem's top level. Max+1: corrupted."
          stops={GEM_LEVELS.map((level) => level.label)}
          index={Math.max(
            0,
            GEM_LEVELS.findIndex(
              (level) => level.value === (options.gemLevel ?? "default"),
            ),
          )}
          onChange={(i) =>
            setOptions({ ...options, gemLevel: GEM_LEVELS[i].value })
          }
        />
        <Slider
          label="Gem quality"
          stops={GEM_QUALITIES.map((q) => (q === null ? "Default" : `${q}%`))}
          index={Math.max(0, GEM_QUALITIES.indexOf(options.gemQuality ?? null))}
          onChange={(i) =>
            setOptions({ ...options, gemQuality: GEM_QUALITIES[i] })
          }
        />
        {leagues && leagues.length > 0 && league !== null && (
          <label className={classNames(styles.control)}>
            <span className={classNames(styles.controlLabel)}>League</span>
            <PanelSelect
              label="League"
              options={leagues}
              value={Math.max(0, leagues.indexOf(league))}
              onChange={(i) => setLeague(leagues[i])}
            />
          </label>
        )}
        <label className={classNames(styles.control)}>
          <span className={classNames(styles.controlLabel)}>Search type</span>
          <PanelSelect
            label="Search type"
            options={STATUS.map((s) => s.label)}
            value={Math.max(
              0,
              STATUS.findIndex((s) => s.value === options.status),
            )}
            onChange={(i) =>
              setOptions({ ...options, status: STATUS[i].value })
            }
          />
        </label>
      </div>
      <div className={classNames(styles.lists)} data-panel-row>
        <section className={classNames(styles.list)}>
          <h3 className={classNames(styles.listTitle)}>Gear</h3>
          {items.length === 0 && (
            <p className={classNames(styles.empty)}>No items</p>
          )}
          {items.map(({ slot, id }, i) => {
            const item = gear?.items[String(id)];
            if (!item) return null;
            const search =
              index && league
                ? tradeSearch(index, item, slot, league, options)
                : null;
            const unique = item.rarity === "UNIQUE" || item.rarity === "RELIC";
            const icon = artFor(item, art);
            return (
              <div
                key={`${slot}-${id}-${i}`}
                className={classNames(styles.row)}
              >
                <button
                  className={classNames(styles.hover)}
                  {...popover.bind(
                    { kind: "item", item },
                    `item-${slot}-${id}-${i}`,
                  )}
                >
                  <span className={classNames(styles.icon)}>
                    {icon && <ItemArt src={icon} className={styles.art} />}
                  </span>
                  <span className={classNames(styles.text)}>
                    <span className={classNames(styles.title)}>
                      <span className={classNames(styles.slot)}>{slot} : </span>
                      <span
                        style={{
                          color: RARITY_COLOURS[item.rarity ?? "NORMAL"],
                        }}
                      >
                        {RARITY_NAMES[item.rarity ?? "NORMAL"]}{" "}
                        {unique
                          ? itemName(item)
                          : (item.base ?? itemName(item))}
                      </span>
                    </span>
                    {search && !unique && search.total > 0 && (
                      <span className={classNames(styles.sub)}>
                        Search for: {search.matched} of {search.total} modifiers
                      </span>
                    )}
                  </span>
                </button>
                <button
                  className={classNames(styles.iconButton)}
                  aria-label={`Copy ${itemName(item)}`}
                  title="Copy"
                  onClick={() => copyItem(item)}
                >
                  <FaRegClipboard aria-hidden />
                </button>
                {search && (
                  <a
                    className={classNames(styles.search)}
                    href={search.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Search ${itemName(item)}`}
                  >
                    Search
                  </a>
                )}
              </div>
            );
          })}
        </section>
        <section className={classNames(styles.list)}>
          <h3 className={classNames(styles.listTitle)}>Gems</h3>
          {gems.length === 0 && (
            <p className={classNames(styles.empty)}>No gems</p>
          )}
          {gems.map((link) => {
            const gem = Data.Gems[link.id];
            return (
              <div key={link.id} className={classNames(styles.row)}>
                <button
                  className={classNames(styles.hover)}
                  {...popover.bind({ kind: "gem", link }, `gem-${link.id}`)}
                >
                  <span className={classNames(styles.icon)}>
                    <MdCircle color={Data.GemColours[gem.primary_attribute]} />
                  </span>
                  <span className={classNames(styles.text)}>
                    <span className={classNames(styles.title, styles.gemName)}>
                      {gem.name}
                    </span>
                    {link.level !== undefined && (
                      <span className={classNames(styles.sub)}>
                        Level {link.level} / {link.quality ?? 0}% quality
                      </span>
                    )}
                  </span>
                </button>
                <a
                  className={classNames(styles.iconButton)}
                  href={wikiUrl(gem.name)}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`${gem.name} on the wiki`}
                  title="Wiki"
                >
                  W
                </a>
                {league && (
                  <a
                    className={classNames(styles.search)}
                    href={gemTradeUrl(
                      gem.name,
                      link.level,
                      link.quality,
                      league,
                      options,
                      gemMaxLevel(maxLevels, link.id),
                    )}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Search ${gem.name}`}
                  >
                    Search
                  </a>
                )}
              </div>
            );
          })}
        </section>
      </div>
    </PageSection>
  );
}

/** pob.codes' slider: named stops, a tick mark under each (or every `tickEvery`th). */
function Slider({
  label,
  title,
  stops,
  index,
  tickEvery = 1,
  onChange,
}: {
  label: string;
  title?: string;
  stops: string[];
  index: number;
  tickEvery?: number;
  onChange: (index: number) => void;
}) {
  const ticks = stops.filter((_, i) => i % tickEvery === 0).length;
  return (
    <label className={classNames(styles.control, styles.slider)} title={title}>
      <span className={classNames(styles.controlLabel)}>
        {label}
        <span className={classNames(styles.sliderValue)}>{stops[index]}</span>
      </span>
      <span className={classNames(styles.track)}>
        <input
          type="range"
          min={0}
          max={stops.length - 1}
          step={1}
          value={index}
          aria-valuetext={stops[index]}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <span className={classNames(styles.ticks)} aria-hidden>
          {Array.from({ length: ticks }, (_, i) => (
            <span key={i} className={classNames(styles.tick)} />
          ))}
        </span>
      </span>
    </label>
  );
}
