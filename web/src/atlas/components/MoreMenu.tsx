import styles from "../atlas.module.css";
import { formStyles } from "../../styles";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";

export interface MenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

/**
 * The toolbar's More menu on narrow windows: the buttons that don't fit. Opens below the
 * button; closes on a pick, Escape, Tab away or a click outside. Arrow keys move between
 * items (one Tab stop, as a menu should be).
 */
export function MoreMenu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrap = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const enabled = () => [
    ...(menu.current?.querySelectorAll<HTMLButtonElement>(
      "button:not(:disabled)",
    ) ?? []),
  ];

  useEffect(() => {
    if (!open) return;
    enabled()[0]?.focus();
    const outside = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" && e.target === button.current) {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const list = enabled();
    if (!list.length) return;
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const down = e.key === "ArrowDown";
    const next =
      at < 0
        ? down
          ? 0
          : list.length - 1
        : (at + (down ? 1 : -1) + list.length) % list.length;
    list[next].focus();
  };

  return (
    <span
      ref={wrap}
      className={styles.more}
      onKeyDown={onKeyDown}
      // Tabbing out of the menu closes it. A blur to nothing (Safari clears focus when an
      // item is pressed; the window lost focus) leaves it open: a click outside closes it.
      onBlur={(e) => {
        if (
          open &&
          e.relatedTarget !== null &&
          !wrap.current?.contains(e.relatedTarget as Node)
        )
          setOpen(false);
      }}
    >
      <button
        ref={button}
        className={formStyles.formButton}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        More
      </button>
      {open && (
        <div ref={menu} id={id} className={styles.menu} role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              tabIndex={-1}
              className={styles.menuItem}
              disabled={item.disabled}
              onClick={() => {
                close();
                item.onClick();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
