import { characterLogAtom } from "../../state/character";
import {
  type ListedCharacter,
  type LiveCharacter,
  characterLink,
  askNinjaRefresh,
  fetchLiveCharacter,
  fetchLiveCharacters,
  fetchLiveVersion,
  fetchNinjaSignedIn,
  liveAccountAtom,
  liveCharacterAtom,
  liveLinkAtom,
  liveRefreshAtom,
  liveStatsAtom,
  liveStatusAtom,
  ninjaSignInUsedAtom,
  ninjaSignedInAtom,
  openNinjaSignIn,
} from "../../state/live-character";
import { liveViewAtom } from "../../state/live-view";
import { pobCodeToXml } from "../../state/pob/process";
import { formStyles } from "../../styles";
import { PanelSelect } from "../PanelSelect";
import { fetchBuildStats } from "../PobStats";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef, useState } from "react";

/** How often poe.ninja is asked whether the character changed. */
const CHECK_EVERY = 3 * 60 * 1000;
/**
 * After asking poe.ninja to re-read the character (a level-up, Refresh), when to check
 * for the new data; poe.ninja reads it from the game in its own time.
 */
const AFTER_ASKING = [20 * 1000, 60 * 1000, 4 * 60 * 1000];

/**
 * Keeps your live character current: reads it when the link is set or Refresh is
 * pressed, checks poe.ninja's version every few minutes (reading it again only when it
 * changed), and has PoB calculate it when its code changes. Signed in to poe.ninja (its
 * window, Settings → Build), a level-up or Refresh first asks poe.ninja to re-read the
 * character, then checks for it a few times. Mounted with the app. Renders nothing.
 */
