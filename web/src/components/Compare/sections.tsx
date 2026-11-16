// Compare's panels. Build 1 is blue and Build 2 orange throughout: a value in a build's
// colour is where that build is ahead, and a bar grows from the centre toward it.

import { RARITY_COLOURS, itemName } from "../Gear";
import { useTradeData, useTradeLeague, useTradeOptions } from "../Gear/data";
import { tradeIndex, tradeUrl } from "../Gear/trade-query";
import { PageSection, useJumpToSection } from "../PageSection";
import type { GearItem, Stats } from "../PobStats";
import { itemDiffs, skillDiffs } from "./diff";
import {
  type CalcCell,
  type CalcLine,
  type Factor,
  type FactorFmt,
  type Metric,
  type Why,
  type WhyBlock,
  type WhyFormula,
  type WhyRow,
  calcBlocks,
  calcLines,
} from "./metrics";
import type { Gap, Result } from "./run";
import styles from "./styles.module.css";
import classNames from "classnames";
import { Fragment, type ReactNode, useMemo, useState } from "react";

// Numbers -----------------------------------------------------------------------------

const MINUS = "−";
const n = (value: number, digits = 0) =>
  Math.abs(value).toLocaleString("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });

/** A metric's value: "255.8k", "1.2M", "75%", "3,779"; — when PoB had none. */
export function fmt(metric: Metric | undefined, value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const sign = value < 0 ? MINUS : "";
  const size = Math.abs(value);
  if (metric?.fmt === "k") {
    if (size >= 1e6) return sign + n(value / 1e6, size >= 1e8 ? 0 : 1) + "M";
    if (size >= 10_000) return sign + n(value / 1000, 1) + "k";
    return sign + n(value);
  }
  if (metric?.fmt === "%") return sign + n(value) + "%";
  return sign + n(value);
}

/** A plain number, one decimal when it has one. */
const plain = (value: number) => (value < 0 ? MINUS : "") + n(value, value % 1 ? 1 : 0);

/** Which build a difference favours: 1 Build 1, -1 Build 2, 0 even. */
const side = (difference: number) => (difference > 0 ? 1 : difference < 0 ? -1 : 0);
const sideClass = (lead: number) => (lead > 0 ? styles.b1 : lead < 0 ? styles.b2 : styles.muted);
/** The leading value bold in its build's colour, the other dimmed. */
const leadClass = (lead: number, mine: 1 | -1) =>
  lead === 0
    ? undefined
    : lead === mine
      ? classNames(styles.lead, mine > 0 ? styles.b1 : styles.b2)
      : styles.trail;

/**
 * Bar length (0-1) from how far apart two values are: percent stats by points (50 is the
 * whole bar), the rest by ratio (half again is the whole bar). Square root, so a small lead
 * still shows.
 */
function reach(a: number, b: number, percent: boolean) {
  const apart = Math.abs(a - b);
  const ratio = percent ? apart / 50 : apart / Math.max(Math.abs(a), Math.abs(b), 1e-9) / 0.5;
  return Math.max(0.05, Math.sqrt(Math.min(1, ratio)));
}

function Bar({ lead, length, mini }: { lead: number; length: number; mini?: boolean }) {
  const width = { width: `${(length * 100).toFixed(1)}%` };
  return (
    <span className={classNames(styles.bar, { [styles.mini]: mini })} aria-hidden>
      <span className={classNames(styles.half, styles.left)}>{lead > 0 && <i style={width} />}</span>
      <span className={classNames(styles.half, styles.right)}>{lead < 0 && <i style={width} />}</span>
    </span>
  );
}

export function BuildName({ which }: { which: 1 | 2 }) {
  return (
    <span className={which === 1 ? styles.b1 : styles.b2}>
      <span className={classNames(styles.swatch)} aria-hidden />
      Build {which}
    </span>
  );
}

// Summary -----------------------------------------------------------------------------

const SECTION_ORDER: Metric["section"][] = ["Offence", "Defence", "Misc"];

export function SummarySection({
  result,
  onAll,
  onShow,
}: {
  result: Result;
  onAll: (key: string) => void;
  onShow: (gap: Gap) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const metrics = [...result.metrics].sort(
    (a, b) => SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section),
  );
  let section = "";
  return (
    <PageSection id="compare-summary" title="Summary">
      <div className={classNames(styles.tug)}>
        <div className={classNames(styles.tugRow, styles.tugHead)}>
          <span className={classNames(styles.label)} />
          <span className={classNames(styles.right)}>
            <BuildName which={1} />
          </span>
          <span />
          <span>
            <BuildName which={2} />
          </span>
          <span className={classNames(styles.diff)}>Diff</span>
        </div>
        {metrics.map((metric) => {
          const a = result.values.one[metric.key];
          const b = result.values.two[metric.key];
          const lead = a !== null && b !== null && Math.abs(a - b) >= metric.thresh ? side(a - b) : 0;
          const heading = metric.section !== section;
          section = metric.section;
          const isOpen = open === metric.key;
          return (
            <div key={metric.key}>
              {heading && <div className={classNames(styles.group)}>{metric.section}</div>}
              <button
                type="button"
                className={classNames(styles.tugRow)}
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : metric.key)}
              >
                <span className={classNames(styles.label)}>{metric.label}</span>
                <span className={classNames(styles.right, leadClass(lead, 1))}>{fmt(metric, a)}</span>
                <Bar
                  lead={lead}
                  length={lead && a !== null && b !== null ? reach(a, b, metric.fmt === "%") : 0}
                />
                <span className={leadClass(lead, -1)}>{fmt(metric, b)}</span>
                <span className={classNames(styles.diff, sideClass(lead))}>
                  {lead && a !== null && b !== null ? fmt(metric, Math.abs(a - b)) : "="}
                </span>
                <span className={classNames(styles.sr)}>
                  {lead > 0 ? "Build 1 ahead" : lead < 0 ? "Build 2 ahead" : "Even"}
                </span>
              </button>
              {isOpen && <SummaryDrawer result={result} metric={metric} onAll={onAll} onShow={onShow} />}
            </div>
          );
        })}
      </div>
    </PageSection>
  );
}

