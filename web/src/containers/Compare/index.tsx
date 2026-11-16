import { BuildTitle } from "../../components/BuildHeader/headline";
import { URL_REWRITERS } from "../../components/BuildImportForm";
import {
  ConfigSection,
  GapsSection,
  ItemsSection,
  PassivesSection,
  SkillsSection,
  StatsSection,
  SummarySection,
  useShowGap,
} from "../../components/Compare/sections";
import {
  type Side,
  type SourceKind,
  SOURCES,
  characterLabel,
  compareAccountsAtom,
  compareSidesAtom,
  buildPrint,
  emptySide,
  listCharacters,
  readCharacter,
} from "../../components/Compare/sources";
import { type Input, type Result, cacheKey, compare } from "../../components/Compare/run";
import styles from "../../components/Compare/styles.module.css";
import { pageSectionId, useJumpToSection } from "../../components/PageSection";
import type { Headline } from "../../components/PobStats";
import { stripPob } from "../../components/PobText";
import {
  type ListedCharacter,
  type LiveCharacter,
  characterLink,
  liveCharacterAtom,
  liveRefreshAtom,
} from "../../state/live-character";
import { mainSkillPickAtom } from "../../state/main-skill";
import { pobAtom } from "../../state/pob";
import { pobCodeToXml } from "../../state/pob/process";
import { fetchStringOrUrl } from "../../utility";
import classNames from "classnames";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Compare: two builds side by side, each your live character, a loadout of the imported
 * build, a character from a PoE account on poe.ninja or a pasted build. PoB calculates
 * both (Build 2 on Build 1's config, so the difference is the builds), picks the stats
 * that matter for them, and measures each gap: Build 1 with one piece of Build 2.
 */

const SECTIONS = [
  { id: "compare-summary", label: "Summary" },
  { id: "compare-gaps", label: "Gaps" },
  { id: "compare-stats", label: "Stats" },
  { id: "compare-config", label: "Config" },
  { id: "compare-passives", label: "Passives" },
  { id: "compare-skills", label: "Skills" },
  { id: "compare-items", label: "Items" },
];

/** A side ready to calculate, or why it isn't. */
type Resolved =
  | { state: "ready"; input: Input; sub?: string; live?: boolean }
  | { state: "loading" }
  | { state: "empty" | "error"; message: string };

const toXml = (code: string) => {
  try {
    return pobCodeToXml(code);
  } catch {
    return null;
  }
};

/** What a side is, as a build for PoB. */
function useResolved(side: Side, first: boolean, again: number): Resolved {
  const live = useAtomValue(liveCharacterAtom);
  const plan = useAtomValue(pobAtom);
  const pick = useAtomValue(mainSkillPickAtom);
  // An account's character, read from poe.ninja (kept for the session; Refresh reads again).
  const [read, setRead] = useState<{
    link: string;
    character?: LiveCharacter;
    error?: string;
  } | null>(null);
  const link = side.kind === "account" ? side.link : null;
  useEffect(() => {
    if (link === null) return;
    let current = true;
    setRead({ link });
    readCharacter(link, again > 0)
      .then((character) => current && setRead({ link, character }))
      .catch((error: unknown) =>
        current &&
        setRead({ link, error: error instanceof Error ? error.message : "Not read. Retry." }),
      );
    return () => {
      current = false;
    };
  }, [link, again]);

  return useMemo((): Resolved => {
    const ready = (code: string, extra: { sub?: string; live?: boolean; usePick?: boolean }) => {
      const xml = toXml(code);
      if (xml === null)
        return {
          state: "error",
          message:
            side.kind === "loadout"
              ? "Code not read. Re-import."
              : side.kind === "pasted"
                ? "Code not read. Change."
                : "Code not read. Refresh.",
        } as const;
      // A loadout picked in another build (re-imported, the character changed) isn't asked for.
      const loadout = side.loadout !== null && side.loadoutFor === buildPrint(xml) ? side.loadout : null;
      return {
        state: "ready",
        input: { xml, loadout, pick: extra.usePick && first ? pick : null },
        sub: extra.sub,
        live: extra.live,
      } as const;
    };
    switch (side.kind) {
      case "live":
        if (live === null) return { state: "empty", message: "No live character" };
        return ready(live.code, { sub: `${live.name} · Lvl ${live.level} ${live.class}`, live: true });
      case "loadout":
        if (plan === null) return { state: "empty", message: "No build" };
        return ready(plan, { usePick: true });
      case "account":
        if (link === null) return { state: "empty", message: "No character" };
        if (read?.link !== link || (!read.character && !read.error)) return { state: "loading" };
        if (read.error) return { state: "error", message: read.error };
        return ready(read.character!.code, {
          sub: `${read.character!.name} · Lvl ${read.character!.level} ${read.character!.class}`,
        });
      case "pasted":
        if (side.code === null) return { state: "empty", message: "No code" };
        return ready(side.code, {});
    }
  }, [side, first, live, plan, pick, read, link]);
}

export default function CompareContainer() {
  const [sides, setSides] = useAtom(compareSidesAtom);
  const [refresh, setRefresh] = useState<[number, number]>([0, 0]);
  const one = useResolved(sides[0], true, refresh[0]);
  const two = useResolved(sides[1], false, refresh[1]);
  const setSide = (index: 0 | 1, side: Side) =>
    setSides((now) => (index === 0 ? [side, now[1]] : [now[0], side]));
  const setAccounts = useSetAtom(compareAccountsAtom);
  const removeAccount = (name: string) => {
    setAccounts((now) => now.filter((account) => account !== name));
    setSides(
      (now) =>
        now.map((side) =>
          side.kind === "account" && side.account === name
            ? { ...side, account: null, link: null, loadout: null }
            : side,
        ) as [Side, Side],
    );
  };

  // The comparison, for the current pair; the run stops when either side changes.
  const [run, setRun] = useState<{ key: string; result?: Result; error?: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key =
    one.state === "ready" && two.state === "ready" ? cacheKey(one.input, two.input) : null;
  useEffect(() => {
    if (key === null || one.state !== "ready" || two.state !== "ready") {
      setRun(null);
      return;
    }
    const controller = new AbortController();
    setRun({ key });
    compare(
      one.input,
      two.input,
      (result) => !controller.signal.aborted && setRun({ key, result }),
      controller.signal,
    ).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      console.warn("Compare failed", error);
      setRun((now) => ({
        key,
        result: now?.key === key ? now.result : undefined,
        error: error instanceof Error ? error.message : "Not calculated",
      }));
    });
    return () => controller.abort();
  }, [key, attempt]);
  const result = run?.key === key ? run.result : undefined;
  const error = run?.key === key ? run.error : undefined;

  // Each build's loadouts (PoB's names), from its last answer.
  const loadouts = useRef(new Map<string, { list: string[]; current: string | null }>());
  if (result && one.state === "ready" && two.state === "ready") {
    const keep = (xml: string, stats: Result["one"]["stats"]) =>
      stats && loadouts.current.set(xml, { list: stats.loadouts, current: stats.loadout });
    keep(one.input.xml, result.one.stats);
    keep(two.input.xml, result.twoOwn.stats);
  }
  const loadoutsOf = (resolved: Resolved) =>
    resolved.state === "ready" ? loadouts.current.get(resolved.input.xml) : undefined;

  const [focus, setFocus] = useState("all");
  const jump = useJumpToSection();
  const showGap = useShowGap();
  const setLiveRefresh = useSetAtom(liveRefreshAtom);
  const refreshSide = (index: 0 | 1) => {
    if (sides[index].kind === "live") setLiveRefresh((n) => n + 1);
    else setRefresh((now) => (index === 0 ? [now[0] + 1, now[1]] : [now[0], now[1] + 1]));
  };

  const skill = result?.one.stats?.headline?.skill;
  const minionSkill = result?.one.extra.minionMain ? result.one.extra.minionSkill : undefined;
  const status = error
    ? null
    : key === null
      ? null
      : !result
        ? "Calculating"
        : null;

  return (
    <div className={classNames(styles.page)}>
      <SectionBar />
      <div className={classNames(styles.body)}>
        <section className={classNames(styles.builds)} aria-label="Builds">
          <div className={classNames(styles.pair)}>
            <SideCard
              which={1}
              side={sides[0]}
              resolved={one}
              loadouts={loadoutsOf(one)}
              headline={result?.one.stats?.headline ?? null}
              onChange={(side) => setSide(0, side)}
              onRemoveAccount={removeAccount}
              onRefresh={() => refreshSide(0)}
            />
            <button
              type="button"
              className={classNames(styles.swap)}
              aria-label="Swap builds"
              title="Swap"
              onClick={() => setSides((now) => [now[1], now[0]])}
            >
              ⇄
            </button>
            <SideCard
              which={2}
              side={sides[1]}
              resolved={two}
              loadouts={loadoutsOf(two)}
              headline={result?.twoOwn.stats?.headline ?? null}
              onChange={(side) => setSide(1, side)}
              onRemoveAccount={removeAccount}
              onRefresh={() => refreshSide(1)}
            />
          </div>
          <div className={classNames(styles.footing)}>
            {skill && (
              <span>
                <span className={classNames(styles.key)}>Skill</span>
                <span className={classNames(styles.value)}>
                  {minionSkill ? `${skill.replace(/^Summon /, "")} › ${minionSkill}` : skill}
                </span>{" "}
                <span className={classNames(styles.chip)}>
                  {result?.sameSkill ? "Same" : "Different"}
                </span>
              </span>
            )}
            <span>
              <span className={classNames(styles.key)}>Config</span>
              <span className={classNames(styles.chip)}>Build 1</span>
            </span>
            {status && <span className={classNames(styles.chip)}>{status}</span>}
            {error && (
              <span className={classNames(styles.row)}>
                <span className={classNames(styles.error)}>{error}</span>
                <button
                  type="button"
                  className={classNames(styles.button)}
                  onClick={() => setAttempt((n) => n + 1)}
                >
                  Retry
                </button>
              </span>
            )}
          </div>
        </section>
        {result && (
          <>
            <SummarySection
              result={result}
              onShow={showGap}
              onAll={(metric) => {
                setFocus(metric);
                jump("compare-gaps");
              }}
            />
            <GapsSection result={result} focus={focus} setFocus={setFocus} onShow={showGap} />
            <StatsSection result={result} />
            <ConfigSection result={result} />
            <PassivesSection result={result} />
            <SkillsSection result={result} />
            <ItemsSection result={result} />
          </>
        )}
      </div>
    </div>
  );
}

