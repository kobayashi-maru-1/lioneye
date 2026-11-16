// Compare's panels. Build 1 is blue and Build 2 orange throughout: a value in a build's
// colour is where that build is ahead, and a bar grows from the centre toward it.

import { RARITY_COLOURS, itemName } from "../Gear";
import { useTradeData, useTradeLeague, useTradeOptions } from "../Gear/data";
import { tradeIndex, tradeUrl } from "../Gear/trade-query";
import { PageSection, useJumpToSection } from "../PageSection";
import type { GearItem, Stats } from "../PobStats";
import {
  PASSIVE_KINDS,
  type PassiveKind,
  itemDiffs,
  passiveDiffs,
  skillDiffs,
} from "./diff";
import type { Metric, Why, WhyFormula, WhyRow } from "./metrics";
import type { Gap, Result } from "./run";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useMemo, useState } from "react";

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
const sideClass = (lead: number) =>
  lead > 0 ? styles.b1 : lead < 0 ? styles.b2 : styles.muted;
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
      <span className={classNames(styles.half, styles.left)}>
        {lead > 0 && <i style={width} />}
      </span>
      <span className={classNames(styles.half, styles.right)}>
        {lead < 0 && <i style={width} />}
      </span>
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

/** A change to Build 1: up in Build 1's colour, down in Build 2's. */
function Change({ metric, value }: { metric: Metric; value: number }) {
  if (Math.abs(value) < metric.thresh) return <span className={styles.muted}>0</span>;
  return (
    <span className={sideClass(side(value))}>
      {value > 0 ? "+" : ""}
      {fmt(metric, value)}
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
          const lead =
            a !== null && b !== null && Math.abs(a - b) >= metric.thresh ? side(a - b) : 0;
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
                <span className={classNames(styles.right, leadClass(lead, 1))}>
                  {fmt(metric, a)}
                </span>
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
              {isOpen && (
                <SummaryDrawer
                  result={result}
                  metric={metric}
                  onAll={onAll}
                  onShow={onShow}
                />
              )}
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
          {top.map((gap) => (
            <GapRow key={gap.id} gap={gap} result={result} focus={metric} onShow={onShow} />
          ))}
          <div>
            <button type="button" className={classNames(styles.button)} onClick={() => onAll(metric.key)}>
              Show all
            </button>
          </div>
        </div>
      )}
      {!why && top.length === 0 && (
        <div className={classNames(styles.empty)}>
          {result.pending > 0 ? "Calculating" : "No gains"}
        </div>
      )}
    </div>
  );
}

// Gaps --------------------------------------------------------------------------------

const KIND_ORDER = ["Links", "Gems", "Gear", "Tree", "Config"];

/** Build 2's item in a slot, for its Trade search. */
function itemIn(stats: Stats | undefined, slot: string): GearItem | undefined {
  const gear = stats?.gear;
  if (!gear) return undefined;
  const set = gear.sets[(stats.lists?.active.items ?? 1) - 1] ?? gear.sets[0];
  const id = set?.slots.find((s) => s.slot === slot)?.item;
  return id === undefined ? undefined : gear.items[String(id)];
}

