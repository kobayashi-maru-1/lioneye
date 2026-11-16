import { mechanicOf, type AtlasData } from "../lib/types.ts";
import { TRAVEL_COLOUR } from "../lib/mechanics.ts";
import {
  LABEL_RADIUS,
  NODE_SIZE,
  hitRadius,
  unsetRadius,
} from "../lib/geometry.ts";
import styles from "../atlas.module.css";
import classNames from "classnames";
import {
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

/** What the tree shows on top of the plan: previews, matches and highlights. */
export interface TreeMarks {
  allocated: ReadonlySet<string>;
  route: ReadonlySet<string>;
  refund: ReadonlySet<string>;
  matches: ReadonlySet<string>;
  /** Nodes to bring out (a Bonuses line); empty for none. */
  lit: ReadonlySet<string>;
  /** Mechanics brought out (their clusters full, the rest dim); empty for none. */
  mechanics: ReadonlySet<number>;
  /** The mechanics picked by a click (mechanics adds the hovered one to these). */
  pinned: ReadonlySet<number>;
  /** The gateway pair under the pointer, ringed. */
  gatewayPair: ReadonlySet<string>;
  /** Allocated choice nodes with no option picked. */
  unset: ReadonlySet<string>;
  overBudget: boolean;
}

export interface TreeHandle {
  fit: () => void;
  focus: (ids: Iterable<string>) => void;
  zoom: (factor: number) => void;
  locate: (id: string) => void;
}

interface TreeViewProps {
  data: AtlasData;
  colours: string[];
  letters: string[];
  marks: TreeMarks;
  /** The node under a mouse pointer (null when it leaves one). */
  onHover: (id: string | null, clientX: number, clientY: number) => void;
  /** A node clicked or tapped; `touch` when there was no hover first. */
  onNode: (id: string, touch: boolean) => void;
  onLabel: (mechanic: number) => void;
  /** A cluster label right-clicked or long-pressed: take that cluster (its group). */
  onLabelTake: (group: string) => void;
  /** A cluster label under a mouse pointer (null when it leaves one). */
  onLabelHover: (mechanic: number | null) => void;
  onStart: () => void;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const PAD = 600;
const DRAG = 5;
/** How long a touch holds a cluster label to take the cluster (ms). */
export const LONG_PRESS = 500;

function boxAround(points: { x: number; y: number }[], pad: number): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return {
    x: minX - pad,
    y: minY - pad,
    w: maxX - minX + pad * 2,
    h: maxY - minY + pad * 2,
  };
}

export const TreeView = forwardRef<TreeHandle, TreeViewProps>(function TreeView(
  {
    data,
    colours,
    letters,
    marks,
    onHover,
    onNode,
    onLabel,
    onLabelTake,
    onLabelHover,
    onStart,
  },
  ref,
) {
  const svgRef = useRef<SVGSVGElement>(null);
  const whole = useMemo(
    () =>
      boxAround(
        [
          { x: data.bounds.minX, y: data.bounds.minY },
          { x: data.bounds.maxX, y: data.bounds.maxY },
        ],
        PAD,
      ),
    [data],
  );
  const [box, setBox] = useState<Box>(whole);
  const boxRef = useRef(box);
  boxRef.current = box;
  const [flash, setFlash] = useState<string | null>(null);

  const clamp = useCallback(
    (b: Box): Box => {
      const maxW = whole.w * 2;
      const minW = 1200;
      const scale = Math.min(Math.max(b.w, minW), maxW) / b.w;
      if (scale === 1) return b;
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      return {
        x: cx - (b.w * scale) / 2,
        y: cy - (b.h * scale) / 2,
        w: b.w * scale,
        h: b.h * scale,
      };
    },
    [whole],
  );

  /** Zooms by `factor` (above 1 zooms in) around a point in tree units. */
  const zoomAt = useCallback(
    (factor: number, at?: { x: number; y: number }) => {
      setBox((b) => {
        const p = at ?? { x: b.x + b.w / 2, y: b.y + b.h / 2 };
        const w = b.w / factor;
        const h = b.h / factor;
        const next = clamp({
          x: p.x - (p.x - b.x) / factor,
          y: p.y - (p.y - b.y) / factor,
          w,
          h,
        });
        return next;
      });
    },
    [clamp],
  );

  useImperativeHandle(
    ref,
    () => ({
      fit: () => setBox(whole),
      focus: (ids) => {
        const points = [...ids].map((id) => data.nodes[id]).filter(Boolean);
        points.push(data.nodes[data.start]);
        setBox(clamp(boxAround(points, PAD)));
      },
      zoom: (factor) => zoomAt(factor),
      locate: (id) => {
        const node = data.nodes[id];
        if (!node) return;
        setBox(clamp({ x: node.x - 1800, y: node.y - 1200, w: 3600, h: 2400 }));
        setFlash(id);
        window.setTimeout(() => setFlash((f) => (f === id ? null : f)), 1600);
      },
    }),
    [data, whole, clamp, zoomAt],
  );

  /** A client point in tree units, through the SVG's current transform. */
  const toTree = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current;
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix) return { x: 0, y: 0 };
    const p = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
    return { x: p.x, y: p.y };
  }, []);

  // Wheel zoom (not passive, so the page doesn't scroll instead).
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(Math.exp(-e.deltaY * 0.0015), toTree(e.clientX, e.clientY));
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [zoomAt, toTree]);

  // Drag to pan, two fingers to pinch; a press that barely moves is a click.
  const pointers = useRef(
    new Map<number, { x: number; y: number; type: string }>(),
  );
  const gesture = useRef<{
    moved: boolean;
    startX: number;
    startY: number;
    pinch: number | null;
    /** What was pressed, read before the capture (after it, events all report the SVG). */
    node: string | null;
    label: string | null;
    group: string | null;
  }>({
    moved: false,
    startX: 0,
    startY: 0,
    pinch: null,
    node: null,
    label: null,
    group: null,
  });
  // A long press on a cluster label (touch) takes the cluster, as a right-click does, once:
  // the context menu event a touch browser sends for the same hold (before the timer, or
  // when the finger lifts) doesn't take it again.
  const press = useRef<{ timer: number; group: string } | null>(null);
  const took = useRef<{ group: string; at: number } | null>(null);
  const endPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };
  useEffect(() => endPress, []);

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    took.current = null;
    // The left button only: right and middle clicks neither pan nor act.
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const target = e.target as Element;
    const node =
      target.closest("[data-node]")?.getAttribute("data-node") ?? null;
    const labelEl = target.closest("[data-label]");
    const label = labelEl?.getAttribute("data-label") ?? null;
    const group = labelEl?.getAttribute("data-group") ?? null;
    svgRef.current?.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY,
      type: e.pointerType,
    });
    endPress();
    if (pointers.current.size === 1) {
      gesture.current = {
        moved: false,
        startX: e.clientX,
        startY: e.clientY,
        pinch: null,
        node,
        label,
        group,
      };
      if (e.pointerType !== "mouse" && group !== null && node === null)
        press.current = {
          group,
          timer: window.setTimeout(() => {
            press.current = null;
            // Held without moving: the cluster, and no tap after it.
            gesture.current.moved = true;
            took.current = { group, at: performance.now() };
            onLabelTake(group);
          }, LONG_PRESS),
        };
    } else {
      const [a, b] = [...pointers.current.values()];
      gesture.current.moved = true;
      gesture.current.pinch = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const previous = pointers.current.get(e.pointerId);
    if (!previous) {
      if (e.pointerType === "mouse") {
        const target = e.target as Element;
        const id = target.closest("[data-node]")?.getAttribute("data-node");
        onHover(id ?? null, e.clientX, e.clientY);
        const label = target
          .closest("[data-label]")
          ?.getAttribute("data-label");
        onLabelHover(label == null ? null : Number(label));
      }
      return;
    }
    if (pointers.current.size === 2 && gesture.current.pinch !== null) {
      pointers.current.set(e.pointerId, {
        ...previous,
        x: e.clientX,
        y: e.clientY,
      });
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (gesture.current.pinch > 0)
        zoomAt(
          distance / gesture.current.pinch,
          toTree((a.x + b.x) / 2, (a.y + b.y) / 2),
        );
      gesture.current.pinch = distance;
      return;
    }
    if (
      !gesture.current.moved &&
      Math.hypot(
        e.clientX - gesture.current.startX,
        e.clientY - gesture.current.startY,
      ) < DRAG
    )
      return;
    gesture.current.moved = true;
    endPress();
    const from = toTree(previous.x, previous.y);
    const to = toTree(e.clientX, e.clientY);
    pointers.current.set(e.pointerId, {
      ...previous,
      x: e.clientX,
      y: e.clientY,
    });
    setBox((b) => ({
      ...b,
      x: b.x - (to.x - from.x),
      y: b.y - (to.y - from.y),
    }));
    onHover(null, 0, 0);
  };

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    endPress();
    const was = pointers.current.get(e.pointerId);
    pointers.current.delete(e.pointerId);
    if (pointers.current.size > 0 || !was || gesture.current.moved) {
      if (pointers.current.size === 0) gesture.current.pinch = null;
      return;
    }
    const { node, label } = gesture.current;
    // The start asks to clear the plan, by mouse only: a mis-tap on a phone shouldn't.
    if (node === data.start) {
      if (was.type === "mouse") onStart();
    } else if (node) onNode(node, was.type !== "mouse");
    else if (label !== null) onLabel(Number(label));
  };

  // A cancelled touch (the browser took it over) is never a tap.
  const onPointerCancel = (e: ReactPointerEvent<SVGSVGElement>) => {
    endPress();
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) gesture.current.pinch = null;
    gesture.current.moved = true;
  };

  // Keyboard: Tab moves through nodes and labels; Enter or Space acts as a click. A focused
  // node off screen is brought into view, and shows its tooltip and preview.
  const onKeyDown = (e: ReactKeyboardEvent<SVGSVGElement>) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const target = e.target as Element;
    const node = target.getAttribute("data-node");
    const label = target.getAttribute("data-label");
    const group = target.getAttribute("data-group");
    // Shift+Enter on a cluster label: take the cluster (as a right-click).
    if (e.key === "Enter" && e.shiftKey && group !== null) {
      if (!e.repeat) onLabelTake(group);
    } else if (node !== null && node !== data.start) onNode(node, false);
    else if (label !== null) onLabel(Number(label));
    else return;
    e.preventDefault();
  };
  // Right-click (or the menu key, Shift+F10) on a cluster label takes the cluster. A long
  // press that a touch browser also reports as a context menu is taken only once.
  const onContextMenu = (e: ReactMouseEvent<SVGSVGElement>) => {
    const group = (e.target as Element)
      .closest("[data-label]")
      ?.getAttribute("data-group");
    if (group == null) return;
    e.preventDefault();
    if (press.current?.group === group) {
      // Reported before the timer: take it now, and no tap after it.
      endPress();
      gesture.current.moved = true;
      took.current = { group, at: performance.now() };
      onLabelTake(group);
    } else if (
      took.current?.group !== group ||
      performance.now() - took.current.at > 5000
    )
      onLabelTake(group);
  };
  // Keyboard focus only: a click or tap also focuses a node, and must not pan the view or
  // turn into a hover (that would hide the touch card).
  const focusFrame = useRef<number | undefined>(undefined);
  const keyboardFocus = useRef<string | null>(null);
  const onFocus = (e: ReactFocusEvent<SVGSVGElement>) => {
    const target = e.target as Element;
    const id = target.getAttribute("data-node");
    if (id === null || !target.matches(":focus-visible")) return;
    keyboardFocus.current = id;
    const node = data.nodes[id];
    const b = boxRef.current;
    const margin = 300;
    if (
      node.x < b.x + margin ||
      node.x > b.x + b.w - margin ||
      node.y < b.y + margin ||
      node.y > b.y + b.h - margin
    )
      setBox({ ...b, x: node.x - b.w / 2, y: node.y - b.h / 2 });
    // After React commits the pan (a timeout, not a frame: frames can be paused).
    window.clearTimeout(focusFrame.current);
    focusFrame.current = window.setTimeout(() => {
      const rect = target.getBoundingClientRect();
      onHover(id, rect.right, rect.bottom);
    }, 0);
  };
  const onBlur = (e: ReactFocusEvent<SVGSVGElement>) => {
    const target = e.target as Element;
    const id = target.getAttribute("data-node");
    if (id === null || keyboardFocus.current !== id) return;
    keyboardFocus.current = null;
    window.clearTimeout(focusFrame.current);
    onHover(null, 0, 0);
  };

  const viewBox = `${box.x} ${box.y} ${box.w} ${box.h}`;
  return (
    <svg
      ref={svgRef}
      className={styles.tree}
      viewBox={viewBox}
      preserveAspectRatio="xMidYMid meet"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={() => {
        onHover(null, 0, 0);
        onLabelHover(null);
      }}
      onKeyDown={onKeyDown}
      onContextMenu={onContextMenu}
      onFocus={onFocus}
      onBlur={onBlur}
      role="group"
      aria-label="Atlas tree"
    >
      <StaticLayers data={data} colours={colours} mechanics={marks.mechanics} />
      <Edges data={data} marks={marks} />
      <Labels
        data={data}
        colours={colours}
        letters={letters}
        mechanics={marks.mechanics}
        pinned={marks.pinned}
      />
      <Hits data={data} />
      <Nodes data={data} colours={colours} marks={marks} flash={flash} />
    </svg>
  );
});

