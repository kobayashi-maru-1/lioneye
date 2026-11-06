import { useCallback, useEffect, useState } from "react";

/** The exe's settings from the guide's Settings page (log-api/src/app-settings.rs). */
export interface ExeSettings {
  /** The game's Client.txt; null: found from the running game. */
  logPath: string | null;
  browser: "app" | "edge" | "default";
  /** Set on the command line, which wins over Settings. */
  logFromCommandLine: string | null;
  browserFromCommandLine: string | null;
}

/** The app's and the bundled PoB's versions, and the exe's settings (/api/app). */
export interface AppInfo {
  version: string;
  /** "v2.67.2" */
  pob: string;
  settings: ExeSettings;
}

let request: Promise<AppInfo | null> | null = null;

function fetchAppInfo() {
  request ??= fetch("/api/app")
    .then((response) =>
      response.ok ? (response.json() as Promise<AppInfo>) : null,
    )
    .catch(() => null)
    .then((info) => {
      // An older exe or a failed request: try again next time it's asked for.
      if (info === null) request = null;
      return info;
    });
  return request;
}

/** The exe's app info; null until it answers (or on the hosted site, where nothing does). */
export function useAppInfo() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    let live = true;
    fetchAppInfo().then((found) => live && setInfo(found));
    return () => {
      live = false;
    };
  }, []);

  /** Changes settings; resolves to an error line, or null when saved. */
  const update = useCallback(
    async (change: { logPath?: string; browser?: ExeSettings["browser"] }) => {
      try {
        const response = await fetch("/api/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(change),
        });
        if (!response.ok)
          return (await response.text()) || "Not saved. Try again.";
        const settings = (await response.json()) as ExeSettings;
        setInfo((info) => (info ? { ...info, settings } : info));
        request = null;
        return null;
      } catch {
        return "Not saved. Try again.";
      }
    },
    [],
  );

  return { info, update };
}
