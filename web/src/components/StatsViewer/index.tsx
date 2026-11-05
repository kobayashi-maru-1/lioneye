import { pobCodeToXml } from "../../state/pob/process";
import { formStyles } from "../../styles";
import { SetPager, useFollowAct } from "../SetPager";
import styles from "./styles.module.css";
import classNames from "classnames";
import React, { Fragment, useEffect, useMemo, useState } from "react";

/** The exe runs Path of Building; the hosted site has nothing to ask. */
export const STATS_AVAILABLE = import.meta.env.MODE !== "production";

const STATS_URL = "/api/pob/stats";

type StatRow =
  { gap: true } | { text: string } | { label: string; value: string };

interface Stats {
  loadouts: string[];
  loadout: string | null;
  rows: StatRow[];
  warnings: string[];
}

const NONE: string[] = [];

/** Path of Building's sidebar stats for the loadout that matches your act. */
export function StatsViewer({ code }: { code: string }) {
  const xml = useMemo(() => {
    try {
      return pobCodeToXml(code);
    } catch {
      return null;
    }
  }, [code]);

  // Kept with the build it came from, so a new import never shows the old build's loadouts.
  const [answer, setAnswer] = useState<{ xml: string; stats: Stats } | null>(
    null,
  );
  const stats = answer !== null && answer.xml === xml ? answer.stats : null;
  const loadouts = stats?.loadouts ?? NONE;
  const [index, setIndex] = useFollowAct(loadouts);
  const requested = loadouts[index] ?? null;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (xml === null) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchStats(xml, requested, controller.signal)
      .then((stats) => {
        setAnswer({ xml, stats });
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => controller.abort();
  }, [xml, requested, attempt]);

  if (xml === null)
    return (
      <p className={classNames(styles.status)}>Build unreadable. Re-import.</p>
    );

  return (
    <div className={classNames(styles.stats)}>
      {loadouts.length > 0 && (
        <SetPager titles={loadouts} index={index} onIndex={setIndex} />
      )}
      {error !== null && (
        <div className={classNames(styles.status)} title={error}>
          Stats failed
          <button
            className={classNames(formStyles.formButton, styles.retry)}
            onClick={() => setAttempt((n) => n + 1)}
          >
            Retry
          </button>
        </div>
      )}
      {error === null && stats === null && (
        <p className={classNames(styles.status)}>Calculating</p>
      )}
      {/* After a failed loadout the old rows would sit under the new loadout's name. */}
      {error === null && stats !== null && (
        <div
          className={classNames(styles.rows, { [styles.stale]: loading })}
          aria-busy={loading}
        >
          {stats.rows.length === 0 && (
            <p className={classNames(styles.text)}>No stats</p>
          )}
          {stats.rows.map((row, i) =>
            "gap" in row ? (
              <div key={i} className={classNames(styles.gap)} />
            ) : "text" in row ? (
              <div key={i} className={classNames(styles.text)}>
                <PobText text={row.text} />
              </div>
            ) : (
              <Fragment key={i}>
                <div className={classNames(styles.label)}>
                  <PobText text={row.label} />
                </div>
                <div className={classNames(styles.value)}>
                  <PobText text={row.value} />
                </div>
              </Fragment>
            ),
          )}
          {stats.warnings.map((warning, i) => (
            <div
              key={`w${i}`}
              className={classNames(styles.text, styles.warning)}
            >
              <PobText text={warning} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

async function fetchStats(
  xml: string,
  loadout: string | null,
  signal: AbortSignal,
): Promise<Stats> {
  const response = await fetch(STATS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ xml, loadout }),
    signal,
  });
  if (!response.ok) {
    const text = response.status === 404 ? "" : await response.text();
    throw new Error(text || "PoB unavailable. Restart the app.");
  }
  const stats = (await response.json()) as Partial<Stats>;
  // PoB's JSON writes an empty list as {}.
  return {
    loadouts: Array.isArray(stats.loadouts) ? stats.loadouts : [],
    loadout: stats.loadout ?? null,
    rows: Array.isArray(stats.rows) ? stats.rows : [],
    warnings: Array.isArray(stats.warnings) ? stats.warnings : [],
  };
}

// PoB colour codes: ^0-^9, or ^x then a hex colour. ^7 is PoB's normal text.
const COLOUR_CODE = /\^(x[0-9a-fA-F]{6}|[0-9])/g;
const DIGIT_COLOURS: Record<string, string | undefined> = {
  "1": "#ff5050",
  "2": "#50ff50",
  "3": "#6f6fff",
  "4": "#ffff50",
  "5": "#ff50ff",
  "6": "#50ffff",
  "8": "#808080",
  "9": "#606060",
};

function PobText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let colour: string | undefined;
  let last = 0;
  for (const match of text.matchAll(COLOUR_CODE)) {
    const start = match.index ?? 0;
    if (start > last) {
      parts.push(
        <span key={parts.length} style={{ color: colour }}>
          {text.slice(last, start)}
        </span>,
      );
    }
    const code = match[1];
    colour = code.startsWith("x") ? `#${code.slice(1)}` : DIGIT_COLOURS[code];
    last = start + match[0].length;
  }
  if (last < text.length) {
    parts.push(
      <span key={parts.length} style={{ color: colour }}>
        {text.slice(last)}
      </span>,
    );
  }
  return <>{parts}</>;
}
