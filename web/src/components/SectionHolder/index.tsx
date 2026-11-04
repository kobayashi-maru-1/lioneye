import { atom, useAtom, useAtomValue } from "jotai";
import { sectionCollapseFamily } from "../../state/section-collapse";
import { TaskList, type RangeHandler, type TaskListProps } from "../TaskList";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
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

  // Fold the act the moment its last step is marked done.
  const wasFinished = useRef(finished);
  useEffect(() => {
    if (finished && !wasFinished.current) setCollapsed(true);
    wasFinished.current = finished;
  }, [finished]);

  const scrollToSection = (collapsed: boolean) => {
    if (!collapsed) return;

    const element = document.getElementById(sectionId);
    if (element)
      element.scrollIntoView({
        behavior: "auto",
        block: "nearest",
        inline: "nearest",
      });
  };

  useLayoutEffect(() => {
    scrollToSection(collapsed);
  }, [collapsed]);

  const icon = collapsed ? <FiChevronDown /> : <FiChevronUp />;
  return (
    <div id={sectionId}>
      <div
        className={classNames(styles.sectionbar, {
          [styles.finished]: finished,
        })}
      >
        <button
          aria-label={name}
          aria-expanded={!collapsed}
          className={classNames(styles.header, styles.sectionbarHeader)}
          onClick={() => {
            setCollapsed(!collapsed);
          }}
        >
          {icon}
          <div className={classNames(styles.title)}>
            {`--== ${name} ==--`}
            <span className={classNames(styles.progress)}>
              {finished ? (
                <FiCheck className={classNames("inlineIcon")} />
              ) : (
                `${done}/${total}`
              )}
            </span>
          </div>
          {icon}
        </button>
        <hr />
      </div>
      {collapsed || (
        <>
          <TaskList items={items} onRange={onRange} />
          <hr />
        </>
      )}
    </div>
  );
}