function SummaryDrawer({
  result,
  metric,
  onAll,
  onShow,
}: {
  result: Result;
  metric: Metric;
  onAll: (key: string) => void;
  onShow: (gap: Gap) => void;
}) {
  const why = metric.why ? result.why[metric.why] : undefined;
  const top = result.gaps
    .filter((gap) => (gap.d[metric.key] ?? 0) >= metric.thresh)
    .sort((a, b) => (b.d[metric.key] ?? 0) - (a.d[metric.key] ?? 0))
    .slice(0, 3);
  return (
    <div className={classNames(styles.drawer)}>
      {why && <WhyView why={why} />}
      {top.length > 0 && (
        <div className={classNames(styles.gapList)}>
          <div className={classNames(styles.gapHead, styles.b1)}>Top gains</div>
          <GapTable result={result} gaps={top} sortKey={metric.key} onShow={onShow} />
          <div>
            <button type="button" className={classNames(styles.button)} onClick={() => onAll(metric.key)}>
              Show all
            </button>
          </div>
        </div>
      )}
      {!why && top.length === 0 && (
        <div className={classNames(styles.empty)}>{result.pending > 0 ? "Calculating" : "No gains"}</div>
      )}
    </div>
  );
}

// Gaps --------------------------------------------------------------------------------

/** Build 2's item in a slot, for its Trade search. */
function itemIn(stats: Stats | undefined, slot: string): GearItem | undefined {
  const gear = stats?.gear;
  if (!gear) return undefined;
  const set = gear.sets[(stats.lists?.active.items ?? 1) - 1] ?? gear.sets[0];
  const id = set?.slots.find((s) => s.slot === slot)?.item;
  return id === undefined ? undefined : gear.items[String(id)];
}

/** A gap's change to one stat: ▲ in Build 1's colour (a gain), ▼ in Build 2's (a loss). */
function ChangeCell({ metric, value }: { metric: Metric; value: number | null | undefined }) {
  if (value === null || value === undefined || Math.abs(value) < metric.thresh)
    return (
      <span className={styles.muted}>
        <span aria-hidden>·</span>
        <span className={classNames(styles.sr)}>No change</span>
      </span>
    );
  return (
    <span className={sideClass(side(value))}>
      <span aria-hidden>{value > 0 ? "▲ " : "▼ "}</span>
      {value > 0 ? "+" : ""}
      {fmt(metric, value)}
    </span>
  );
}

/** Show (and Trade, for one gear slot) for a gap. */
function GapActions({ gap, result, onShow }: { gap: Gap; result: Result; onShow: (gap: Gap) => void }) {
  const trade = useTradeData();
  const index = useMemo(() => (trade ? tradeIndex(trade.stats, trade.items) : null), [trade]);
  const { league } = useTradeLeague();
  const [options] = useTradeOptions();
  const item =
    gap.kind === "Gear" && gap.slot && gap.id !== "gear-all" && gap.id !== "gear-flasks"
      ? itemIn(result.two.stats, gap.slot)
      : undefined;
  return (
    <span className={classNames(styles.row)}>
      {(gap.target === "items" || gap.target === "skills") && (
        <button type="button" className={classNames(styles.button)} onClick={() => onShow(gap)}>
          Show
        </button>
      )}
      {item && index && league && gap.slot && (
        <a
          className={classNames(styles.button)}
          href={tradeUrl(index, item, gap.slot, league, options)}
          target="_blank"
          rel="noreferrer"
        >
          Trade
        </a>
      )}
    </span>
  );
}

