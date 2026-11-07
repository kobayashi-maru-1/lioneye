import { compareCodeAtom } from "../../state/compare";
import { pobCodeToXml } from "../../state/pob/process";
import { formStyles } from "../../styles";
import { fetchStringOrUrl } from "../../utility";
import { BuildTitle, HeadlineNumbers, format } from "../BuildHeader/headline";
import { URL_REWRITERS } from "../BuildImportForm";
import { stripPob } from "../PobText";
import { RARITY_COLOURS, itemName } from "../Gear";
import { Modal } from "../Modal";
import {
  type SkillGroup,
  type Stats,
  fetchBuildStats,
  usePobStats,
} from "../PobStats";
import {
  type ItemDiff,
  PASSIVE_KINDS,
  type PassiveDiff,
  type PassiveKind,
  itemDiffs,
  passiveDiffs,
  skillDiffs,
  statDiffs,
} from "./diff";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useAtom } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { FaExchangeAlt } from "react-icons/fa";

type Tab = "stats" | "passives" | "skills" | "items";

const TABS: { id: Tab; label: string }[] = [
  { id: "stats", label: "Stats" },
  { id: "passives", label: "Passives" },
  { id: "skills", label: "Skills" },
  { id: "items", label: "Items" },
];

const KIND_TITLES: Record<PassiveKind, string> = {
  Keystone: "Keystones",
  Notable: "Notables",
  Ascendancy: "Ascendancy",
  Mastery: "Masteries",
  Socket: "Sockets",
  Normal: "Small passives",
};

/** The pasted build (Build 1), calculated by the exe's PoB, kept with its code. */
interface Yours {
  code: string;
  stats?: Stats;
  error?: string;
}

/**
 * pob.codes' "Compare my PoB": paste any build's PoB code or link (Build 1) and see
 * what differs from the guide's shown loadout (Build 2). Both are calculated by the same PoB.
 */
export function BuildCompare({ buttonClassName }: { buttonClassName: string }) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <>
      <button className={buttonClassName} onClick={() => setIsOpen(true)}>
        <FaExchangeAlt aria-hidden />
        Compare
      </button>
      {isOpen && <CompareDialog onClose={() => setIsOpen(false)} />}
    </>
  );
}

function CompareDialog({ onClose }: { onClose: () => void }) {
  const [code, setCode] = useAtom(compareCodeAtom);
  const [editing, setEditing] = useState(code === null);
  const [draft, setDraft] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [yours, setYours] = useState<Yours | null>(null);
  const [tab, setTab] = useState<Tab>("stats");
  // Asks PoB again for the same code (after a failure, or the same code pasted again).
  const [attempt, setAttempt] = useState(0);
  // The guide's shown loadout (the header's Loadout picker), once PoB has answered for it.
  const pob = usePobStats();
  const guide = pob?.stats ?? null;
  const guideReady = guide !== null && !pob?.loading && !pob?.error;
  const guideNote = pob?.error
    ? "Not calculated. Pick the loadout again."
    : !guideReady
      ? "Calculating…"
      : undefined;
  const loadoutTitle = guide?.loadout ? stripPob(guide.loadout) : undefined;

  // The pasted build's stats, for the saved code.
  useEffect(() => {
    if (code === null) return;
    let xml: string;
    try {
      xml = pobCodeToXml(code);
    } catch {
      setYours({ code, error: "Code not read. Choose Change." });
      return;
    }
    const controller = new AbortController();
    setYours({ code });
    fetchBuildStats(xml, controller.signal)
      .then((stats) => setYours({ code, stats }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        console.warn("Compare: PoB failed", err);
        setYours({ code, error: "Not calculated. Retry or restart the app." });
      });
    return () => controller.abort();
  }, [code, attempt]);

  const submit = async () => {
    const text = draft.trim();
    if (text === "") return;
    setImporting(true);
    setImportError(null);
    try {
      const value = (await fetchStringOrUrl(text, URL_REWRITERS)).trim();
      try {
        pobCodeToXml(value);
      } catch {
        setImportError("Code not read. Paste a PoB code or link.");
        return;
      }
      setCode(value);
      setAttempt((n) => n + 1);
      setEditing(false);
      setDraft("");
    } catch {
      setImportError("Link not loaded. Check it and retry.");
    } finally {
      setImporting(false);
    }
  };

  const ready = yours?.code === code ? yours : null;

  return (
    <Modal
      size="large"
      className={classNames(styles.dialog)}
      overlayClassName={classNames(styles.overlay)}
      isOpen={true}
      onRequestClose={onClose}
      contentLabel="Compare"
    >
      <div className={classNames(styles.top)}>
        <h2 className={classNames(styles.heading)}>Compare</h2>
        <button className={classNames(formStyles.formButton)} onClick={onClose}>
          Close
        </button>
      </div>

      {editing ? (
        <div className={classNames(styles.input)}>
          <textarea
            className={classNames(formStyles.formInput, styles.code)}
            spellCheck={false}
            autoFocus
            placeholder="PoB code or link"
            aria-label="PoB code or link"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          {importError && (
            <div className={classNames(styles.error)}>{importError}</div>
          )}
          <div className={classNames(formStyles.groupRight)}>
            {code !== null && (
              <button
                className={classNames(formStyles.formButton)}
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
            )}
            <button
              className={classNames(formStyles.formButton)}
              disabled={importing || draft.trim() === ""}
              onClick={submit}
            >
              {importing ? "Loading…" : "Compare"}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className={classNames(styles.builds)}>
            <div className={classNames(styles.buildList)}>
              <BuildRow
                tag="Build 1"
                stats={ready?.stats}
                note={
                  ready?.error ??
                  (ready?.stats === undefined ? "Calculating…" : undefined)
                }
              />
              <BuildRow
                tag="Build 2"
                stats={guide ?? undefined}
                loadout={loadoutTitle}
                note={guideNote}
              />
            </div>
            {ready?.error && (
              <button
                className={classNames(formStyles.formButton)}
                onClick={() => setAttempt((n) => n + 1)}
              >
                Retry
              </button>
            )}
            <button
              className={classNames(formStyles.formButton)}
              onClick={() => {
                setImportError(null);
                setEditing(true);
              }}
            >
              Change
            </button>
          </div>
          {ready?.stats && guide && guideReady && (
            <Differences
              yours={ready.stats}
              guide={guide}
              tab={tab}
              setTab={setTab}
            />
          )}
        </>
      )}
    </Modal>
  );
}

