// The in-game bar, shown by lioneye.exe over the game in a WebView2 window
// (log-api/src/overlay.rs). Buttons tell the exe, which tells the guide page to jump to that
// panel. The exe sends the buttons ("overlay:" messages) from the guide's Settings, and the
// guide's tooltips ("tips:"): the Gems panel's set, Campaign's next steps and the Tree's
// next points.
import { TREE_DATA_LOOKUP } from "../state/tree";
import type { TreeTip } from "../state/tree/next-points";
import "./styles.css";
import type { SkillTree } from "common";

interface OverlayButton {
  id: string;
  label: string;
}

interface OverlayConfig {
  on: boolean;
  buttons: OverlayButton[];
}

/** WebView2's channel to the exe (wry): moving and sizing the window. */
declare global {
  interface Window {
    ipc?: { postMessage(message: string): void };
  }
}

const SOCKET_URL = `ws://${location.host}/ws`;

/** The Gems panel's set, from the guide (web/src/state/overlay.ts OverlayGems). */
interface OverlayGems {
  title: string;
  groups: {
    label?: string;
    gems: {
      name: string;
      colour: string;
      primary: boolean;
      level?: number;
      quality?: number;
    }[];
  }[];
}

const frame = document.getElementById("frame")!;
const bar = document.getElementById("bar")!;
const grip = document.getElementById("grip")!;
const buttons = document.getElementById("buttons")!;
const dot = document.getElementById("dot")!;
const tip = document.getElementById("tip")!;

/** A route step as text pieces, from the guide (web/src/state/step-text.ts StepPart). */
type Step = { text: string; kind?: string }[];

let socket: WebSocket | null = null;
let shown = "";
/** The ids of the bar's buttons. */
let barIds = new Set<string>();
/** The guide's tooltips by button: "gems" (OverlayGems | null), "campaign" (Step[]), "tree" (TreeTip). */
let tips: Record<string, unknown> = {};
/** Whether the first tooltips have arrived (a pinned one opens then). */
let tipsArrived = false;
/** The button whose tooltip is open. */
let openId: string | null = null;
/** The tooltip the pointer (or the pin) asks for last: a side flip reopens only that. */
let wanted: string | null = null;
/** The tooltip opens above the bar (bar in the lower half of the screen). */
let up = false;

/** Buttons with a tooltip: Gems (the Gems panel's links), Campaign (the next steps), Tree. */
const TIPS: Record<string, () => void> = {
  gems: renderGems,
  campaign: renderCampaign,
  tree: renderTree,
};

/** Tooltips that can be pinned open; one at a time, kept across restarts. */
const PINNABLE = new Set(["campaign", "tree"]);
const PIN_KEY = "overlay-pin";
let pinned: string | null = readPin();

function readPin() {
  try {
    const id = localStorage.getItem(PIN_KEY);
    return id !== null && PINNABLE.has(id) ? id : null;
  } catch {
    return null;
  }
}

function setPin(id: string | null) {
  pinned = id;
  try {
    if (id === null) localStorage.removeItem(PIN_KEY);
    else localStorage.setItem(PIN_KEY, id);
  } catch {
    // Not kept: pinned until the bar reloads.
  }
  renderTip();
}

/** The pinned tooltip, while its button is on the bar. */
function pinnedShown() {
  return pinned !== null && barIds.has(pinned) ? pinned : null;
}

function render(config: OverlayConfig) {
  const key = JSON.stringify(config.buttons);
  if (key === shown) return;
  shown = key;
  barIds = new Set(config.buttons.map((button) => button.id));
  buttons.replaceChildren(
    ...config.buttons.map(({ id, label }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "button";
      button.textContent = label;
      button.addEventListener("click", () => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(`jump:${id}`);
      });
      // Hovering Gems, Campaign or Tree shows what they'd jump to, without leaving the game.
      button.addEventListener("mouseenter", () =>
        TIPS[id] ? openTip(id) : rest(),
      );
      return button;
    }),
  );
  // Open the pinned tooltip, or close one whose button left; a hovered one stays.
  if (tip.hidden || (openId !== null && !barIds.has(openId))) rest();
}

/** Builds an element with a class and children. */
function el(tag: string, className: string, ...children: (Node | string)[]) {
  const element = document.createElement(tag);
  element.className = className;
  element.append(...children);
  return element;
}

const PIN_ICON =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M10.5 1.5l4 4-1.5.5-2.5 2.5.5 3-1.5 1.5-2.5-2.5-4 4-.5-.5 4-4-2.5-2.5L5 6l3 .5L10.5 4z" fill="currentColor"/></svg>';

/** A tooltip's title, with the pin for Campaign and Tree. */
function head(title: string) {
  const id = openId;
  if (id === null || !PINNABLE.has(id)) return el("div", "tipTitle", title);
  const on = pinned === id;
  const pin = document.createElement("button");
  pin.type = "button";
  pin.className = on ? "pin on" : "pin";
  pin.innerHTML = PIN_ICON;
  pin.title = on ? "Unpin" : "Pin";
  pin.setAttribute("aria-label", pin.title);
  pin.setAttribute("aria-pressed", String(on));
  pin.addEventListener("click", () => setPin(on ? null : id));
  return el("div", "tipHead", el("div", "tipTitle", title), pin);
}

