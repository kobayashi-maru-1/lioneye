// The in-game bar, shown by exile-leveling.exe over the game in a WebView2 window
// (log-api/src/overlay.rs). Buttons tell the exe, which tells the guide page to jump to that
// panel. The exe sends the buttons ("overlay:" messages) from the guide's Settings, and the
// guide's tooltips ("tips:"): the Gems panel's set and Campaign's next steps.
import "./styles.css";

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
/** The guide's tooltips by button: "gems" (OverlayGems | null), "campaign" (Step[]). */
let tips: Record<string, unknown> = {};
/** The button whose tooltip is open. */
let openId: string | null = null;
/** The tooltip opens above the bar (bar in the lower half of the screen). */
let up = false;

/** Buttons with a tooltip: Gems (the Gems panel's links), Campaign (the next steps). */
const TIPS: Record<string, () => void> = {
  gems: renderGems,
  campaign: renderCampaign,
};

function render(config: OverlayConfig) {
  const key = JSON.stringify(config.buttons);
  if (key === shown) return;
  shown = key;
  buttons.replaceChildren(
    ...config.buttons.map(({ id, label }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "button";
      button.textContent = label;
      button.addEventListener("click", () => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(`jump:${id}`);
      });
      // Hovering Gems or Campaign shows what they'd jump to, without leaving the game.
      button.addEventListener("mouseenter", () =>
        TIPS[id] ? openTip(id) : closeTip(),
      );
      return button;
    }),
  );
}

/** Builds an element with a class and children. */
function el(tag: string, className: string, ...children: (Node | string)[]) {
  const element = document.createElement(tag);
  element.className = className;
  element.append(...children);
  return element;
}

function renderTip() {
  if (openId === null) return;
  try {
    TIPS[openId]?.();
  } catch {
    // A malformed message: say so rather than never opening.
    tip.replaceChildren(el("div", "tipEmpty", "Not available"));
  }
}

function renderCampaign() {
  const steps = tips.campaign as Step[] | undefined;
  if (!Array.isArray(steps) || steps.length === 0) {
    tip.replaceChildren(el("div", "tipEmpty", "No steps"));
    return;
  }
  tip.replaceChildren(
    el("div", "tipTitle", "Next"),
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

function openTip(id: string) {
  openId = id;
  // Already open (back on the button from the tooltip, or another button with one): the
  // window holds the tooltip too, so working out the side again would move the bar.
  if (!tip.hidden) {
    renderTip();
    return;
  }
  // Above the bar when it sits in the lower half of its screen, so it stays on screen.
  const screenTop = (screen as Screen & { availTop?: number }).availTop ?? 0;
  const barMiddle =
    window.screenY + bar.getBoundingClientRect().top + bar.offsetHeight / 2;
  up = barMiddle > screenTop + screen.availHeight / 2;
  frame.classList.toggle("up", up);
  renderTip();
  tip.hidden = false;
}

function closeTip() {
  tip.hidden = true;
  openId = null;
}

frame.addEventListener("mouseleave", closeTip);
grip.addEventListener("mouseenter", closeTip);
dot.addEventListener("mouseenter", closeTip);

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
