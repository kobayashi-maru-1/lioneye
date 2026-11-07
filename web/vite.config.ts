import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vitejs.dev/config/
// Builds the copy that lioneye.exe serves, from the root: the guide (index.html) and the
// in-game bar (overlay.html). No service worker, so a new exe always shows its own UI.
export default defineConfig({
  base: "/",
  build: {
    rollupOptions: {
      input: { main: "index.html", overlay: "overlay.html" },
    },
  },
  server: {
    host: true,
    proxy: {
      // `npm run dev` talks to a running exe for auto-progress and PoB stats
      "/ws": { target: "ws://127.0.0.1:6754", ws: true },
      "/api": { target: "http://127.0.0.1:6754" },
    },
  },
  plugins: [react()],
});