function renderTip() {
  if (openId === null) return;
  try {
    TIPS[openId]?.();
  } catch {
    // A malformed message: say so rather than never opening.
    tip.replaceChildren(head(""), el("div", "tipEmpty", "Not available"));
  }
}

function renderCampaign() {
  const steps = tips.campaign as Step[] | undefined;
  if (!Array.isArray(steps) || steps.length === 0) {
    tip.replaceChildren(head("Next"), el("div", "tipEmpty", "No steps"));
    return;
  }
  tip.replaceChildren(
    head("Next"),
    ...steps.map((step) =>
      el(
        "div",
        "tipStep",
        ...step.map((part) =>
          el("span", part.kind ? `part ${part.kind}` : "part", part.text),
        ),
      ),
    ),
  );
}

function renderGems() {
  const gems = (tips.gems ?? null) as OverlayGems | null;
  if (
    gems === null ||
    !Array.isArray(gems.groups) ||
    gems.groups.length === 0
  ) {
    tip.replaceChildren(el("div", "tipEmpty", "No gems"));
    return;
  }
  tip.replaceChildren(
    el("div", "tipTitle", gems.title),
    ...gems.groups.map((group) =>
      el(
        "div",
        "tipGroup",
        ...(group.label ? [el("div", "tipLabel", group.label)] : []),
        ...group.gems.map((gem) => {
          const swatch = el("span", "tipDot");
          swatch.style.backgroundColor = gem.colour;
          return el(
            "div",
            gem.primary ? "tipGem" : "tipGem support",
            swatch,
            el("span", "tipName", gem.name),
            ...(gem.level !== undefined
              ? [el("span", "tipLevel", `${gem.level}/${gem.quality ?? 0}`)]
              : []),
          );
        }),
      ),
    ),
  );
}

const TREE_TITLE = "Next points";

/** The whole tree, drawn once per tree version and zoomed to each tooltip's area. */
interface TreeView {
  version: string;
  skillTree: SkillTree.Data;
  compiled: (context: object) => string;
  box: HTMLElement;
  css: HTMLStyleElement;
}
let treeView: TreeView | null = null;
/** Only the latest tree render may finish (the data loads asynchronously). */
let treeRender = 0;

function renderTree() {
  const data = tips.tree as TreeTip | undefined;
  const lookup =
    data && Array.isArray(data.next)
      ? TREE_DATA_LOOKUP[data.version]
      : undefined;
  const token = ++treeRender;
  if (!data || !lookup) {
    tip.replaceChildren(head(TREE_TITLE), el("div", "tipEmpty", "No tree"));
    return;
  }
  if (data.next.length === 0) {
    tip.replaceChildren(head(TREE_TITLE), el("div", "tipEmpty", "Tree done"));
    return;
  }
  if (treeView?.version === data.version) {
    drawTree(treeView, data);
    return;
  }
  tip.replaceChildren(head(TREE_TITLE), el("div", "tipEmpty", "Loading"));
  lookup.then(
    ([skillTree, , svg, , compiled]) => {
      if (token !== treeRender || openId !== "tree") return;
      const box = el("div", "tipTree");
      box.id = "tree-tip";
      box.innerHTML = svg;
      const picture = box.querySelector("svg");
      picture?.setAttribute("width", "100%");
      picture?.setAttribute("height", "100%");
      picture?.setAttribute("preserveAspectRatio", "xMidYMid meet");
      const css = document.createElement("style");
      treeView = { version: data.version, skillTree, compiled, box, css };
      try {
        drawTree(treeView, data);
      } catch {
        // A malformed tip: renderTip's catch can't see this one.
        tip.replaceChildren(
          head(TREE_TITLE),
          el("div", "tipEmpty", "Not available"),
        );
      }
    },
    () => {
      if (token === treeRender && openId === "tree")
        tip.replaceChildren(
          head(TREE_TITLE),
          el("div", "tipEmpty", "Not available"),
        );
    },
  );
}

/** What the tree was last drawn for: redrawing it restyles about 6,000 elements. */
let drawnTree = "";

function drawTree(view: TreeView, data: TreeTip) {
  const key = JSON.stringify(data);
  if (key === drawnTree && view.box.parentNode === tip) {
    // Same picture: only the title (the pin) may have changed.
    tip.firstChild?.replaceWith(head(TREE_TITLE));
    return;
  }
  drawnTree = key;
  view.css.textContent = treeStyle(data, view.skillTree, view.compiled);
  const { x, y, w, h } = data.view;
  view.box.querySelector("svg")?.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
  tip.replaceChildren(head(TREE_TITLE), view.css, view.box);
}

/**
 * The Tree panel's colours: yours blue, the next points bright green, the guide's later
 * points dim green (in the "removed" slot, which this tooltip has no use for).
 */
