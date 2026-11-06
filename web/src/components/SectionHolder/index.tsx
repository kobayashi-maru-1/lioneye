import { atom, useAtom, useAtomValue } from "jotai";
import { sectionCollapseFamily } from "../../state/section-collapse";
import { scrolledInside } from "../PageSection";
import { TaskList, type RangeHandler, type TaskListProps } from "../TaskList";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useEffect, useMemo, useRef } from "react";
import { FiCheck, FiChevronDown, FiChevronUp } from "react-icons/fi";

interface SectionHolderProps {
  name: string;
  items: TaskListProps["items"];
  onRange?: RangeHandler;
}

export function SectionHolder({ name, items, onRange }: SectionHolderProps) {
  const sectionId = `section-${name.replace(/\s+/g, "_")}`;
  const [collapsed, setCollapsed] = useAtom(sectionCollapseFamily(sectionId));

  // How many of this act's steps are done.
  const doneAtom = useMemo(
    () =>
      atom((get) =>
        (items ?? []).reduce(
          (count, item) =>
            item.isCompletedState && get(item.isCompletedState)
              ? count + 1
              : count,
          0,
        ),
      ),
    [items],
  );
  const done = useAtomValue(doneAtom);
  const total = items?.length ?? 0;
  const finished = total > 0 && done === total;

  // Fold the act the moment its last step is marked done. Nothing reopens on its own:
  // a folded act stays folded until you click it.
  const wasFinished = useRef(finished);
  useEffect(() => {
    if (finished && !wasFinished.current) setCollapsed(true);
    wasFinished.current = finished;
  }, [finished]);

  // Folding an act while you're inside it (its header pinned) lands on the next act's
  // header instead of mid-page.
  const actRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const toggle = () => {
    const act = actRef.current;
    const bar = barRef.current;
    // Inside: the act's top has scrolled above where its header pins.
    const inside = act !== null && bar !== null && scrolledInside(act, bar);
    setCollapsed(!collapsed);
    if (!collapsed && inside)
      requestAnimationFrame(() =>
        (act.nextElementSibling ?? act).scrollIntoView({ block: "start" }),
      );
  };

  const icon = collapsed ? <FiChevronDown /> : <FiChevronUp />;
  return (
    <div id={sectionId} ref={actRef} className={classNames(styles.act)}>
      <div
        ref={barRef}
        className={classNames(styles.sectionbar, {
          [styles.finished]: finished,
        })}
      >
        <button
          aria-label={name}
          aria-expanded={!collapsed}
          className={classNames(styles.header, styles.sectionbarHeader)}
          onClick={toggle}
        >
          <div className={classNames(styles.title)}>
            {name}
            {icon}
          </div>
          <span className={classNames(styles.progress)}>
            {finished ? (
              <FiCheck className={classNames("inlineIcon")} />
            ) : (
              `${done}/${total}`
            )}
          </span>
        </button>
      </div>
      {collapsed || <TaskList items={items} onRange={onRange} />}
    </div>
  );
}