/** Cluster discs: only for the mechanics brought out (hovered or picked), none otherwise. */
const StaticLayers = memo(function StaticLayers({
  data,
  colours,
  mechanics,
}: {
  data: AtlasData;
  colours: string[];
  mechanics: ReadonlySet<number>;
}) {
  const discs = useMemo(() => {
    const members = new Map<string, { x: number; y: number }[]>();
    for (const node of Object.values(data.nodes)) {
      const list = members.get(node.g) ?? [];
      list.push(node);
      members.set(node.g, list);
    }
    return data.labels.map((label) => {
      const r = Math.max(
        320,
        ...(members.get(label.g) ?? []).map(
          (n) => Math.hypot(n.x - label.x, n.y - label.y) + 170,
        ),
      );
      return { ...label, r };
    });
  }, [data]);
  if (mechanics.size === 0) return null;
  return (
    <g className={styles.discs}>
      {discs
        .filter((d) => mechanics.has(d.m))
        .map((d) => (
          <circle
            key={d.g}
            cx={d.x}
            cy={d.y}
            r={d.r}
            fill={colours[d.m] ?? TRAVEL_COLOUR}
          />
        ))}
    </g>
  );
});

const Edges = memo(function Edges({
  data,
  marks,
}: {
  data: AtlasData;
  marks: TreeMarks;
}) {
  const paths = useMemo(
    () =>
      data.edges
        .filter((e) => !e.hidden)
        .map((e) => {
          const a = data.nodes[e.a];
          const b = data.nodes[e.b];
          const d = e.arc
            ? `M${a.x} ${a.y}A${e.arc.r} ${e.arc.r} 0 0 ${e.arc.sweep} ${b.x} ${b.y}`
            : `M${a.x} ${a.y}L${b.x} ${b.y}`;
          return { key: `${e.a}-${e.b}`, a: e.a, b: e.b, d };
        }),
    [data],
  );
  const held = (id: string) => id === data.start || marks.allocated.has(id);
  return (
    <g className={styles.edges}>
      {paths.map((p) => {
        const on = held(p.a) && held(p.b);
        const refund = on && (marks.refund.has(p.a) || marks.refund.has(p.b));
        const route =
          !on &&
          (marks.route.has(p.a) || held(p.a)) &&
          (marks.route.has(p.b) || held(p.b));
        return (
          <path
            key={p.key}
            d={p.d}
            className={classNames(styles.edge, {
              [styles.edgeOn]: on && !refund,
              [styles.edgeRefund]: refund,
              [styles.edgeRoute]: route,
              [styles.over]: route && marks.overBudget,
            })}
          />
        );
      })}
    </g>
  );
});

