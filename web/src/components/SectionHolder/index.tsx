import { atom, useAtom, useAtomValue } from "jotai";
import { sectionCollapseFamily } from "../../state/section-collapse";
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

  // Folding a long act from its header keeps the header in view.
  const toggle = () => {
    const folding = !collapsed;
    setCollapsed(folding);
    if (folding)
      requestAnimationFrame(() =>
        document.getElementById(sectionId)?.scrollIntoView({
          behavior: "auto",
          block: "nearest",
          inline: "nearest",
        }),
      );
  };

  const icon = collapsed ? <FiChevronDown /> : <FiChevronUp />;
  return (
    <div id={sectionId} className={classNames(styles.act)}>
      <div
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