/** The page's sections, pinned under the app bar; the one you're in is underlined. */
function SectionBar() {
  const jump = useJumpToSection();
  const bar = useRef<HTMLElement>(null);
  const [current, setCurrent] = useState(SECTIONS[0].id);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = (bar.current?.getBoundingClientRect().bottom ?? 0) + 8;
      let at = SECTIONS[0].id;
      for (const { id } of SECTIONS) {
        const top = document.getElementById(pageSectionId(id))?.getBoundingClientRect().top;
        if (top !== undefined && top <= line) at = id;
      }
      setCurrent(at);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return (
    <nav ref={bar} className={classNames(styles.tabs)} aria-label="Compare sections">
      {SECTIONS.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          className={classNames(styles.tab, { [styles.active]: current === id })}
          aria-current={current === id ? "location" : undefined}
          onClick={() => jump(id)}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}

function SideCard({
  which,
  side,
  resolved,
  loadouts,
  headline,
  onChange,
  onRemoveAccount,
  onRefresh,
}: {
  which: 1 | 2;
  side: Side;
  resolved: Resolved;
  loadouts?: { list: string[]; current: string | null };
  headline: Headline | null;
  onChange: (side: Side) => void;
  onRemoveAccount: (name: string) => void;
  onRefresh: () => void;
}) {
  const label = `Build ${which}`;
  const xml = resolved.state === "ready" ? resolved.input.xml : null;
  // The loadout asked for, else the one PoB showed ("" when its sets match no loadout).
  const loadoutValue =
    (resolved.state === "ready" ? resolved.input.loadout : null) ?? loadouts?.current ?? "";
  return (
    <div className={classNames(styles.build, which === 1 ? styles.one : styles.two)}>
      <div className={classNames(styles.who, which === 1 ? styles.b1 : styles.b2)}>
        <span className={classNames(styles.swatch)} aria-hidden />
        {label}
      </div>
      <div className={classNames(styles.row)}>
        <select
          className={classNames(styles.select)}
          aria-label={`${label} source`}
          value={side.kind}
          onChange={(e) => onChange(emptySide(e.target.value as SourceKind))}
        >
          {SOURCES.map((source) => (
            <option key={source.kind} value={source.kind}>
              {source.label}
            </option>
          ))}
        </select>
        {side.kind === "account" && (
          <AccountPicker label={label} side={side} onChange={onChange} onRemove={onRemoveAccount} />
        )}
        {(side.kind === "live" || side.kind === "account") && resolved.state !== "empty" && (
          <button type="button" className={classNames(styles.button)} onClick={onRefresh}>
            Refresh
          </button>
        )}
        {side.kind === "pasted" && side.code !== null && (
          <button
            type="button"
            className={classNames(styles.button)}
            onClick={() => onChange({ ...side, code: null, loadout: null })}
          >
            Change
          </button>
        )}
      </div>
      {side.kind === "pasted" && side.code === null && (
        <PasteCode label={label} onCode={(code) => onChange({ ...side, code, loadout: null })} />
      )}
      {loadouts && loadouts.list.length > 1 && (
        <select
          className={classNames(styles.select)}
          aria-label={`${label} loadout`}
          value={loadoutValue}
          onChange={(e) =>
            onChange({
              ...side,
              loadout: e.target.value || null,
              loadoutFor: xml === null ? null : buildPrint(xml),
            })
          }
        >
          <option value="">Saved</option>
          {loadouts.list.map((name) => (
            <option key={name} value={name}>
              {stripPob(name).replace(/\s*\{[^}]*\}\s*$/, "")}
            </option>
          ))}
        </select>
      )}
      {headline && resolved.state === "ready" && (
        <div className={classNames(styles.name)}>
          <BuildTitle headline={headline} />
        </div>
      )}
      <BuildLine resolved={resolved} />
    </div>
  );
}

/** Under a build's pickers: its name and level, or why it isn't there. */
function BuildLine({ resolved }: { resolved: Resolved }) {
  if (resolved.state === "loading") return <div className={classNames(styles.sub)}>Reading</div>;
  if (resolved.state !== "ready")
    return <div className={classNames(styles.error)}>{resolved.message}</div>;
  return resolved.sub ? <div className={classNames(styles.sub)}>{resolved.sub}</div> : null;
}

/** A PoE account (added once, kept) and one of its characters on poe.ninja. */
function AccountPicker({
  label,
  side,
  onChange,
  onRemove,
}: {
  label: string;
  side: Side;
  onChange: (side: Side) => void;
  onRemove: (name: string) => void;
}) {
  const [accounts, setAccounts] = useAtom(compareAccountsAtom);
  const [adding, setAdding] = useState(accounts.length === 0);
  const [draft, setDraft] = useState("");
  const [list, setList] = useState<{ account: string; characters?: ListedCharacter[]; error?: string } | null>(null);
  const [again, setAgain] = useState(0);
  const account = side.account;

  useEffect(() => {
    if (account === null) return;
    let current = true;
    setList({ account });
    listCharacters(account, again > 0)
      .then((characters) => current && setList({ account, characters }))
      .catch((error: unknown) =>
        current &&
        setList({ account, error: error instanceof Error ? error.message : "Not loaded. Retry." }),
      );
    return () => {
      current = false;
    };
  }, [account, again]);

  const add = async () => {
    const name = draft.trim();
    if (!name) return;
    setList({ account: name });
    try {
      const characters = await listCharacters(name);
      setAccounts((now) => (now.some((a) => a.toLowerCase() === name.toLowerCase()) ? now : [...now, name]));
      setAdding(false);
      setDraft("");
      onChange({ ...side, account: name, link: null, loadout: null });
      setList({ account: name, characters });
    } catch (error) {
      setList({ account: name, error: error instanceof Error ? error.message : "Not loaded. Retry." });
    }
  };

  if (adding)
    return (
      <>
        <input
          className={classNames(styles.input, styles.grow)}
          placeholder="Name#1234"
          aria-label={`${label} account`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button
          type="button"
          className={classNames(styles.button)}
          disabled={!draft.trim() || (list?.account === draft.trim() && !list.characters && !list.error)}
          onClick={add}
        >
          Load
        </button>
        {accounts.length > 0 && (
          <button type="button" className={classNames(styles.button)} onClick={() => setAdding(false)}>
            Cancel
          </button>
        )}
        {list?.error && <span className={classNames(styles.error)}>{list.error}</span>}
      </>
    );

  const characters = list?.account === account ? list.characters : undefined;
  const linkOf = (character: ListedCharacter) => characterLink(account ?? "", character);
  return (
    <>
      <select
        className={classNames(styles.select, styles.grow)}
        aria-label={`${label} account`}
        value={account ?? ""}
        onChange={(e) => {
          if (e.target.value === "+") setAdding(true);
          else onChange({ ...side, account: e.target.value, link: null, loadout: null });
        }}
      >
        {account === null && <option value="">Account</option>}
        {accounts.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
        <option value="+">Add…</option>
      </select>
      {account !== null && (
        <button
          type="button"
          className={classNames(styles.button)}
          aria-label="Remove account"
          title="Remove account"
          onClick={() => onRemove(account)}
        >
          Remove
        </button>
      )}
      {account !== null && (
        <select
          className={classNames(styles.select, styles.grow)}
          aria-label={`${label} character`}
          value={side.link ?? ""}
          disabled={!characters}
          onChange={(e) => onChange({ ...side, link: e.target.value || null, loadout: null })}
        >
          <option value="">{characters ? "Character" : list?.error ? "Not loaded" : "Loading"}</option>
          {characters?.map((character) => (
            <option key={linkOf(character)} value={linkOf(character)}>
              {characterLabel(character)}
            </option>
          ))}
        </select>
      )}
      {list?.account === account && list?.error && (
        <>
          <span className={classNames(styles.error)}>{list.error}</span>
          <button type="button" className={classNames(styles.button)} onClick={() => setAgain((n) => n + 1)}>
            Retry
          </button>
        </>
      )}
    </>
  );
}

/** A PoB code or a pobb.in, poe.ninja, pastebin or maxroll link. */
function PasteCode({ label, onCode }: { label: string; onCode: (code: string) => void }) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    const text = draft.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      const code = (await fetchStringOrUrl(text, URL_REWRITERS)).trim();
      if (toXml(code) === null) {
        setError("Code not read. Paste again.");
        return;
      }
      onCode(code);
    } catch {
      setError("Link not loaded. Check it and retry.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={classNames(styles.row)}>
      <textarea
        className={classNames(styles.input, styles.code)}
        spellCheck={false}
        placeholder="PoB code or link"
        aria-label={`${label} PoB code or link`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button
        type="button"
        className={classNames(styles.button)}
        disabled={busy || !draft.trim()}
        onClick={load}
      >
        {busy ? "Loading" : "Load"}
      </button>
      {error && <span className={classNames(styles.error)}>{error}</span>}
    </div>
  );
}