function GapRow({
  gap,
  result,
  focus,
  onShow,
}: {
  gap: Gap;
  result: Result;
  focus: Metric | null;
  onShow: (gap: Gap) => void;
}) {
  const trade = useTradeData();
  const index = useMemo(() => (trade ? tradeIndex(trade.stats, trade.items) : null), [trade]);
  const { league } = useTradeLeague();
  const [options] = useTradeOptions();
  const item =
    gap.kind === "Gear" && gap.slot && gap.id !== "gear-all" && gap.id !== "gear-flasks"
      ? itemIn(result.two.stats, gap.slot)
      : undefined;
  const others = result.metrics.filter(
    (m) => m !== focus && Math.abs(gap.d[m.key] ?? 0) >= m.thresh,
  );
  const value = focus ? gap.d[focus.key] : null;
  // The bar for the metric in focus: from Build 1's value to Build 1's after the change.
  const base = focus ? (result.values.one[focus.key] ?? 0) : 0;
  return (
    <div className={classNames(styles.gap)}>
      <span className={classNames(styles.kind)}>{gap.kind}</span>
      <div className={classNames(styles.what)}>
        <b>{gap.title}</b> <span className={classNames(styles.detail)}>{gap.detail}</span>
      </div>
      <div className={classNames(styles.actions)}>
        <button type="button" className={classNames(styles.button)} onClick={() => onShow(gap)}>
          Show
        </button>
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
      </div>
      {focus && value !== null && value !== undefined && Math.abs(value) >= focus.thresh && (
        <div className={classNames(styles.pull)}>
          <Bar lead={side(value)} length={reach(base + value, base, focus.fmt === "%")} />
          <span>
            <b>
              <Change metric={focus} value={value} />
            </b>{" "}
            <span className={styles.muted}>{focus.label}</span>
          </span>
        </div>
      )}
      <div className={classNames(styles.pills)}>
        {others.map((m) => (
          <span key={m.key} className={classNames(styles.pill)}>
            <Change metric={m} value={gap.d[m.key]!} />{" "}
            <span className={styles.muted}>{m.label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function GapsSection({
  result,
  focus,
  setFocus,
  onShow,
}: {
  result: Result;
  focus: string;
  setFocus: (key: string) => void;
  onShow: (gap: Gap) => void;
}) {
  const metric = result.metrics.find((m) => m.key === focus) ?? null;
  const shows = (gap: Gap, m: Metric) => Math.abs(gap.d[m.key] ?? 0) >= m.thresh;
  let body: React.ReactNode;
  if (metric === null) {
    body = KIND_ORDER.map((kind) => {
      const rows = result.gaps
        .filter((gap) => gap.kind === kind && result.metrics.some((m) => shows(gap, m)))
        .sort((a, b) => (b.d.dps ?? 0) - (a.d.dps ?? 0));
      if (rows.length === 0) return null;
      return (
        <div key={kind} className={classNames(styles.gapList)}>
          <div className={classNames(styles.gapHead)}>{kind}</div>
          {rows.map((gap) => (
            <GapRow key={gap.id} gap={gap} result={result} focus={null} onShow={onShow} />
          ))}
        </div>
      );
    });
  } else {
    const rows = result.gaps.filter((gap) => shows(gap, metric));
    const value = (gap: Gap) => gap.d[metric.key] ?? 0;
    const gains = rows.filter((gap) => value(gap) > 0).sort((a, b) => value(b) - value(a));
    const losses = rows.filter((gap) => value(gap) < 0).sort((a, b) => value(a) - value(b));
    body = (
      <>
        {gains.length > 0 && (
          <div className={classNames(styles.gapList)}>
            <div className={classNames(styles.gapHead, styles.b1)}>Gains</div>
            {gains.map((gap) => (
              <GapRow key={gap.id} gap={gap} result={result} focus={metric} onShow={onShow} />
            ))}
          </div>
        )}
        {losses.length > 0 && (
          <div className={classNames(styles.gapList)}>
            <div className={classNames(styles.gapHead, styles.b2)}>Losses</div>
            {losses.map((gap) => (
              <GapRow key={gap.id} gap={gap} result={result} focus={metric} onShow={onShow} />
            ))}
          </div>
        )}
      </>
    );
  }
  const shown =
    metric === null
      ? result.gaps.some((gap) => result.metrics.some((m) => shows(gap, m)))
      : result.gaps.some((gap) => shows(gap, metric));
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
          {result.failed > 0 && (
            <span className={classNames(styles.chip)}>{result.failed} failed</span>
          )}
          <span className={classNames(styles.chip)} aria-label="Build 2 on Build 1">
            Build 2 → Build 1
          </span>
        </>
      }
    >
      <div className={classNames(styles.chips)} role="group" aria-label="Metric">
        {[{ key: "all", label: "All" }, ...result.metrics].map((m) => (
          <button
            key={m.key}
            type="button"
            aria-pressed={m.key === (metric?.key ?? "all")}
            onClick={() => setFocus(m.key)}
          >
            {m.label}
          </button>
        ))}
      </div>
      {body}
      {!shown && (
        <div className={classNames(styles.empty)}>
          {result.pending > 0 ? "Calculating" : "No gaps"}
        </div>
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
      <td className={classNames(styles.right, leadClass(lead, 1))}>
        {a === null ? "—" : plain(a) + unit}
      </td>
      <td className={classNames(styles.right, leadClass(lead, -1))}>
        {b === null ? "—" : plain(b) + unit}
      </td>
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

export function WhyView({ why }: { why: Why }) {
  return (
    <div className={classNames(styles.why)} role="region" aria-label="Sources">
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
      {why.blocks.map((block) => {
        const unit = block.unit ?? "";
        const total = (pick: (row: WhyRow) => number | null) =>
          block.rows.reduce((s, row) => s + (pick(row) ?? 0), 0);
        return (
          <div key={block.title} className={classNames(styles.scroll)}>
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
                    <tr
                      key={row.group + row.key}
                      className={classNames({ [styles.same]: row.one === row.two })}
                    >
                      <td className={classNames(styles.source)}>
                        {row.group} · {row.key}
                        {detail && <small>{detail}</small>}
                      </td>
                      <PairCells a={row.one} b={row.two} unit={unit} />
                    </tr>
                  );
                })}
                <tr className={classNames(styles.groupRow)}>
                  <td>Total</td>
                  <PairCells a={total((r) => r.one)} b={total((r) => r.two)} unit={unit} />
                </tr>
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

// Stats -------------------------------------------------------------------------------

export function StatsSection({ result }: { result: Result }) {
  const [query, setQuery] = useState("");
  const [same, setSame] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const q = query.trim().toLowerCase();
  const rows = result.lines.filter(
    (line) => (same || line.one !== line.two) && (!q || line.label.toLowerCase().includes(q)),
  );
  const number = (value: string | undefined) =>
    parseFloat(String(value ?? "").replace(/,/g, ""));
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
              const lead =
                d === undefined || Math.abs(d) < 0.005 ? 0 : side(d) * (line.lower ? -1 : 1);
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
                  className={classNames({ [styles.same]: line.one === line.two, [styles.open]: isOpen })}
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
                    {d === undefined ? "" : lead === 0 ? (
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

// Config ------------------------------------------------------------------------------

export function ConfigSection({ result }: { result: Result }) {
  const { rows, modsOne, modsTwo } = result.config;
  const mods = (list: string[]) =>
    list.length ? (
      <ul>
        {list.map((mod, i) => (
          <li key={i}>{mod}</li>
        ))}
      </ul>
    ) : (
      <span className={styles.muted}>None</span>
    );
  return (
    <PageSection
      id="compare-config"
      title="Config"
      actions={<span className={classNames(styles.chip)}>{rows.length} differ</span>}
    >
      <div className={classNames(styles.scroll)}>
        <table className={classNames(styles.table)}>
          <thead>
            <tr>
              <th>Setting</th>
              <th>
                <BuildName which={1} />
              </th>
              <th>
                <BuildName which={2} />
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={3} className={classNames(styles.empty)}>
                  No differences
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.label}>
                <td>{row.label}</td>
                <td>{row.one ?? "—"}</td>
                <td>{row.two ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(modsOne.length > 0 || modsTwo.length > 0) && (
        <div className={classNames(styles.scroll)}>
          <table className={classNames(styles.table)}>
            <thead>
              <tr>
                <th>
                  Mods · <BuildName which={1} />
                </th>
                <th>
                  Mods · <BuildName which={2} />
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{mods(modsOne)}</td>
                <td>{mods(modsTwo)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </PageSection>
  );
}

// Passives ----------------------------------------------------------------------------

const KIND_TITLES: Record<PassiveKind, string> = {
  Keystone: "Keystones",
  Notable: "Notables",
  Ascendancy: "Ascendancy",
  Mastery: "Masteries",
  Socket: "Sockets",
  Normal: "Small passives",
};

export function PassivesSection({ result }: { result: Result }) {
  const one = result.one.stats;
  const two = result.two.stats;
  const diffs = useMemo(() => (one && two ? passiveDiffs(one, two) : []), [one, two]);
  const count = (value: number, mine: 1 | -1, lead: number) =>
    value === 0 ? (
      <span className={styles.muted}>—</span>
    ) : (
      <span className={lead === mine ? (mine > 0 ? styles.b1 : styles.b2) : undefined}>
        {value === 1 ? "✓" : value}
      </span>
    );
  return (
    <PageSection
      id="compare-passives"
      title="Passives"
      actions={
        <span className={classNames(styles.chip)}>
          {one?.passives.length ?? 0} vs {two?.passives.length ?? 0}
        </span>
      }
    >
      <div className={classNames(styles.scroll)}>
        <table className={classNames(styles.table)}>
          <thead>
            <tr>
              <th>Passive</th>
              <th className={classNames(styles.right)}>
                <BuildName which={1} />
              </th>
              <th className={classNames(styles.right)}>
                <BuildName which={2} />
              </th>
            </tr>
          </thead>
          {PASSIVE_KINDS.map((kind) => {
            const rows = diffs.filter((diff) => diff.kind === kind);
            if (rows.length === 0) return null;
            return (
              <tbody key={kind}>
                <tr className={classNames(styles.groupRow)}>
                  <td colSpan={3}>{KIND_TITLES[kind]}</td>
                </tr>
                {rows.map((row) => {
                  const lead = side(row.yours - row.guide);
                  return (
                    <tr key={`${row.name}\n${row.effect ?? ""}`}>
                      <td>
                        {row.name}
                        {row.effect && <div className={classNames(styles.effect)}>{row.effect}</div>}
                      </td>
                      <td className={classNames(styles.right)}>{count(row.yours, 1, lead)}</td>
                      <td className={classNames(styles.right)}>{count(row.guide, -1, lead)}</td>
                    </tr>
                  );
                })}
              </tbody>
            );
          })}
        </table>
        {diffs.length === 0 && <div className={classNames(styles.empty)}>No differences</div>}
      </div>
    </PageSection>
  );
}

// Skills ------------------------------------------------------------------------------

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
                <div className={classNames(styles.sub)}>
                  {[...new Set(slots)].join(" / ")}
                </div>
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
      <span
        className={classNames(styles.swatch, which === 1 ? styles.b1 : styles.b2)}
        aria-hidden
      />
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
      jump(`compare-${gap.target}`);
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
