import { BuildHeader } from "../../components/BuildHeader";
import { BuildPicker } from "../../components/BuildPicker";
import { CampaignReset } from "../../components/CampaignReset";
import { BuildNotes, buildNotes } from "../../components/BuildNotes";
import { ConfigList } from "../../components/ConfigList";
import { FragmentStep } from "../../components/FragmentStep";
import { GearPanel } from "../../components/Gear";
import { GemLinkViewer } from "../../components/GemLinkViewer";
import { GemReward } from "../../components/ItemReward";
import { jumpTargetsAtom } from "../../components/AppBar";
import { settingsTabAtom } from "../../state/settings-tab";
import { characterNodesNowAtom, treeCompareAtom } from "../../state/character";
import {
  PageSection,
  pageSectionId,
  usePageSectionCollapsed,
  useSetPageSectionCollapsed,
} from "../../components/PageSection";
import { PanelSelect } from "../../components/PanelSelect";
import {
  PobStatsProvider,
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
import { currentActAtom, displaySetName } from "../../state/current-act";
import { stripPob } from "../../components/PobText";
import {
  viewedGemLinksAtom,
  viewedUrlTreesAtom,
  viewingLiveAtom,
} from "../../state/live-view";
import { pobCodeToXml } from "../../state/pob/process";
import { gemProgressFamily } from "../../state/gem-progress";
import { gemsToGetSelector } from "../../state/gem";
import { gemRegex } from "../../state/gem-regex";
import {
  type OverlayGems,
  overlayGemsAtom,
  overlayTreeAtom,
  shownPanelsAtom,
  treeStepAtom,
  gemsStepAtom,
} from "../../state/overlay";
import { pageSectionCollapseFamily } from "../../state/page-section-collapse";
import { pobAtom } from "../../state/pob";
import {
  campaignInViewAtom,
  routeSelector,
  scrollToActiveEdgeEffect,
  stepKey,
} from "../../state/route";
import { routeProgressFamily } from "../../state/route-progress";
import { searchStringsSelector } from "../../state/search-strings";
import { TREE_DATA_LOOKUP } from "../../state/tree";
import { treeTip } from "../../state/tree/next-points";
import { lookAhead, treeProgressAtom } from "../../state/tree/progress";
import type { UrlTree } from "../../state/tree/url-tree";
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

/** Every gem's name, for the gem searches' unique pieces. */
const ALL_GEM_NAMES = Object.values(Data.Gems).map((gem) => gem.name);

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
    route.sections.forEach((section) =>
      section.steps.forEach((step) => {
        if (step.type === "fragment_step")
          order.push({
            family: "route",
            key: stepKey(step),
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
            isCompletedState: routeProgressFamily(stepKey(step)),
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
 * The page, laid out like a pob.codes build page: the Loadout and PoB's stats on the
 * left; the header card (title, headline numbers) and the panels on the right, Campaign
 * first.
 */
function GuidePage({ campaign }: { campaign: ReactNode }) {
  const code = useAtomValue(pobAtom);
  // Gems and Tree show your live character while the Loadout dropdown does (else the plan).
  const urlTrees = useAtomValue(viewedUrlTreesAtom);
  const gemLinks = useAtomValue(viewedGemLinksAtom);
  const searchStrings = useAtomValue(searchStringsSelector);
  // Notes are the plan's own, whatever the page shows.
  const notes = useMemo(() => {
    if (code === null) return null;
    try {
      return buildNotes(pobCodeToXml(code));
    } catch {
      return null;
    }
  }, [code]);
  const showStats = code !== null;
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
      ...(urlTrees.length > 0 ? [{ id: "tree", label: "Tree" }] : []),
      ...(showStats ? [{ id: "health", label: "Health" }] : []),
      ...(showStats ? [{ id: "config", label: "Config" }] : []),
      ...(notes !== null ? [{ id: "notes", label: "Notes" }] : []),
      ...(hasSearch ? [{ id: "search", label: "Search" }] : []),
    ],
    [targetKey],
  );
  // The in-game bar keeps the plan's buttons and tooltips while the page shows your live
  // character (they guide the plan).
  const viewingLive = useAtomValue(viewingLiveAtom);
  useEffect(() => {
    setTargets(targets);
    if (!viewingLive) setShownPanels(targets.map((target) => target.id));
  }, [targets, viewingLive]);
  // Kept when the page closes: the bar shows the panels on every page (League, Settings)
  // and takes you back here. A build changed meanwhile updates them once this page opens.
  // No gem links, so no Gems panel to set the bar's Gems tooltip: clear the last build's.
  const setOverlayGems = useSetAtom(overlayGemsAtom);
  useEffect(() => {
    if (gemLinks.length === 0 && !viewingLive) setOverlayGems(null);
  }, [gemLinks.length === 0, viewingLive]);

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
                actions={
                  <>
                    <ActPicker />
                    <CampaignReset />
                  </>
                }
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
              {urlTrees.length > 0 && <TreePanel urlTrees={urlTrees} />}
              {showStats && <BuildHealthPanel />}
              {showStats && <ConfigPanel />}
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
  // While the page shows your live character, the bar's Gems tooltip keeps the plan's.
  const viewingLive = useAtomValue(viewingLiveAtom);
  // The in-game Gems tooltip's ‹ › arrows: the set before or after the one shown, picked
  // here as if from the dropdown (until the loadout, act or level set changes). Not while
  // the page shows your live character: the tooltip's sets are the plan's, not these.
  const gemsStep = useAtomValue(gemsStepAtom);
  const handledGemsStep = useRef(gemsStep);
  useEffect(() => {
    const delta = gemsStep - handledGemsStep.current;
    handledGemsStep.current = gemsStep;
    if (viewingLive || delta === 0 || titles.length === 0) return;
    const next = Math.min(Math.max(index + delta, 0), titles.length - 1);
    if (next !== index) choose(next);
  }, [gemsStep]);

  // The set shown here, for the in-game bar's Gems tooltip, with a search for its gems
  // still on the gem list unticked (soonest first; gems you took off the list stay off).
  // With none of them left to get (or none on the list), the search is for all the set's
  // gems in the set's order, for finding them in your stash.
  const setOverlayGems = useSetAtom(overlayGemsAtom);
  const title = titles[index];
  const toGet = useAtomValue(gemsToGetSelector);
  // As JSON, so a tick that doesn't change the search doesn't send the tooltip again.
  const search = useMemo(() => {
    if (title === undefined) return "";
    const setIds = [
      ...new Set(
        gemLinks
          .filter((link) => link.title === title)
          .flatMap((link) => [...link.primaryGems, ...link.secondaryGems])
          .map((gem) => gem.id),
      ),
    ];
    const inSet = new Set(setIds);
    const left = toGet.filter((id) => inSet.has(id));
    const wanted = (left.length > 0 ? left : setIds).flatMap((id) =>
      Data.Gems[id] ? [Data.Gems[id].name] : [],
    );
    if (wanted.length === 0) return "";
    const { regex, count, total } = gemRegex(wanted, ALL_GEM_NAMES);
    return count > 0 ? JSON.stringify({ text: regex, count, total }) : "";
  }, [gemLinks, title, toGet]);
  useEffect(() => {
    if (viewingLive) return;
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
              ...(link.off ? { off: true } : {}),
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
          slot: link.slot,
          gems: [
            ...link.primaryGems.flatMap((g) => gem(g, true)),
            ...link.secondaryGems.flatMap((g) => gem(g, false)),
          ],
        })),
      ...(search
        ? { search: JSON.parse(search) as OverlayGems["search"] }
        : {}),
      index,
      count: titles.length,
    });
    // (Kept when you leave for Settings, so the bar still shows them.)
  }, [gemLinks, title, search, viewingLive, index, titles.length]);

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

