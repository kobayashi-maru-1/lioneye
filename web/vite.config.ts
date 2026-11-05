import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// https://vitejs.dev/config/
// `vite build --mode desktop` builds the copy that the local exe serves:
// served from the root, and no service worker so a new exe always shows its own UI.
export default defineConfig(({ mode }) => {
  const local = mode === "desktop";
  return {
    base: local ? "/" : "/exile-leveling/",
    server: {
      host: true,
      proxy: {
        // `npm run dev` talks to a running exe for auto-progress and PoB stats
        "/ws": { target: "ws://127.0.0.1:6754", ws: true },
        "/api": { target: "http://127.0.0.1:6754" },
      },
    },
    plugins: [
      react(),
      ...(local
        ? []
        : [
            VitePWA({
              registerType: "autoUpdate",
              manifest: {
                name: "Exile Leveling",
                short_name: "Exile Leveling",
                description:
                  "Exile Leveling is a Path of Exile leveling guide with Path of Building integration",
                theme_color: "#000000",
                background_color: "#000000",
                icons: [
                  {
                    src: "android-chrome-192x192.png",
                    sizes: "192x192",
                    type: "image/png",
                    purpose: "any maskable",
                  },
                  {
                    src: "android-chrome-512x512.png",
                    sizes: "512x512",
                    type: "image/png",
                    purpose: "any maskable",
                  },
                ],
              },
            }),
          ]),
    ],
  };
});
