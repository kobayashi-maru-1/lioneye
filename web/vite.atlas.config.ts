import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The standalone Atlas planner (plans/atlas-planner.md): a static page for GitHub Pages
// (/lioneye/atlas/), built apart from the exe's guide. Relative paths so it works under any
// folder. No proxy: it never talks to lioneye.exe, so testing it can't touch a running guide.
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist-atlas",
    emptyOutDir: true,
    rollupOptions: { input: { atlas: "atlas.html" } },
  },
  plugins: [react()],
});
