import { buildToggleState } from "../../state/toggle-state";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useAtom, useAtomValue } from "jotai";
import { useAtomCallback } from "jotai/utils";
import React, { useCallback } from "react";
import { FiChevronDown, FiChevronUp } from "react-icons/fi";

/** Which page sections are folded (true: folded), remembered between visits. */
const PAGE_SECTION_COLLAPSE_VERSION = 0;
const pageSectionCollapseFamily = buildToggleState(
  PAGE_SECTION_COLLAPSE_VERSION,
  "page-section-collapse",
);

/** Whether a page section is folded. */
export function usePageSectionCollapsed(id: string) {
  return useAtomValue(pageSectionCollapseFamily(id));
}

export function pageSectionId(id: string) {
  return `page-${id}`;
}

interface PageSectionProps {
  id: string;
  title: React.ReactNode;
  /** Extra class for the body, e.g. a fixed height for the tree. */
  bodyClassName?: string;
}

/** A foldable section of the one-page guide, with a header the jump bar scrolls to. */
export function PageSection({
  id,
  title,
  bodyClassName,
  children,
}: React.PropsWithChildren<PageSectionProps>) {
  const [collapsed, setCollapsed] = useAtom(pageSectionCollapseFamily(id));
  const icon = collapsed ? <FiChevronDown /> : <FiChevronUp />;

  return (
    <section id={pageSectionId(id)} className={classNames(styles.section)}>
      <button
        className={classNames(styles.header)}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className={classNames(styles.title)}>{title}</span>
        {icon}
      </button>
      {!collapsed && (
        <div className={classNames(styles.body, bodyClassName)}>{children}</div>
      )}
    </section>
  );
}

/** Opens a section if it's folded, then scrolls to its header. */
export function useJumpToSection() {
  return useAtomCallback(
    useCallback((_get, set, id: string) => {
      set(pageSectionCollapseFamily(id), false);
      // After the open section has rendered.
      requestAnimationFrame(() =>
        document
          .getElementById(pageSectionId(id))
          ?.scrollIntoView({ behavior: "smooth", block: "start" }),
      );
    }, []),
  );
}