/** The Tree panel's Compare choices: the loadout before, or your character (from the log). */
const TREE_COMPARE = [
  { value: "previous", label: "Previous set" },
  { value: "character", label: "Character" },
] as const;

function TreePanel({ urlTrees }: { urlTrees: UrlTree.Data[] }) {
  const sets = useLoadoutSets();
  const titles = useMemo(() => urlTrees.map((tree) => tree.name), [urlTrees]);
  const [panelIndex, choose, picked] = usePanelSet(
    titles,
    titleIndex(titles, sets?.tree),
  );
  // Your set's tree finished before your level reaches the next set: the next one you
  // haven't finished, unless you picked a set here.
  const progress = useAtomValue(treeProgressAtom);
  const index = picked ? panelIndex : lookAhead(titles, panelIndex, progress);
  const ahead = index !== panelIndex;
  // The in-game Tree tooltip's ‹ › arrows: the set before or after the one shown, picked
  // here as if from the dropdown (until the loadout, act or level set changes). Not while
  // the page shows your live character: the tooltip's sets are the plan's, not these.
  const viewingLive = useAtomValue(viewingLiveAtom);
  const treeStep = useAtomValue(treeStepAtom);
  const handledStep = useRef(treeStep);
  useEffect(() => {
    const delta = treeStep - handledStep.current;
    handledStep.current = treeStep;
    if (viewingLive || delta === 0 || titles.length === 0) return;
    const next = Math.min(Math.max(index + delta, 0), titles.length - 1);
    if (next !== index) choose(next);
  }, [treeStep]);
  // Your character's tree, once the exe has read it from the game's log.
  const character = useAtomValue(characterNodesNowAtom);
  const [compare, setCompare] = useAtom(treeCompareAtom);
  const against = compare === "character" && character ? character.nodes : null;
  useTreeTip(urlTrees, index, character?.nodes ?? null);
  // PoB's jewels, timeless jewel changes and cluster passives for each tree shown. Each
  // answer from PoB (another main skill or config) repeats them; the same ones keep the
  // tree as it is (redrawing it would reset its zoom). The plan's, also while Live shows
  // your character's numbers: these trees are the plan's.
  const stats = usePobStats()?.planStats ?? null;
  const treeExtras = useSameValue(stats?.treeExtras ?? null);
  const pobTitles = useSameValue(stats?.lists?.trees ?? null);
  const items = useSameValue(stats?.gear?.items);
  const extras = useMemo(() => {
    if (!treeExtras) return urlTrees.map(() => null);
    const pobNames = (pobTitles ?? []).map((title) => stripPob(title));
    return urlTrees.map((tree, i) => {
      // Older imports have no place: the same title's nth tree, counting from this one's.
      const nth = urlTrees
        .slice(0, i)
        .filter((t) => t.name === tree.name).length;
      const spec = tree.spec ?? nthIndex(pobNames, tree.name, nth);
      const found = spec >= 0 ? (treeExtras[spec] ?? null) : null;
      // A tree PoB calculated on a newer tree (no older one bundled): its places don't fit.
      return found && found.version && found.version !== tree.version
        ? null
        : found;
    });
  }, [urlTrees, treeExtras, pobTitles]);
  return (
    <PageSection
      id="tree"
      title="Tree"
      bodyClassName={styles.treeBody}
      actions={
        <>
          {character && (
            <PanelSelect
              label="Compare"
              options={TREE_COMPARE.map((option) => option.label)}
              value={TREE_COMPARE.findIndex((o) => o.value === compare)}
              onChange={(i) => setCompare(TREE_COMPARE[i].value)}
            />
          )}
          {titles.length > 1 && (
            <PanelSelect
              label="Tree set"
              options={titles}
              value={index}
              onChange={choose}
            />
          )}
        </>
      }
    >
      <p className={classNames(styles.hint)}>
        {ahead && `${displaySetName(stripPob(titles[panelIndex]))} done · `}
        {against
          ? `${character?.name}: green to take, red off the guide`
          : "Ctrl+scroll zooms, drag pans"}
      </p>
      {/* Plain scrolling moves the page; the tree zooms only with Ctrl held. */}
      <div
        className={classNames(styles.tree)}
        onWheelCapture={(event) => {
          if (!event.ctrlKey) event.stopPropagation();
        }}
      >
        <SkillTreeViewer
          urlTrees={urlTrees}
          selectedIndex={index}
          against={against}
          extras={extras}
          items={items}
        />
      </div>
    </PageSection>
  );
}

