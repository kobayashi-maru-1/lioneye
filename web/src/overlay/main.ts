// The in-game bar, shown by exile-leveling.exe over the game in a WebView2 window
// (log-api/src/overlay.rs). Buttons tell the exe, which tells the guide page to jump to that
// panel. The exe sends the buttons ("overlay:" messages) from the guide's Settings.
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

const bar = document.getElementById("bar")!;
const grip = document.getElementById("grip")!;
const buttons = document.getElementById("buttons")!;
const dot = document.getElementById("dot")!;

let socket: WebSocket | null = null;
let shown = "";

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
      return button;
    }),
  );
}

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

// The window fits the bar.
new ResizeObserver(() => {
  const { width, height } = bar.getBoundingClientRect();
  window.ipc?.postMessage(`size:${Math.ceil(width)},${Math.ceil(height)}`);
}).observe(bar);

document.addEventListener("contextmenu", (event) => event.preventDefault());

setState("offline");
connect();
