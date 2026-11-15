import {
  MAX_BUDGET,
  mechanicOf,
  type AtlasData,
  type Plan,
} from "./lib/types.ts";
import { buildGraph, fits, normalise, refundSet, route } from "./lib/graph.ts";
import { nodeStats } from "./lib/bonuses.ts";
import { encodeOfficial, encodeShare, parseLink } from "./lib/links.ts";
import { mechanicColours, mechanicLetters } from "./lib/mechanics.ts";
import { KIND, byId, flat } from "./lib/text.ts";
import {
  IMPORT_MAX_BYTES,
  exportFile,
  historyReducer,
  importFile,
  newHistory,
  newId,
  nextPlanName,
  readCurrent,
  readDraft,
  readSaved,
  samePlan,
  writeCurrent,
  writeDraft,
  writeSaved,
  type SavedPlan,
} from "./store.ts";
import {
  TreeView,
  type TreeHandle,
  type TreeMarks,
} from "./components/TreeView.tsx";
import {
  Bonuses,
  Explore,
  Panel,
  Saved,
  type Tab,
} from "./components/Panel.tsx";
import { MoreMenu, type MenuItem } from "./components/MoreMenu.tsx";
import { PlanName } from "./components/PlanName.tsx";
import {
  ChoiceDialog,
  ConfirmDialog,
  OpenDialog,
  ShareDialog,
} from "./components/Dialogs.tsx";
import { formStyles } from "../styles";
import styles from "./atlas.module.css";
import classNames from "classnames";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

/** Toolbar widths (px): every button in words at or above FULL; icons for Undo and Redo and
 *  a More menu at or above ICONS; below it (phones), Undo and Redo in More too. */
const TOOLBAR_FULL = 780;
const TOOLBAR_ICONS = 540;

const sameNodes = (a: Plan, b: Plan) =>
  a.allocated.length === b.allocated.length &&
  a.allocated.every((id, i) => id === b.allocated[i]);

const stamp = () =>
  new Date().toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/** A link in the address bar (`#t=…` or `#p=…`), or null; the caller clears it. */
