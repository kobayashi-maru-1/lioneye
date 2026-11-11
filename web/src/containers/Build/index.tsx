import { useAtom, useSetAtom } from "jotai";
import { AppSettingsForm } from "../../components/AppSettingsForm";
import { BuildCodeForm } from "../../components/BuildCodeForm";
import { BuildInfoForm } from "../../components/BuildInfoForm";
import { ConfigForm } from "../../components/ConfigForm";
import { PobEditorSelect } from "../../components/DesktopPob";
import { LiveCharacterForm } from "../../components/LiveCharacter";
import { GemEditForm } from "../../components/GemEditForm";
import { Modal } from "../../components/Modal";
import { OverlayForm } from "../../components/OverlayForm";
import { SearchStringsEditor } from "../../components/SearchStringsEditor";
import {
  CardGrid,
  SettingRow,
  SettingsCard,
} from "../../components/SettingsCard";
import {
  type SettingsTab as Tab,
  settingsTabAtom,
} from "../../state/settings-tab";
import { buildDataSelector } from "../../state/build-data";
import { configSelector } from "../../state/config";
import { requiredGemsSelector } from "../../state/gem";
import { formStyles } from "../../styles";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useAtomCallback } from "jotai/utils";
import { pobAtom, resetCampaignAtom, resetGemsAtom } from "../../state/pob";
import { routeSelector } from "../../state/route";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "react-toastify";

/**
 * One list, in this order, each section a grid of cards. App: Overlay, Game. Build: Build
 * (code, Editor), Character, Search. Route: Route, Gems, Reset. The bar at the top jumps to
 * each section and marks the one you're in.
 */
const SECTIONS: { id: Tab; label: string }[] = [
  { id: "app", label: "App" },
  { id: "build", label: "Build" },
  { id: "route", label: "Route" },
];

const sectionId = (id: Tab) => `settings-${id}`;

/** A section of the list, with its heading. */
function Section({
  id,
  label,
  children,
}: React.PropsWithChildren<{ id: Tab; label: string }>) {
  return (
    <section
      id={sectionId(id)}
      className={classNames(styles.section)}
      aria-labelledby={`${sectionId(id)}-title`}
    >
      <h2
        id={`${sectionId(id)}-title`}
        className={classNames(styles.heading)}
        tabIndex={-1}
      >
        {label}
      </h2>
      {children}
    </section>
  );
}

/** Scrolls to a section's heading (just under the jump bar). */
function jump(id: Tab, behavior: ScrollBehavior) {
  document
    .getElementById(sectionId(id))
    ?.scrollIntoView({ behavior, block: "start" });
}

/**
 * The section you're in: the last one whose top has reached the jump bar's bottom (the
 * last section is at least a screen tall, so each can). Checked on scroll and whenever the
 * list's height changes (rows that load late, cards that grow).
 */
function useCurrentSection(
  bar: React.RefObject<HTMLElement | null>,
  list: React.RefObject<HTMLElement | null>,
) {
  const [current, setCurrent] = useState<Tab>(SECTIONS[0].id);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const nav = bar.current;
      if (!nav) return;
      // Where a jumped-to section's top lands (its scroll margin), plus a little.
      const line = nav.getBoundingClientRect().bottom + 8;
      let index = 0;
      SECTIONS.forEach(({ id }, i) => {
        const top = document
          .getElementById(sectionId(id))
          ?.getBoundingClientRect().top;
        if (top !== undefined && top <= line) index = i;
      });
      setCurrent(SECTIONS[index].id);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const resized = new ResizeObserver(schedule);
    if (list.current) resized.observe(list.current);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      resized.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return current;
}

/**
 * Opens at the top, or at the section a link asked for (once). Rows above it load late
 * (the exe's settings, the Editor), so the jump repeats as the list grows, for a moment
 * or until you scroll yourself.
 */
function useOpeningJump(list: React.RefObject<HTMLElement | null>) {
  const [requested, setRequested] = useAtom(settingsTabAtom);
  useLayoutEffect(() => {
    const target =
      requested !== null && SECTIONS.some((s) => s.id === requested)
        ? requested
        : null;
    if (requested !== null) setRequested(null);
    if (target === null) {
      window.scrollTo(0, 0);
      return;
    }
    jump(target, "auto");
    const element = list.current;
    if (!element) return;
    const again = new ResizeObserver(() => jump(target, "auto"));
    again.observe(element);
    const stop = () => {
      again.disconnect();
      window.clearTimeout(timer);
      for (const event of STOP_EVENTS)
        window.removeEventListener(event, stop, true);
    };
    const timer = window.setTimeout(stop, 2000);
    for (const event of STOP_EVENTS)
      window.addEventListener(event, stop, { capture: true, passive: true });
    return stop;
  }, []);
}

/** You scrolling or typing: the opening jump stops repeating. */
const STOP_EVENTS = ["wheel", "touchstart", "keydown", "pointerdown"] as const;