const Labels = memo(function Labels({
  data,
  colours,
  letters,
  mechanics,
  pinned,
}: {
  data: AtlasData;
  colours: string[];
  letters: string[];
  mechanics: ReadonlySet<number>;
  pinned: ReadonlySet<number>;
}) {
  return (
    <g className={styles.labels}>
      {data.labels.map((label) => (
        <g
          key={label.g}
          data-label={label.m}
          data-group={label.g}
          role="button"
          tabIndex={0}
          aria-label={data.mechanics[label.m]}
          aria-pressed={pinned.has(label.m)}
          aria-keyshortcuts="Shift+Enter"
          className={classNames(styles.label, {
            [styles.dim]: mechanics.size > 0 && !mechanics.has(label.m),
          })}
        >
          <title>{data.mechanics[label.m]}</title>
          <circle
            cx={label.x}
            cy={label.y}
            r={LABEL_RADIUS}
            fill={colours[label.m]}
          />
          <text x={label.x} y={label.y} dy="0.36em" textAnchor="middle">
            {letters[label.m]}
          </text>
        </g>
      ))}
    </g>
  );
});

/**
 * Click targets larger than the dots, in a layer under every node so a neighbour's
 * target never covers a visible dot.
 */
const Hits = memo(function Hits({ data }: { data: AtlasData }) {
  return (
    <g className={styles.hits} aria-hidden="true">
      {Object.entries(data.nodes).map(([id, node]) => (
        <circle
          key={id}
          data-node={id}
          cx={node.x}
          cy={node.y}
          r={hitRadius(node.kind)}
        />
      ))}
    </g>
  );
});

