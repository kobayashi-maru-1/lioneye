import { characterLevelAtom } from "../../state/character-level";
import { pobAtom } from "../../state/pob";
import { BuildCompare } from "../BuildCompare";
import { DesktopPob } from "../DesktopPob";
import { usePobStats } from "../PobStats";
import { BuildTitle, HeadlineNumbers, Stat } from "./headline";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useAtomValue } from "jotai";
import { FaDesktop, FaRegClipboard } from "react-icons/fa";
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
 * pob.codes-style card above the guide: the build's title, its headline numbers for
 * the shown loadout, Compare, Desktop PoB (opens it in the chosen PoB) and Copy. The
 * Loadout dropdown is at the top of the left column (StatsViewer).
 */
export function BuildHeader() {
  const pob = usePobStats();
  // Your level from the game log; the title keeps the level PoB calculates at.
  const characterLevel = useAtomValue(characterLevelAtom);
  const code = useAtomValue(pobAtom);
  if (pob === null || pob.stats === null) return null;
  const { error, loading } = pob;
  const headline = pob.stats.headline ?? {};
  // Never the old loadout's numbers under the new loadout's name.
  const numbersShown = error === null;

  return (
    <section className={classNames(styles.header)}>
      <div className={classNames(styles.titleRow)}>
        <h1 className={classNames(styles.title)}>
          <BuildTitle headline={headline} />
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
      {/* Your level is from the log, so it shows even when PoB's numbers can't. */}
      {!numbersShown && characterLevel !== null && (
        <div className={classNames(styles.numbers)}>
          <Stat
            label="Char lvl"
            value={characterLevel.level}
            colour="#d7c08d"
          />
        </div>
      )}
      {numbersShown && (
        <div
          className={classNames(styles.numbers, { [styles.stale]: loading })}
        >
          <Stat
            label="Char lvl"
            value={characterLevel?.level}
            colour="#d7c08d"
          />
          <HeadlineNumbers headline={headline} />
        </div>
      )}
    </section>
  );
}
