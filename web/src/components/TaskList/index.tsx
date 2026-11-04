import { useAtom } from "jotai";
import { borderListStyles, interactiveStyles } from "../../styles";
import styles from "./styles.module.css";
import classNames from "classnames";
import type { WritableAtom } from "jotai";
import { FaRegCircle, FaRegPlayCircle } from "react-icons/fa";
import { edgeId, nextEdgeAtom } from "../../state/route";

/** Marks a run of steps: done = this one and all before, not done = this one and all after. */
export type RangeHandler = (orderIndex: number, done: boolean) => void;

interface TaskItemProps {
  edgeIndex: number | null;
  /** Position in the whole route, for shift-click ranges */
  orderIndex?: number;
  isCompletedState?: WritableAtom<boolean, [boolean], void>;
  children?: React.ReactNode;
}

function TaskListItem({
  edgeIndex,
  orderIndex,
  isCompletedState,
  onRange,
  children,
}: TaskItemProps & { onRange?: RangeHandler }) {
  const [isCompleted, setIsCompleted] = isCompletedState
    ? useAtom(isCompletedState)
    : [undefined, undefined];

  const [nextEdge, setNextEdge] = useAtom(nextEdgeAtom(edgeIndex));

  return (
    <li
      id={edgeIndex !== null ? edgeId(edgeIndex) : undefined}
      tabIndex={0}
      className={classNames(
        styles.listItem,
        borderListStyles.item,
        interactiveStyles.hoverPrimary,
        {
          [styles.completed]: isCompleted,
        },
      )}
      onClick={(ev) => {
        if (!setIsCompleted) return;
        if (ev.shiftKey && onRange && orderIndex !== undefined) {
          onRange(orderIndex, !isCompleted);
          return;
        }
        setIsCompleted(!isCompleted);
      }}
    >
      <div className={classNames(styles.listItemInner)}>
        {
          <span
            aria-hidden
            className={classNames(styles.edgeTag)}
            onClick={(ev) => {
              setNextEdge();
              ev.stopPropagation();
            }}
          >
            <>
              {nextEdge !== null && nextEdge && (
                <FaRegPlayCircle size={"100%"} />
              )}
              {nextEdge !== null && !nextEdge && <FaRegCircle size={"100%"} />}
            </>
          </span>
        }
        {children}
      </div>
    </li>
  );
}

export interface TaskListProps {
  items?: TaskItemProps[];
  onRange?: RangeHandler;
}

export function TaskList({ items, onRange }: TaskListProps) {
  return (
    <ol className={classNames(styles.list)}>
      {items &&
        items.map(({ children, ...rest }, i) => (
          <TaskListItem key={i} {...rest} onRange={onRange}>
            <span aria-hidden className={classNames(styles.bullet)}>
              {`${i + 1}`.padStart(2, "0")}.
            </span>
            <div className={classNames(styles.task)}>{children}</div>
          </TaskListItem>
        ))}
    </ol>
  );
}
