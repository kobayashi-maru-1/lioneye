import { characterLevelAtom } from "../../state/character-level";
import {
  liveCharacterAtom,
  liveLinkAtom,
  liveRefreshAtom,
  liveStatsAtom,
  liveStatusAtom,
  ninjaSignInUsedAtom,
  ninjaSignedInAtom,
  openNinjaSignIn,
} from "../../state/live-character";
import { pobAtom } from "../../state/pob";
import { BuildCompare } from "../BuildCompare";
import { DesktopPob } from "../DesktopPob";
import { type Headline, usePobStats } from "../PobStats";
import { BuildTitle, HeadlineNumbers, Stat } from "./headline";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useRef } from "react";
import { FaDesktop, FaRegClipboard, FaSyncAlt } from "react-icons/fa";
import { toast } from "react-toastify";

/** The imported build's PoB code to the clipboard, as pob.codes' Copy does. */
async function copyCode(code: string) {
  try {
    await navigator.clipboard.writeText(code);
    toast.success("PoB copied");
  } catch {
    toast.error("Copy failed. Try again.");
  }
}

/**
 * pob.codes-style card above the guide: the build's title, then a Plan row (the shown
 * loadout's PoB numbers) and a Live row (your character: its level from the game log,
 * its numbers from poe.ninja, with Refresh). Compare, Desktop PoB (opens it in the
 * chosen PoB) and Copy at the right of the title. The Loadout dropdown is at the top of
 * the left column (StatsViewer).
 */
export function BuildHeader() {
  const pob = usePobStats();
  const code = useAtomValue(pobAtom);
  if (pob === null) return null;
  const { planStats, planLoading, planError } = pob;
  // The page's build: your live character in Live view, else the plan's loadout.
  const shown = pob.stats ?? planStats;
  if (shown === null) return null;

  return (
    <section className={classNames(styles.header)}>
      <div className={classNames(styles.titleRow)}>
        <h1 className={classNames(styles.title)}>
          <BuildTitle headline={shown.headline ?? {}} level={false} />
        </h1>
        <div className={classNames(styles.tools)}>
          <BuildCompare buttonClassName={classNames(styles.tool)} />
          <DesktopPob className={classNames(styles.tool)}>
            <FaDesktop aria-hidden />
            Desktop PoB
          </DesktopPob>
          {code !== null && (
            <button
              className={classNames(styles.tool)}
              title="Copy PoB"
              aria-label="Copy PoB"
              onClick={() => copyCode(code)}
            >
              <FaRegClipboard aria-hidden />
            </button>
          )}
        </div>
      </div>
      <div className={classNames(styles.rows)}>
        {/* Never the old loadout's numbers under the new loadout's name. */}
        {planStats !== null && planError === null && (
          <NumbersRow
            tag="Plan"
            level={planStats.headline?.level}
            headline={planStats.headline ?? {}}
            stale={planLoading}
          />
        )}
        <LiveRow />
      </div>
    </section>
  );
}

function NumbersRow({
  tag,
  level,
  headline,
  stale,
  children,
}: React.PropsWithChildren<{
  tag: string;
  level?: number;
  headline?: Headline;
  stale?: boolean;
}>) {
  return (
    <div className={classNames(styles.row)}>
      <span className={classNames(styles.tag)}>{tag}</span>
      <div className={classNames(styles.numbers, { [styles.stale]: stale })}>
        <Stat label="Lvl" value={level} colour="#d7c08d" />
        {headline && <HeadlineNumbers headline={headline} />}
      </div>
      {children}
    </div>
  );
}

/**
 * Your character. The level is the game log's (it's never behind poe.ninja's), the
 * numbers poe.ninja's copy as PoB calculates it. Without a live character, just the
 * log's level.
 */
function LiveRow() {
  const logLevel = useAtomValue(characterLevelAtom);
  const link = useAtomValue(liveLinkAtom);
  const live = useAtomValue(liveCharacterAtom);
  const liveStats = useAtomValue(liveStatsAtom);
  const status = useAtomValue(liveStatusAtom);
  // The character's last calculated numbers: shown dimmed while a newer copy calculates,
  // so the row doesn't empty and refill. Never another character's.
  const lastReady = useRef<{ name: string; headline: Headline } | null>(null);

  // The log follows the guide's character: its level counts only for the same one. With
  // a live character picked but not read yet, the log may be another character's.
  const sameCharacter =
    live !== null && logLevel !== null && logLevel.name === live.name;
  const level =
    live === null
      ? link === null
        ? logLevel?.level
        : undefined
      : sameCharacter
        ? Math.max(logLevel.level, live.level)
        : live.level;
  // poe.ninja's copy is from before your latest level-up.
  const behind = sameCharacter && logLevel.level > live.level;
  const answer =
    live !== null && liveStats?.code === live.code ? liveStats : null;
  const ready =
    answer?.state === "ready" ? (answer.stats.headline ?? {}) : undefined;
  if (ready && live) lastReady.current = { name: live.name, headline: ready };
  const earlier =
    live !== null && lastReady.current?.name === live.name
      ? lastReady.current.headline
      : undefined;
  // PoB couldn't calculate the new copy: no numbers, rather than old ones that look
  // like they're still calculating.
  const headline = answer?.state === "error" ? undefined : (ready ?? earlier);

  if (level === undefined && link === null) return null;
  return (
    <NumbersRow
      tag="Live"
      level={level}
      headline={headline}
      stale={ready === undefined && headline !== undefined}
    >
      {link !== null && (
        <RefreshButton
          behind={behind ? live!.level : null}
          reading={status.kind === "loading"}
        />
      )}
    </NumbersRow>
  );
}

/**
 * Has poe.ninja re-read your character, then reads it into the app (Settings → Build's
 * Refresh). Not signed in to poe.ninja: opens its sign-in window too, since only signed
 * in can Lioneye ask for a fresh read. Amber while poe.ninja's copy is behind your level.
 */
function RefreshButton({
  behind,
  reading,
}: {
  behind: number | null;
  reading: boolean;
}) {
  const signedIn = useAtomValue(ninjaSignedInAtom);
  const [used, setUsed] = useAtom(ninjaSignInUsedAtom);
  const setRefresh = useSetAtom(liveRefreshAtom);
  // Signed out, or never signed in. Not "couldn't tell" (null) once you have: the check
  // may not have answered yet, and you're likely signed in.
  const signIn = signedIn === false || (signedIn === null && !used);
  const label = signIn
    ? "Sign in to poe.ninja"
    : behind !== null
      ? `Refresh: poe.ninja at Lvl ${behind}`
      : "Refresh";
  return (
    <button
      className={classNames(styles.tool, styles.refresh, {
        [styles.behind]: behind !== null,
      })}
      title={label}
      aria-label={label}
      disabled={reading}
      onClick={async () => {
        setRefresh((n) => n + 1);
        if (signIn) {
          setUsed(true);
          if (!(await openNinjaSignIn()))
            toast.error(
              "Sign-in window unavailable. Install WebView2 and restart.",
            );
        }
      }}
    >
      <FaSyncAlt
        aria-hidden
        className={classNames({ [styles.spinning]: reading })}
      />
    </button>
  );
}
