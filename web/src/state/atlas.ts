/** The Atlas tab's two planners: New (ours) and Old (Atlas Route). */
export type AtlasPlanner = "new" | "old";

/** Our Atlas planner, published next to the League page (plans/atlas-planner.md). */
export const ATLAS_NEW_URL =
  "https://kobayashi-maru-1.github.io/lioneye/atlas/";
/** Atlas Route, an independent atlas tree planner (not open source; framed as it is). */
export const ATLAS_OLD_URL = "https://poeatlasplanner.com/";

const NEW = new URL(ATLAS_NEW_URL);
const OLD_ORIGIN = new URL(ATLAS_OLD_URL).origin;

/** What the League page hands the Atlas tab when a tree link is clicked. */
export interface AtlasTreeState {
  tree: string;
}

/** The Atlas route's state: a tree to open, or `seen` once it has opened. */
export interface AtlasRouteState {
  tree?: unknown;
  seen?: true;
}

/**
 * A tree link, as the New planner's address to open it with, or null. Takes our Share
 * links (`#t=`) and Atlas Route's Share tree links (`#p=`, which New reads too). Only the
 * fragment is carried over, onto New's own address, so nothing else from the link reaches
 * the frame.
 */
export function atlasTreeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const ours = url.origin === NEW.origin && url.pathname === NEW.pathname;
  if (!ours && url.origin !== OLD_ORIGIN) return null;
  // Base64url, or plain base64 (New reads both).
  const fragment = /^#([tp]=[A-Za-z0-9_+/-]+={0,2})$/.exec(url.hash);
  if (fragment === null) return null;
  return `${ATLAS_NEW_URL}#${fragment[1]}`;
}
