import { BuildHeader } from "../../components/BuildHeader";
import { BuildNotes, buildNotes } from "../../components/BuildNotes";
import { ConfigList } from "../../components/ConfigList";
import { FragmentStep } from "../../components/FragmentStep";
import { GearPanel } from "../../components/Gear";
import { GemLinkViewer } from "../../components/GemLinkViewer";
import { GemReward } from "../../components/ItemReward";
import { jumpTargetsAtom } from "../../components/AppBar";
import { settingsTabAtom } from "../../state/settings-tab";
import {
  PageSection,
  pageSectionId,
  usePageSectionCollapsed,
  useSetPageSectionCollapsed,
} from "../../components/PageSection";
import { PanelSelect } from "../../components/PanelSelect";
import {
  PobStatsProvider,
  STATS_AVAILABLE,
  useLoadoutSets,
  usePanelSet,
  usePobStats,
} from "../../components/PobStats";
import { SearchStrings } from "../../components/SearchStrings";
import { SectionHolder } from "../../components/SectionHolder";
import { SkillTreeViewer } from "../../components/SkillTreeViewer";
import { BuildHealthPanel } from "../../components/BuildHealth";
import { StatsViewer } from "../../components/StatsViewer";
import { TradeListPanel } from "../../components/TradeList";
import type { TaskListProps } from "../../components/TaskList";
import { currentActAtom } from "../../state/current-act";
import { gemLinksSelector } from "../../state/gem-links";
import { gemProgressFamily } from "../../state/gem-progress";
import { overlayGemsAtom, shownPanelsAtom } from "../../state/overlay";
import { pageSectionCollapseFamily } from "../../state/page-section-collapse";
import { pobAtom } from "../../state/pob";
import {
  campaignInViewAtom,
  routeSelector,
  scrollToActiveEdgeEffect,
} from "../../state/route";
import { routeProgressFamily } from "../../state/route-progress";
import { searchStringsSelector } from "../../state/search-strings";
import { type UrlTree, urlTreesSelector } from "../../state/tree/url-tree";
import { interactiveStyles } from "../../styles";
import styles from "./styles.module.css";
import classNames from "classnames";
import { Data, type RouteData } from "common";
import { atom, useAtom, useAtomValue, useSetAtom } from "jotai";
import { useAtomCallback } from "jotai/utils";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";

/** Where a step's done flag is stored, in route order. */
interface ProgressRef {
  family: "route" | "gem";
  key: string;
}

/**
 * The guide on one page, laid out like pob.codes: PoB's stats on the left; the header
 * card and foldable panels (Campaign, Gems, Config, Tree, Notes, Search) on the right.
 */
export default function RoutesContainer() {
  useAtom(scrollToActiveEdgeEffect);
  const route = useAtomValue(routeSelector);

  // Every step's done flag in route order, for shift-click ranges.
  const order = useMemo(() => {
    const order: ProgressRef[] = [];
    route.sections.forEach((section, sectionIndex) =>
      section.steps.forEach((step, stepIndex) => {
        if (step.type === "fragment_step")
          order.push({
            family: "route",
            key: [sectionIndex, stepIndex].toString(),
          });
        if (step.type === "gem_step")
          order.push({ family: "gem", key: step.requiredGem.id });
      }),
    );
    return order;
  }, [route]);

  // Shift-click: done → this and everything before; not done → this and everything after.
  const markRange = useAtomCallback(
    useCallback(
      (_get, set, orderIndex: number, done: boolean) => {
        const range = done
          ? order.slice(0, orderIndex + 1)
          : order.slice(orderIndex);
        const routeKeys = range
          .filter((x) => x.family === "route")
          .map((x) => x.key);
        // A gem can have more than one step (quest and vendor) sharing one flag:
        // clearing from here leaves a gem alone if it also appears before this point.
        const before = done
          ? new Set<string>()
          : new Set(
              order
                .slice(0, orderIndex)
                .filter((x) => x.family === "gem")
                .map((x) => x.key),
            );
        const gemKeys = range
          .filter(
            (x, i) =>
              x.family === "gem" && ((!done && i === 0) || !before.has(x.key)),
          )
          .map((x) => x.key);
        if (routeKeys.length > 0)
          set(routeProgressFamily.setMany, routeKeys, done);
        if (gemKeys.length > 0) set(gemProgressFamily.setMany, gemKeys, done);
      },
      [order],
    ),
  );

  const items = useMemo(() => {
    const items: ReactNode[] = [];
    let orderIndex = 0;
    for (
      let sectionIndex = 0;
      sectionIndex < route.sections.length;
      sectionIndex++
    ) {
      const section = route.sections[sectionIndex];

      let taskItems: TaskListProps["items"] = [];
      for (let stepIndex = 0; stepIndex < section.steps.length; stepIndex++) {
        const step = section.steps[stepIndex];

        if (step.type == "fragment_step")
          taskItems.push({
            edgeIndex: step.edgeIndex,
            orderIndex: orderIndex++,
            isCompletedState: routeProgressFamily(
              [sectionIndex, stepIndex].toString(),
            ),
            children: <FragmentStep key={stepIndex} step={step} />,
          });

        if (step.type == "gem_step")
          taskItems.push({
            edgeIndex: null,
            orderIndex: orderIndex++,
            isCompletedState: gemProgressFamily(step.requiredGem.id),
            children: (
              <GemReward
                key={taskItems.length}
                requiredGem={step.requiredGem}
                count={step.count}
                rewardType={step.rewardType}
                questId={step.questId}
                rewardOfferId={step.rewardOfferId}
              />
            ),
          });
      }

      items.push(
        <SectionHolder
          key={sectionIndex}
          name={section.name}
          items={taskItems}
          onRange={markRange}
        />,
      );
    }

    return items;
  }, [route, markRange]);

  return (
    <PobStatsProvider>
      <GuidePage campaign={items} />
    </PobStatsProvider>
  );
}

