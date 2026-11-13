/** Atlas Route, an independent atlas tree planner (not open source; framed as it is). */
export const ATLAS_PLANNER_URL = "https://poeatlasplanner.com/";
export const ATLAS_PLANNER_ORIGIN = new URL(ATLAS_PLANNER_URL).origin;

/** What the League page hands the Atlas tab when a tree link is clicked. */
export interface AtlasTreeState {
  tree: string;
}

/** A planner link (a Share tree link, its tree in the #p= fragment), or null. */
export function atlasTreeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    // blob: and filesystem: URLs share the planner's origin; only its own pages.
    if (url.protocol !== "https:" || url.origin !== ATLAS_PLANNER_ORIGIN)
      return null;
    url.username = "";
    url.password = "";
    return url.href;
  } catch {
    return null;
  }
}
