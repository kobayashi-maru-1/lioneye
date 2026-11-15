import { mechanicOf, type AtlasData, type Plan } from "../lib/types.ts";
import { bonuses } from "../lib/bonuses.ts";
import { HEADINGS, headingOf } from "../lib/mechanics.ts";
import type { SavedPlan } from "../store.ts";
import { formStyles } from "../../styles";
import styles from "../atlas.module.css";
import classNames from "classnames";
import { KIND, flat } from "../lib/text.ts";
import { useMemo, useRef, useState, type ReactNode } from "react";

export type Tab = "explore" | "bonuses" | "saved";

export function Panel({
  tab,
  onTab,
  children,
}: {
  tab: Tab;
  onTab: (tab: Tab) => void;
  children: ReactNode;
}) {
  const tabs: [Tab, string][] = [
    ["explore", "Explore"],
    ["bonuses", "Bonuses"],
    ["saved", "Saved"],
  ];
  return (
    <div className={styles.panelInner}>
      <div className={styles.tabs}>
        {tabs.map(([id, label]) => (
          <button
            key={id}
            aria-pressed={tab === id}
            className={classNames(styles.tab, { [styles.tabOn]: tab === id })}
            onClick={() => onTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className={styles.tabBody}>{children}</div>
    </div>
  );
}

function Swatch({ colour, letter }: { colour: string; letter: string }) {
  return (
    <span className={styles.swatch} style={{ background: colour }} aria-hidden>
      {letter}
    </span>
  );
}

/** Search and the mechanic list. */
export function Explore({
  data,
  colours,
  letters,
  query,
  onQuery,
  matches,
  onLocate,
  pinned,
  onPin,
  onPreview,
}: {
  data: AtlasData;
  colours: string[];
  letters: string[];
  query: string;
  onQuery: (q: string) => void;
  matches: string[];
  onLocate: (id: string) => void;
  pinned: number | null;
  onPin: (m: number | null) => void;
  onPreview: (m: number | null) => void;
}) {
  const clusters = useMemo(() => {
    const count = new Array<number>(data.mechanics.length).fill(0);
    for (const label of data.labels) count[label.m]++;
    return count;
  }, [data]);
  return (
    <>
      <input
        type="search"
        className={classNames(formStyles.formInput, styles.search)}
        placeholder="Search"
        aria-label="Search"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
      />
      {query.trim().length >= 2 && (
        <div className={styles.results}>
          {matches.length === 0 && (
            <div className={styles.empty}>No matches</div>
          )}
          {matches.slice(0, 60).map((id) => {
            const node = data.nodes[id];
            return (
              <button
                key={id}
                className={styles.result}
                onClick={() => onLocate(id)}
              >
                <span className={styles.resultName}>{node.name}</span>
                <span className={styles.resultKind}>
                  {KIND[node.kind]}
                  {mechanicOf(node) >= 0
                    ? ` · ${data.mechanics[mechanicOf(node)]}`
                    : ""}
                </span>
              </button>
            );
          })}
          {matches.length > 60 && (
            <div className={styles.empty}>{matches.length - 60} more</div>
          )}
        </div>
      )}
      {pinned !== null && (
        <div className={styles.pinRow}>
          <span>{data.mechanics[pinned]}</span>
          <button className={formStyles.formButton} onClick={() => onPin(null)}>
            Clear
          </button>
        </div>
      )}
      {HEADINGS.map((heading) => {
        const members = data.mechanics
          .map((name, m) => ({ name, m }))
          .filter(({ name }) => headingOf(name) === heading.name);
        if (members.length === 0) return null;
        return (
          <section key={heading.name} className={styles.section}>
            <h3 className={styles.heading}>{heading.name}</h3>
            {members.map(({ name, m }) => (
              <button
                key={m}
                className={classNames(styles.mechanic, {
                  [styles.mechanicOn]: pinned === m,
                })}
                aria-pressed={pinned === m}
                onClick={() => onPin(pinned === m ? null : m)}
                onPointerEnter={(e) =>
                  e.pointerType === "mouse" && onPreview(m)
                }
                onPointerLeave={(e) =>
                  e.pointerType === "mouse" && onPreview(null)
                }
                onFocus={() => onPreview(m)}
                onBlur={() => onPreview(null)}
              >
                <Swatch colour={colours[m]} letter={letters[m]} />
                <span className={styles.mechanicName}>{name}</span>
                <span className={styles.count}>{clusters[m]}</span>
              </button>
            ))}
          </section>
        );
      })}
    </>
  );
}

/** The plan's combined effects. */
export function Bonuses({
  data,
  plan,
  budget,
  colours,
  letters,
  lit,
  onLight,
  onChoose,
}: {
  data: AtlasData;
  plan: Plan;
  /** The budget shown: the one being typed, else the plan's. */
  budget: number;
  colours: string[];
  letters: string[];
  lit: string | null;
  onLight: (key: string | null, nodes: string[]) => void;
  /** An unset choice node: opens its picker. */
  onChoose: (id: string) => void;
}) {
  const result = useMemo(() => bonuses(data, plan), [data, plan]);
  const used = plan.allocated.length;
  if (used === 0) return <div className={styles.empty}>No points</div>;
  const byHeading = HEADINGS.map((h) => ({
    name: h.name,
    groups: result.groups.filter(
      (g) =>
        g.mechanic >= 0 && headingOf(data.mechanics[g.mechanic]) === h.name,
    ),
  }));
  const other = result.groups.find((g) => g.mechanic < 0);
  const line = (key: string, text: string, count: number, nodes: string[]) => (
    <button
      key={key}
      className={classNames(styles.bonus, { [styles.bonusOn]: lit === key })}
      aria-pressed={lit === key}
      onClick={() => onLight(lit === key ? null : key, nodes)}
    >
      {text}
      {count > 1 && <span className={styles.count}> ×{count}</span>}
    </button>
  );
  return (
    <>
      <div className={styles.pointsLine}>
        {used} / {budget}
      </div>
      {result.unset.length > 0 && (
        <section className={styles.section}>
          <h3 className={classNames(styles.heading, styles.unsetHeading)}>
            Unset
          </h3>
          {result.unset.map((u) => (
            <button
              key={u.id}
              className={styles.bonus}
              onClick={() => onChoose(u.id)}
            >
              {u.name}
              <span className={styles.count}> Choose</span>
            </button>
          ))}
        </section>
      )}
      {result.keystones.length > 0 && (
        <section className={styles.section}>
          <h3 className={styles.heading}>Keystones</h3>
          {result.keystones.map((k) => line(`k${k.id}`, k.name, 1, [k.id]))}
        </section>
      )}
      {byHeading.map(
        (h) =>
          h.groups.length > 0 && (
            <section key={h.name} className={styles.section}>
              <h3 className={styles.heading}>{h.name}</h3>
              {h.groups.map((g) => (
                <div key={g.mechanic} className={styles.bonusGroup}>
                  <div className={styles.bonusMechanic}>
                    <Swatch
                      colour={colours[g.mechanic]}
                      letter={letters[g.mechanic]}
                    />
                    {data.mechanics[g.mechanic]}
                    <span className={styles.count}>{g.nodes}</span>
                  </div>
                  {g.lines.map((l, i) =>
                    line(`${g.mechanic}:${i}`, flat(l.text), l.count, l.nodes),
                  )}
                </div>
              ))}
            </section>
          ),
      )}
      {other && (
        <section className={styles.section}>
          <h3 className={styles.heading}>Other</h3>
          <div className={styles.bonusGroup}>
            {other.lines.map((l, i) =>
              line(`o:${i}`, flat(l.text), l.count, l.nodes),
            )}
          </div>
        </section>
      )}
    </>
  );
}

/** Named plans in this browser, and the Export file. */
export function Saved({
  saved,
  currentId,
  onLoad,
  onRename,
  onDelete,
  onExport,
  onImport,
}: {
  saved: SavedPlan[];
  /** The saved plan being edited, marked in the list. */
  currentId: string | null;
  onLoad: (p: SavedPlan) => void;
  onRename: (p: SavedPlan, name: string) => void;
  onDelete: (p: SavedPlan) => void;
  onExport: () => void;
  onImport: (file: File) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // Escape leaves a rename without saving it (the box's blur would otherwise save it).
  const cancelled = useRef(false);
  return (
    <>
      {saved.length === 0 && <div className={styles.empty}>No saved plans</div>}
      {saved.map((p) => (
        <div key={p.id} className={styles.savedRow}>
          {renaming === p.id ? (
            <input
              className={formStyles.formInput}
              aria-label="Name"
              maxLength={60}
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && draft.trim()) {
                  onRename(p, draft.trim());
                  setRenaming(null);
                } else if (e.key === "Escape") {
                  cancelled.current = true;
                  setRenaming(null);
                }
              }}
              onBlur={() => {
                const next = draft.trim();
                if (!cancelled.current && next && next !== p.name)
                  onRename(p, next);
                cancelled.current = false;
                setRenaming(null);
              }}
            />
          ) : (
            <button
              className={classNames(styles.savedName, {
                [styles.savedCurrent]: p.id === currentId,
              })}
              onClick={() => onLoad(p)}
              title="Load"
              aria-current={p.id === currentId ? "true" : undefined}
            >
              {p.name}
              <span className={styles.count}>{p.plan.allocated.length}</span>
            </button>
          )}
          <button
            className={formStyles.formButton}
            onClick={() => {
              setDraft(p.name);
              setRenaming(p.id);
            }}
          >
            Rename
          </button>
          <button className={formStyles.formButton} onClick={() => onDelete(p)}>
            Delete
          </button>
        </div>
      ))}
      <div className={styles.fileRow}>
        <button
          className={formStyles.formButton}
          onClick={onExport}
          disabled={saved.length === 0}
        >
          Export
        </button>
        <label className={classNames(formStyles.formButton, styles.fileButton)}>
          Import
          <input
            type="file"
            accept=".json,application/json"
            className={styles.fileInput}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onImport(file);
              e.target.value = "";
            }}
          />
        </label>
      </div>
    </>
  );
}
