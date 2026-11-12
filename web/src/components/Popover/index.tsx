import styles from "./styles.module.css";
import classNames from "classnames";
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/** What a popover shows and where: the hovered or clicked thing and its element. */
interface PopoverState<T> {
  value: T;
  key: string;
  anchor: HTMLElement;
  /** Clicked: stays open (with its buttons) until clicked again, Escape or a click elsewhere. */
  pinned: boolean;
}

/**
 * pob.codes-style tooltips: hovering a thing shows its popover beside it; clicking pins
 * it so its buttons can be used. `bind(value, key)` gives the hover and click handlers.
 */
export function usePopover<T>() {
  const [state, setState] = useState<PopoverState<T> | null>(null);
  const close = useCallback(() => setState(null), []);

  const bind = useCallback(
    (value: T, key: string) => ({
      onPointerEnter: (event: React.PointerEvent<HTMLElement>) => {
        const anchor = event.currentTarget;
        setState((prev) =>
          prev?.pinned ? prev : { value, key, anchor, pinned: false },
        );
      },
      onPointerLeave: () => setState((prev) => (prev?.pinned ? prev : null)),
      onClick: (event: React.MouseEvent<HTMLElement>) => {
        const anchor = event.currentTarget;
        setState((prev) =>
          prev?.pinned && prev.key === key
            ? null
            : { value, key, anchor, pinned: true },
        );
      },
      "aria-expanded": state?.key === key,
    }),
    [state?.key],
  );

  return { state, bind, close };
}

interface PopoverProps {
  /** An HTML element, or an SVG one (a node on the passive tree). */
  anchor: Element;
  pinned: boolean;
  onClose: () => void;
  /** Shown under the content (Copy, Trade, Wiki...); usable once pinned. */
  actions?: React.ReactNode;
  className?: string;
}

/** A popover beside its anchor (right if there's room, else left), kept on screen. */
export function Popover({
  anchor,
  pinned,
  onClose,
  actions,
  className,
  children,
}: React.PropsWithChildren<PopoverProps>) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>();

  const place = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    // The thing it belongs to left the page (another set or act): close.
    if (!anchor.isConnected) return onClose();
    const a = anchor.getBoundingClientRect();
    const { width, height } = element.getBoundingClientRect();
    const gap = 8;
    const room = window.innerWidth - a.right - gap;
    const left =
      room >= width ? a.right + gap : Math.max(gap, a.left - gap - width);
    const top = Math.min(
      Math.max(gap, a.top),
      Math.max(gap, window.innerHeight - height - gap),
    );
    // Same place: keep the same object, so this doesn't re-render (and re-place) forever.
    setPosition((prev) =>
      prev && prev.left === left && prev.top === top ? prev : { left, top },
    );
  }, [anchor, onClose]);

  useLayoutEffect(place);

  // Follow the anchor as the page scrolls; a hover popover just closes. Only scrolls that
  // move the anchor count: on wide screens Campaign's column scrolls by itself.
  useEffect(() => {
    const onScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && !target.contains(anchor)) return;
      if (pinned) place();
      else onClose();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", place);
    };
  }, [pinned, place, onClose, anchor]);

  // A pinned popover closes on Escape or a click outside it and its anchor.
  useEffect(() => {
    if (!pinned) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !anchor.contains(target)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [pinned, anchor, onClose]);

  return (
    <div
      ref={ref}
      className={classNames(styles.popover, className, {
        [styles.pinned]: pinned,
      })}
      style={
        position
          ? { left: position.left, top: position.top }
          : { visibility: "hidden" }
      }
      role={pinned ? "dialog" : "tooltip"}
    >
      {children}
      {/* Shown on hover too, so you know clicking pins them within reach. */}
      {actions && (
        <div className={classNames(styles.actions)} inert={!pinned}>
          {actions}
        </div>
      )}
    </div>
  );
}

/** A square icon button for a popover's action row. */
export function PopoverAction({
  label,
  href,
  onClick,
  children,
}: React.PropsWithChildren<{
  label: string;
  href?: string;
  onClick?: () => void;
}>) {
  return href ? (
    <a
      className={classNames(styles.action)}
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={label}
      title={label}
    >
      {children}
    </a>
  ) : (
    <button
      className={classNames(styles.action)}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}
