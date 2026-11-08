import { useAtomValue } from "jotai";
import { formStyles } from "../../styles";
import { characterLevelAtom } from "../../state/character-level";
import { buildIdSelector } from "../../state/pob";
import {
  actRange,
  currentActAtom,
  displaySetName,
  indexForAct,
  indexForLevel,
  levelRange,
} from "../../state/current-act";
import { progressIndex, treeProgressAtom } from "../../state/tree/progress";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useCallback, useState } from "react";
import { HiChevronLeft, HiChevronRight } from "react-icons/hi";

/**
 * Picks the set (loadout, tree or gem links) for where you are: by your level when the
 * titles name levels ("Lvl 30") and the log has shown one, else by the act you're in
 * ("Act 2"). Titles that name neither ("Early", "27 points") follow your tree: the first
 * set whose tree you haven't finished (from the log). Picking another overrides it until
 * the set your level, act or tree points to changes (a level-up that doesn't change it
 * keeps your pick). A new list of titles (PoB saved the build again) keeps the set you
 * were on, by its title, while your level, act or tree still points to the same set. A
 * different build starts over.
 */
export function useFollowAct(titles: string[]) {
  const act = useAtomValue(currentActAtom);
  const level = useAtomValue(characterLevelAtom)?.level ?? null;
  const progress = useAtomValue(treeProgressAtom);
  const buildId = useAtomValue(buildIdSelector);
  const key = titles.join("\n");
  const levelIndex = indexForLevel(titles, level);
  const named = titles.some(
    (title) => levelRange(title) !== null || actRange(title) !== null,
  );
  const fresh = named ? null : progressIndex(titles, progress);
  const titleAt = (index: number | null) =>
    index === null ? null : (titles[index] ?? null);
  const [state, setState] = useState(() => {
    const followed = levelIndex ?? indexForAct(titles, act) ?? fresh;
    return {
      buildId,
      act,
      levelIndex,
      treeIndex: fresh,
      key,
      titles,
      /** The title your level, act or tree points to. */
      followed: titleAt(followed),
      index: followed ?? 0,
    };
  });
  // A moment without your tree (the log couldn't be read) keeps the set it pointed to, so
  // a set you picked isn't reset when it comes back.
  const treeIndex = fresh ?? (state.key === key ? state.treeIndex : null);
  const follow = () => levelIndex ?? indexForAct(titles, act) ?? treeIndex;

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
          : (followed ??
            (sameBuild && state.index < titles.length ? state.index : 0)),
    };
    setState(current);
  }

  const setIndex = useCallback(
    (index: number) => setState((prev) => ({ ...prev, index })),
    [],
  );
  const safeIndex = current.index < titles.length ? current.index : 0;
  return [safeIndex, setIndex] as const;
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
