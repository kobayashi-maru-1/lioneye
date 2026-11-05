import { buildToggleState } from "./toggle-state";

/** Which guide panels are folded (true: folded), remembered between visits. */
const PAGE_SECTION_COLLAPSE_VERSION = 0;
export const pageSectionCollapseFamily = buildToggleState(
  PAGE_SECTION_COLLAPSE_VERSION,
  "page-section-collapse",
);