export default function BuildContainer() {
  const [config, setConfig] = useAtom(configSelector);
  const [buildData, setBuildData] = useAtom(buildDataSelector);
  const [requiredGems, setRequiredGems] = useAtom(requiredGemsSelector);
  const bar = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const current = useCurrentSection(bar, list);
  useOpeningJump(list);

  return (
    <div ref={list}>
      <nav
        ref={bar}
        className={classNames(styles.tabs)}
        aria-label="Settings sections"
      >
        {SECTIONS.map(({ id, label }) => (
          <a
            key={id}
            href={`#${sectionId(id)}`}
            aria-current={current === id ? "location" : undefined}
            className={classNames(styles.tab, {
              [styles.active]: current === id,
            })}
            onClick={(event) => {
              // No hash in the address (the app's routes use the path).
              event.preventDefault();
              jump(id, "smooth");
              // Tab and screen readers carry on from the section's heading.
              document
                .getElementById(`${sectionId(id)}-title`)
                ?.focus({ preventScroll: true });
            }}
          >
            {label}
          </a>
        ))}
      </nav>
      <Section id="app" label="App">
        <CardGrid>
          <SettingsCard title="Overlay">
            <OverlayForm />
          </SettingsCard>
          <AppSettingsForm />
        </CardGrid>
      </Section>
      <Section id="build" label="Build">
        <CardGrid>
          <SettingsCard title="Build" wide>
            <BuildCodeForm />
            <PobEditorSelect />
          </SettingsCard>
          <SettingsCard title="Character">
            <LiveCharacterForm />
          </SettingsCard>
          <SettingsCard
            title="Search"
            aside={
              <a
                href="https://poe.re/"
                target="_blank"
                rel="noreferrer"
                title="Path of Exile Regex"
              >
                poe.re
              </a>
            }
          >
            <SearchStringsEditor />
          </SettingsCard>
        </CardGrid>
      </Section>
      <Section id="route" label="Route">
        <CardGrid>
          {/* Alone (no gem list yet): full width, not half a row. */}
          <SettingsCard title="Route" wide={requiredGems.length === 0}>
            <BuildInfoForm
              buildData={buildData}
              onSubmit={(buildData) => {
                setBuildData(buildData);
              }}
            />
            <ConfigForm
              config={config}
              onSubmit={(config) => {
                setConfig(config);
              }}
            />
            <RouteButtons />
          </SettingsCard>
          {requiredGems.length > 0 && (
            <SettingsCard title="Gems" aside={requiredGems.length}>
              {/* Long: it scrolls inside the card. */}
              <div className={classNames(styles.gems)}>
                <GemEditForm
                  requiredGems={requiredGems}
                  onUpdate={(requiredGems) => {
                    setRequiredGems(requiredGems);
                  }}
                />
              </div>
            </SettingsCard>
          )}
          <SettingsCard title="Reset" wide danger>
            <Resets />
          </SettingsCard>
        </CardGrid>
      </Section>
    </div>
  );
}

/** Edit route, and the export for other tools (the old menu bar's). */
function RouteButtons() {
  const navigate = useNavigate();
  const exportRoute = useAtomCallback(
    useCallback(async (get) => {
      const route = await get(routeSelector);
      const pobCode = get(pobAtom);
      const output = [...route.sections, `pob-code:${pobCode ?? "none"}`];
      try {
        await navigator.clipboard.writeText(JSON.stringify(output));
        toast.success("Exported to Clipboard");
      } catch {
        toast.error("Export failed. Try again.");
      }
    }, []),
  );

  return (
    <SettingRow label="">
      <div className={classNames(formStyles.groupLeft)}>
        <button
          className={classNames(formStyles.formButton)}
          onClick={() => navigate("/edit-route")}
        >
          Edit route
        </button>
        <button
          className={classNames(formStyles.formButton)}
          title="Copy the route and build for other tools"
          onClick={() => exportRoute()}
        >
          Export
        </button>
      </div>
    </SettingRow>
  );
}

/** The resets: each asks first. Loading a build never clears any of these. */
const RESETS = {
  campaign: {
    title: "Reset campaign?",
    detail: "Clears campaign ticks, your place and level.",
    done: "Campaign reset",
  },
  gems: {
    title: "Reset gems?",
    detail: "Clears gem ticks.",
    done: "Gems reset",
  },
} as const;

/** The Reset card's buttons. Each asks first. */
function Resets() {
  const resetCampaign = useSetAtom(resetCampaignAtom);
  const resetGems = useSetAtom(resetGemsAtom);
  const [confirm, setConfirm] = useState<keyof typeof RESETS | null>(null);
  const asking = confirm === null ? null : RESETS[confirm];

  return (
    <>
      <div className={classNames(styles.resets)}>
        <button
          className={classNames(formStyles.formButton, styles.reset)}
          onClick={() => setConfirm("campaign")}
        >
          Reset campaign
        </button>
        <button
          className={classNames(formStyles.formButton, styles.reset)}
          onClick={() => setConfirm("gems")}
        >
          Reset gems
        </button>
      </div>
      <Modal
        size="small"
        isOpen={asking !== null}
        onRequestClose={() => setConfirm(null)}
        contentLabel={asking?.title ?? ""}
      >
        <div className={classNames(formStyles.form)}>
          <div className={classNames(formStyles.formRow)}>
            <label>{asking?.title}</label>
          </div>
          <p>{asking?.detail}</p>
          <div className={classNames(formStyles.groupRight)}>
            <button
              className={classNames(formStyles.formButton)}
              autoFocus
              onClick={() => setConfirm(null)}
            >
              Cancel
            </button>
            <button
              className={classNames(formStyles.formButton)}
              onClick={() => {
                if (confirm === "campaign") resetCampaign();
                if (confirm === "gems") resetGems();
                if (asking) toast.success(asking.done);
                setConfirm(null);
              }}
            >
              Reset
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
