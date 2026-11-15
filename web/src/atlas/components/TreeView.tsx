import { mechanicOf, type AtlasData } from "../lib/types.ts";
import { TRAVEL_COLOUR } from "../lib/mechanics.ts";
import styles from "../atlas.module.css";
import classNames from "classnames";
import {
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
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
  /** A mechanic brought out (its clusters full, the rest dim); null for none. */
  mechanic: number | null;
  /** The mechanic pinned by a click (mechanic is the hovered one, else this). */
  pinned: number | null;
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

const RADIUS = { start: 150, small: 79, notable: 113, keystone: 141 } as const;
/** A cluster's letter badge: about a notable's size, so the passives around it read first. */
const LABEL_RADIUS = 100;
const PAD = 600;
const DRAG = 5;

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
  }>({
    moved: false,
    startX: 0,
    startY: 0,
    pinch: null,
    node: null,
    label: null,
  });

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    // The left button only: right and middle clicks neither pan nor act.
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const target = e.target as Element;
    const node =
      target.closest("[data-node]")?.getAttribute("data-node") ?? null;
    const label =
      target.closest("[data-label]")?.getAttribute("data-label") ?? null;
    svgRef.current?.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY,
      type: e.pointerType,
    });
    if (pointers.current.size === 1)
      gesture.current = {
        moved: false,
        startX: e.clientX,
        startY: e.clientY,
        pinch: null,
        node,
        label,
      };
    else {
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
    const was = pointers.current.get(e.pointerId);
    pointers.current.delete(e.pointerId);
    if (pointers.current.size > 0 || !was || gesture.current.moved) {
      if (pointers.current.size === 0) gesture.current.pinch = null;
      return;
    }
    const { node, label } = gesture.current;
    // The start clears the plan by mouse only: a mis-tap on a phone shouldn't.
    if (node === data.start) {
      if (was.type === "mouse") onStart();
    } else if (node) onNode(node, was.type !== "mouse");
    else if (label !== null) onLabel(Number(label));
  };

  // A cancelled touch (the browser took it over) is never a tap.
  const onPointerCancel = (e: ReactPointerEvent<SVGSVGElement>) => {
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
    if (node !== null && node !== data.start) onNode(node, false);
    else if (label !== null) onLabel(Number(label));
    else return;
    e.preventDefault();
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
      onFocus={onFocus}
      onBlur={onBlur}
      role="group"
      aria-label="Atlas tree"
    >
      <StaticLayers data={data} colours={colours} mechanic={marks.mechanic} />
      <Edges data={data} marks={marks} />
      <Labels
        data={data}
        colours={colours}
        letters={letters}
        mechanic={marks.mechanic}
        pinned={marks.pinned}
      />
      <Nodes data={data} colours={colours} marks={marks} flash={flash} />
    </svg>
  );
});

/** Cluster discs: only for the mechanic brought out (hovered or pinned), none otherwise. */
const StaticLayers = memo(function StaticLayers({
  data,
  colours,
  mechanic,
}: {
  data: AtlasData;
  colours: string[];
  mechanic: number | null;
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
  if (mechanic === null) return null;
  return (
    <g className={styles.discs}>
      {discs
        .filter((d) => d.m === mechanic)
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
  mechanic,
  pinned,
}: {
  data: AtlasData;
  colours: string[];
  letters: string[];
  mechanic: number | null;
  pinned: number | null;
}) {
  return (
    <g className={styles.labels}>
      {data.labels.map((label) => (
        <g
          key={label.g}
          data-label={label.m}
          role="button"
          tabIndex={0}
          aria-label={data.mechanics[label.m]}
          aria-pressed={pinned === label.m}
          className={classNames(styles.label, {
            [styles.dim]: mechanic !== null && mechanic !== label.m,
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
        const r = RADIUS[node.kind];
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
                (marks.mechanic !== null &&
                  m !== marks.mechanic &&
                  !allocated) ||
                (marks.lit.size > 0 && !marks.lit.has(id)),
              [styles.start]: start,
            })}
          >
            {(node.kind === "notable" || node.kind === "keystone") && (
              <circle
                className={styles.ring}
                cx={node.x}
                cy={node.y}
                r={r * 1.3}
              />
            )}
            {marks.unset.has(id) && (
              <circle
                className={styles.unsetRing}
                cx={node.x}
                cy={node.y}
                r={r * 1.75}
              />
            )}
            {node.kind === "small" &&
              (marks.matches.has(id) || marks.lit.has(id) || flash === id) && (
                <circle
                  className={styles.halo}
                  cx={node.x}
                  cy={node.y}
                  r={r * 1.45}
                />
              )}
            <circle className={styles.dot} cx={node.x} cy={node.y} r={r} />
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