/**
 * Gaps as a table: a row per piece of Build 2 tried on Build 1, a column per stat, each
 * cell the change to Build 1. Sorted by one stat's change, biggest gain first.
 */
function GapTable({
  result,
  gaps,
  sortKey,
  setSortKey,
  onShow,
}: {
  result: Result;
  gaps: Gap[];
  sortKey: string;
  setSortKey?: (key: string) => void;
  onShow: (gap: Gap) => void;
}) {
  const rows = [...gaps].sort(
    (a, b) => (b.d[sortKey] ?? 0) - (a.d[sortKey] ?? 0) || a.title.localeCompare(b.title),
  );
  return (
    <div className={classNames(styles.scroll)}>
      <table className={classNames(styles.table, styles.gapTable)}>
        <thead>
          <tr>
            <th className={classNames(styles.swapCell)}>From Build 2</th>
            {result.metrics.map((m) => (
              <th
                key={m.key}
                className={classNames(styles.right)}
                aria-sort={m.key === sortKey ? "descending" : undefined}
              >
                {setSortKey ? (
                  <button
                    type="button"
                    className={classNames(styles.sortButton, {
                      [styles.sorted]: m.key === sortKey,
                    })}
                    onClick={() => setSortKey(m.key)}
                  >
                    {m.label}
                  </button>
                ) : (
                  m.label
                )}
              </th>
            ))}
            <th>
              <span className={classNames(styles.sr)}>Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((gap) => (
            <tr key={gap.id}>
              <td className={classNames(styles.swapCell)}>
                <span className={classNames(styles.kind)}>{gap.kind}</span>{" "}
                <b className={classNames(styles.swapTitle)}>{gap.title}</b>
                <div className={classNames(styles.detail)}>{gap.detail}</div>
              </td>
              {result.metrics.map((m) => (
                <td key={m.key} className={classNames(styles.right)}>
                  <ChangeCell metric={m} value={gap.d[m.key]} />
                </td>
              ))}
              <td>
                <GapActions gap={gap} result={result} onShow={onShow} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function GapsSection({
  result,
  sortKey,
  setSortKey,
  onShow,
}: {
  result: Result;
  sortKey: string;
  setSortKey: (key: string) => void;
  onShow: (gap: Gap) => void;
}) {
  const key = result.metrics.some((m) => m.key === sortKey) ? sortKey : (result.metrics[0]?.key ?? "dps");
  // Gaps that change something worth showing.
  const gaps = result.gaps.filter((gap) =>
    result.metrics.some((m) => Math.abs(gap.d[m.key] ?? 0) >= m.thresh),
  );
  const total = result.gaps.length + result.pending + result.failed;
  return (
    <PageSection
      id="compare-gaps"
      title="Gaps"
      actions={
        <>
          {result.pending > 0 && (
            <span className={classNames(styles.chip)}>
              {total - result.pending} / {total}
            </span>
          )}
          {result.failed > 0 && <span className={classNames(styles.chip)}>{result.failed} failed</span>}
          <span className={classNames(styles.chip)} aria-label="Build 2 on Build 1">
            Build 2 → Build 1
          </span>
        </>
      }
    >
      {gaps.length > 0 ? (
        <GapTable result={result} gaps={gaps} sortKey={key} setSortKey={setSortKey} onShow={onShow} />
      ) : (
        <div className={classNames(styles.empty)}>{result.pending > 0 ? "Calculating" : "No gaps"}</div>
      )}
    </PageSection>
  );
}

// Why ---------------------------------------------------------------------------------

function FormulaLine({ f }: { f: WhyFormula }) {
  if (!f.ok) return <b>{plain(f.total)}</b>;
  if (f.kind === "pool")
    return (
      <>
        {n(f.flat)} × (1 + {plain(f.inc)}%)
        {f.more !== 1 && ` × ${f.more.toFixed(2)}`} = <b>{n(f.total)}</b>
      </>
    );
  return f.sum > f.cap ? (
    <>
      {plain(f.sum)}% · cap {f.cap}% = <b>{plain(f.total)}%</b>
    </>
  ) : (
    <b>{plain(f.total)}%</b>
  );
}

/** A pair of values (and their difference) in the leading build's colour. */
function PairCells({ a, b, unit }: { a: number | null; b: number | null; unit: string }) {
  const lead = side((a ?? 0) - (b ?? 0));
  return (
    <>
      <td className={classNames(styles.right, leadClass(lead, 1))}>{a === null ? "—" : plain(a) + unit}</td>
      <td className={classNames(styles.right, leadClass(lead, -1))}>{b === null ? "—" : plain(b) + unit}</td>
      <td className={classNames(styles.right, sideClass(lead))}>
        {lead ? plain(Math.abs((a ?? 0) - (b ?? 0))) + unit : "="}
      </td>
    </>
  );
}

function sourceDetail(row: WhyRow) {
  if (row.oneDetail && row.twoDetail && row.oneDetail !== row.twoDetail)
    return `${row.oneDetail} / ${row.twoDetail}`;
  return row.oneDetail ?? row.twoDetail;
}

/** A factor's value: "23.8k", "75%", "×1.30", "+412%", "3.76/s", "2.4s". */
function factorValue(fmtKind: FactorFmt, value: number | null) {
  if (value === null) return "—";
  switch (fmtKind) {
    case "k":
      return fmt({ fmt: "k" } as Metric, value);
    case "%":
      return `${n(value, value % 1 && Math.abs(value) < 10 ? 1 : 0)}%`;
    case "x":
      return `×${n(value, 2)}`;
    case "inc":
      return `${value < 1 ? MINUS : "+"}${n(Math.abs(value - 1) * 100)}%`;
    case "rate":
      return `${n(value, 2)}/s`;
    case "s":
      return `${n(value, 2)}s`;
  }
}

/** How many times one build's value is the other's (1: level). */
const ratioOf = (one: number | null, two: number | null) =>
  one && two && one > 0 && two > 0 ? Math.max(one, two) / Math.min(one, two) : 1;

/** The row with the widest ratio, if any is wide enough to matter. */
function widestOf<T extends { one: number | null; two: number | null }>(rows: T[]) {
  return rows
    .filter((row) => ratioOf(row.one, row.two) >= 1.05)
    .reduce<T | null>(
      (best, row) => (best === null || ratioOf(row.one, row.two) > ratioOf(best.one, best.two) ? row : best),
      null,
    );
}

/** A factor or part row's values, ratio and note, in the leading build's colour. */
function RatioCells({
  fmtKind,
  one,
  two,
  biggest,
}: {
  fmtKind: FactorFmt;
  one: number | null;
  two: number | null;
  biggest: boolean;
}) {
  const a = one ?? 0;
  const b = two ?? 0;
  const lead = Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 0.005 ? 0 : side(a - b);
  const r = ratioOf(one, two);
  return (
    <>
      <td className={classNames(styles.right, leadClass(lead, 1))}>{factorValue(fmtKind, one)}</td>
      <td className={classNames(styles.right, leadClass(lead, -1))}>{factorValue(fmtKind, two)}</td>
      <td className={classNames(styles.right, sideClass(lead))}>
        {lead === 0 ? "=" : r > 1 && Number.isFinite(r) ? `×${n(r, r >= 10 ? 0 : 2)}` : "—"}
      </td>
      <td>{biggest && <span className={classNames(styles.chip)}>Biggest</span>}</td>
    </>
  );
}

/** A row label that opens what's under it. */
function Toggle({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <button type="button" className={classNames(styles.toggle)} aria-expanded={open} onClick={onToggle}>
      <span className={classNames(styles.caret)} aria-hidden="true">
        {open ? "▾" : "▸"}
      </span>
      {children}
    </button>
  );
}

/**
 * The DPS factors side by side, the widest multiplying one marked. A factor opens into the
 * parts it is the product of, and a part into its sources.
 */
function FactorTable({ factors }: { factors: Factor[] }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (key: string) =>
    setOpen((now) => {
      const next = new Set(now);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const widest = widestOf(factors.filter((f) => f.multiplies));
  return (
    <div className={classNames(styles.scroll)}>
      <table className={classNames(styles.table)}>
        <thead>
          <tr>
            <th>DPS</th>
            <th className={classNames(styles.right)}>
              <BuildName which={1} />
            </th>
            <th className={classNames(styles.right)}>
              <BuildName which={2} />
            </th>
            <th className={classNames(styles.right)}>Ratio</th>
            <th>
              <span className={classNames(styles.sr)}>Note</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {factors.map((f) => {
            const parts = f.parts ?? [];
            const opened = parts.length > 0 && open.has(f.label);
            const widestPart = opened && !f.lowest ? widestOf(parts) : null;
            return (
              <Fragment key={f.label}>
                <tr className={classNames({ [styles.groupRow]: f.total })}>
                  <td>
                    {parts.length ? (
                      <Toggle open={opened} onToggle={() => toggle(f.label)}>
                        {f.label}
                      </Toggle>
                    ) : (
                      f.label
                    )}
                  </td>
                  <RatioCells fmtKind={f.fmt} one={f.one} two={f.two} biggest={f === widest} />
                </tr>
                {opened &&
                  parts.map((p) => {
                    const key = f.label + "|" + p.label;
                    const partOpen = !!p.block && open.has(key);
                    return (
                      <Fragment key={key}>
                        <tr className={classNames(styles.partRow)}>
                          <td>
                            {p.block ? (
                              <Toggle open={partOpen} onToggle={() => toggle(key)}>
                                {p.label}
                              </Toggle>
                            ) : (
                              p.label
                            )}
                          </td>
                          <RatioCells fmtKind={p.fmt} one={p.one} two={p.two} biggest={p === widestPart} />
                        </tr>
                        {partOpen && p.block && (
                          <tr className={classNames(styles.sourcesRow)}>
                            <td colSpan={5}>
                              <SourceTable block={p.block} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** A source table: each source's value for both builds, and the total. */
function SourceTable({ block }: { block: WhyBlock }) {
  const unit = block.unit ?? "";
  // "More" mods multiply; the rest add up.
  const total = (pick: (row: WhyRow) => number | null) =>
    block.product
      ? (block.rows.reduce((s, row) => s * (1 + (pick(row) ?? 0) / 100), 1) - 1) * 100
      : block.rows.reduce((s, row) => s + (pick(row) ?? 0), 0);
  return (
    <div className={classNames(styles.scroll)}>
      <table className={classNames(styles.table)}>
        <thead>
          <tr>
            <th>{block.title}</th>
            <th className={classNames(styles.right)}>
              <BuildName which={1} />
            </th>
            <th className={classNames(styles.right)}>
              <BuildName which={2} />
            </th>
            <th className={classNames(styles.right)}>Diff</th>
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row) => {
            const detail = sourceDetail(row);
            return (
              <tr key={row.group + row.key} className={classNames({ [styles.same]: row.one === row.two })}>
                <td className={classNames(styles.source)}>
                  {row.group} · {row.key}
                  {detail && <small>{detail}</small>}
                </td>
                <PairCells a={row.one} b={row.two} unit={unit} />
              </tr>
            );
          })}
          {!block.noTotal && (
            <tr className={classNames(styles.groupRow)}>
              <td>Total</td>
              <PairCells
                a={Math.round(total((r) => r.one) * 10) / 10}
                b={Math.round(total((r) => r.two) * 10) / 10}
                unit={unit}
              />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function WhyView({ why }: { why: Why }) {
  return (
    <div className={classNames(styles.why)} role="region" aria-label="Sources">
      {why.formula && (
        <div className={classNames(styles.formula)}>
          <span className={classNames(styles.who)}>
            <BuildName which={1} />
          </span>
          <span>
            <FormulaLine f={why.formula[0]} />
          </span>
          <span className={classNames(styles.who)}>
            <BuildName which={2} />
          </span>
          <span>
            <FormulaLine f={why.formula[1]} />
          </span>
        </div>
      )}
      {why.factors && <FactorTable factors={why.factors} />}
      {why.blocks.map((block) => (
        <SourceTable key={block.title} block={block} />
      ))}
    </div>
  );
}

// Stats -------------------------------------------------------------------------------

/** PoB's sidebar stats for both builds (a comparison PoB sent no Calcs tab for). */
function SidebarStats({ result }: { result: Result }) {
  const [query, setQuery] = useState("");
  const [same, setSame] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const q = query.trim().toLowerCase();
  const rows = result.lines.filter(
    (line) => (same || line.one !== line.two) && (!q || line.label.toLowerCase().includes(q)),
  );
  const number = (value: string | undefined) => parseFloat(String(value ?? "").replace(/,/g, ""));
  let section = "";
  return (
    <PageSection id="compare-stats" title="Stats">
      <div className={classNames(styles.tools)}>
        <input
          className={classNames(styles.input, styles.search)}
          type="search"
          placeholder="Search"
          aria-label="Search stats"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className={classNames(styles.check)}>
          <input type="checkbox" checked={same} onChange={(e) => setSame(e.target.checked)} />
          Show same
        </label>
      </div>
      <div className={classNames(styles.scroll)}>
        <table className={classNames(styles.table)}>
          <thead>
            <tr>
              <th>Stat</th>
              <th className={classNames(styles.right)}>
                <BuildName which={1} />
              </th>
              <th className={classNames(styles.statBar)}>
                <span className={classNames(styles.sr)}>Ahead</span>
              </th>
              <th>
                <BuildName which={2} />
              </th>
              <th className={classNames(styles.right)}>Diff</th>
              <th>
                <span className={classNames(styles.sr)}>Sources</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className={classNames(styles.empty)}>
                  {q ? "No matches" : "No differences"}
                </td>
              </tr>
            )}
            {rows.map((line, i) => {
              const heading = line.section !== section;
              section = line.section;
              const d = line.diff;
              const lead = d === undefined || Math.abs(d) < 0.005 ? 0 : side(d) * (line.lower ? -1 : 1);
              const percent = /%$/.test(line.one ?? "") || /%$/.test(line.two ?? "");
              const isOpen = !!line.why && open === line.why;
              return [
                heading && (
                  <tr key={`h${i}`} className={classNames(styles.groupRow)}>
                    <td colSpan={6}>{line.section}</td>
                  </tr>
                ),
                <tr
                  key={`r${i}`}
                  className={classNames({
                    [styles.same]: line.one === line.two,
                    [styles.open]: isOpen,
                  })}
                >
                  <td>
                    {line.label}
                    {line.calcs && <span className={classNames(styles.tag)}>CALCS</span>}
                  </td>
                  <td className={classNames(styles.right, leadClass(lead, 1))}>{line.one ?? "—"}</td>
                  <td className={classNames(styles.statBar)}>
                    {lead !== 0 && (
                      <>
                        <Bar lead={lead} length={reach(number(line.one), number(line.two), percent)} mini />
                        <span className={classNames(styles.sr)}>Build {lead > 0 ? 1 : 2}</span>
                      </>
                    )}
                  </td>
                  <td className={leadClass(lead, -1)}>{line.two ?? "—"}</td>
                  <td className={classNames(styles.right)}>
                    {d === undefined ? (
                      ""
                    ) : lead === 0 ? (
                      <span className={styles.muted}>=</span>
                    ) : (
                      <span className={sideClass(lead)}>
                        {n(d, Math.abs(d) % 1 ? (Math.abs(d) < 10 ? 2 : 1) : 0)}
                      </span>
                    )}
                  </td>
                  <td className={classNames(styles.right)}>
                    {line.why && (
                      <button
                        type="button"
                        className={classNames(styles.button)}
                        aria-expanded={isOpen}
                        onClick={() => setOpen(isOpen ? null : line.why!)}
                      >
                        Why
                      </button>
                    )}
                  </td>
                </tr>,
                isOpen && (
                  <tr key={`w${i}`}>
                    <td colSpan={6} className={classNames(styles.drawerCell)}>
                      <WhyView why={result.why[line.why!]} />
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
      </div>
    </PageSection>
  );
}

// Skills ------------------------------------------------------------------------------

/** PoB's Calcs tab for both builds; the sidebar list when PoB sent no Calcs tab for one. */
export function StatsSection({ result }: { result: Result }) {
  // Both builds need PoB's Calcs tab, or neither column could be compared row by row.
  if (!result.one.extra.calcsPage || !result.two.extra.calcsPage) return <SidebarStats result={result} />;
  // A new Build 1 main skill starts the switch over (Minion for a minion's skill).
  return <CalcsStats key={result.one.extra.minionMain ? "minion" : "player"} result={result} />;
}

function CalcsStats({ result }: { result: Result }) {
  const hasMinion = !!(result.one.extra.calcsPage?.minion || result.two.extra.calcsPage?.minion);
  const [who, setWho] = useState<"player" | "minion">(
    hasMinion && result.one.extra.minionMain ? "minion" : "player",
  );
  const actor = hasMinion ? who : "player";
  const [query, setQuery] = useState("");
  const [same, setSame] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const all = useMemo(() => calcLines(result.one.extra, result.two.extra, actor), [result, actor]);
  const q = query.trim().toLowerCase();
  const rows = all.filter(
    (line) =>
      (same || line.one?.value !== line.two?.value) &&
      (!q || line.label.toLowerCase().includes(q) || line.section.toLowerCase().includes(q)),
  );
  const detailed = (cell: CalcCell | undefined) =>
    !!cell && (cell.lines.length > 0 || cell.tables.length > 0 || cell.mods.some((m) => m.rows.length > 0));
  let section = "";
  return (
    <PageSection id="compare-stats" title="Stats">
      <div className={classNames(styles.tools)}>
        {hasMinion && (
          <div className={classNames(styles.switch)} role="group" aria-label="Stats of">
            {(["player", "minion"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={classNames(styles.switchButton)}
                aria-pressed={who === value}
                onClick={() => {
                  setWho(value);
                  setOpen(null);
                }}
              >
                {value === "player" ? "Player" : "Minion"}
              </button>
            ))}
          </div>
        )}
        <input
          className={classNames(styles.input, styles.search)}
          type="search"
          placeholder="Search"
          aria-label="Search stats"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className={classNames(styles.check)}>
          <input type="checkbox" checked={same} onChange={(e) => setSame(e.target.checked)} />
          Show same
        </label>
      </div>
      <div className={classNames(styles.scroll)}>
        <table className={classNames(styles.table)}>
          <thead>
            <tr>
              <th>Stat</th>
              <th className={classNames(styles.right)}>
                <BuildName which={1} />
              </th>
              <th className={classNames(styles.statBar)}>
                <span className={classNames(styles.sr)}>Ahead</span>
              </th>
              <th>
                <BuildName which={2} />
              </th>
              <th className={classNames(styles.right)}>Diff</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className={classNames(styles.empty)}>
                  {q ? "No matches" : "No differences"}
                </td>
              </tr>
            )}
            {rows.map((line) => {
              const heading = line.section !== section;
              section = line.section;
              const d = line.diff;
              const lead = d === undefined || Math.abs(d) < 0.005 ? 0 : side(d) * (line.lower ? -1 : 1);
              const one = line.one?.value;
              const two = line.two?.value;
              const percent = /%/.test(one ?? "") || /%/.test(two ?? "");
              const canOpen = detailed(line.one) || detailed(line.two);
              const isOpen = canOpen && open === line.order;
              return (
                <Fragment key={line.order}>
                  {heading && (
                    <tr className={classNames(styles.groupRow)}>
                      <td colSpan={5}>{line.section}</td>
                    </tr>
                  )}
                  <tr className={classNames({ [styles.same]: one === two, [styles.open]: isOpen })}>
                    <td>
                      {canOpen ? (
                        <Toggle open={isOpen} onToggle={() => setOpen(isOpen ? null : line.order)}>
                          {line.label}
                        </Toggle>
                      ) : (
                        line.label
                      )}
                    </td>
                    <td className={classNames(styles.right, leadClass(lead, 1))}>{one || "—"}</td>
                    <td className={classNames(styles.statBar)}>
                      {lead !== 0 && (
                        <>
                          <Bar
                            lead={lead}
                            length={reach(Math.abs(calcValue(one)), Math.abs(calcValue(two)), percent)}
                            mini
                          />
                          <span className={classNames(styles.sr)}>Build {lead > 0 ? 1 : 2}</span>
                        </>
                      )}
                    </td>
                    <td className={leadClass(lead, -1)}>{two || "—"}</td>
                    <td className={classNames(styles.right)}>
                      {d === undefined ? (
                        ""
                      ) : lead === 0 ? (
                        <span className={styles.muted}>=</span>
                      ) : (
                        <span className={sideClass(lead)}>
                          {n(d, Math.abs(d) % 1 ? (Math.abs(d) < 10 ? 2 : 1) : 0)}
                        </span>
                      )}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={5} className={classNames(styles.drawerCell)}>
                        <CalcDetail result={result} line={line} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </PageSection>
  );
}

/** A Calcs value's leading number ("x 1.158" → 1.158), 0 when it has none. */
const calcValue = (value: string | undefined) =>
  parseFloat(
    String(value ?? "")
      .replace(/^x\s*/, "")
      .replace(/,/g, ""),
  ) || 0;

/** PoB's working for one build: its tooltip's lines and tables. */
function Working({ cell }: { cell: CalcCell | undefined }) {
  if (!cell || (cell.lines.length === 0 && cell.tables.length === 0))
    return <div className={classNames(styles.muted)}>—</div>;
  return (
    <>
      {cell.lines.length > 0 && (
        <div className={classNames(styles.workingLines)}>
          {cell.lines.map((line, i) => (
            <div key={i}>{line || " "}</div>
          ))}
        </div>
      )}
      {cell.tables.map((table, i) => (
        <div key={i} className={classNames(styles.scroll)}>
          <table className={classNames(styles.table)}>
            <thead>
              <tr>
                {table.cols.map((col, j) => (
                  <th key={j}>{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, j) => (
                <tr key={j}>
                  {row.map((value, k) => (
                    <td key={k}>{value}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {table.footer && <div className={classNames(styles.workingLines)}>{table.footer}</div>}
        </div>
      ))}
    </>
  );
}

/** A Calcs row opened: both builds' working side by side, then its mods by source. */
function CalcDetail({ result, line }: { result: Result; line: CalcLine }) {
  const blocks = useMemo(() => calcBlocks(result.one, result.two, line), [result, line]);
  const hasWorking = [line.one, line.two].some((cell) => cell && (cell.lines.length || cell.tables.length));
  return (
    <div className={classNames(styles.why)} role="region" aria-label="Sources">
      {hasWorking && (
        <div className={classNames(styles.working)}>
          <div>
            <div className={classNames(styles.who)}>
              <BuildName which={1} />
            </div>
            <Working cell={line.one} />
          </div>
          <div>
            <div className={classNames(styles.who)}>
              <BuildName which={2} />
            </div>
            <Working cell={line.two} />
          </div>
        </div>
      )}
      {blocks.map((block) => (
        <SourceTable key={block.title} block={block} />
      ))}
    </div>
  );
}

export function SkillsSection({ result }: { result: Result }) {
  const one = result.one.stats;
  const two = result.two.stats;
  const diffs = useMemo(() => (one && two ? skillDiffs(one, two) : []), [one, two]);
  return (
    <PageSection id="compare-skills" title="Skills">
      {diffs.length === 0 && <div className={classNames(styles.empty)}>No differences</div>}
      <div className={classNames(styles.groups)}>
        {diffs.map((diff, i) => {
          const gems = (group: typeof diff.yours) => group?.gems.filter((gem) => gem.enabled) ?? [];
          const names = [...new Set([...gems(diff.guide), ...gems(diff.yours)].map((gem) => gem.name))];
          const level = (gem: ReturnType<typeof gems>[number] | undefined) =>
            gem ? `${gem.level ?? "—"}${gem.quality ? "/" + gem.quality : ""}` : "—";
          const slots = [diff.yours?.slot, diff.guide?.slot].filter(Boolean);
          return (
            <div key={`${diff.name}-${i}`} className={classNames(styles.card)}>
              <h3>{diff.name}</h3>
              {slots.length > 0 && (
                <div className={classNames(styles.sub)}>{[...new Set(slots)].join(" / ")}</div>
              )}
              <table className={classNames(styles.table)}>
                <thead>
                  <tr>
                    <th>Gem</th>
                    <th className={classNames(styles.right)}>
                      <BuildName which={1} />
                    </th>
                    <th className={classNames(styles.right)}>
                      <BuildName which={2} />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {names.map((name) => {
                    const a = gems(diff.yours).find((gem) => gem.name === name);
                    const b = gems(diff.guide).find((gem) => gem.name === name);
                    // Only in one build, or a higher level there: that build's colour.
                    const lead = !b
                      ? 1
                      : !a
                        ? -1
                        : side((a.level ?? 0) - (b.level ?? 0) || (a.quality ?? 0) - (b.quality ?? 0));
                    return (
                      <tr key={name}>
                        <td className={!a || !b ? sideClass(lead) : undefined}>{name}</td>
                        <td className={classNames(styles.right, leadClass(lead, 1))}>{level(a)}</td>
                        <td className={classNames(styles.right, leadClass(lead, -1))}>{level(b)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>
    </PageSection>
  );
}

// Items -------------------------------------------------------------------------------

export const itemRowId = (slot: string) => "compare-item-" + slot.replace(/\W+/g, "-");

function ItemLabel({ item, which }: { item?: GearItem; which: 1 | 2 }) {
  return (
    <span className={classNames(styles.itemName)}>
      <span className={classNames(styles.swatch, which === 1 ? styles.b1 : styles.b2)} aria-hidden />
      {item ? (
        <span style={{ color: RARITY_COLOURS[item.rarity ?? "NORMAL"] }}>{itemName(item)}</span>
      ) : (
        <span className={styles.muted}>Empty</span>
      )}
    </span>
  );
}

export function ItemsSection({ result }: { result: Result }) {
  const one = result.one.stats;
  const two = result.two.stats;
  const diffs = useMemo(() => (one && two ? itemDiffs(one, two) : []), [one, two]);
  const list = (lines: string[]) =>
    lines.length ? (
      <ul>
        {lines.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
    ) : (
      <span className={styles.muted}>None</span>
    );
  return (
    <PageSection id="compare-items" title="Items">
      {diffs.length === 0 && <div className={classNames(styles.empty)}>No differences</div>}
      {diffs.map((diff) => (
        <details key={diff.slot} id={itemRowId(diff.slot)} className={classNames(styles.item)}>
          <summary>
            <span className={classNames(styles.slot)}>{diff.slot}</span>
            <ItemLabel item={diff.yours} which={1} />
            <ItemLabel item={diff.guide} which={2} />
          </summary>
          <div className={classNames(styles.lines)}>
            <div>
              <h4 className={styles.b1}>Build 1 only</h4>
              {list(diff.onlyYours.map((line) => line.text))}
            </div>
            <div>
              <h4 className={styles.b2}>Build 2 only</h4>
              {list(diff.onlyGuide.map((line) => line.text))}
            </div>
            {diff.rolls.length > 0 && (
              <div className={classNames(styles.rolls)}>
                <h4>Rolls</h4>
                <ul>
                  {diff.rolls.map((roll, i) => (
                    <li key={i}>
                      {roll.yours} <span className={styles.muted}>→</span> {roll.guide}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </details>
      ))}
    </PageSection>
  );
}

/** Opens a gap's place: its item's row, or its section. */
export function useShowGap() {
  const jump = useJumpToSection();
  return (gap: Gap) => {
    if (gap.target !== "items" || !gap.slot) {
      if (gap.target === "skills" || gap.target === "items") jump(`compare-${gap.target}`);
      return;
    }
    jump("compare-items");
    const slot = gap.slot;
    // After the section has opened and scrolled.
    window.setTimeout(() => {
      const row =
        document.getElementById(itemRowId(slot)) ??
        document.getElementById(itemRowId(slot + " Abyssal Socket 1"));
      if (!(row instanceof HTMLDetailsElement)) return;
      row.open = true;
      row.scrollIntoView({ behavior: "smooth", block: "center" });
      row.querySelector("summary")?.focus({ preventScroll: true });
      row.classList.add(styles.flash);
      window.setTimeout(() => row.classList.remove(styles.flash), 2200);
    }, 350);
  };
}
