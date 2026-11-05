import { persistentAtom } from "../../state";
import { PageSection } from "../PageSection";
import { PanelSelect } from "../PanelSelect";
import {
  type Gear,
  type GearItem,
  usePanelSet,
  usePobStats,
} from "../PobStats";
import { SidebarTooltip } from "../SidebarTooltip";
import { type Art, useArt, useLeagues, useTradeData } from "./data";
import styles from "./styles.module.css";
import { tradeIndex, tradeUrl } from "./trade-query";
import classNames from "classnames";
import { useAtom } from "jotai";
import { useMemo, useState } from "react";
import { FaBalanceScale } from "react-icons/fa";

/** The trade league for Trade buttons and item art; null: the current challenge league. */
const gearLeagueAtom = persistentAtom<string | null>("gear-league", null, 0);

/** Paper-doll slots and their grid areas (styles.doll). */
const DOLL: Record<string, string> = {
  "Weapon 1": "w1",
  "Weapon 2": "w2",
  Helmet: "helm",
  "Body Armour": "body",
  Gloves: "gloves",
  Boots: "boots",
  Amulet: "amulet",
  "Ring 1": "r1",
  "Ring 2": "r2",
  "Ring 3": "r3",
  Belt: "belt",
};

const RARITY_COLOURS: Record<string, string> = {
  NORMAL: "#c8c8c8",
  MAGIC: "#8888ff",
  RARE: "#ffff77",
  UNIQUE: "#af6025",
  RELIC: "#60c060",
};

/** PoB names new rares "New Item"; the base says more. */
function itemName(item: GearItem) {
  return item.name === "New Item" && item.base ? item.base : item.name;
}

function artFor(item: GearItem, art: Art | undefined) {
  if (!art) return undefined;
  if (item.rarity === "UNIQUE" || item.rarity === "RELIC") {
    const unique = art.uniques.get(item.name);
    if (unique) return unique;
  }
  const base = item.base?.replace(/ \([^)]*\)$/, "");
  return base ? art.bases.get(base) : undefined;
}

/**
 * pob.codes-style Gear panel: the loadout's item set as a paper doll, with flasks, the
 * other slots (weapon swap, abyssal sockets, grafts) and the tree's jewels. Hover an item
 * for its mods; Trade opens a trade site search for something like it.
 */
export function GearPanel() {
  const stats = usePobStats()?.stats ?? null;
  const gear = stats?.gear ?? null;
  const lists = stats?.lists ?? null;
  const titles = useMemo(
    () => gear?.sets.map((set) => set.title) ?? [],
    [gear],
  );
  const [index, choose] = usePanelSet(
    titles,
    lists ? lists.active.items - 1 : null,
  );

  const leagues = useLeagues();
  const [savedLeague, setLeague] = useAtom(gearLeagueAtom);
  const league =
    savedLeague !== null && (!leagues || leagues.includes(savedLeague))
      ? savedLeague
      : (leagues?.[0] ?? null);

  return (
    <PageSection
      id="gear"
      title="Gear"
      actions={
        <>
          {leagues && leagues.length > 0 && league !== null && (
            <PanelSelect
              label="League"
              options={leagues}
              value={Math.max(0, leagues.indexOf(league))}
              onChange={(i) => setLeague(leagues[i])}
            />
          )}
          {titles.length > 1 && (
            <PanelSelect
              label="Item set"
              options={titles}
              value={index}
              onChange={choose}
            />
          )}
        </>
      }
    >
      {gear === null ? (
        <p className={classNames(styles.status)}>Calculating</p>
      ) : (
        <GearView
          gear={gear}
          setIndex={index}
          treeIndex={lists ? lists.active.tree - 1 : 0}
          league={league}
        />
      )}
    </PageSection>
  );
}

interface GearViewProps {
  gear: Gear;
  setIndex: number;
  /** The loadout's tree (PoB's order), for its jewels. */
  treeIndex: number;
  league: string | null;
}

