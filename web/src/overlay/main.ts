// The in-game bar, shown by lioneye.exe over the game in a WebView2 window
// (log-api/src/overlay.rs). Buttons tell the exe, which tells the guide page to jump to that
// panel. The exe sends the buttons ("overlay:" messages) from the guide's Settings, and the
// guide's tooltips ("tips:"): the Gems panel's set, Campaign's next steps, the Tree's
// next points, the Gear panel's items, Build health's findings and the build's notes.
import type { OverlayGear } from "../state/overlay";
import { notesLines, pobSpans } from "../state/pob/colour";
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
    slot?: string;
    gems: {
      name: string;
      colour: string;
      primary: boolean;
      level?: number;
      quality?: number;
    }[];
  }[];
  /** A vendor or stash search for the gems still to get. */
  search?: { text: string; count: number; total: number };
}

const frame = document.getElementById("frame")!;
const bar = document.getElementById("bar")!;
const grip = document.getElementById("grip")!;
const buttons = document.getElementById("buttons")!;
const dot = document.getElementById("dot")!;
const tip = document.getElementById("tip")!;

/**
 * A route step from the guide (web/src/state/overlay.ts OverlayStep): its text pieces
 * (state/step-text.ts StepPart), and what its checkbox ticks.
 */
type Step = { parts: { text: string; kind?: string }[]; tick?: string };
type MissedQuest = { name: string; act: number };

/**
 * The Campaign tooltip's message: { steps, missed } (an older guide page sends the steps
 * alone), checked field by field.
 */
function campaignTip() {
  const value = tips.campaign as unknown;
  const message =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as { steps?: unknown; missed?: unknown; search?: unknown })
      : { steps: value, missed: [], search: undefined };
  const steps = Array.isArray(message.steps) ? (message.steps as Step[]) : [];
  const missed = Array.isArray(message.missed)
    ? (message.missed as MissedQuest[]).filter(
        (quest) =>
          typeof quest?.name === "string" && typeof quest?.act === "number",
      )
    : [];
  return { steps, missed, search: validSearch(message.search) };
}

/** A gem search from a message, when it's complete (else none: no copy icon). */
function validSearch(value: unknown) {
  const search = value as
    { text?: unknown; count?: unknown; total?: unknown } | null | undefined;
  return search &&
    typeof search.text === "string" &&
    search.text !== "" &&
    typeof search.count === "number" &&
    typeof search.total === "number"
    ? { text: search.text, count: search.count, total: search.total }
    : null;
}

/** Sets or clears a button's warning colour and what screen readers add about it. */
function markWarning(
  id: string,
  level: "high" | "medium" | null,
  description: string,
) {
  const button = buttons.querySelector<HTMLElement>(`.button[data-id="${id}"]`);
  if (!button) return;
  button.classList.toggle("warnHigh", level === "high");
  button.classList.toggle("warnMedium", level === "medium");
  if (level === null) button.removeAttribute("aria-description");
  else button.setAttribute("aria-description", description);
}

/**
 * Campaign turns amber with quest points your character missed; Health takes the colour of
 * its worst finding (red high, amber medium; low ones leave it gold).
 */
function markBadges() {
  const count = campaignTip().missed.length;
  markWarning(
    "campaign",
    count > 0 ? "medium" : null,
    `${count} missed ${count === 1 ? "point" : "points"}`,
  );
  const findings = (tips.health as { findings?: unknown } | null | undefined)
    ?.findings;
  // Missed quest points colour Campaign; Health counts them only without that button.
  const severities = (Array.isArray(findings) ? findings : [])
    .map((finding) => finding as { severity?: unknown; campaign?: unknown })
    .filter(
      (finding) => !(finding?.campaign === true && barIds.has("campaign")),
    )
    .map((finding) => finding?.severity);
  const level = severities.includes("high")
    ? "high"
    : severities.includes("medium")
      ? "medium"
      : null;
  const issues = severities.filter((s) => s === "high" || s === "medium");
  markWarning("health", level, `${issues.length} to check`);
}

