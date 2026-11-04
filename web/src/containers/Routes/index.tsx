import { useAtom, useAtomValue } from "jotai";
import { useAtomCallback } from "jotai/utils";
import { FragmentStep } from "../../components/FragmentStep";
import { GemReward } from "../../components/ItemReward";
import { SectionHolder } from "../../components/SectionHolder";
import { Sidebar } from "../../components/Sidebar";
import type { TaskListProps } from "../../components/TaskList";
import { gemProgressFamily } from "../../state/gem-progress";
import { routeSelector, scrollToActiveEdgeEffect } from "../../state/route";
import { routeProgressFamily } from "../../state/route-progress";
import { getPersistent, NO_MIGRATORS, setPersistent } from "../../utility";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";

/** Where a step's done flag is stored, in route order. */
interface ProgressRef {
  family: "route" | "gem";
  key: string;
}

const LAYOUT_VERSION = 0;
const LAYOUT_KEY = "local-layout";

interface Layout {
  /** Route column share of the width, 0.2–0.8 */
  split: number;
  panel: boolean;
}

const DEFAULT_LAYOUT: Layout = { split: 0.45, panel: true };

export default function RoutesContainer() {
  useAtom(scrollToActiveEdgeEffect);
  const route = useAtomValue(routeSelector);
  const [layout, setLayoutState] = useState<Layout>(
    () =>
      getPersistent<Layout>(LAYOUT_KEY, LAYOUT_VERSION, NO_MIGRATORS) ??
      DEFAULT_LAYOUT,
  );
  const setLayout = useCallback((next: Layout) => {
    setLayoutState(next);
    setPersistent(LAYOUT_KEY, LAYOUT_VERSION, next);
  }, []);

  // Every step's done flag in route order, for shift-click ranges.
  const order = useMemo(() => {
    const order: ProgressRef[] = [];
    route.sections.forEach((section, sectionIndex) =>
      section.steps.forEach((step, stepIndex) => {
        if (step.type === "fragment_step")
          order.push({
            family: "route",
            key: [sectionIndex, stepIndex].toString(),
          });
        if (step.type === "gem_step")
          order.push({ family: "gem", key: step.requiredGem.id });
      }),
    );
    return order;
  }, [route]);

  // Shift-click: done → this and everything before; not done → this and everything after.
  const markRange = useAtomCallback(
    useCallback(
      (_get, set, orderIndex: number, done: boolean) => {
        const range = done
          ? order.slice(0, orderIndex + 1)
          : order.slice(orderIndex);
        const routeKeys = range
          .filter((x) => x.family === "route")
          .map((x) => x.key);
        const gemKeys = range
          .filter((x) => x.family === "gem")
          .map((x) => x.key);
        if (routeKeys.length > 0)
          set(routeProgressFamily.setMany, routeKeys, done);
        if (gemKeys.length > 0) set(gemProgressFamily.setMany, gemKeys, done);
      },
      [order],
    ),
  );

  const items = useMemo(() => {
    const items: ReactNode[] = [];
    let orderIndex = 0;
    for (
      let sectionIndex = 0;
      sectionIndex < route.sections.length;
      sectionIndex++
    ) {
      const section = route.sections[sectionIndex];

      let taskItems: TaskListProps["items"] = [];
      for (let stepIndex = 0; stepIndex < section.steps.length; stepIndex++) {
        const step = section.steps[stepIndex];

        if (step.type == "fragment_step")
          taskItems.push({
            edgeIndex: step.edgeIndex,
            orderIndex: orderIndex++,
            isCompletedState: routeProgressFamily(
              [sectionIndex, stepIndex].toString(),
            ),
            children: <FragmentStep key={stepIndex} step={step} />,
          });

        if (step.type == "gem_step")
          taskItems.push({
            edgeIndex: null,
            orderIndex: orderIndex++,
            isCompletedState: gemProgressFamily(step.requiredGem.id),
            children: (
              <GemReward
                key={taskItems.length}
                requiredGem={step.requiredGem}
                count={step.count}
                rewardType={step.rewardType}
              />
            ),
          });
      }

      items.push(
        <SectionHolder
          key={sectionIndex}
          name={section.name}
          items={taskItems}
          onRange={markRange}
        />,
      );
    }

    return items;
  }, [route, markRange]);

  return (
    <div
      className={classNames(styles.layout, { [styles.noPanel]: !layout.panel })}
      style={
        layout.panel
          ? {
              gridTemplateColumns: `minmax(0, ${layout.split}fr) auto minmax(0, ${1 - layout.split}fr)`,
            }
          : undefined
      }
    >
      <div className={classNames(styles.route)}>{items}</div>
      {layout.panel && (
        <Splitter
          split={layout.split}
          onSplit={(split) => setLayout({ ...layout, split })}
        />
      )}
      <Sidebar
        expand={layout.panel}
        onToggleExpand={(panel) => setLayout({ ...layout, panel })}
      />
    </div>
  );
}

interface SplitterProps {
  split: number;
  onSplit: (split: number) => void;
}

/** Drag to resize the route column; double-click to reset. */
function Splitter({ split, onSplit }: SplitterProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragSplit, setDragSplit] = useState<number | null>(null);

  const toSplit = (clientX: number) => {
    const parent = ref.current?.parentElement;
    if (!parent) return split;
    const rect = parent.getBoundingClientRect();
    const value = (clientX - rect.left) / rect.width;
    return Math.min(0.8, Math.max(0.2, value));
  };

  return (
    <div
      ref={ref}
      className={classNames(styles.splitter, {
        [styles.dragging]: dragSplit !== null,
      })}
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={Math.round((dragSplit ?? split) * 100)}
      title="Drag to resize"
      onPointerDown={(ev) => {
        ev.currentTarget.setPointerCapture(ev.pointerId);
        setDragSplit(split);
      }}
      onPointerMove={(ev) => {
        if (dragSplit === null) return;
        const next = toSplit(ev.clientX);
        setDragSplit(next);
        onSplit(next);
      }}
      onPointerUp={(ev) => {
        ev.currentTarget.releasePointerCapture(ev.pointerId);
        setDragSplit(null);
      }}
      onDoubleClick={() => onSplit(DEFAULT_LAYOUT.split)}
    />
  );
}