const Nodes = memo(function Nodes({
  data,
  colours,
  marks,
  flash,
}: {
  data: AtlasData;
  colours: string[];
  marks: TreeMarks;
  flash: string | null;
}) {
  const nodes = useMemo(() => Object.entries(data.nodes), [data]);
  return (
    <g>
      {nodes.map(([id, node]) => {
        const size = NODE_SIZE[node.kind];
        const m = mechanicOf(node);
        const colour =
          node.kind === "start"
            ? "#d9b46a"
            : m >= 0
              ? colours[m]
              : TRAVEL_COLOUR;
        const start = node.kind === "start";
        const allocated = start || marks.allocated.has(id);
        return (
          <g
            key={id}
            data-node={id}
            {...(start
              ? {}
              : {
                  role: "button",
                  tabIndex: 0,
                  "aria-label": node.name,
                  "aria-pressed": allocated,
                })}
            style={{ "--c": colour } as CSSProperties}
            className={classNames(styles.node, {
              [styles.on]: allocated,
              [styles.route]: marks.route.has(id),
              [styles.refund]: marks.refund.has(id),
              [styles.over]: marks.route.has(id) && marks.overBudget,
              [styles.match]: marks.matches.has(id) || flash === id,
              [styles.lit]: marks.lit.has(id),
              [styles.gate]: marks.gatewayPair.has(id),
              [styles.unset]: marks.unset.has(id),
              // A highlighted mechanic never dims the plan itself; a lit Bonuses line
              // does (it picks out some allocated nodes from the rest).
              [styles.dim]:
                (marks.mechanics.size > 0 &&
                  !marks.mechanics.has(m) &&
                  !allocated) ||
                (marks.lit.size > 0 && !marks.lit.has(id)),
              [styles.start]: start,
            })}
          >
            {size.ring !== undefined && (
              <circle
                className={styles.ring}
                cx={node.x}
                cy={node.y}
                r={size.ring}
              />
            )}
            {marks.unset.has(id) && (
              <circle
                className={styles.unsetRing}
                cx={node.x}
                cy={node.y}
                r={unsetRadius(node.kind)}
              />
            )}
            {node.kind === "small" &&
              (marks.matches.has(id) || marks.lit.has(id) || flash === id) && (
                <circle
                  className={styles.halo}
                  cx={node.x}
                  cy={node.y}
                  r={size.dot * 1.45}
                />
              )}
            <circle
              className={styles.dot}
              cx={node.x}
              cy={node.y}
              r={size.dot}
            />
            {node.kind === "start" && (
              <text
                x={node.x}
                y={node.y}
                dy="0.36em"
                textAnchor="middle"
                className={styles.startText}
              >
                S
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
});
