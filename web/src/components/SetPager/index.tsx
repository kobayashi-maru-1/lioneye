import { atom, useAtom, useAtomValue, type PrimitiveAtom } from "jotai";
import { formStyles } from "../../styles";
import { characterLevelAtom } from "../../state/character-level";
import { buildIdSelector } from "../../state/pob";
import {
  actRange,
  currentActAtom,
  displaySetName,
  followedAct,
  indexForAct,
  indexForEndgame,
  indexForLevel,
  levelRange,
} from "../../state/current-act";
import { progressIndex, treeProgressAtom } from "../../state/tree/progress";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useCallback, useEffect, useRef, useState } from "react";
import { HiChevronLeft, HiChevronRight } from "react-icons/hi";

/** A set you picked over the one your level, act or tree points to. */
export interface SetPick {
  buildId: number;
  /** The set followed when you picked (null: none was). */
  followed: string | null;
  title: string;
}

/** For hooks that don't remember picks: never written. */
const NO_PICK = atom<SetPick | null>(null);

/**
 * Picks the set (loadout, tree or gem links) for where you are: by your level when the
 * titles name levels ("Lvl 30") and the log has shown one, else by the act you're in
 * ("Act 2"); once your level is well past that act (followedAct), by the act your level
 * suggests, then the first set after the act ones ("Early Maps"). Titles that name
 * neither ("Early", "27 points") follow your tree: the first
 * set whose tree you haven't finished (from the log). Picking another overrides it until
 * the set your level, act or tree points to changes (a level-up that doesn't change it
 * keeps your pick). A new list of titles (PoB saved the build again) keeps the set you
 * were on, by its title, while your level, act or tree still points to the same set. A
 * different build starts over.
 */
export function useFollowAct(
  titles: string[],
  /** Keeps your pick through a page change or restart (the Loadout dropdown's). */
  remember?: PrimitiveAtom<SetPick | null>,
) {
  const campaignAct = useAtomValue(currentActAtom);
  const level = useAtomValue(characterLevelAtom)?.level ?? null;
  const progress = useAtomValue(treeProgressAtom);
  const buildId = useAtomValue(buildIdSelector);
  const [memory, setMemory] = useAtom(remember ?? NO_PICK);
  const key = titles.join("\n");
  const levelIndex = indexForLevel(titles, level);
  // Well past the campaign marker's act: the act your level suggests picks, and past
  // Act 9's levels the first set after the act ones.
  const act = followedAct(campaignAct, level);
  const actIndex =
    act === "end" ? indexForEndgame(titles) : indexForAct(titles, act);
  const named = titles.some(
    (title) => levelRange(title) !== null || actRange(title) !== null,
  );
  const fresh = named ? null : progressIndex(titles, progress);
  const titleAt = (index: number | null) =>
    index === null ? null : (titles[index] ?? null);
  // Your remembered pick, while the build and the set your level, act or tree points to
  // are the ones it was made on; also while that set isn't known yet (the route or your
  // tree still being read after a restart), so the page doesn't show another first.
  const remembered = (followedTitle: string | null) => {
    if (
      remember === undefined ||
      memory === null ||
      memory.buildId !== buildId ||
      (followedTitle !== null && memory.followed !== followedTitle)
    )
      return -1;
    return titles.indexOf(memory.title);
  };
  const [state, setState] = useState(() => {
    const followed = levelIndex ?? actIndex ?? fresh;
    const pick = remembered(titleAt(followed));
    return {
      buildId,
      act,
      levelIndex,
      treeIndex: fresh,
      key,
      titles,
      /** The title your level, act or tree points to. */
      followed: titleAt(followed),
      index: pick >= 0 ? pick : (followed ?? 0),
    };
  });
  // A moment without your tree (the log couldn't be read) keeps the set it pointed to, so
  // a set you picked isn't reset when it comes back.
  const treeIndex = fresh ?? (state.key === key ? state.treeIndex : null);
  const follow = () => levelIndex ?? actIndex ?? treeIndex;

  // Adjusted during render rather than in an effect, so the first render with new
  // titles already has the right index (the Stats tab would otherwise calculate twice).
  // A moment without titles (the build's sets are being read again) changes nothing.
  let current = state;
  if (
    titles.length > 0 &&
    (state.buildId !== buildId ||
      state.act !== act ||
      state.levelIndex !== levelIndex ||
      state.treeIndex !== treeIndex ||
      state.key !== key)
  ) {
    const followed = follow();
    const followedTitle = titleAt(followed);
    const sameBuild = state.buildId === buildId;
    // Same build and pointer, new list: stay on the set you were on, if it's still there.
    const shown = state.titles[state.index];
    const kept =
      sameBuild &&
      state.key !== key &&
      followedTitle === state.followed &&
      shown
        ? titles[state.index] === shown
          ? state.index
          : titles.indexOf(shown)
        : -1;
    const pick = kept >= 0 ? -1 : remembered(followedTitle);
    current = {
      buildId,
      act,
      levelIndex,
      treeIndex,
      key,
      titles,
      followed: followedTitle,
      index:
        kept >= 0
          ? kept
          : pick >= 0
            ? pick
            : (followed ??
              (sameBuild && state.index < titles.length ? state.index : 0)),
    };
    setState(current);
  }

  // A pick made on another build, or before the set followed changed, is forgotten. Not
  // while the titles are still coming (empty until PoB answers), nor while the set to
  // follow isn't known yet (the route or your tree is still being read after a restart).
  const stale =
    remember !== undefined &&
    memory !== null &&
    titles.length > 0 &&
    (memory.buildId !== buildId ||
      (current.followed !== null && memory.followed !== current.followed));
  useEffect(() => {
    if (stale) setMemory(null);
  }, [stale]);

  // Remembered with the build and the set followed then; picking that set itself forgets.
  const latest = useRef({ buildId, followed: current.followed, titles });
  latest.current = { buildId, followed: current.followed, titles };
  const setIndex = useCallback(
    (index: number) => {
      setState((prev) => ({ ...prev, index }));
      if (remember === undefined) return;
      const { buildId, followed, titles } = latest.current;
      const title = titles[index];
      setMemory(
        title === undefined || title === followed
          ? null
          : { buildId, followed, title },
      );
    },
    [remember],
  );
  const safeIndex = current.index < titles.length ? current.index : 0;
  // The set your level, act or tree points to (null when none does).
  const followedIndex =
    current.followed === null ? null : titles.indexOf(current.followed);
  return [
    safeIndex,
    setIndex,
    followedIndex === null || followedIndex < 0 ? null : followedIndex,
  ] as const;
}

interface SetPagerProps {
  titles: string[];
  index: number;
  onIndex: (index: number) => void;
}

/** ‹ title (n/N) › row above a tree or gem set. */
export function SetPager({ titles, index, onIndex }: SetPagerProps) {
  const title = titles[index] ?? "";
  return (
    <div className={classNames(styles.pager)}>
      <button
        className={classNames(formStyles.formButton, styles.button)}
        aria-label="Previous"
        disabled={index <= 0}
        onClick={() => index > 0 && onIndex(index - 1)}
      >
        <HiChevronLeft />
      </button>
      <span className={classNames(styles.label)} title={title}>
        {displaySetName(title)}
        {titles.length > 1 && (
          <span className={classNames(styles.count)}>
            {index + 1}/{titles.length}
          </span>
        )}
      </span>
      <button
        className={classNames(formStyles.formButton, styles.button)}
        aria-label="Next"
        disabled={index >= titles.length - 1}
        onClick={() => index < titles.length - 1 && onIndex(index + 1)}
      >
        <HiChevronRight />
      </button>
    </div>
  );
}