let socket: WebSocket | null = null;
let shown = "";
/** The ids of the bar's buttons. */
let barIds = new Set<string>();
/**
 * The guide's tooltips by button: "gems" (OverlayGems | null), "campaign" ({ steps, missed }), "tree"
 * (TreeTip), "gear" (OverlayGear | null), "health" (OverlayHealth), "notes" (string | null).
 */
let tips: Record<string, unknown> = {};
/** Whether the first tooltips have arrived (a pinned one opens then). */
let tipsArrived = false;
/** The button whose tooltip is open. */
let openId: string | null = null;
/** The open tooltip is above the bar (the side it opened on). */
let up = false;

/**
 * Buttons with a tooltip: Gems (the Gems panel's links), Campaign (the next steps), Tree,
 * Gear (the items' mods), Health (Build health's findings) and Notes. Every tooltip gets
 * the pin and the flip.
 */
const TIPS: Record<string, () => void> = {
  gems: renderGems,
  campaign: renderCampaign,
  tree: renderTree,
  gear: renderGear,
  health: renderHealth,
  notes: renderNotes,
};

/** Draws a bar icon: 16px strokes in the button's colour. */
const barIcon = (paths: string) =>
  `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

/** Each panel's icon on the bar; a panel without one shows its label. */
const BAR_ICONS: Record<string, string> = {
  // A flag: the route.
  campaign: barIcon('<path d="M3.5 14.5v-13M3.5 2.5h9l-2 3 2 3h-9"/>'),
  // Plate armour: pauldrons, a V neck and belly plates (a cog would read as Settings).
  gear: barIcon(
    '<path d="M4.5 3.25 8 6l3.5-2.75.5 5.25-.5 5.5c-1 .75-2.25 1-3.5 1s-2.5-.25-3.5-1L4 8.5z"/><path d="M4.5 3.25C2.5 3.5 1.25 5 1.5 7.75L4 8.5M11.5 3.25c2 .25 3.25 1.75 3 4.5L12 8.5M4.5 10.5c1.25.5 2.25.75 3.5.75s2.25-.25 3.5-.75M4.75 12.5c1 .5 2 .75 3.25.75s2.25-.25 3.25-.75"/>',
  ),
  // A cut gem.
  gems: barIcon(
    '<path d="M4.5 2h7l3 4L8 14.5 1.5 6zM1.5 6h13M6 6l2 8.5L10 6M4.5 2L6 6l2-4 2 4 1.5-4"/>',
  ),
  // Two arrows, opposite ways.
  trade: barIcon('<path d="M2 5h11M10 2l3 3-3 3M14 11H3M6 8l-3 3 3 3"/>'),
  // Sliders.
  config: barIcon(
    '<path d="M2 4h1.5M6.5 4H14M2 8h7.5M12.5 8H14M2 12h3.5M8.5 12H14"/><circle cx="5" cy="4" r="1.5"/><circle cx="11" cy="8" r="1.5"/><circle cx="7" cy="12" r="1.5"/>',
  ),
  // Three linked nodes: the passive tree.
  tree: barIcon(
    '<circle cx="8" cy="3.5" r="2"/><circle cx="3.5" cy="12" r="2"/><circle cx="12.5" cy="12" r="2"/><path d="M7 5.3l-2.5 4.9M9 5.3l2.5 4.9M5.5 12h5"/>',
  ),
  // A heart with a pulse.
  health: barIcon(
    '<path d="M8 14S1.5 10 1.5 5.75A3.25 3.25 0 0 1 8 4a3.25 3.25 0 0 1 6.5 1.75C14.5 10 8 14 8 14z"/><path d="M4 8h1.75l1-1.5 1.5 3 1-1.5H12"/>',
  ),
  // A page of text.
  notes: barIcon(
    '<path d="M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3M5.5 8h5M5.5 10.5h5M5.5 13h3"/>',
  ),
  // A magnifier.
  search: barIcon('<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5l4 4"/>'),
};

/** One tooltip can be pinned open, kept across restarts. */
const PIN_KEY = "overlay-pin";
let pinned: string | null = readPin();

function readPin() {
  try {
    const id = localStorage.getItem(PIN_KEY);
    return id !== null && id in TIPS ? id : null;
  } catch {
    return null;
  }
}

/** Tooltips open above the bar: the flip's choice, kept across restarts (below at first). */
const SIDE_KEY = "overlay-side";
let above = readSide();

function readSide() {
  try {
    return localStorage.getItem(SIDE_KEY) === "above";
  } catch {
    return false;
  }
}

/** A flip in progress: hovers wait until the window has shrunk to the bar. */
let flipping = false;
/**
 * The bar alone has been sized once. Until then no tooltip opens: the exe places the
 * window at the saved spot by the bar's own size, and a tooltip opening above first
 * would shift the bar.
 */
let sized = false;

/**
 * The flip: tooltips open on the other side. The tooltip closes first, so the window
 * shrinks to the bar (sent with the old side) before anything grows on the new side and
 * the bar stays put. Then the pinned tooltip reopens there; an unpinned one stays closed
 * (the pointer is no longer over it).
 */
function flipSide() {
  above = !above;
  try {
    localStorage.setItem(SIDE_KEY, above ? "above" : "below");
  } catch {
    // Not kept: this side until the bar reloads.
  }
  closeTip();
  flipping = true;
  // Two frames: the shrink goes out with the first frame's resize observation.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      flipping = false;
      rest();
    }),
  );
}

function setPin(id: string | null) {
  pinned = id;
  try {
    if (id === null) localStorage.removeItem(PIN_KEY);
    else localStorage.setItem(PIN_KEY, id);
  } catch {
    // Not kept: pinned until the bar reloads.
  }
  markPinned();
  renderTip();
}

/** Marks the button whose tooltip is pinned. */
function markPinned() {
  for (const button of buttons.querySelectorAll<HTMLElement>(".button"))
    button.classList.toggle("pinned", button.dataset.id === pinned);
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
      // Own keys only: a panel id like "constructor" has no icon.
      const icon = Object.prototype.hasOwnProperty.call(BAR_ICONS, id)
        ? BAR_ICONS[id]
        : undefined;
      if (icon) {
        // The icon alone: its panel's name on hover and for screen readers.
        button.className = "button iconic";
        button.innerHTML = icon;
        button.setAttribute("aria-label", label);
        button.title = label;
      } else {
        button.className = "button";
        button.textContent = label;
      }
      button.dataset.id = id;
      button.addEventListener("click", () => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(`jump:${id}`);
      });
      // Hovering Gems, Campaign or Tree shows what they'd jump to, without leaving the game.
      button.addEventListener("mouseenter", () =>
        TIPS[id] ? openTip(id) : rest(),
      );
      // Right-click pins its tooltip (or unpins it), as the tooltip's pin does.
      button.addEventListener("contextmenu", () => {
        if (!TIPS[id]) return;
        if (pinned === id) {
          setPin(null);
        } else {
          openTip(id);
          setPin(id);
        }
      });
      return button;
    }),
  );
  markPinned();
  markBadges();
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
const FLIP_ICON =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M5 1.5l3.5 3.5H6v6H4V5H1.5zM11 14.5L7.5 11H10V5h2v6h2.5z" fill="currentColor"/></svg>';

function iconButton(icon: string, label: string, className: string) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.innerHTML = icon;
  button.title = label;
  button.setAttribute("aria-label", label);
  return button;
}

/**
 * A tooltip's title row: the pin at its left (near the bar's grip), the flip at its right.
 * It sits on the edge next to the bar: on top below the bar, at the bottom above it.
 */
function head(
  title: string,
  sub = "",
  extra: HTMLElement[] = [],
  /** Small controls right after the title (the Tree's set arrows). */
  afterTitle: HTMLElement[] = [],
) {
  const id = openId;
  const on = id !== null && pinned === id;
  const pin = iconButton(PIN_ICON, "Pin", on ? "icon on" : "icon");
  // Screen readers say "Pin, pressed"; the hover label says what a click does.
  pin.title = on ? "Unpin" : "Pin";
  pin.setAttribute("aria-pressed", String(on));
  pin.addEventListener("click", () => {
    if (id !== null) setPin(on ? null : id);
  });
  const flip = iconButton(FLIP_ICON, up ? "Show below" : "Show above", "icon");
  flip.addEventListener("click", flipSide);
  // `sub` (the Tree's set name) shares the row, so it stays by the title on either side.
  const text = el(
    "div",
    "tipTitle",
    title,
    ...(sub ? [el("span", "tipSub", ` · ${sub}`)] : []),
  );
  // The whole title on hover when a long one is cut short.
  text.title = sub ? `${title} · ${sub}` : title;
  // `extra`: the tooltip's own icons (Gems' copy), before the flip.
  return el(
    "div",
    "tipHead",
    pin,
    text,
    ...afterTitle,
    el("div", "tipSpacer"),
    ...extra,
    flip,
  );
}

const PREV_ICON =
  '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M10.5 2.5L5 8l5.5 5.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
const NEXT_ICON =
  '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M5.5 2.5L11 8l-5.5 5.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>';

/**
 * The Tree tooltip's ‹ › beside its set name: the guide's Tree panel shows the set before
 * or after, and sends this tooltip back for it. None for a one-set build.
 */
function treeArrows(data: TreeTip) {
  const { index, count } = data;
  if (typeof index !== "number" || typeof count !== "number" || count < 2)
    return [];
  const arrow = (step: "prev" | "next") => {
    const button = iconButton(
      step === "prev" ? PREV_ICON : NEXT_ICON,
      step === "prev" ? "Set before" : "Set after",
      "icon step",
    );
    button.disabled = step === "prev" ? index <= 0 : index >= count - 1;
    button.addEventListener("click", () => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(`tree:${step}`);
    });
    return button;
  };
  return [arrow("prev"), arrow("next")];
}

/** The Tree tooltip's title row: its set name, with the arrows to step it. */
function treeHead(data: TreeTip) {
  return head(TREE_TITLE, setName(data.set), [], treeArrows(data));
}

const COPY_ICON =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M5 1.5h7.5a1.5 1.5 0 0 1 1.5 1.5v8.5h-1.5V3H5zM2 4.5h8.5V15H2zm1.5 1.5v7.5H9V6z" fill="currentColor"/></svg>';

/**
 * Copies a vendor or stash search for the gems still to get. The exe puts it on the
 * clipboard: this window never has focus, which the page's clipboard needs.
 */
function copyButton(search: { text: string; count: number; total: number }) {
  const label =
    search.count < search.total
      ? `Copy search (${search.count} of ${search.total})`
      : "Copy search";
  const button = iconButton(COPY_ICON, label, "icon");
  button.addEventListener("click", () => {
    window.ipc?.postMessage(`copy:${search.text}`);
    button.classList.add("on");
    button.title = "Copied";
    button.setAttribute("aria-label", "Copied");
    setTimeout(() => {
      button.classList.remove("on");
      button.title = label;
      button.setAttribute("aria-label", label);
    }, 1500);
  });
  return button;
}

/** Fills the tooltip: the title row on the bar's side, then the content. */
function fill(title: string, ...content: Node[]) {
  fillWith(head(title), content);
}

function fillWith(row: HTMLElement, content: Node[]) {
  tip.replaceChildren(...(up ? [...content, row] : [row, ...content]));
}

function renderTip() {
  if (openId === null) return;
  try {
    TIPS[openId]?.();
  } catch {
    // A malformed message: say so rather than never opening.
    fill("", el("div", "tipEmpty", "Not available"));
  }
}

/**
 * Campaign: the quest points your character missed (from your latest /passives), then the
 * next steps. Its copy icon: a vendor search for the gems to buy at your next stop.
 */
function renderCampaign() {
  const { steps, missed, search } = campaignTip();
  const row = head("Next", "", search ? [copyButton(search)] : []);
  const missedBox =
    missed.length > 0
      ? [
          el(
            "div",
            "tipMissed",
            el("div", "tipLabel", "Missed points"),
            ...missed.map((quest) =>
              el(
                "div",
                "tipMissedQuest",
                el("span", "tipName", quest.name),
                el("span", "tipLevel", `Act ${quest.act}`),
              ),
            ),
          ),
        ]
      : [];
  if (steps.length === 0) {
    fillWith(row, [...missedBox, el("div", "tipEmpty", "No steps")]);
    return;
  }
  fillWith(row, [
    ...missedBox,
    ...steps.map((step) => {
      // An older guide page sends each step as its parts alone.
      const parts = Array.isArray(step)
        ? (step as Step["parts"])
        : Array.isArray(step?.parts)
          ? step.parts
          : [];
      const text = el(
        "div",
        "tipStepText",
        ...parts.map((part) =>
          el("span", part.kind ? `part ${part.kind}` : "part", part.text),
        ),
      );
      return el(
        "div",
        "tipStep",
        text,
        ...(typeof step?.tick === "string" ? [doneBox(step.tick)] : []),
      );
    }),
  ]);
}

/**
 * The checkbox at a Campaign step's right: ticks it in the guide (for steps the log can't
 * tell, like a bandit killed early), which then sends the next steps.
 */
function doneBox(tick: string) {
  const box = document.createElement("input");
  box.type = "checkbox";
  box.className = "tipDone";
  box.title = "Mark done";
  box.setAttribute("aria-label", "Mark done");
  box.addEventListener("change", () => {
    if (!box.checked) return;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(`tick:${tick}`);
      box.disabled = true;
      // The guide sends the next steps, which redraws the tooltip. Still here after a
      // while: no guide took it (none open), so it can be ticked again.
      setTimeout(() => {
        box.disabled = false;
        box.checked = false;
      }, 3000);
    } else {
      box.checked = false;
    }
  });
  return box;
}

function renderGems() {
  const gems = (tips.gems ?? null) as OverlayGems | null;
  if (
    gems === null ||
    !Array.isArray(gems.groups) ||
    gems.groups.length === 0
  ) {
    fill("Gems", el("div", "tipEmpty", "No gems"));
    return;
  }
  const search = validSearch(gems.search);
  const copy = search ? [copyButton(search)] : [];
  fillWith(
    head(gems.title, "", copy),
    gems.groups.map((group) =>
      el(
        "div",
        "tipGroup",
        ...(group.label || group.slot
          ? [
              el(
                "div",
                "tipGroupHead",
                el("span", "tipLabel", group.label ?? ""),
                ...(typeof group.slot === "string"
                  ? [el("span", "tipGroupSlot", group.slot)]
                  : []),
              ),
            ]
          : []),
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

/** A text list from a message, keeping only strings. */
function texts(value: unknown) {
  return Array.isArray(value)
    ? value.filter((text): text is string => typeof text === "string")
    : [];
}

/**
 * Gear: the Gear panel's items with PoB's mods, two to a row, scrolling past the cap.
 * Enchants and implicits dim above the explicit mods; crafted mods in their own colour.
 */
function renderGear() {
  const gear = (tips.gear ?? null) as OverlayGear | null;
  if (gear === null || !Array.isArray(gear.items) || gear.items.length === 0) {
    fill("Gear", el("div", "tipEmpty", "No gear"));
    return;
  }
  const items = gear.items.map((item) => {
    const name = el("div", "tipItemName", String(item.name ?? ""));
    if (typeof item.colour === "string") name.style.color = item.colour;
    const mods = (kind: string, lines: string[]) =>
      lines.map((text) => el("div", `tipMod ${kind}`, text));
    const above = [
      ...mods("enchant", texts(item.enchant)),
      ...mods("implicit", texts(item.implicit)),
    ];
    const explicit = (Array.isArray(item.explicit) ? item.explicit : [])
      .filter((mod) => typeof mod?.text === "string")
      .map((mod) =>
        el("div", mod.crafted ? "tipMod crafted" : "tipMod", mod.text),
      );
    return el(
      "div",
      "tipItem",
      el("div", "tipSlot", String(item.slot ?? "")),
      name,
      ...(item.base ? [el("div", "tipBase", String(item.base))] : []),
      ...above,
      ...(above.length > 0 && explicit.length > 0 ? [el("div", "tipSep")] : []),
      ...explicit,
    );
  });
  fill(
    typeof gear.title === "string" && gear.title ? gear.title : "Gear",
    el("div", "tipScroll", el("div", "tipGear", ...items)),
  );
}

const SEVERITIES = new Set(["high", "medium", "low"]);

/**
 * Health: Build health's findings in the panel's order, each with its fix; "Live" or "Plan"
 * by the title when a live character is set. PoB's state while it works (earlier findings
 * dimmed meanwhile, as the panel does), and the /passives ask.
 */
function renderHealth() {
  const value = tips.health as
    | {
        source?: unknown;
        status?: unknown;
        findings?: unknown;
        passivesStale?: unknown;
        stale?: unknown;
      }
    | null
    | undefined;
  if (value === null || typeof value !== "object") {
    fill("Build health", el("div", "tipEmpty", "No build"));
    return;
  }
  const findings = (Array.isArray(value.findings) ? value.findings : []).filter(
    (
      finding,
    ): finding is { severity: string; message: string; fix?: unknown } =>
      typeof finding?.message === "string",
  );
  const status = typeof value.status === "string" ? value.status : "";
  const content: Node[] = [];
  if (status) content.push(el("div", "tipEmpty", status));
  else if (findings.length === 0)
    content.push(el("div", "tipEmpty", "No issues"));
  for (const finding of findings) {
    const severity = SEVERITIES.has(finding.severity)
      ? finding.severity
      : "low";
    content.push(
      el(
        "div",
        value.stale === true ? "tipFinding stale" : "tipFinding",
        el("span", `tipSeverity ${severity}`),
        el(
          "div",
          "tipStepText",
          el("div", "", finding.message),
          ...(typeof finding.fix === "string" && finding.fix
            ? [el("div", "tipFix", finding.fix)]
            : []),
        ),
      ),
    );
  }
  if (value.passivesStale === true)
    content.push(
      el("div", "tipEmpty", "Type /passives in game to check quest points."),
    );
  fillWith(
    head("Build health", typeof value.source === "string" ? value.source : ""),
    [el("div", "tipScroll", ...content)],
  );
}

/** Notes: the build's PoB notes in PoB's colours, scrolling past the cap. */
function renderNotes() {
  const notes = tips.notes;
  if (typeof notes !== "string" || notes.trim() === "") {
    fill("Notes", el("div", "tipEmpty", "No notes"));
    return;
  }
  const lines = notesLines(notes).map((line) => {
    if (line.replace(/\^(x[0-9a-fA-F]{6}|[0-9])/g, "").trim() === "")
      return el("div", "tipBlank");
    return el(
      "div",
      "tipNote",
      ...pobSpans(line).map((span) => {
        const part = el("span", "", span.text);
        if (span.colour) part.style.color = span.colour;
        return part;
      }),
    );
  });
  fill("Notes", el("div", "tipScroll", ...lines));
}

const TREE_TITLE = "Next points";

/** "^2Lvl 13-24 {2}" → "Lvl 13-24": PoB colour codes and loadout links aren't for reading. */
function setName(name: unknown) {
  return typeof name === "string"
    ? name
        .replace(/\^(x[0-9a-fA-F]{6}|[0-9])/g, "")
        .replace(/\s*\{[^}]*\}\s*$/, "")
    : "";
}

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
    fill(TREE_TITLE, el("div", "tipEmpty", "No tree"));
    return;
  }
  if (data.next.length === 0) {
    // Its set is done: the arrows step on to the next one.
    fillWith(treeHead(data), [el("div", "tipEmpty", "Set done")]);
    return;
  }
  if (treeView?.version === data.version) {
    drawTree(treeView, data);
    return;
  }
  fill(TREE_TITLE, el("div", "tipEmpty", "Loading"));
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
      zoomable(box);
      treeView = { version: data.version, skillTree, compiled, box, css };
      try {
        drawTree(treeView, data);
      } catch {
        // A malformed tip: renderTip's catch can't see this one.
        fill(TREE_TITLE, el("div", "tipEmpty", "Not available"));
      }
    },
    () => {
      if (token === treeRender && openId === "tree")
        fill(TREE_TITLE, el("div", "tipEmpty", "Not available"));
    },
  );
}

/** What the tree was last drawn for: redrawing it restyles about 6,000 elements. */
let drawnTree = "";

function drawTree(view: TreeView, data: TreeTip) {
  const key = JSON.stringify(data);
  const row = tip.querySelector(".tipHead");
  if (key === drawnTree && view.box.parentNode === tip) {
    // Same picture: only the title row (the pin, or its side after a flip) may change.
    row?.remove();
    if (up) tip.append(treeHead(data));
    else tip.prepend(treeHead(data));
    return;
  }
  const { x, y, w, h } = data.view;
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0)
    throw new Error("No tree area");
  view.css.textContent = treeStyle(data, view.skillTree, view.compiled);
  // New points: back to their area. The same points again (reopened, or after another
  // tooltip) keep your zoom.
  if (key !== zoomedFor || !treeArea) {
    zoomedFor = key;
    treeHome = { x, y, w, h };
    treeArea = { ...treeHome };
  }
  drawnTree = key;
  showArea(view.box, treeArea);
  fillWith(treeHead(data), [view.css, view.box]);
}

/** The points the zoom belongs to. */
let zoomedFor = "";

type Area = { x: number; y: number; w: number; h: number };
/** The area the tooltip zooms to for the next points, and the area shown now. */
let treeHome: Area | null = null;
let treeArea: Area | null = null;
/** Zooming stops at this much closer or farther than the next points' area. */
const ZOOM_IN = 6;
const ZOOM_OUT = 12;

function showArea(box: HTMLElement, area: Area) {
  treeArea = area;
  box
    .querySelector("svg")
    ?.setAttribute("viewBox", `${area.x} ${area.y} ${area.w} ${area.h}`);
}

/** A point on the screen in the tree's own units. */
function treePoint(svg: SVGSVGElement, clientX: number, clientY: number) {
  const matrix = svg.getScreenCTM();
  if (!matrix) return null;
  return new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
}

/**
 * The tree tooltip zooms: the mouse wheel zooms in and out around the pointer, dragging
 * moves the tree, and a double-click goes back to the next points.
 */
function zoomable(box: HTMLElement) {
  box.addEventListener(
    "wheel",
    (event) => {
      const svg = box.querySelector("svg");
      if (!svg || !treeArea || !treeHome) return;
      event.preventDefault();
      const at = treePoint(svg, event.clientX, event.clientY);
      if (!at) return;
      // In pixels, whatever the device: a wheel notch (~100) zooms about 20%, and a
      // touchpad's many small steps add up to the same.
      const pixels =
        event.deltaY *
        (event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 33
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? 240
            : 1);
      const step = Math.exp(Math.max(-100, Math.min(100, pixels)) * 0.002);
      const scale =
        Math.min(
          Math.max(treeArea.w * step, treeHome.w / ZOOM_IN),
          treeHome.w * ZOOM_OUT,
        ) / treeArea.w;
      showArea(box, {
        x: at.x - (at.x - treeArea.x) * scale,
        y: at.y - (at.y - treeArea.y) * scale,
        w: treeArea.w * scale,
        h: treeArea.h * scale,
      });
    },
    { passive: false },
  );
  // The last pointer position while dragging; each move pans from the area shown now, so
  // a wheel zoom or new points mid-drag aren't undone.
  let drag: { x: number; y: number } | null = null;
  const stop = () => {
    drag = null;
    box.classList.remove("dragging");
  };
  box.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !treeArea) return;
    drag = { x: event.clientX, y: event.clientY };
    box.setPointerCapture(event.pointerId);
    box.classList.add("dragging");
  });
  box.addEventListener("pointermove", (event) => {
    if (!drag) return;
    // The button came up where the box didn't hear it.
    if (event.buttons === 0) return stop();
    const units = box.querySelector("svg")?.getScreenCTM()?.a;
    if (!treeArea || !units) return;
    showArea(box, {
      ...treeArea,
      x: treeArea.x - (event.clientX - drag.x) / units,
      y: treeArea.y - (event.clientY - drag.y) / units,
    });
    drag = { x: event.clientX, y: event.clientY };
  });
  box.addEventListener("pointerup", stop);
  box.addEventListener("pointercancel", stop);
  // Capture lost some other way (the tooltip redrawn, focus handed back to the game).
  box.addEventListener("lostpointercapture", stop);
  box.addEventListener("dblclick", () => {
    if (treeHome) showArea(box, { ...treeHome });
  });
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

function openTip(id: string) {
  if (flipping || !sized) return;
  // Already open (back on the button from the tooltip, or another button with one).
  if (!tip.hidden && openId === id) return;
  openId = id;
  if (!tip.hidden) {
    renderTip();
    return;
  }
  // The side the flip chose; the window grows that way from the bar.
  up = above;
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
  if (flipping || !sized) return;
  const id = pinnedShown();
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
      const before = openId === null ? undefined : JSON.stringify(tips[openId]);
      try {
        const all = JSON.parse(event.data.slice("tips:".length)) as unknown;
        tips =
          all !== null && typeof all === "object"
            ? (all as Record<string, unknown>)
            : {};
      } catch {
        tips = {};
      }
      markBadges();
      // Every tooltip comes each time one changes (Campaign on each zone): the open one is
      // drawn again only when its own changed, keeping where you scrolled it to.
      const changed =
        openId === null || JSON.stringify(tips[openId]) !== before;
      if (!tip.hidden) {
        if (changed) {
          const scrolled = tip.querySelector(".tipScroll")?.scrollTop ?? 0;
          renderTip();
          const scroll = tip.querySelector(".tipScroll");
          if (scroll) scroll.scrollTop = scrolled;
        }
      } else if (!tipsArrived) rest();
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
  // The bar's own height too: with a tooltip above, the exe saves the bar's place, not
  // the tooltip's top.
  const barHeight = Math.ceil(bar.getBoundingClientRect().height);
  window.ipc?.postMessage(
    `size:${Math.ceil(width)},${Math.ceil(height)},${up ? "up" : ""},${barHeight}`,
  );
  // The bar alone has gone out: now a pinned tooltip may open.
  if (!sized) {
    sized = true;
    rest();
  }
}).observe(frame);

document.addEventListener("contextmenu", (event) => event.preventDefault());

setState("offline");
connect();
