import { gemLinksSelector } from "../../state/gem-links";
import { artFor, copyItem, itemName, RARITY_COLOURS } from "../Gear";
import {
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
import { PageSection } from "../PageSection";
import { PanelSelect } from "../PanelSelect";
import { useLoadoutSets, usePobStats } from "../PobStats";
import styles from "./styles.module.css";
import classNames from "classnames";
import { Data } from "common";
import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { FaRegClipboard } from "react-icons/fa";
import { MdCircle } from "react-icons/md";

const STATUS: { value: TradeOptions["status"]; label: string }[] = [
  { value: "securable", label: "Instant Buyout" },
  { value: "online", label: "In Person" },
  { value: "any", label: "Any" },
];

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

  return (
    <PageSection id="trade" title="Trade List">
      <div className={classNames(styles.controls)}>
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
        <Slider
          label="Min mods"
          title="Share of an item's mods a listing must have"
          value={options.modShare}
          shown={percent(options.modShare)}
          onChange={(modShare) => setOptions({ ...options, modShare })}
        />
        <Slider
          label="Min values"
          title="Each mod's minimum, as a share of yours"
          value={options.valueShare}
          shown={percent(options.valueShare)}
          onChange={(valueShare) => setOptions({ ...options, valueShare })}
        />
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
              <div key={`${slot}-${i}`} className={classNames(styles.row)}>
                <span className={classNames(styles.icon)}>
                  {icon && <img src={icon} alt="" />}
                </span>
                <span className={classNames(styles.text)}>
                  <span className={classNames(styles.title)}>
                    <span className={classNames(styles.slot)}>{slot} : </span>
                    <span
                      style={{ color: RARITY_COLOURS[item.rarity ?? "NORMAL"] }}
                    >
                      {RARITY_NAMES[item.rarity ?? "NORMAL"]}{" "}
                      {unique ? itemName(item) : (item.base ?? itemName(item))}
                    </span>
                  </span>
                  {search && !unique && search.total > 0 && (
                    <span className={classNames(styles.sub)}>
                      Search for: {search.matched} of {search.total} modifiers
                    </span>
                  )}
                </span>
                <button
                  className={classNames(styles.iconButton)}
                  aria-label={`Copy ${itemName(item)}`}
                  title="Copy item"
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
                    )}
                    target="_blank"
                    rel="noreferrer"
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

function Slider({
  label,
  title,
  value,
  shown,
  onChange,
}: {
  label: string;
  title: string;
  value: number;
  shown: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className={classNames(styles.control, styles.slider)} title={title}>
      <span className={classNames(styles.controlLabel)}>
        {label}
        <span className={classNames(styles.sliderValue)}>{shown}</span>
      </span>
      <input
        type="range"
        min={0.5}
        max={1}
        step={0.05}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}