function BuildRow({
  tag,
  stats,
  loadout,
  note,
}: {
  tag: string;
  stats?: Stats;
  loadout?: string;
  note?: string;
}) {
  const headline = stats?.headline;
  return (
    <div className={classNames(styles.build)}>
      <div className={classNames(styles.buildTitle)}>
        <span className={classNames(styles.tag)}>{tag}</span>
        {headline ? <BuildTitle headline={headline} /> : null}
        {loadout && (
          <span className={classNames(styles.loadout)}>{loadout}</span>
        )}
      </div>
      {note ? (
        <div className={classNames(styles.note)}>{note}</div>
      ) : (
        headline && (
          <div className={classNames(styles.numbers)}>
            <HeadlineNumbers headline={headline} />
          </div>
        )
      )}
    </div>
  );
}

function Differences({
  yours,
  guide,
  tab,
  setTab,
}: {
  yours: Stats;
  guide: Stats;
  tab: Tab;
  setTab: (tab: Tab) => void;
}) {
  const diffs = useMemo(
    () => ({
      stats: statDiffs(yours, guide),
      passives: passiveDiffs(yours, guide),
      skills: skillDiffs(yours, guide),
      items: itemDiffs(yours, guide),
    }),
    [yours, guide],
  );

  return (
    <>
      <div className={classNames(styles.tabs)} role="tablist">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            role="tab"
            id={`compare-tab-${id}`}
            aria-controls="compare-panel"
            aria-selected={tab === id}
            aria-label={`${label}, ${diffs[id].length}`}
            className={classNames(formStyles.formButton, styles.tab, {
              [styles.active]: tab === id,
            })}
            onClick={() => setTab(id)}
          >
            {label}
            <span className={classNames(styles.count)}>{diffs[id].length}</span>
          </button>
        ))}
      </div>
      <div
        className={classNames(styles.panel)}
        role="tabpanel"
        id="compare-panel"
        aria-labelledby={`compare-tab-${tab}`}
      >
        {diffs[tab].length === 0 ? (
          <div className={classNames(styles.note)}>No differences</div>
        ) : tab === "stats" ? (
          <StatsTable diffs={diffs.stats} />
        ) : tab === "passives" ? (
          <PassivesTable diffs={diffs.passives} />
        ) : tab === "skills" ? (
          <SkillsTable diffs={diffs.skills} />
        ) : (
          <ItemsTable diffs={diffs.items} />
        )}
      </div>
    </>
  );
}

