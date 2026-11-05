import { pageSectionCollapseFamily } from "../../state/page-section-collapse";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useAtomCallback } from "jotai/utils";
import React, { useCallback } from "react";
import { FiChevronDown, FiChevronUp } from "react-icons/fi";

/** Whether a page section is folded. */
export function usePageSectionCollapsed(id: string) {
  return useAtomValue(pageSectionCollapseFamily(id));
}

/** Folds (true) or opens a page section. */
export function useSetPageSectionCollapsed(id: string) {
  return useSetAtom(pageSectionCollapseFamily(id));
}

export function pageSectionId(id: string) {
  return `page-${id}`;
}

interface PageSectionProps {
  id: string;
  title: React.ReactNode;
  /** Shown at the right of the header, e.g. the panel's set dropdown. */
  actions?: React.ReactNode;
  /** Extra class for the body, e.g. a fixed height for the tree. */
  bodyClassName?: string;
}

/**
 * A foldable pob.codes-style panel of the one-page guide. Its header stays pinned under
 * the jump bar while you're inside the panel.
 */
export function PageSection({
  id,
  title,
  actions,
  bodyClassName,
  children,
}: React.PropsWithChildren<PageSectionProps>) {
  const [collapsed, setCollapsed] = useAtom(pageSectionCollapseFamily(id));
  const icon = collapsed ? <FiChevronDown /> : <FiChevronUp />;

  return (
    <section id={pageSectionId(id)} className={classNames(styles.section)}>
      <div className={classNames(styles.header)}>
        <button
          className={classNames(styles.toggle)}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
        >
          <span className={classNames(styles.title)}>{title}</span>
          {icon}
        </button>
        {actions && !collapsed && (
          <div className={classNames(styles.actions)}>{actions}</div>
        )}
      </div>
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
