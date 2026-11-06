import { pageSectionCollapseFamily } from "../../state/page-section-collapse";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useAtomCallback } from "jotai/utils";
import React, { useCallback, useRef } from "react";
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

/** A guide column that scrolls by itself (wide screens), else null: the window scrolls. */
function scrollingColumn(element: Element): Element | null {
  const column = element.closest("[data-panel-column]");
  return column && getComputedStyle(column).display !== "contents"
    ? column
    : null;
}

/**
 * True when an element's top has scrolled above where its pinned header sits, i.e. you're
 * inside it. Measured from the top of its scrolling column on wide screens.
 */
export function scrolledInside(element: Element, header: Element) {
  const top = scrollingColumn(element)?.getBoundingClientRect().top ?? 0;
  return (
    element.getBoundingClientRect().top - top <
    parseFloat(getComputedStyle(header).top) - 2
  );
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
  const sectionRef = useRef<HTMLElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const icon = collapsed ? <FiChevronDown /> : <FiChevronUp />;

  // The whole bar folds and opens the panel (its dropdown aside). Folding while you're
  // inside the panel (its header pinned) lands on the next panel instead of mid-page.
  const toggle = () => {
    const section = sectionRef.current;
    const header = headerRef.current;
    // Inside: the panel's top has scrolled above where its header pins.
    const inside =
      section !== null && header !== null && scrolledInside(section, header);
    setCollapsed(!collapsed);
    if (!collapsed && inside)
      requestAnimationFrame(() =>
        nextPanel(section).scrollIntoView({ block: "start" }),
      );
  };

  return (
    <section
      id={pageSectionId(id)}
      ref={sectionRef}
      className={classNames(styles.section)}
    >
      <div
        ref={headerRef}
        className={classNames(styles.header)}
        onClick={toggle}
      >
        {/* The bar's click does the folding; the button gives keyboards a way in. */}
        <button
          className={classNames(styles.toggle)}
          aria-expanded={!collapsed}
        >
          <span className={classNames(styles.title)}>{title}</span>
          {icon}
        </button>
        {actions && !collapsed && (
          <div
            className={classNames(styles.actions)}
            onClick={(event) => event.stopPropagation()}
          >
            {actions}
          </div>
        )}
      </div>
      {!collapsed && (
        <div className={classNames(styles.body, bodyClassName)}>{children}</div>
      )}
    </section>
  );
}

/**
 * The panel after this one; for panels side by side (data-panel-row), the one after the row.
 * One column (narrow screens): across into the next column's panels. Itself when it's the
 * last in its column.
 */
function nextPanel(section: HTMLElement): Element {
  const row = section.parentElement?.hasAttribute("data-panel-row")
    ? section.parentElement
    : null;
  const stacked = (element: Element | null) =>
    element !== null &&
    element.hasAttribute("data-panel-column") &&
    getComputedStyle(element).display === "contents";
  let current: Element = row ?? section;
  while (!current.nextElementSibling && stacked(current.parentElement))
    current = current.parentElement!;
  let next = current.nextElementSibling;
  while (next !== null && stacked(next)) next = next.firstElementChild;
  return next ?? section;
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
