import { useAtomValue } from "jotai";
import { formStyles } from "../../styles";
import {
  currentActAtom,
  displaySetName,
  indexForAct,
} from "../../state/current-act";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useCallback, useState } from "react";
import { HiChevronLeft, HiChevronRight } from "react-icons/hi";

/**
 * Picks the set (tree or gem links) whose title covers the act you're in.
 * The arrows override it until you move into another act.
 */
export function useFollowAct(titles: string[]) {
  const act = useAtomValue(currentActAtom);
  const key = titles.join("\n");
  const [state, setState] = useState(() => ({
    act,
    key,
    index: indexForAct(titles, act) ?? 0,
  }));

  // Adjusted during render rather than in an effect, so the first render with new
  // titles already has the right index (the Stats tab would otherwise calculate twice).
  let current = state;
  if (state.act !== act || state.key !== key) {
    const followed = indexForAct(titles, act);
    current = {
      act,
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