/** Where `value` is in `list` for the nth time (from 0), or -1. */
function nthIndex(list: string[], value: string, nth: number) {
  let seen = 0;
  for (let i = 0; i < list.length; i++)
    if (list[i] === value && seen++ === nth) return i;
  return -1;
}

/** The value from the last render while it's the same (as JSON), so memos and effects keep. */
function useSameValue<T>(value: T): T {
  const kept = useRef<{ json: string; value: T } | null>(null);
  const json = JSON.stringify(value ?? null);
  if (kept.current?.json !== json) kept.current = { json, value };
  return kept.current.value;
}

/**
 * The in-game bar's Tree tooltip for the set the Tree panel shows: the guide's next points
 * from your character's tree (from the log), else from the set before (none for the first).
 */
function useTreeTip(
  urlTrees: UrlTree.Data[],
  index: number,
  character: string[] | null,
) {
  const setTip = useSetAtom(overlayTreeAtom);
  // While the page shows your live character, the bar's Tree tooltip keeps the plan's.
  const viewingLive = useAtomValue(viewingLiveAtom);
  useEffect(() => {
    if (viewingLive) return;
    const tree = urlTrees[index];
    if (!tree) return;
    let live = true;
    const have = character ?? urlTrees[index - 1]?.nodes ?? [];
    TREE_DATA_LOOKUP[tree.version]?.then(([skillTree]) => {
      if (live)
        setTip({
          ...treeTip(tree, have, skillTree, index === urlTrees.length - 1),
          index,
          count: urlTrees.length,
        });
    });
    return () => {
      live = false;
    };
  }, [urlTrees, index, character, viewingLive]);
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
        const section = route.sections[route.sections.length - 1];
        if (!section) return false;
        return section.steps.every((step) =>
          step.type === "fragment_step"
            ? get(routeProgressFamily(stepKey(step)))
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
  // Import is in Settings' Build section (Settings opens at App, the top).
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
      {/* PoB's builds folder, when PoB is installed. */}
      <BuildPicker
        label="Builds"
        hideWithoutPob
        className={classNames(
          styles.emptyButton,
          interactiveStyles.hoverPrimary,
        )}
      >
        Builds
      </BuildPicker>
    </div>
  );
}