function hashLink(): string | null {
  return /[#&](t|p)=/.test(location.hash) ? location.hash : null;
}

function clearHash() {
  history.replaceState(null, "", location.pathname + location.search);
}

/**
 * Where the page starts: the stored draft, or a link in the address bar opened over it.
 * A draft with nodes that the link would replace is kept in Saved ("Draft <time>").
 */
function start(fix: (p: unknown) => Plan) {
  const draft = fix(readDraft());
  const saved = readSaved();
  const hash = hashLink();
  // The saved plan the draft was being edited as, if it still exists.
  const open = saved.find((s) => s.id === readCurrent()) ?? null;
  const current = open?.id ?? null;
  const alone = newHistory(draft, current);
  if (hash === null)
    return {
      history: alone,
      saved,
      status: null as string | null,
      keepDraft: false,
    };
  const link = parseLink(hash);
  if (!link.ok)
    return {
      history: alone,
      saved,
      status: "Link not read. Copy it again.",
      keepDraft: false,
    };
  const plan = fix(link.plan);
  // An unchanged save is already kept; anything else becomes a Draft.
  const keepDraft =
    draft.allocated.length > 0 &&
    !sameNodes(draft, plan) &&
    !(open && samePlan(fix(open.plan), draft));
  return {
    // An opened link is a new plan; Undo goes back to the draft and its save.
    history: newHistory(
      plan,
      null,
      draft.allocated.length ? [{ plan: draft, current, session: 0 }] : [],
    ),
    saved: keepDraft
      ? [
          ...saved,
          {
            id: newId(),
            name: `Draft ${stamp()}`,
            plan: draft,
            at: new Date().toISOString(),
          },
        ]
      : saved,
    status: `Opened · ${plan.allocated.length} points`,
    keepDraft,
  };
}

export function App({ data }: { data: AtlasData }) {
  const graph = useMemo(() => buildGraph(data), [data]);
  const colours = useMemo(() => mechanicColours(data), [data]);
  const letters = useMemo(() => mechanicLetters(data.mechanics), [data]);
  const fix = useCallback(
    (plan: unknown) =>
      normalise(graph, data, plan as Partial<Plan> | null | undefined),
    [graph, data],
  );

  const [initial] = useState(() => start(fix));
  const [history, dispatch] = useReducer(historyReducer, initial.history);
  const plan = history.plan;
  const apply = useCallback(
    (next: Plan) => dispatch({ type: "apply", plan: next }),
    [],
  );

  const [status, setStatus] = useState<string | null>(initial.status);
  const statusTimer = useRef<number | undefined>(undefined);
  const say = useCallback((text: string) => {
    setStatus(text);
    window.clearTimeout(statusTimer.current);
    statusTimer.current = window.setTimeout(() => setStatus(null), 3000);
  }, []);
  useEffect(() => {
    if (initial.status) say(initial.status);
    if (hashLink() !== null) clearHash();
    if (initial.keepDraft) writeSaved(initial.saved);
  }, []);

  // The draft, kept on every change; one warning if storage refuses it.
  const draftWarned = useRef(false);
  useEffect(() => {
    if (!writeDraft(plan) && !draftWarned.current) {
      draftWarned.current = true;
      say("Draft not kept. Allow site storage.");
    }
  }, [plan, say]);

  // A share link pasted into the address bar of the open page.
  const [saved, setSaved] = useState<SavedPlan[]>(initial.saved);
  const storeSaved = useCallback((list: SavedPlan[]) => {
    setSaved(list);
    return writeSaved(list);
  }, []);

  // The saved plan being edited (null for a new plan): part of each undo step, and kept
  // across reloads.
  const currentId = history.current;
  const setCurrentId = useCallback(
    (id: string | null) => dispatch({ type: "current", current: id }),
    [],
  );
  const current = saved.find((s) => s.id === currentId) ?? null;
  useEffect(() => {
    writeCurrent(current?.id ?? null);
  }, [current]);
  const savedVersion = useMemo(
    () => (current ? fix(current.plan) : null),
    [current, fix],
  );
  /** Saves the plan: over the one being edited, or (with a name) as a new save. Nothing
   *  changes on screen unless storage takes it. */
  const savePlan = (name: string | null) => {
    const at = new Date().toISOString();
    const id = name === null && current ? current.id : newId();
    const list =
      id === current?.id
        ? saved.map((s) => (s.id === id ? { ...s, plan, at } : s))
        : [...saved, { id, name: name ?? "", plan, at }];
    if (!writeSaved(list)) {
      say("Not saved. Free or allow storage.");
      return false;
    }
    setSaved(list);
    setCurrentId(id);
    say("Saved");
    return true;
  };
  const openPlan = useRef<(next: Plan) => void>(() => {});
  useEffect(() => {
    const onHash = () => {
      const hash = hashLink();
      if (hash === null) return;
      clearHash();
      const link = parseLink(hash);
      if (link.ok) openPlan.current(fix(link.plan));
      else say("Link not read. Copy it again.");
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [fix, say]);

  const allocated = useMemo(() => new Set(plan.allocated), [plan]);
  const used = plan.allocated.length;
  // The budget being typed applies at once; it becomes an undo step on Enter or leaving.
  const [typedBudget, setTypedBudget] = useState<number | null>(null);
  const budget = typedBudget ?? plan.budget;
  // A budget being typed counts, so Save lights up before leaving the box.
  const dirty =
    savedVersion !== null && !samePlan(savedVersion, { ...plan, budget });
  const unset = useMemo(
    () =>
      new Set(
        plan.allocated.filter(
          (id) => data.nodes[id]?.choices && plan.choices[id] === undefined,
        ),
      ),
    [plan, data],
  );

  // Pointer, previews and highlights.
  const [hover, setHover] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const focus = hover?.id ?? selected;
  const preview = useMemo(() => {
    if (focus === null || focus === data.start) return null;
    if (allocated.has(focus))
      return {
        kind: "refund" as const,
        nodes: refundSet(graph, allocated, focus),
      };
    const path = route(graph, allocated, focus);
    return path === null
      ? null
      : { kind: "route" as const, nodes: new Set(path) };
  }, [focus, allocated, graph, data.start]);
  const cost = preview?.kind === "route" ? preview.nodes.size : 0;
  const over = preview?.kind === "route" && !fits(used, cost, budget);

  const twins = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of data.edges)
      if (e.hidden) {
        map.set(e.a, e.b);
        map.set(e.b, e.a);
      }
    return map;
  }, [data]);

  const [query, setQuery] = useState("");
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return Object.entries(data.nodes)
      .filter(([id, node]) => {
        if (id === data.start) return false;
        const text = [
          node.name,
          ...node.stats,
          ...(node.choices?.flatMap((c) => c.stats) ?? []),
        ]
          .join(" ")
          .toLowerCase();
        return text.includes(q);
      })
      .map(([id]) => id)
      .sort(
        (a, b) =>
          data.nodes[a].name.localeCompare(data.nodes[b].name) || byId(a, b),
      );
  }, [query, data]);
  const matchSet = useMemo(() => new Set(matches), [matches]);
  const [pinned, setPinned] = useState<number | null>(null);
  const [previewMechanic, setPreviewMechanic] = useState<number | null>(null);
  const [lit, setLit] = useState<{ key: string; nodes: Set<string> } | null>(
    null,
  );

  const none = useMemo(() => new Set<string>(), []);
  const gatewayPair = useMemo(
    () =>
      focus && twins.has(focus) ? new Set([focus, twins.get(focus)!]) : none,
    [focus, twins, none],
  );
  const marks: TreeMarks = useMemo(
    () => ({
      allocated,
      route: preview?.kind === "route" ? preview.nodes : none,
      refund: preview?.kind === "refund" ? preview.nodes : none,
      matches: matchSet,
      lit: lit?.nodes ?? none,
      mechanic: previewMechanic ?? pinned,
      pinned,
      gatewayPair,
      unset,
      overBudget: over,
    }),
    [
      allocated,
      preview,
      matchSet,
      lit,
      previewMechanic,
      pinned,
      gatewayPair,
      unset,
      over,
      none,
    ],
  );

  // Allocate and refund.
  const [choiceFor, setChoiceFor] = useState<string | null>(null);
  const allocate = useCallback(
    (id: string, effect?: number) => {
      const path = route(graph, allocated, id);
      if (path === null) return;
      if (!fits(used, path.length, budget)) {
        say(`Over budget by ${used + path.length - budget}`);
        return;
      }
      apply(
        fix({
          ...plan,
          budget,
          allocated: [...plan.allocated, ...path],
          choices:
            effect === undefined
              ? plan.choices
              : { ...plan.choices, [id]: effect },
        }),
      );
    },
    [graph, allocated, used, plan, budget, apply, fix, say],
  );
  const refund = useCallback(
    (id: string) => {
      const gone = refundSet(graph, allocated, id);
      const choices = { ...plan.choices };
      for (const g of gone) delete choices[g];
      apply(
        fix({
          ...plan,
          allocated: plan.allocated.filter((a) => !gone.has(a)),
          choices,
        }),
      );
    },
    [graph, allocated, plan, apply, fix],
  );
  const act = useCallback(
    (id: string) => {
      const node = data.nodes[id];
      if (!node) return;
      if (node.choices) setChoiceFor(id);
      else if (allocated.has(id)) refund(id);
      else allocate(id);
    },
    [data, allocated, refund, allocate],
  );
  const onNode = useCallback(
    (id: string, touch: boolean) => {
      if (touch) setSelected((s) => (s === id ? null : id));
      else act(id);
    },
    [act],
  );
  const clear = useCallback(() => {
    if (plan.allocated.length) apply({ ...plan, allocated: [], choices: {} });
  }, [plan, apply]);
  // Only the hovered node's id matters to the tree: the tooltip keeps where it appeared,
  // so moving within a node doesn't redraw the whole tree.
  const onHover = useCallback((id: string | null, x: number, y: number) => {
    setHover((h) => (h?.id === id ? h : id ? { id, x, y } : null));
  }, []);
  const onLabel = useCallback(
    (m: number) => setPinned((p) => (p === m ? null : m)),
    [],
  );

  // View.
  const tree = useRef<TreeHandle>(null);
  const [tab, setTab] = useState<Tab>("explore");
  const [panelOpen, setPanelOpen] = useState(false);
  /** A search result: centred, and its card open (the keyboard way to allocate). */
  const locate = (id: string) => {
    tree.current?.locate(id);
    setPanelOpen(false);
    setSelected(id);
  };

  // Links and saved plans.
  const [shareLinks, setShareLinks] = useState<{
    ours: string;
    official: string;
  } | null>(null);
  const [openLink, setOpenLink] = useState(false);
  const [deleting, setDeleting] = useState<SavedPlan | null>(null);
  /** The start node was clicked with nodes allocated: Clear asks first. */
  const [confirmClear, setConfirmClear] = useState(false);
  const undo = () => dispatch({ type: "undo" });
  const redo = () => dispatch({ type: "redo" });
  const canUndo = history.past.length > 0;
  const canRedo = history.future.length > 0;
  const share = () =>
    setShareLinks({
      ours: `${location.origin}${location.pathname}#${encodeShare(plan, data.version)}`,
      official: encodeOfficial(plan.allocated),
    });
  const askClear = useCallback(() => {
    if (plan.allocated.length) setConfirmClear(true);
  }, [plan]);

  // The toolbar keeps one row: narrower, Undo and Redo become icons and Clear, Share and
  // Open move to More; narrower still (phones), Undo and Redo move to More too.
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [toolbarWidth, setToolbarWidth] = useState(Infinity);
  useLayoutEffect(() => {
    const bar = toolbarRef.current;
    if (!bar) return;
    const measure = () => setToolbarWidth(bar.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);
  const toolbar =
    toolbarWidth >= TOOLBAR_FULL
      ? "full"
      : toolbarWidth >= TOOLBAR_ICONS
        ? "icons"
        : "phone";
  openPlan.current = (next: Plan) => {
    // The plan is kept as a Draft unless it's already an unchanged save.
    if (
      plan.allocated.length > 0 &&
      !sameNodes(plan, next) &&
      !(current && !dirty)
    )
      storeSaved([
        ...saved,
        {
          id: newId(),
          name: `Draft ${stamp()}`,
          plan,
          at: new Date().toISOString(),
        },
      ]);
    dispatch({ type: "apply", plan: next, current: null });
    tree.current?.focus(next.allocated);
    say(`Opened · ${next.allocated.length} points`);
  };
  const openText = (text: string) => {
    const link = parseLink(text);
    if (!link.ok) return false;
    openPlan.current(fix(link.plan));
    return true;
  };
  const importText = async (file: File) => {
    if (file.size > IMPORT_MAX_BYTES) {
      say("File too large. Pick an Export file.");
      return;
    }
    let plans: ReturnType<typeof importFile>;
    try {
      plans = importFile(await file.text());
    } catch {
      plans = null;
    }
    if (plans === null) {
      say("Not a plans file. Pick an Export file.");
      return;
    }
    const at = new Date().toISOString();
    const ok = storeSaved([
      ...saved,
      ...plans.map((p) => ({
        id: newId(),
        name: p.name,
        plan: fix(p.plan),
        at,
      })),
    ]);
    say(ok ? `Imported ${plans.length}` : "Not saved. Free or allow storage.");
  };
  const exportSaved = () => {
    const blob = new Blob([exportFile(saved)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "atlas-plans.json";
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  };

  // Keyboard: Ctrl+Z / Ctrl+Y (and Ctrl+Shift+Z) outside text boxes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        !(e.ctrlKey || e.metaKey) ||
        (e.target as HTMLElement).closest("input, textarea")
      )
        return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) dispatch({ type: "undo" });
      else if (key === "y" || (key === "z" && e.shiftKey))
        dispatch({ type: "redo" });
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const shown =
    focus !== null && focus !== data.start ? data.nodes[focus] : null;
  const choiceNode = choiceFor ? data.nodes[choiceFor] : null;
  const choiceCost =
    choiceFor && !allocated.has(choiceFor)
      ? (route(graph, allocated, choiceFor)?.length ?? 0)
      : 0;

  return (
    <div className={styles.app}>
      <aside
        className={classNames(styles.panel, { [styles.panelOpen]: panelOpen })}
      >
        <div className={styles.brand}>
          <span>Atlas planner</span>
          <span className={styles.version}>{data.version}</span>
          <button
            className={classNames(formStyles.formButton, styles.closePanel)}
            onClick={() => setPanelOpen(false)}
          >
            Close
          </button>
        </div>
        <Panel tab={tab} onTab={setTab}>
          {tab === "explore" && (
            <Explore
              data={data}
              colours={colours}
              letters={letters}
              query={query}
              onQuery={setQuery}
              matches={matches}
              onLocate={locate}
              pinned={pinned}
              onPin={setPinned}
              onPreview={setPreviewMechanic}
            />
          )}
          {tab === "bonuses" && (
            <Bonuses
              data={data}
              plan={plan}
              budget={budget}
              colours={colours}
              letters={letters}
              lit={lit?.key ?? null}
              onLight={(key, nodes) =>
                setLit(key === null ? null : { key, nodes: new Set(nodes) })
              }
              onChoose={(id) => {
                setPanelOpen(false);
                setChoiceFor(id);
              }}
            />
          )}
          {tab === "saved" && (
            <Saved
              saved={saved}
              currentId={current?.id ?? null}
              onLoad={(p) => {
                const next = fix(p.plan);
                dispatch({ type: "apply", plan: next, current: p.id });
                tree.current?.focus(next.allocated);
                setPanelOpen(false);
              }}
              onRename={(p, name) =>
                storeSaved(
                  saved.map((s) =>
                    s.id === p.id
                      ? {
                          ...s,
                          name: name.slice(0, 60),
                          at: new Date().toISOString(),
                        }
                      : s,
                  ),
                )
              }
              onDelete={setDeleting}
              onExport={exportSaved}
              onImport={importText}
            />
          )}
        </Panel>
        <p className={styles.credit}>
          Tree data: Grinding Gear Games' official export. Fan-made; not
          affiliated with or endorsed by GGG.
        </p>
      </aside>

      <main className={styles.main}>
        <div className={styles.toolbar} ref={toolbarRef}>
          <button
            className={classNames(formStyles.formButton, styles.panelButton)}
            onClick={() => setPanelOpen(true)}
          >
            Panel
          </button>
          <PlanName
            current={current}
            dirty={dirty}
            empty={used === 0}
            defaultName={nextPlanName(saved)}
            onSave={savePlan}
          />
          <span
            className={classNames(styles.points, {
              [styles.costOver]: used > budget,
            })}
          >
            {used} /
            <BudgetInput
              value={plan.budget}
              onLive={setTypedBudget}
              onCommit={(n) => {
                setTypedBudget(null);
                if (n !== plan.budget) apply(fix({ ...plan, budget: n }));
              }}
            />
          </span>
          {toolbar !== "phone" && (
            <>
              <button
                className={formStyles.formButton}
                onClick={undo}
                disabled={!canUndo}
                aria-label={toolbar === "icons" ? "Undo" : undefined}
                title={toolbar === "icons" ? "Undo" : undefined}
              >
                {toolbar === "icons" ? (
                  <span aria-hidden className={styles.toolIcon}>
                    ↶
                  </span>
                ) : (
                  "Undo"
                )}
              </button>
              <button
                className={formStyles.formButton}
                onClick={redo}
                disabled={!canRedo}
                aria-label={toolbar === "icons" ? "Redo" : undefined}
                title={toolbar === "icons" ? "Redo" : undefined}
              >
                {toolbar === "icons" ? (
                  <span aria-hidden className={styles.toolIcon}>
                    ↷
                  </span>
                ) : (
                  "Redo"
                )}
              </button>
            </>
          )}
          {toolbar === "full" && (
            <button
              className={formStyles.formButton}
              onClick={clear}
              disabled={used === 0}
            >
              Clear
            </button>
          )}
          <span className={styles.spacer} />
          {toolbar === "full" ? (
            <>
              <button
                className={formStyles.formButton}
                onClick={share}
                disabled={used === 0}
              >
                Share
              </button>
              <button
                className={formStyles.formButton}
                onClick={() => setOpenLink(true)}
              >
                Open
              </button>
            </>
          ) : (
            <MoreMenu
              items={
                [
                  ...(toolbar === "phone"
                    ? [
                        { label: "Undo", onClick: undo, disabled: !canUndo },
                        { label: "Redo", onClick: redo, disabled: !canRedo },
                      ]
                    : []),
                  { label: "Clear", onClick: clear, disabled: used === 0 },
                  { label: "Share", onClick: share, disabled: used === 0 },
                  { label: "Open", onClick: () => setOpenLink(true) },
                ] satisfies MenuItem[]
              }
            />
          )}
        </div>

        <div className={styles.treeWrap}>
          {/* Before the tree: Tab reaches zoom before the tree's many stops. */}
          <div className={styles.zoom}>
            <button
              className={formStyles.formButton}
              onClick={() => tree.current?.zoom(1.4)}
              aria-label="Zoom in"
              title="Zoom in"
            >
              +
            </button>
            <button
              className={formStyles.formButton}
              onClick={() => tree.current?.zoom(1 / 1.4)}
              aria-label="Zoom out"
              title="Zoom out"
            >
              −
            </button>
            <button
              className={formStyles.formButton}
              onClick={() => tree.current?.fit()}
            >
              Fit
            </button>
            <button
              className={formStyles.formButton}
              onClick={() => tree.current?.focus(plan.allocated)}
              disabled={used === 0}
            >
              Focus
            </button>
          </div>
          <TreeView
            ref={tree}
            data={data}
            colours={colours}
            letters={letters}
            marks={marks}
            onHover={onHover}
            onNode={onNode}
            onLabel={onLabel}
            onLabelHover={setPreviewMechanic}
            onStart={askClear}
          />
          {/* Over the tree, so a message never changes the toolbar's height. */}
          <div
            className={classNames(styles.status, styles.toast, {
              [styles.toastOn]: status !== null,
            })}
            role="status"
          >
            {status ?? ""}
          </div>
          {hover && shown && (
            <NodeTip
              data={data}
              plan={plan}
              id={hover.id}
              x={hover.x}
              y={hover.y}
              allocated={allocated.has(hover.id)}
              change={preview?.nodes.size ?? 0}
              over={over}
            />
          )}
          {!hover && selected && shown && (
            <NodeCard
              data={data}
              plan={plan}
              id={selected}
              allocated={allocated.has(selected)}
              change={preview?.nodes.size ?? 0}
              over={over}
              onAct={() => {
                act(selected);
                setSelected(null);
              }}
              onClose={() => setSelected(null)}
            />
          )}
        </div>
      </main>

      <ChoiceDialog
        key={choiceFor ?? ""}
        node={choiceNode}
        picked={choiceFor ? (plan.choices[choiceFor] ?? null) : null}
        allocated={choiceFor !== null && allocated.has(choiceFor)}
        cost={choiceCost}
        over={!fits(used, choiceCost, budget)}
        onPick={(effect) => {
          if (!choiceFor) return;
          if (allocated.has(choiceFor))
            apply(
              fix({
                ...plan,
                choices: { ...plan.choices, [choiceFor]: effect },
              }),
            );
          else allocate(choiceFor, effect);
          setChoiceFor(null);
        }}
        onRefund={() => {
          if (choiceFor) refund(choiceFor);
          setChoiceFor(null);
        }}
        onClose={() => setChoiceFor(null)}
      />
      <ShareDialog links={shareLinks} onClose={() => setShareLinks(null)} />
      <OpenDialog
        isOpen={openLink}
        onOpen={openText}
        onClose={() => setOpenLink(false)}
      />
      <ConfirmDialog
        title={confirmClear ? "Clear tree?" : null}
        action="Clear"
        onConfirm={() => {
          clear();
          setConfirmClear(false);
        }}
        onClose={() => setConfirmClear(false)}
      />
      <ConfirmDialog
        title={deleting ? `Delete ${deleting.name}?` : null}
        action="Delete"
        onConfirm={() => {
          if (deleting) {
            storeSaved(saved.filter((s) => s.id !== deleting.id));
            if (deleting.id === currentId) setCurrentId(null);
          }
          setDeleting(null);
        }}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}

/** A typed budget, clamped to 1–150; null while the box holds no number. */
function budgetFrom(typed: string): number | null {
  const n = Math.round(Number(typed));
  return typed.trim() !== "" && Number.isFinite(n)
    ? Math.min(MAX_BUDGET, Math.max(1, n))
    : null;
}

/**
 * The point budget: applies as it's typed (onLive), and becomes one undo step on Enter or
 * leaving the box (onCommit). Escape puts the plan's budget back.
 */
function BudgetInput({
  value,
  onLive,
  onCommit,
}: {
  value: number;
  onLive: (n: number | null) => void;
  onCommit: (n: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  // Reads the box itself: a blur straight after typing can come before the re-render.
  const commit = (typed: string) => {
    const next = budgetFrom(typed) ?? value;
    onCommit(next);
    setText(String(next));
  };
  return (
    <input
      type="number"
      min={1}
      max={MAX_BUDGET}
      className={classNames(formStyles.formInput, styles.budget)}
      aria-label="Budget"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onLive(budgetFrom(e.target.value));
      }}
      onBlur={(e) => commit(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit(e.currentTarget.value);
        else if (e.key === "Escape") {
          setText(String(value));
          onLive(null);
        }
      }}
    />
  );
}

interface TipProps {
  data: AtlasData;
  plan: Plan;
  id: string;
  allocated: boolean;
  change: number;
  over: boolean;
}

function TipBody({ data, plan, id, allocated, change, over }: TipProps) {
  const node = data.nodes[id];
  const stats = nodeStats(data, plan, id);
  const m = mechanicOf(node);
  return (
    <>
      <div className={styles.tipHead}>
        <span className={styles.tipName}>{node.name}</span>
        <span
          className={classNames(styles.cost, {
            [styles.costOver]: !allocated && over,
            [styles.costRefund]: allocated,
          })}
        >
          {allocated ? `−${change}` : `+${change}`}
        </span>
      </div>
      <div className={styles.tipKind}>
        {KIND[node.kind]}
        {m >= 0
          ? ` · ${data.mechanics[m]}`
          : node.kind === "small"
            ? " · Travel"
            : ""}
        {node.gateway ? " · Gateway" : ""}
      </div>
      {node.choices && !stats.length && (
        <>
          <div className={styles.tipNote}>
            {allocated ? "Unset · " : ""}Pick 1 of {node.choices.length}
          </div>
          {node.choices.map((option) => (
            <div key={option.effect} className={styles.tipOption}>
              {option.stats.map((line, i) => (
                <div key={i} className={styles.tipStat}>
                  {flat(line)}
                </div>
              ))}
            </div>
          ))}
        </>
      )}
      {stats.map((line, i) => (
        <div key={i} className={styles.tipStat}>
          {flat(line)}
        </div>
      ))}
      {node.reminder?.map((line, i) => (
        <div key={i} className={styles.tipNote}>
          {flat(line)}
        </div>
      ))}
      {!allocated && over && <div className={styles.costOver}>Over budget</div>}
    </>
  );
}

/** Beside the pointer, kept inside the window. */
function NodeTip(props: TipProps & { x: number; y: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: props.x + 16, top: props.y + 16 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const right = props.x + 16;
    const below = props.y + 16;
    const left = right + w > innerWidth ? props.x - w - 12 : right;
    const top = below + h > innerHeight ? props.y - h - 12 : below;
    const next = {
      left: Math.min(Math.max(4, left), Math.max(4, innerWidth - w - 4)),
      top: Math.min(Math.max(4, top), Math.max(4, innerHeight - h - 4)),
    };
    if (next.left !== pos.left || next.top !== pos.top) setPos(next);
  });
  return (
    <div ref={ref} className={styles.tip} style={pos} role="tooltip">
      <TipBody {...props} />
    </div>
  );
}

/** A tapped or searched node: its details and the one action, for touch and keyboard. */
function NodeCard(
  props: TipProps & { onAct: () => void; onClose: () => void },
) {
  const { data, id, allocated, over, onAct, onClose } = props;
  const action = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    action.current?.focus();
  }, [id]);
  const choice = data.nodes[id].choices !== undefined;
  return (
    <div
      className={styles.card}
      role="dialog"
      aria-label={data.nodes[id].name}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <TipBody {...props} />
      <div className={formStyles.groupRight}>
        <button className={formStyles.formButton} onClick={onClose}>
          Close
        </button>
        <button
          ref={action}
          className={formStyles.formButton}
          disabled={!allocated && over && !choice}
          onClick={onAct}
        >
          {choice ? "Choose" : allocated ? "Refund" : "Allocate"}
        </button>
      </div>
    </div>
  );
}
