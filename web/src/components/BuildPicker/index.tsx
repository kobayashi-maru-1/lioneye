import {
  buildIdSelector,
  loadBuildAtom,
  pobFileSelector,
} from "../../state/pob";
import {
  type BuildEntry,
  editorInstalled,
  listBuildFiles,
  readBuildFile,
  xmlToPobCode,
} from "../../state/pob/file";
import { errorMessage, usePobEditor, usePobHome } from "../DesktopPob";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiChevronDown } from "react-icons/fi";
import { toast } from "react-toastify";

/** The list as the exe answered: loading, the builds, or what failed. */
type Listing =
  | { kind: "loading" }
  | { kind: "ready"; builds: BuildEntry[] }
  | { kind: "error"; message: string };

/** "Nov 9" for a save date; empty when unknown. */
function saved(modified: number) {
  return modified > 0
    ? new Date(modified).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })
    : "";
}

/**
 * One file however it's written: Windows ignores case, and PoB's custom build path uses
 * forward slashes where the Open dialog uses backslashes.
 */
export function samePath(a: string | null, b: string | null) {
  const norm = (path: string) => path.replace(/\//g, "\\").toLowerCase();
  return a !== null && b !== null && norm(a) === norm(b);
}

/** Space kept between the menu and the window's edges. */
const EDGE = 8;

/**
 * A dropdown of the builds in the chosen PoB's builds folder (its top level, last saved
 * first, with search). Choosing one opens it as Settings' Open does: the guide then
 * follows the file. Without that PoB installed, just `children`.
 *
 * The menu is drawn on the page's top layer (a portal), under the trigger and kept inside
 * the window, so it can sit beside a heading's button and over the panels; dialogs stay
 * above it.
 */
export function BuildPicker({
  className,
  label,
  hideWithoutPob = false,
  children,
}: React.PropsWithChildren<{
  /** The button's class (it shows `children` and a chevron). */
  className?: string;
  /** The button's tooltip and the menu's name. */
  label: string;
  /** Without that PoB: nothing, rather than `children`. */
  hideWithoutPob?: boolean;
}>) {
  const home = usePobHome();
  const [editor] = usePobEditor();
  const file = useAtomValue(pobFileSelector);
  const loadBuild = useSetAtom(loadBuildAtom);
  const store = useStore();
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<Listing>({ kind: "loading" });
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(
    null,
  );
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  /** Closes the menu; `refocus` puts the keyboard back on the button. */
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };

  // Read the folder each time it opens: PoB may have saved builds since.
  useEffect(() => {
    if (!open) return;
    let live = true;
    listBuildFiles(editor)
      .then((answer) => {
        if (live) setListing({ kind: "ready", builds: answer.builds });
      })
      .catch((error) => {
        if (live)
          setListing({
            kind: "error",
            message: errorMessage(error, "Builds not listed"),
          });
      });
    return () => {
      live = false;
    };
  }, [open, editor]);

  // Under the button, kept inside the window; again when the window resizes or the page
  // scrolls (the guide scrolls itself as you move zones). The search box gets the keyboard
  // once (the menu is only see-through until placed, so it can take focus).
  useLayoutEffect(() => {
    if (!open) {
      setPlace(null);
      return;
    }
    const measure = (event?: Event) => {
      if (
        event?.type === "scroll" &&
        event.target instanceof Node &&
        menu.current?.contains(event.target)
      )
        return;
      const button = trigger.current?.getBoundingClientRect();
      const width = menu.current?.offsetWidth ?? 0;
      if (!button) return;
      // Its button scrolled out of sight (or under the app bar): the menu goes with it.
      const bar = document
        .querySelector('nav[aria-label="Main"]')
        ?.getBoundingClientRect();
      if (button.bottom < (bar?.bottom ?? 0) || button.top > window.innerHeight)
        return setOpen(false);
      setPlace({
        top: button.bottom + 6,
        left: Math.max(
          EDGE,
          Math.min(button.left, window.innerWidth - width - EDGE),
        ),
      });
    };
    measure();
    search.current?.focus({ preventScroll: true });
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  // A click outside or Escape closes it.
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Node &&
      (menu.current?.contains(target) || trigger.current?.contains(target));
    const outside = (event: PointerEvent) => {
      if (!inside(event.target)) close(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Only the menu, not a popover or panel behind it.
      event.stopPropagation();
      close(true);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  const shown = useMemo(() => {
    if (listing.kind !== "ready") return [];
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return listing.builds.filter((build) =>
      words.every((word) => build.name.toLowerCase().includes(word)),
    );
  }, [listing, query]);

  if (!editorInstalled(home, editor))
    return hideWithoutPob ? null : <>{children}</>;

  const choose = async (build: BuildEntry) => {
    close(true);
    if (samePath(build.path, file)) return;
    // Another build loaded while this one was read (Import, Open): keep that one.
    const before = store.get(buildIdSelector);
    setBusy(true);
    try {
      const { path, xml } = await readBuildFile(build.path);
      if (store.get(buildIdSelector) !== before) return;
      if (loadBuild(xmlToPobCode(xml), path)) toast.success("Build opened");
      else toast.error("Not a PoB build. Pick another.");
    } catch (error) {
      toast.error(errorMessage(error, "Open failed"));
    } finally {
      setBusy(false);
    }
  };

  /** Up and Down move between the search box and the rows. */
  const move = (from: HTMLElement, step: 1 | -1) => {
    const rows = [
      ...(list.current?.querySelectorAll<HTMLButtonElement>("button") ?? []),
    ];
    const at = rows.indexOf(from as HTMLButtonElement);
    const next = at + step;
    if (next < 0) search.current?.focus();
    else rows[Math.min(next, rows.length - 1)]?.focus();
  };

  return (
    <>
      <button
        ref={trigger}
        className={classNames(styles.trigger, className)}
        // A tooltip, not aria-label: screen readers keep the button's own text (the title).
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        // Not disabled while a build loads: focus stays on it.
        aria-disabled={busy || undefined}
        onClick={() => {
          if (busy) return;
          if (open) return close(false);
          // A fresh list and search each time (no flash of the last one).
          setListing({ kind: "loading" });
          setQuery("");
          setOpen(true);
        }}
        onKeyDown={(event) => {
          // Back into the open menu from its button.
          if (open && event.key === "ArrowDown") {
            event.preventDefault();
            search.current?.focus();
          }
        }}
      >
        {children}
        <FiChevronDown aria-hidden className={classNames(styles.chevron)} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            className={classNames(styles.menu)}
            style={
              place
                ? { top: place.top, left: place.left }
                : { opacity: 0, pointerEvents: "none" }
            }
            role="dialog"
            aria-label={label}
            onKeyDown={(event) => {
              // The menu sits at the end of the page, away from its button: Tab leaves it
              // for the button rather than for the page's end.
              if (event.key === "Tab") {
                event.preventDefault();
                close(true);
              }
            }}
            onBlur={(event) => {
              // Tabbed away (not a click inside on something that takes no focus).
              const to = event.relatedTarget;
              if (
                to !== null &&
                !menu.current?.contains(to) &&
                to !== trigger.current
              )
                close(false);
            }}
          >
            <input
              className={classNames(styles.search)}
              type="search"
              placeholder="Search"
              aria-label="Search builds"
              ref={search}
              spellCheck={false}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && shown.length > 0) {
                  event.preventDefault();
                  choose(shown[0]);
                }
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  move(event.currentTarget, 1);
                }
              }}
            />
            {listing.kind === "loading" && (
              <div className={classNames(styles.note)}>Loading…</div>
            )}
            {listing.kind === "error" && (
              <div
                className={classNames(styles.note, styles.error)}
                role="alert"
              >
                {listing.message}
              </div>
            )}
            {listing.kind === "ready" && shown.length === 0 && (
              <div className={classNames(styles.note)}>
                {listing.builds.length === 0 ? "No builds" : "No matches"}
              </div>
            )}
            {shown.length > 0 && (
              <ul ref={list} className={classNames(styles.list, "thin-scroll")}>
                {shown.map((build) => {
                  const current = samePath(build.path, file);
                  return (
                    <li key={build.path}>
                      <button
                        className={classNames(styles.row, {
                          [styles.current]: current,
                        })}
                        aria-current={current ? "true" : undefined}
                        title={build.path}
                        onClick={() => choose(build)}
                        onKeyDown={(event) => {
                          if (
                            event.key === "ArrowDown" ||
                            event.key === "ArrowUp"
                          ) {
                            event.preventDefault();
                            move(
                              event.currentTarget,
                              event.key === "ArrowDown" ? 1 : -1,
                            );
                          }
                        }}
                      >
                        <span className={classNames(styles.name)}>
                          {build.name}
                        </span>
                        <span className={classNames(styles.date)}>
                          {saved(build.modified)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