function treeStyle(
  data: TreeTip,
  skillTree: SkillTree.Data,
  compiled: (context: object) => string,
) {
  const have = new Set(data.have);
  const next = new Set(data.next);
  const later = new Set(data.later);
  const active: string[] = [];
  const added: string[] = [];
  const dim: string[] = [];
  for (const { a, b } of skillTree.graphs[skillTree.graphIndex].connections) {
    const id = `${a}-${b}`;
    if (have.has(a) && have.has(b)) active.push(id);
    else if (
      (next.has(a) && (next.has(b) || have.has(b))) ||
      (next.has(b) && have.has(a))
    )
      added.push(id);
    else if (
      (later.has(a) && (later.has(b) || next.has(b))) ||
      (later.has(b) && next.has(a))
    )
      dim.push(id);
  }
  return compiled({
    styleId: "tree-tip",
    backgroundColor: "#11161f",
    ascendancy: data.ascendancy,
    nodeColor: "hsl(215, 15%, 50%)",
    nodeActiveColor: "hsl(200, 80%, 50%)",
    nodeAddedColor: "hsl(120, 90%, 50%)",
    nodeRemovedColor: "hsl(120, 45%, 32%)",
    connectionColor: "hsl(215, 15%, 40%)",
    connectionActiveColor: "hsl(200, 80%, 40%)",
    connectionAddedColor: "hsl(120, 90%, 40%)",
    connectionRemovedColor: "hsl(120, 45%, 26%)",
    nodesActive: data.have,
    nodesAdded: data.next,
    nodesRemoved: data.later,
    connectionsActive: active,
    connectionsAdded: added,
    connectionsRemoved: dim,
  });
}

/** Which side the tooltip goes: above the bar when it sits in the lower half of its screen. */
function sideUp() {
  const screenTop = (screen as Screen & { availTop?: number }).availTop ?? 0;
  const barMiddle =
    window.screenY + bar.getBoundingClientRect().top + bar.offsetHeight / 2;
  return barMiddle > screenTop + screen.availHeight / 2;
}

function openTip(id: string) {
  wanted = id;
  // Already open (back on the button from the tooltip, or another button with one): only
  // re-render, unless the bar was dragged to the other half of the screen since. Then
  // shrink to the bar first, so the window grows from the bar's new side.
  if (!tip.hidden && sideUp() !== up) {
    closeTip();
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (tip.hidden && wanted === id) openTip(id);
      }),
    );
    return;
  }
  if (!tip.hidden && openId === id) return; // Already showing it.
  openId = id;
  if (!tip.hidden) {
    renderTip();
    return;
  }
  up = sideUp();
  frame.classList.toggle("up", up);
  renderTip();
  tip.hidden = false;
}

function closeTip() {
  tip.hidden = true;
  openId = null;
}

/** Nothing hovered: back to the pinned tooltip, else closed. */
function rest() {
  const id = pinnedShown();
  wanted = id;
  if (id === null) closeTip();
  else openTip(id);
}

frame.addEventListener("mouseleave", rest);
grip.addEventListener("mouseenter", rest);
dot.addEventListener("mouseenter", rest);

const STATES = {
  offline: "Offline",
  waiting: "Waiting",
  watching: "Auto",
} as const;

function setState(state: keyof typeof STATES) {
  dot.className = `dot ${state}`;
  dot.setAttribute("aria-label", STATES[state]);
  dot.title = STATES[state];
}

function connect() {
  const ws = new WebSocket(SOCKET_URL);
  socket = ws;
  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    if (event.data.startsWith("status:")) {
      const status = event.data.slice("status:".length).split("|")[0];
      setState(status === "watching" ? "watching" : "waiting");
    } else if (event.data.startsWith("overlay:")) {
      try {
        render(
          JSON.parse(event.data.slice("overlay:".length)) as OverlayConfig,
        );
      } catch {
        // A malformed message: keep the current buttons.
      }
    } else if (event.data.startsWith("tips:")) {
      try {
        const all = JSON.parse(event.data.slice("tips:".length)) as unknown;
        tips =
          all !== null && typeof all === "object"
            ? (all as Record<string, unknown>)
            : {};
      } catch {
        tips = {};
      }
      if (!tip.hidden) renderTip();
      else if (!tipsArrived) rest();
      tipsArrived = true;
    }
    // Log lines and jumps are for the guide page.
  });
  ws.addEventListener("close", () => {
    setState("offline");
    setTimeout(connect, 1000);
  });
}

// The grip drags the window (Windows' own move, as a title bar would).
grip.addEventListener("pointerdown", (event) => {
  if (event.button === 0) window.ipc?.postMessage("drag");
});

// The window fits the bar and the tooltip; with the tooltip above, it grows upwards.
new ResizeObserver(() => {
  const { width, height } = frame.getBoundingClientRect();
  window.ipc?.postMessage(
    `size:${Math.ceil(width)},${Math.ceil(height)}${up ? ",up" : ""}`,
  );
}).observe(frame);

document.addEventListener("contextmenu", (event) => event.preventDefault());

setState("offline");
connect();
