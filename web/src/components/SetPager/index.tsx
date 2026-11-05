import { useAtomValue } from "jotai";
import { formStyles } from "../../styles";
import { characterLevelAtom } from "../../state/character-level";
import {
  currentActAtom,
  displaySetName,
  indexForAct,
  indexForLevel,
} from "../../state/current-act";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useCallback, useState } from "react";
import { HiChevronLeft, HiChevronRight } from "react-icons/hi";

/**
 * Picks the set (loadout, tree or gem links) for where you are: by your level when the
 * titles name levels ("Lvl 30") and the log has shown one, else by the act you're in
 * ("Act 2"). Picking another overrides it until the set your level or act points to
 * changes (a level-up that doesn't change it keeps your pick).
 */
export function useFollowAct(titles: string[]) {
  const act = useAtomValue(currentActAtom);
  const level = useAtomValue(characterLevelAtom)?.level ?? null;
  const key = titles.join("\n");
  const levelIndex = indexForLevel(titles, level);
  const follow = () => levelIndex ?? indexForAct(titles, act);
  const [state, setState] = useState(() => ({
    act,
    levelIndex,
    key,
    index: follow() ?? 0,
  }));

  // Adjusted during render rather than in an effect, so the first render with new
  // titles already has the right index (the Stats tab would otherwise calculate twice).
  let current = state;
  if (
    state.act !== act ||
    state.levelIndex !== levelIndex ||
    state.key !== key
  ) {
    const followed = follow();
    current = {
      act,
      levelIndex,
      key,
      index: followed ?? (state.index < titles.length ? state.index : 0),
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