/**
 * The page, laid out like a pob.codes build page: PoB's stats on the left; the header
 * card (title, headline numbers, Loadout) and the panels on the right, Campaign first.
 */
function GuidePage({ campaign }: { campaign: ReactNode }) {
  const code = useAtomValue(pobAtom);
  const pob = usePobStats();
  const urlTrees = useAtomValue(urlTreesSelector);
  const gemLinks = useAtomValue(gemLinksSelector);
  const searchStrings = useAtomValue(searchStringsSelector);
  const xml = pob?.xml ?? null;
  const notes = useMemo(() => (xml ? buildNotes(xml) : null), [xml]);
  const showStats = STATS_AVAILABLE && code !== null;
  const hasSearch = searchStrings !== null && searchStrings.length > 0;
  useCampaignInView();
  useFoldCampaignAtEnd();
  const campaignColumn = useColumnScroll(0);
  const panelColumn = useColumnScroll(1);

  // The app bar's jump buttons, one per panel shown.
  const setTargets = useSetAtom(jumpTargetsAtom);
  // The in-game bar only gets buttons for these (state/overlay.ts).
  const setShownPanels = useSetAtom(shownPanelsAtom);
  const targetKey = [gemLinks.length > 0, showStats, urlTrees.length > 0]
    .concat([notes !== null, hasSearch])
    .join();
  const targets = useMemo(
    () => [
      { id: "campaign", label: "Campaign" },
      ...(showStats ? [{ id: "gear", label: "Gear" }] : []),
      ...(gemLinks.length > 0 ? [{ id: "gems", label: "Gems" }] : []),
      ...(showStats ? [{ id: "trade", label: "Trade" }] : []),
      ...(showStats ? [{ id: "health", label: "Health" }] : []),
      ...(showStats ? [{ id: "config", label: "Config" }] : []),
      ...(urlTrees.length > 0 ? [{ id: "tree", label: "Tree" }] : []),
      ...(notes !== null ? [{ id: "notes", label: "Notes" }] : []),
      ...(hasSearch ? [{ id: "search", label: "Search" }] : []),
    ],
    [targetKey],
  );
  useEffect(() => {
    setTargets(targets);
    setShownPanels(targets.map((target) => target.id));
  }, [targets]);
  useEffect(() => () => setTargets([]), []);
  // No gem links, so no Gems panel to set the bar's Gems tooltip: clear the last build's.
  const setOverlayGems = useSetAtom(overlayGemsAtom);
  useEffect(() => {
    if (gemLinks.length === 0) setOverlayGems(null);
  }, [gemLinks.length === 0]);

  // Wide screens: a column whose panels are all folded gives its width to the other.
  const campaignFolded = usePageSectionCollapsed("campaign");
  const panelsFoldedAtom = useMemo(() => {
    const ids = targets.map((t) => t.id).filter((id) => id !== "campaign");
    return atom(
      (get) =>
        ids.length > 0 && ids.every((id) => get(pageSectionCollapseFamily(id))),
    );
  }, [targets]);
  const panelsFolded = useAtomValue(panelsFoldedAtom);

  return (
    <>
      <div
        className={classNames(styles.page, {
          [styles.noSidebar]: !showStats,
        })}
      >
        {showStats && (
          <aside className={classNames(styles.sidebar, "thin-scroll")}>
            <StatsViewer />
          </aside>
        )}
        <div className={classNames(styles.main)}>
          {code === null && <EmptyHint />}
          {showStats && <BuildHeader />}
          {/* Wide screens: Campaign and the other panels side by side, each column
              scrolling by itself. Narrower: one column, as before (styles.columns). */}
          <div
            className={classNames(styles.columns, {
              [styles.stacked]: campaignFolded || panelsFolded,
            })}
          >
            <div
              ref={campaignColumn}
              className={classNames(styles.column, "thin-scroll", {
                [styles.folded]: campaignFolded,
              })}
              data-panel-column
            >
              <PageSection
                id="campaign"
                title="Campaign"
                actions={<ActPicker />}
              >
                {campaign}
              </PageSection>
            </div>
            <div
              ref={panelColumn}
              className={classNames(styles.column, "thin-scroll", {
                [styles.folded]: panelsFolded,
              })}
              data-panel-column
            >
              {/* Gear and Gems side by side, as on pob.codes. */}
              {(showStats || gemLinks.length > 0) && (
                <div className={classNames(styles.pair)} data-panel-row>
                  {showStats && <GearPanel />}
                  {gemLinks.length > 0 && <GemsPanel gemLinks={gemLinks} />}
                </div>
              )}
              {showStats && <TradeListPanel />}
              {showStats && <BuildHealthPanel />}
              {showStats && <ConfigPanel />}
              {urlTrees.length > 0 && <TreePanel urlTrees={urlTrees} />}
              {notes !== null && (
                <PageSection id="notes" title="Notes">
                  <BuildNotes notes={notes} />
                </PageSection>
              )}
              {hasSearch && (
                <PageSection id="search" title="Search">
                  <SearchStrings values={searchStrings} />
                </PageSection>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/** Jumps to an act's header (what the old menu's Sections list did); shows the act you're in. */
function ActPicker() {
  const route = useAtomValue(routeSelector);
  const act = useAtomValue(currentActAtom);
  const names = useMemo(
    () => route.sections.map((section) => section.name),
    [route],
  );
  const current = names.find((name) => act !== null && name === `Act ${act}`);
  // Shows the act you're in, but every choice jumps, including that act.
  return (
    <PanelSelect
      label="Act"
      options={names}
      value={-1}
      placeholder={current ?? names[0]}
      onChange={(index) =>
        document
          .getElementById(`section-${names[index].replace(/\s+/g, "_")}`)
          ?.scrollIntoView({ behavior: "smooth", block: "start" })
      }
    />
  );
}

/** Index of `title` in `titles`, or null (the panel then follows your act). */
function titleIndex(titles: string[], title: string | undefined) {
  if (title === undefined) return null;
  const index = titles.indexOf(title);
  return index === -1 ? null : index;
}

function GemsPanel({ gemLinks }: { gemLinks: RouteData.GemLinkGroup[] }) {
  const sets = useLoadoutSets();
  const titles = useMemo(
    () => [...new Set(gemLinks.map((link) => link.title))],
    [gemLinks],
  );
  const [index, choose] = usePanelSet(titles, titleIndex(titles, sets?.skills));

  // The set shown here, for the in-game bar's Gems tooltip.
  const setOverlayGems = useSetAtom(overlayGemsAtom);
  const title = titles[index];
  useEffect(() => {
    if (title === undefined) {
      setOverlayGems(null);
      return;
    }
    const gem = (link: RouteData.GemLink, primary: boolean) => {
      const data = Data.Gems[link.id];
      return data
        ? [
            {
              name: data.name,
              colour: Data.GemColours[data.primary_attribute],
              primary,
              level: link.level,
              quality: link.quality,
            },
          ]
        : [];
    };
    setOverlayGems({
      title,
      groups: gemLinks
        .filter((link) => link.title === title)
        .map((link) => ({
          label: link.label,
          gems: [
            ...link.primaryGems.flatMap((g) => gem(g, true)),
            ...link.secondaryGems.flatMap((g) => gem(g, false)),
          ],
        })),
    });
    // (Kept when you leave for Settings, so the bar still shows them.)
  }, [gemLinks, title]);

  return (
    <PageSection
      id="gems"
      title="Gems"
      actions={
        titles.length > 1 && (
          <PanelSelect
            label="Gem set"
            options={titles}
            value={index}
            onChange={choose}
          />
        )
      }
    >
      <GemLinkViewer gemLinks={gemLinks} selectedTitle={titles[index]} />
    </PageSection>
  );
}

function ConfigPanel() {
  const lists = usePobStats()?.stats?.lists ?? null;
  const titles = useMemo(
    () => lists?.configs.map((set) => set.title) ?? [],
    [lists],
  );
  const [index, choose] = usePanelSet(
    titles,
    lists ? lists.active.config - 1 : null,
  );
  return (
    <PageSection
      id="config"
      title="Config"
      actions={
        titles.length > 1 && (
          <PanelSelect
            label="Config set"
            options={titles}
            value={index}
            onChange={choose}
          />
        )
      }
    >
      <ConfigList
        rows={lists ? (lists.configs[index]?.rows ?? []) : undefined}
      />
    </PageSection>
  );
}

function TreePanel({ urlTrees }: { urlTrees: UrlTree.Data[] }) {
  const sets = useLoadoutSets();
  const titles = useMemo(() => urlTrees.map((tree) => tree.name), [urlTrees]);
  const [index, choose] = usePanelSet(titles, titleIndex(titles, sets?.tree));
  return (
    <PageSection
      id="tree"
      title="Tree"
      bodyClassName={styles.treeBody}
      actions={
        titles.length > 1 && (
          <PanelSelect
            label="Tree set"
            options={titles}
            value={index}
            onChange={choose}
          />
        )
      }
    >
      <p className={classNames(styles.hint)}>Ctrl+scroll zooms, drag pans</p>
      {/* Plain scrolling moves the page; the tree zooms only with Ctrl held. */}
      <div
        className={classNames(styles.tree)}
        onWheelCapture={(event) => {
          if (!event.ctrlKey) event.stopPropagation();
        }}
      >
        <SkillTreeViewer urlTrees={urlTrees} selectedIndex={index} />
      </div>
    </PageSection>
  );
}

/**
 * Folds Campaign once the last act is done (auto-tick finishes it when you leave its
 * last zone). It stays folded until you open it.
 */
function useFoldCampaignAtEnd() {
  const route = useAtomValue(routeSelector);
  const endedAtom = useMemo(
    () =>
      atom((get) => {
        const sectionIndex = route.sections.length - 1;
        const section = route.sections[sectionIndex];
        if (!section) return false;
        return section.steps.every((step, stepIndex) =>
          step.type === "fragment_step"
            ? get(routeProgressFamily([sectionIndex, stepIndex].toString()))
            : step.type === "gem_step"
              ? get(gemProgressFamily(step.requiredGem.id))
              : true,
        );
      }),
    [route],
  );
  const ended = useAtomValue(endedAtom);
  const setFolded = useSetPageSectionCollapsed("campaign");
  const wasEnded = useRef(ended);
  useEffect(() => {
    if (ended && !wasEnded.current) setFolded(true);
    wasEnded.current = ended;
  }, [ended]);
}

/** Where each wide-layout column was scrolled, kept while you're on Settings. */
const columnScroll = [0, 0];

/**
 * Wide screens: a column scrolls by itself, which the window's scroll restoration doesn't
 * see. Keeps its place when you leave the guide page and come back. (Narrow, the column
 * takes no part in layout and the window's restoration does the job.)
 */
function useColumnScroll(index: number) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const column = ref.current;
    if (!column) return;
    column.scrollTop = columnScroll[index];
    const save = () => {
      columnScroll[index] = column.scrollTop;
    };
    column.addEventListener("scroll", save, { passive: true });
    return () => column.removeEventListener("scroll", save);
  }, []);
  return ref;
}

/**
 * Tracks whether Campaign fills the top of the window. Auto-progress only scrolls to
 * your zone then, so it never pulls you away from a section you jumped to.
 */
function useCampaignInView() {
  const setInView = useSetAtom(campaignInViewAtom);
  // Folded, there's no zone to scroll to; a scroll asked for then would never retry.
  const folded = usePageSectionCollapsed("campaign");
  const [intersecting, setIntersecting] = useState(true);
  useEffect(() => {
    const element = document.getElementById(pageSectionId("campaign"));
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => setIntersecting(entry.isIntersecting),
      // Only the top 40% of the window counts.
      { rootMargin: "0px 0px -60% 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setInView(intersecting && !folded);
  }, [intersecting, folded]);
  useEffect(() => () => setInView(true), []);
}

function EmptyHint() {
  const navigate = useNavigate();
  // Import is on Settings' Build tab, whichever tab was open last.
  const setSettingsTab = useSetAtom(settingsTabAtom);
  return (
    <div className={classNames(styles.empty)}>
      <span>No build yet</span>
      <button
        className={classNames(
          styles.emptyButton,
          interactiveStyles.hoverPrimary,
        )}
        onClick={() => {
          setSettingsTab("build");
          navigate("/settings");
        }}
      >
        Import
      </button>
    </div>
  );
}
