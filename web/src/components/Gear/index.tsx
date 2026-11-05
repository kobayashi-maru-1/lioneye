import { PageSection } from "../PageSection";
import { PanelSelect } from "../PanelSelect";
import {
  type Gear,
  type GearItem,
  usePanelSet,
  usePobStats,
} from "../PobStats";
import { Popover, PopoverAction, usePopover } from "../Popover";
import {
  PoeTooltip,
  type TooltipKind,
  TooltipProperty,
  tooltipStyles,
} from "../PoeTooltip";
import {
  type Art,
  type TradeOptions,
  useArt,
  useTradeData,
  useTradeLeague,
  useTradeOptions,
} from "./data";
import styles from "./styles.module.css";
import { type TradeIndex, tradeIndex, tradeUrl } from "./trade-query";
import classNames from "classnames";
import { useMemo, useState } from "react";
import { FaBalanceScale, FaRegClipboard } from "react-icons/fa";
import { toast } from "react-toastify";

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

export const RARITY_COLOURS: Record<string, string> = {
  NORMAL: "#c8c8c8",
  MAGIC: "#8888ff",
  RARE: "#ffff77",
  UNIQUE: "#af6025",
  RELIC: "#60c060",
};

const TOOLTIP_KIND: Record<string, TooltipKind> = {
  NORMAL: "normal",
  MAGIC: "magic",
  RARE: "rare",
  UNIQUE: "unique",
  RELIC: "unique",
};

/** PoB names new rares "New Item"; the base says more. */
export function itemName(item: GearItem) {
  return item.name === "New Item" && item.base ? item.base : item.name;
}

export function artFor(item: GearItem, art: Art | undefined) {
  if (!art) return undefined;
  if (item.rarity === "UNIQUE" || item.rarity === "RELIC") {
    // "Foulborn X" uses X's art.
    const unique = art.uniques.get(item.name.replace(/^Foulborn /, ""));
    if (unique) return unique;
  }
  const base = item.base?.replace(/ \([^)]*\)$/, "");
  return base ? art.bases.get(base) : undefined;
}

/** Copies an item's text, as PoB writes it (pastes into PoB), to the clipboard. */
export async function copyItem(item: GearItem) {
  try {
    await navigator.clipboard.writeText(item.raw ?? itemName(item));
    toast.success("Item copied");
  } catch {
    toast.error("Copy failed. Try again.");
  }
}

/**
 * pob.codes-style Gear panel: the loadout's item set as a paper doll, with flasks, the
 * other slots (weapon swap, abyssal sockets, grafts) and the tree's jewels. Hover an item
 * for its tooltip; click to pin it and use Copy or Trade.
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
  const { league, leagues, setLeague } = useTradeLeague();

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

interface Shown {
  item: GearItem;
  slot: string;
}

function GearView({ gear, setIndex, treeIndex, league }: GearViewProps) {
  const art = useArt(league);
  const trade = useTradeData();
  const index = useMemo(
    () => (trade ? tradeIndex(trade.stats, trade.items) : null),
    [trade],
  );
  const popover = usePopover<Shown>();
  const [options] = useTradeOptions();

  const slots = gear.sets[setIndex]?.slots ?? [];
  const doll = slots.filter((s) => DOLL[s.slot] !== undefined);
  const flasks = slots.filter((s) => s.slot.startsWith("Flask"));
  const others = slots.filter(
    (s) => DOLL[s.slot] === undefined && !s.slot.startsWith("Flask"),
  );
  const jewels = gear.treeJewels[treeIndex] ?? [];

  const tile = (
    slot: string,
    itemId: number,
    size?: string,
    label?: string,
  ) => {
    const item = gear.items[String(itemId)];
    if (!item) return null;
    const key = `${slot}-${itemId}`;
    return (
      <ItemTile
        key={key}
        slot={slot}
        item={item}
        size={size}
        label={label}
        art={artFor(item, art)}
        area={DOLL[slot]}
        open={popover.state?.key === key}
        handlers={popover.bind({ item, slot }, key)}
      />
    );
  };

  if (slots.length === 0 && jewels.length === 0)
    return <p className={classNames(styles.status)}>No items</p>;

  const shown = popover.state;
  return (
    <div className={classNames(styles.gear)}>
      {shown && (
        <Popover
          anchor={shown.anchor}
          pinned={shown.pinned}
          onClose={popover.close}
          actions={
            <ItemActions
              item={shown.value.item}
              slot={shown.value.slot}
              index={index}
              league={league}
              options={options}
            />
          }
        >
          <ItemTooltip item={shown.value.item} />
        </Popover>
      )}
      <div className={classNames(styles.doll)}>
        {doll.map((s) => tile(s.slot, s.item))}
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

/** Copy and Trade, under a pinned item tooltip. */
export function ItemActions({
  item,
  slot,
  index,
  league,
  options,
}: {
  item: GearItem;
  slot: string;
  index: TradeIndex | null;
  league: string | null;
  options?: TradeOptions;
}) {
  return (
    <>
      <PopoverAction label="Copy" onClick={() => copyItem(item)}>
        <FaRegClipboard aria-hidden />
      </PopoverAction>
      {index && league && (
        <PopoverAction
          label="Trade"
          href={tradeUrl(index, item, slot, league, options)}
        >
          <FaBalanceScale aria-hidden />
        </PopoverAction>
      )}
    </>
  );
}

