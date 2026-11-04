import { atom, useAtom, useAtomValue } from "jotai";
import { activeEdgeAtom } from "../../state/route";
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

  // Fold the act the moment its last step is marked done; open it again if a step is cleared.
  const wasFinished = useRef(finished);
  useEffect(() => {
    if (finished && !wasFinished.current) setCollapsed(true);
    if (!finished && wasFinished.current) setCollapsed(false);
    wasFinished.current = finished;
  }, [finished]);

  // Open a folded act when auto-progress moves into it, so the marker stays visible.
  const [activeEdge] = useAtomValue(activeEdgeAtom);
  const edgeHere = useMemo(
    () =>
      (items ?? []).some(
        (item) =>
          item.edgeIndex !== null &&
          (item.edgeIndex === activeEdge || item.edgeIndex === activeEdge + 1),
      ),
    [items, activeEdge],
  );
  const prevEdge = useRef(activeEdge);
  const prevEdgeHere = useRef(edgeHere);
  useEffect(() => {
    if (activeEdge !== prevEdge.current) {
      if (edgeHere && collapsed) setCollapsed(false);
      // Leaving a finished act folds it again.
      if (!edgeHere && prevEdgeHere.current && finished && !collapsed)
        setCollapsed(true);
    }
    prevEdge.current = activeEdge;
    prevEdgeHere.current = edgeHere;
  }, [activeEdge, edgeHere]);

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