function StatsTable({ diffs }: { diffs: ReturnType<typeof statDiffs> }) {
  return (
    <table className={classNames(styles.table)}>
      <thead>
        <tr>
          <th>Stat</th>
          <th>Build 1</th>
          <th>Build 2</th>
          <th>Diff</th>
        </tr>
      </thead>
      <tbody>
        {diffs.map((row) => (
          <tr key={row.label}>
            <td>{row.label}</td>
            <td>{row.yours ?? "–"}</td>
            <td>{row.guide ?? "–"}</td>
            <td className={classNames(styles.diff)}>
              {row.diff === undefined
                ? ""
                : `${row.diff > 0 ? "+" : ""}${format(row.diff)}`}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** ✓ for one, a number for more, – for none. */
function count(n: number) {
  return n === 0 ? "–" : n === 1 ? "✓" : String(n);
}

function PassivesTable({ diffs }: { diffs: PassiveDiff[] }) {
  return (
    <table className={classNames(styles.table)}>
      <thead>
        <tr>
          <th>Passive</th>
          <th>Build 1</th>
          <th>Build 2</th>
        </tr>
      </thead>
      {PASSIVE_KINDS.map((kind) => {
        const rows = diffs.filter((diff) => diff.kind === kind);
        if (rows.length === 0) return null;
        return (
          <tbody key={kind}>
            <tr>
              <th colSpan={3} className={classNames(styles.section)}>
                {KIND_TITLES[kind]}
              </th>
            </tr>
            {rows.map((row) => (
              <tr key={`${row.name}\n${row.effect ?? ""}`}>
                <td>
                  {row.name}
                  {row.effect && (
                    <div className={classNames(styles.effect)}>
                      {row.effect}
                    </div>
                  )}
                </td>
                <td>{count(row.yours)}</td>
                <td>{count(row.guide)}</td>
              </tr>
            ))}
          </tbody>
        );
      })}
    </table>
  );
}

function SkillsTable({ diffs }: { diffs: ReturnType<typeof skillDiffs> }) {
  return (
    <table className={classNames(styles.table)}>
      <thead>
        <tr>
          <th>Skill</th>
          <th>Build 1</th>
          <th>Build 2</th>
        </tr>
      </thead>
      <tbody>
        {diffs.map((row, index) => (
          <tr key={`${row.name}-${index}`}>
            <td>{row.name}</td>
            <td>
              <Gems group={row.yours} marked={row.extra} />
            </td>
            <td>
              <Gems group={row.guide} marked={row.missing} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A group's enabled gems; the ones the other build lacks are marked. */
function Gems({ group, marked }: { group?: SkillGroup; marked: string[] }) {
  if (!group) return <span className={classNames(styles.none)}>None</span>;
  const left = [...marked];
  return (
    <ul className={classNames(styles.lines)}>
      {group.gems
        .filter((gem) => gem.enabled)
        .map((gem, index) => {
          const at = left.indexOf(gem.name);
          if (at >= 0) left.splice(at, 1);
          return (
            <li
              key={index}
              className={classNames({
                [styles.only]: at >= 0,
                [styles.support]: gem.support,
              })}
            >
              {gem.name}
              {at >= 0 && (
                <span className={classNames(styles.hidden)}> (only here)</span>
              )}
            </li>
          );
        })}
    </ul>
  );
}

function ItemsTable({ diffs }: { diffs: ItemDiff[] }) {
  return (
    <table className={classNames(styles.table)}>
      <thead>
        <tr>
          <th>Slot</th>
          <th>Build 1</th>
          <th>Build 2</th>
        </tr>
      </thead>
      <tbody>
        {diffs.map((row) => (
          <tr key={row.slot}>
            <td>{row.slot}</td>
            <td>
              <ItemCell
                item={row.yours}
                only={row.onlyYours.map((line) => line.text)}
                rolls={row.rolls.map((roll) => roll.yours)}
              />
            </td>
            <td>
              <ItemCell
                item={row.guide}
                only={row.onlyGuide.map((line) => line.text)}
                rolls={row.rolls.map((roll) => roll.guide)}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ItemCell({
  item,
  only,
  rolls,
}: {
  item?: ItemDiff["yours"];
  only: string[];
  rolls: string[];
}) {
  if (!item) return <span className={classNames(styles.none)}>None</span>;
  return (
    <>
      <div
        className={classNames(styles.itemName)}
        style={{ color: RARITY_COLOURS[item.rarity ?? ""] }}
      >
        {itemName(item)}
      </div>
      {(item.sockets || item.corrupted) && (
        <div className={classNames(styles.meta)}>
          {[item.sockets, item.corrupted ? "Corrupted" : undefined]
            .filter(Boolean)
            .join(" · ")}
        </div>
      )}
      {only.length > 0 && (
        <>
          <div className={classNames(styles.subhead)}>Only here</div>
          <ul className={classNames(styles.lines)}>
            {only.map((text, index) => (
              <li key={index}>{text}</li>
            ))}
          </ul>
        </>
      )}
      {rolls.length > 0 && (
        <>
          <div className={classNames(styles.subhead)}>Rolls</div>
          <ul className={classNames(styles.lines)}>
            {rolls.map((text, index) => (
              <li key={index}>{text}</li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
