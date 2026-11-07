import { deflate } from "pako";

/**
 * PoB build files through the exe (log-api/src/pob-routes.rs): Open (Windows' dialog),
 * reading the linked file again, saving a pasted build as a file, and Edit (PoB opened on
 * the file). Each throws an Error whose message is ready to show.
 */

/** PoB Community on this PC: whether it's installed, and its builds folder. */
export interface PobHome {
  installed: boolean;
  builds: string | null;
}

/** A build file and the XML PoB saved in it. */
export interface BuildFile {
  path: string;
  xml: string;
}

/**
 * One request. `failed` names what failed ("Open failed"), for answers the exe gives no
 * reason for. A 404 is the file gone (the exe's own reasons say what to do).
 */
async function call<T>(
  path: string,
  body: unknown,
  failed: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers:
        body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("Lioneye not reached. Retry.");
  }
  if (response.status === 404)
    throw new Error("File not found. Open it again.");
  if (!response.ok) {
    const text =
      response.status === 400
        ? (await response.text().catch(() => "")).trim()
        : "";
    throw new Error(text ? `${text}.` : `${failed}. Retry.`);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

let home: Promise<PobHome | null> | null = null;
/**
 * Asked once per page: whether Open and Edit show. Null when no exe answers (the dev
 * server without one): neither shows.
 */
export function pobHome() {
  home ??= call<PobHome>("/api/pob/home", undefined, "Not found").catch(() => {
    home = null;
    return null;
  });
  return home;
}

/** Windows' Open dialog: the chosen build file, or null when cancelled. */
export function openBuildFile() {
  return call<BuildFile | null>("/api/pob/open", {}, "Open failed");
}

export function readBuildFile(path: string) {
  return call<BuildFile>("/api/pob/read", { path }, "File not read");
}

/** Saves a build as a new file in PoB's builds folder; answers its path. */
export async function saveBuildFile(name: string, xml: string) {
  const saved = await call<{ path: string }>(
    "/api/pob/save",
    { name, xml },
    "Not saved",
  );
  return saved.path;
}

/** Opens PoB Community on a build file. */
export function editBuildFile(path: string) {
  return call<void>("/api/pob/edit", { path }, "PoB not opened");
}

/** A file's name without its folder or ".xml", as PoB's build list shows it. */
export function buildFileName(path: string) {
  return (path.split(/[\\/]/).pop() ?? path).replace(/\.xml$/i, "");
}

/** The XML PoB saves, as the code PoB exports (zlib, base64 with - and _). */
export function xmlToPobCode(xml: string) {
  const bytes = deflate(new TextEncoder().encode(xml));
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_");
}