/** Short names for the parents of abyssal sockets. */
const ABYSS_PARENT: Record<string, string> = {
  "Weapon 1": "W1",
  "Weapon 2": "W2",
  "Weapon 1 Swap": "Swap W1",
  "Weapon 2 Swap": "Swap W2",
  Helmet: "Helm",
  "Body Armour": "Body",
  Gloves: "Gloves",
  Boots: "Boots",
  Belt: "Belt",
};

/** "Weapon 1 Swap" → "Swap 1", "Belt Abyssal Socket 2" → "Belt A2". */
function shortSlot(slot: string) {
  const abyss = /^(.*) Abyssal Socket (\d)$/.exec(slot);
  if (abyss) return `${ABYSS_PARENT[abyss[1]] ?? abyss[1]} A${abyss[2]}`;
  return slot.replace(/^Weapon (\d) Swap$/, "Swap $1");
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
  /** Size class (flask, small); paper-doll tiles take their grid area's size. */
  size?: string;
  label?: string;
  art?: string;
  area?: string;
  open: boolean;
  handlers: ReturnType<ReturnType<typeof usePopover<Shown>>["bind"]>;
}

/** An item: its art (or name) on a navy tile framed in its rarity colour. */
function ItemTile({
  slot,
  item,
  size,
  label,
  art,
  area,
  open,
  handlers,
}: ItemTileProps) {
  const name = itemName(item);
  return (
    <button
      className={classNames(styles.tile, size, { [styles.open]: open })}
      style={{
        gridArea: area,
        borderColor: RARITY_COLOURS[item.rarity ?? "NORMAL"],
      }}
      aria-label={`${slot}: ${name}`}
      {...handlers}
    >
      {art ? (
        <ItemArt src={art} className={classNames(styles.art)} />
      ) : (
        <span
          className={classNames(styles.name)}
          style={{ color: RARITY_COLOURS[item.rarity ?? "NORMAL"] }}
        >
          {name}
        </span>
      )}
      {label && <span className={classNames(styles.label)}>{label}</span>}
    </button>
  );
}

/**
 * An item's art. The game's flask art is a sheet of three frames (glass, back, liquid)
 * side by side; those are stacked into one flask: back, then liquid, then glass.
 */
export function ItemArt({
  src,
  className,
}: {
  src: string;
  className?: string;
}) {
  const [sheet, setSheet] = useState<{ src: string; ratio: number } | null>(
    null,
  );
  const ratio = sheet?.src === src ? sheet.ratio : null;
  if (ratio !== null && Math.abs(ratio - 1.5) < 0.05) {
    const layer = (position: string) => (
      <span
        className={classNames(styles.flaskLayer)}
        style={{
          backgroundImage: `url("${src}")`,
          backgroundPosition: position,
        }}
      />
    );
    return (
      <span className={classNames(className, styles.flaskArt)} aria-hidden>
        {layer("50% 0")}
        {layer("100% 0")}
        {layer("0 0")}
      </span>
    );
  }
  return (
    <img
      className={className}
      src={src}
      alt=""
      onLoad={(event) => {
        const img = event.currentTarget;
        if (img.naturalHeight > 0)
          setSheet({ src, ratio: img.naturalWidth / img.naturalHeight });
      }}
    />
  );
}

/** The item as the game shows it: banner, quality, sockets, requirements, mods. */
export function ItemTooltip({ item }: { item: GearItem }) {
  const name = itemName(item);
  const showBase = item.base && item.base !== name;
  const requires = item.requires;
  const requireParts = requires
    ? [
        requires.level && `Level ${requires.level}`,
        requires.str && `${requires.str} Str`,
        requires.dex && `${requires.dex} Dex`,
        requires.int && `${requires.int} Int`,
      ].filter(Boolean)
    : [];
  const lines = (list: GearItem["explicit"], kind: string) =>
    list.map((line, i) => (
      <div
        key={`${kind}${i}`}
        className={classNames(tooltipStyles.mod, {
          [tooltipStyles.crafted]: line.crafted,
          [tooltipStyles.fractured]: line.fractured,
          [tooltipStyles.enchant]: kind === "enchant",
        })}
      >
        {line.text}
      </div>
    ));
  return (
    <PoeTooltip
      kind={TOOLTIP_KIND[item.rarity ?? "NORMAL"] ?? "normal"}
      name={name}
      base={showBase ? item.base : undefined}
    >
      {((item.quality ?? 0) > 0 || item.sockets) && (
        <>
          {(item.quality ?? 0) > 0 && (
            <TooltipProperty label="Quality:" value={`+${item.quality}%`} />
          )}
          {item.sockets && (
            <TooltipProperty label="Sockets:" value={item.sockets} />
          )}
        </>
      )}
      {requireParts.length > 0 && (
        <TooltipProperty label="Requires" value={requireParts.join(", ")} />
      )}
      {item.enchant.length > 0 && lines(item.enchant, "enchant")}
      {item.implicit.length > 0 && lines(item.implicit, "implicit")}
      {(item.explicit.length > 0 || item.corrupted) && (
        <>
          {lines(item.explicit, "explicit")}
          {item.corrupted && (
            <div className={classNames(tooltipStyles.corrupted)}>Corrupted</div>
          )}
        </>
      )}
    </PoeTooltip>
  );
}