export function LiveCharacterSync() {
  const link = useAtomValue(liveLinkAtom);
  const [live, setLive] = useAtom(liveCharacterAtom);
  const setStatus = useSetAtom(liveStatusAtom);
  const refresh = useAtomValue(liveRefreshAtom);
  const level = useAtomValue(characterLogAtom)?.level ?? null;
  const setStats = useSetAtom(liveStatsAtom);
  const setLiveView = useSetAtom(liveViewAtom);

  // The newest answer only: a slow older read never replaces a newer one.
  const latest = useRef(0);
  const version = useRef<number | null>(live?.version ?? null);
  version.current = live?.version ?? null;
  // A full read (new link, Refresh) under way: background checks wait for the next turn,
  // so they never drop its answer (and leave "Reading…" showing).
  const reading = useRef(false);
  // The first read of this session has answered (or failed): PoB waits for it, so a
  // stale saved code isn't calculated just before the fresh one.
  const [settled, setSettled] = useState(false);

  // The character followed now: a check scheduled for another one (picked before, or
  // cleared since) never reads it back.
  const linkNow = useRef(link);
  linkNow.current = link;

  const read = async (target: string, onlyIfChanged: boolean) => {
    if (target !== linkNow.current) return;
    if (onlyIfChanged && reading.current) return;
    const id = ++latest.current;
    if (!onlyIfChanged) reading.current = true;
    try {
      if (onlyIfChanged) {
        const now = await fetchLiveVersion(target);
        if (id !== latest.current || now === version.current) return;
      }
      setStatus({ kind: "loading" });
      const character = await fetchLiveCharacter(target);
      if (id !== latest.current || target !== linkNow.current) return;
      setLive(character);
      setStatus({ kind: "idle" });
    } catch (error) {
      if (id !== latest.current) return;
      // A background check that fails stays quiet; the last character stays.
      setStatus(
        onlyIfChanged
          ? { kind: "idle" }
          : {
              kind: "error",
              message:
                error instanceof Error ? error.message : "Not read. Retry.",
            },
      );
    } finally {
      if (id === latest.current) {
        reading.current = false;
        setSettled(true);
      }
    }
  };

  // A new link (or Refresh): read it now.
  const shownLink = useRef<string | null>(link);
  useEffect(() => {
    if (link === null) {
      latest.current++;
      reading.current = false;
      // No character to show: the guide shows the plan (a later one doesn't open in it).
      setLiveView(false);
      setLive(null);
      setStatus({ kind: "idle" });
      setSettled(true);
      shownLink.current = null;
      return;
    }
    const changed = shownLink.current !== link;
    shownLink.current = link;
    if (changed) setLive(null);
    read(link, false);
  }, [link, refresh]);

  // Every few minutes, while a link is set.
  useEffect(() => {
    if (link === null) return;
    const timer = window.setInterval(() => read(link, true), CHECK_EVERY);
    return () => window.clearInterval(timer);
  }, [link]);

  // Signed in to poe.ninja in its window? Only once you've used Sign in (the window, a
  // hidden browser, isn't started for anyone who never does). Asked on start, and when the
  // guide gets focus again while not signed in (after you sign in there), at most every
  // 20 seconds.
  const [signedIn, setSignedIn] = useAtom(ninjaSignedInAtom);
  const signInUsed = useAtomValue(ninjaSignInUsedAtom);
  const signedInNow = useRef(signedIn);
  signedInNow.current = signedIn;
  useEffect(() => {
    if (link === null || !signInUsed) return;
    let live = true;
    let last = 0;
    const check = () => {
      if (Date.now() - last < 20_000) return;
      last = Date.now();
      fetchNinjaSignedIn().then((answer) => live && setSignedIn(answer));
    };
    const onFocus = () => {
      if (signedInNow.current !== true) check();
    };
    check();
    window.addEventListener("focus", onFocus);
    return () => {
      live = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [link, signInUsed]);

  /** Signed in: has poe.ninja re-read the character, then checks a few times. */
  const askAndCheck = (target: string) => {
    if (signedInNow.current) {
      askNinjaRefresh(target).then((result) => {
        if (result === "signed-out") setSignedIn(false);
      });
    }
    return AFTER_ASKING.map((delay) =>
      window.setTimeout(() => read(target, true), delay),
    );
  };

  // After a level-up.
  const lastLevel = useRef(level);
  useEffect(() => {
    const before = lastLevel.current;
    lastLevel.current = level;
    if (link === null || level === null || before === null || level <= before)
      return;
    const timers = askAndCheck(link);
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [level, link]);

  // After Refresh (not on start): it reads at once (above), and asks poe.ninja too.
  const askedFor = useRef(refresh);
  useEffect(() => {
    if (askedFor.current === refresh) return;
    askedFor.current = refresh;
    if (link === null) return;
    const timers = askAndCheck(link);
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [refresh]);

  // PoB's numbers, whenever the code changes (once the session's first read settled).
  const code = live?.code ?? null;
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (code === null) {
      setStats(null);
      return;
    }
    if (!settled) return;
    let xml: string;
    try {
      xml = pobCodeToXml(code);
    } catch {
      setStats({ code, state: "error" });
      return;
    }
    const controller = new AbortController();
    setStats({ code, state: "loading" });
    fetchBuildStats(xml, controller.signal)
      .then((stats) => setStats({ code, state: "ready", stats }))
      .catch(() => {
        if (!controller.signal.aborted) setStats({ code, state: "error" });
      });
    return () => controller.abort();
  }, [code, attempt, settled]);
  // Refresh also retries PoB after it failed (not on start, and not for a good answer).
  const stats = useAtomValue(liveStatsAtom);
  const failed = useRef(false);
  failed.current = stats?.state === "error";
  const retriedFor = useRef(refresh);
  useEffect(() => {
    if (retriedFor.current === refresh) return;
    retriedFor.current = refresh;
    if (failed.current) setAttempt((n) => n + 1);
  }, [refresh]);

  return null;
}

/** "KobayashiSRS · Level 27 Witch" */
export function liveSummary(live: LiveCharacter) {
  return `${live.name} · Level ${live.level} ${live.class}`.trim();
}

/** "KobayashiSRS · 27 Witch · Allflame" */
function listedLabel(character: ListedCharacter) {
  return `${character.name} · ${character.level} ${character.class} · ${character.league}`;
}

/**
 * Settings → Build: your PoE account (its poe.ninja profile must be public), the
 * characters poe.ninja lists for it, and the one Compare and Build health use (Live
 * character), with Refresh.
 */
export function LiveCharacterForm() {
  const [account, setAccount] = useAtom(liveAccountAtom);
  const [link, setLink] = useAtom(liveLinkAtom);
  const live = useAtomValue(liveCharacterAtom);
  const status = useAtomValue(liveStatusAtom);
  const setRefresh = useSetAtom(liveRefreshAtom);
  const [draft, setDraft] = useState(account ?? "");
  // The list with the account it was loaded for (links are built from that account).
  const [loaded, setLoaded] = useState<{
    account: string;
    list: ListedCharacter[];
  } | null>(null);
  const list = loaded?.list ?? null;
  const [listError, setListError] = useState<string | null>(null);
  const [listing, setListing] = useState(false);
  const asked = useRef(0);

  /** Loads `name`'s characters; the account is saved once they load. */
  const load = async (name: string) => {
    const id = ++asked.current;
    setListing(true);
    setListError(null);
    // Never another account's characters under this one.
    setLoaded(null);
    try {
      const found = await fetchLiveCharacters(name);
      if (id !== asked.current) return;
      setLoaded({ account: name, list: found });
      setAccount(name);
      if (found.length === 0) setListError("No characters");
    } catch (error) {
      if (id !== asked.current) return;
      setListError(
        error instanceof Error ? error.message : "Not loaded. Retry.",
      );
    } finally {
      if (id === asked.current) setListing(false);
    }
  };

  // The saved account's characters, when Settings opens.
  useEffect(() => {
    if (account) load(account);
  }, []);

  const submit = () => {
    const name = draft.trim();
    if (name === "") {
      asked.current++;
      setAccount(null);
      setLoaded(null);
      setListError(null);
      setListing(false);
      setLink(null);
      return;
    }
    load(name);
  };

  // The followed character in the list (by its page), else none picked.
  const chosen = loaded
    ? loaded.list.findIndex(
        (character) => characterLink(loaded.account, character) === link,
      )
    : -1;
  const options = ["None", ...(list ?? []).map(listedLabel)];

  const note =
    status.kind === "loading"
      ? "Reading…"
      : status.kind === "error"
        ? status.message
        : live
          ? liveSummary(live)
          : link
            ? "Not read"
            : null;

  return (
    <>
      <div className={classNames(formStyles.formRow)}>
        <label htmlFor="live-account">PoE account</label>
        <div className={classNames(styles.line)}>
          <input
            id="live-account"
            className={classNames(formStyles.formInput, styles.link)}
            spellCheck={false}
            placeholder="Name#1234"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
          />
          <button
            className={classNames(formStyles.formButton)}
            disabled={listing || (draft.trim() === "" && account === null)}
            onClick={submit}
          >
            {/* Emptied: the button forgets the account and stops following. */}
            {listing ? "Loading…" : draft.trim() === "" ? "Clear" : "Load"}
          </button>
        </div>
        {listError && (
          <span className={classNames(styles.note, styles.error)} role="alert">
            {listError}
          </span>
        )}
      </div>
      {(list !== null || link !== null) && (
        <div className={classNames(formStyles.formRow)}>
          <label>Live character</label>
          <div className={classNames(styles.line)}>
            {loaded !== null ? (
              <PanelSelect
                label="Live character"
                options={options}
                value={link === null ? 0 : chosen >= 0 ? chosen + 1 : -1}
                placeholder={live?.name ?? "Pick character"}
                onChange={(i) =>
                  setLink(
                    i === 0
                      ? null
                      : characterLink(loaded.account, loaded.list[i - 1]),
                  )
                }
              />
            ) : (
              <span>{live?.name ?? "Not read"}</span>
            )}
            <button
              className={classNames(formStyles.formButton)}
              disabled={link === null || status.kind === "loading"}
              onClick={() => setRefresh((n) => n + 1)}
            >
              Refresh
            </button>
          </div>
          {note && link !== null && (
            <span
              className={classNames(styles.note, {
                [styles.error]: status.kind === "error",
              })}
              role={status.kind === "error" ? "alert" : undefined}
            >
              {note}
            </span>
          )}
        </div>
      )}
      {link !== null && <NinjaSignIn />}
    </>
  );
}

/**
 * Settings → Build → poe.ninja: signed in to poe.ninja in Lioneye's poe.ninja window, or
 * Sign in (opens it). Signed in, a level-up and Refresh ask poe.ninja to re-read your
 * character, instead of waiting for its own schedule.
 */
function NinjaSignIn() {
  const signedIn = useAtomValue(ninjaSignedInAtom);
  const [used, setUsed] = useAtom(ninjaSignInUsedAtom);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className={classNames(formStyles.formRow)}>
      <label>poe.ninja</label>
      <div className={classNames(styles.line)}>
        <span>
          {signedIn === true
            ? "Signed in"
            : signedIn === false || !used
              ? "Not signed in"
              : "Not checked"}
        </span>
        {signedIn !== true && (
          <button
            className={classNames(formStyles.formButton)}
            onClick={async () => {
              setUsed(true);
              setError(
                (await openNinjaSignIn())
                  ? null
                  : "Sign-in window unavailable. Install WebView2 and restart.",
              );
            }}
          >
            Sign in
          </button>
        )}
      </div>
      {error && (
        <span className={classNames(styles.note, styles.error)} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