function GearView({ gear, setIndex, treeIndex, league }: GearViewProps) {
  const art = useArt(league);
  const trade = useTradeData();
  const index = useMemo(
    () => (trade ? tradeIndex(trade.stats, trade.items) : null),
    [trade],
  );
  const [hovered, setHovered] = useState<GearItem | null>(null);

  const slots = gear.sets[setIndex]?.slots ?? [];
  const doll = slots.filter((s) => DOLL[s.slot] !== undefined);
  const flasks = slots.filter((s) => s.slot.startsWith("Flask"));
  const others = slots.filter(
    (s) => DOLL[s.slot] === undefined && !s.slot.startsWith("Flask"),
  );
  const jewels = gear.treeJewels[treeIndex] ?? [];

  const tile = (slot: string, itemId: number, size: string, label?: string) => {
    const item = gear.items[String(itemId)];
    if (!item) return null;
    return (
      <ItemTile
        key={`${slot}-${itemId}`}
        slot={slot}
        item={item}
        size={size}
        label={label}
        art={artFor(item, art)}
        tradeHref={
          index && league ? tradeUrl(index, item, slot, league) : undefined
        }
        area={DOLL[slot]}
        onHover={setHovered}
      />
    );
  };

  if (slots.length === 0 && jewels.length === 0)
    return <p className={classNames(styles.status)}>No items</p>;

  return (
    <div className={classNames(styles.gear)}>
      {hovered && <ItemTooltip item={hovered} />}
      <div className={classNames(styles.doll)}>
        {doll.map((s) => tile(s.slot, s.item, styles[DOLL[s.slot]]))}
      </div>
      {flasks.length > 0 && (
        <div className={classNames(styles.row)}>
          {flasks.map((s) => tile(s.slot, s.item, styles.flask))}
        </div>
      )}
      {others.length > 0 && (
        <Group title="Other">
          {others.map((s) =>
            tile(s.slot, s.item, styles.small, shortSlot(s.slot)),
          )}
        </Group>
      )}
      {jewels.length > 0 && (
        <Group title="Jewels">
          {jewels.map((j) => tile(`Jewel ${j.node}`, j.item, styles.small))}
        </Group>
      )}
    </div>
  );
}

/** "Weapon 1 Swap" → "Swap 1", "Belt Abyssal Socket 2" → "Abyss 2". */
function shortSlot(slot: string) {
  return slot
    .replace(/^Weapon (\d) Swap$/, "Swap $1")
    .replace(/^.* Abyssal Socket (\d)$/, "Abyss $1");
}

function Group({
  title,
  children,
}: React.PropsWithChildren<{ title: string }>) {
  return (
    <div className={classNames(styles.group)}>
      <h3 className={classNames(styles.groupTitle)}>{title}</h3>
      <div className={classNames(styles.row)}>{children}</div>
    </div>
  );
}

interface ItemTileProps {
  slot: string;
  item: GearItem;
  /** Size class from styles (w1, helm, flask, small...). */
  size: string;
  label?: string;
  art?: string;
  tradeHref?: string;
  area?: string;
  onHover: (item: GearItem | null) => void;
}

function ItemTile({
  slot,
  item,
  size,
  label,
  art,
  tradeHref,
  area,
  onHover,
}: ItemTileProps) {
  const name = itemName(item);
  return (
    <div
      className={classNames(styles.tile, size)}
      style={{
        gridArea: area,
        borderColor: RARITY_COLOURS[item.rarity ?? "NORMAL"],
      }}
      onPointerEnter={() => onHover(item)}
      onPointerLeave={() => onHover(null)}
      aria-label={`${slot}: ${name}`}
    >
      {art ? (
        <img className={classNames(styles.art)} src={art} alt="" />
      ) : (
        <span
          className={classNames(styles.name)}
          style={{ color: RARITY_COLOURS[item.rarity ?? "NORMAL"] }}
        >
          {name}
        </span>
      )}
      {label && <span className={classNames(styles.label)}>{label}</span>}
      {tradeHref && (
        <a
          className={classNames(styles.trade)}
          href={tradeHref}
          target="_blank"
          rel="noreferrer"
          aria-label={`Trade ${name}`}
          title="Trade"
        >
          <FaBalanceScale aria-hidden />
        </a>
      )}
    </div>
  );
}

/** The item's name, base and mods, as in game. */
function ItemTooltip({ item }: { item: GearItem }) {
  const colour = RARITY_COLOURS[item.rarity ?? "NORMAL"];
  const lines = (list: GearItem["explicit"], kind: string) =>
    list.map((line, i) => (
      <div
        key={`${kind}${i}`}
        className={classNames(styles.mod, {
          [styles.crafted]: line.crafted,
          [styles.fractured]: line.fractured,
          [styles.enchant]: kind === "enchant",
        })}
      >
        {line.text}
      </div>
    ));
  return (
    <SidebarTooltip
      title={
        <span style={{ color: colour }}>
          {itemName(item)}
          {item.base && item.base !== itemName(item) && (
            <span className={classNames(styles.base)}>{item.base}</span>
          )}
        </span>
      }
    >
      <div className={classNames(styles.mods)}>
        {(item.quality ?? 0) > 0 && (
          <div className={classNames(styles.meta)}>
            Quality: +{item.quality}%
          </div>
        )}
        {item.sockets && (
          <div className={classNames(styles.meta)}>Sockets: {item.sockets}</div>
        )}
        {lines(item.enchant, "enchant")}
        {lines(item.implicit, "implicit")}
        {item.implicit.length > 0 && item.explicit.length > 0 && <hr />}
        {lines(item.explicit, "explicit")}
        {item.corrupted && (
          <div className={classNames(styles.corrupted)}>Corrupted</div>
        )}
      </div>
    </SidebarTooltip>
  );
}
