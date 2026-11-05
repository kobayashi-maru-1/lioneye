import { BuildNotes, buildNotes } from "../../components/BuildNotes";
import { ConfigList } from "../../components/ConfigList";
import { FragmentStep } from "../../components/FragmentStep";
import { GemLinkViewer } from "../../components/GemLinkViewer";
import { GemReward } from "../../components/ItemReward";
import { JumpBar } from "../../components/JumpBar";
import { PageSection, pageSectionId } from "../../components/PageSection";
import {
  PobStatsProvider,
  STATS_AVAILABLE,
  useLoadoutSets,
  usePobStats,
} from "../../components/PobStats";
import { SearchStrings } from "../../components/SearchStrings";
import { SectionHolder } from "../../components/SectionHolder";
import { SkillTreeViewer } from "../../components/SkillTreeViewer";
import { StatsViewer } from "../../components/StatsViewer";
import type { TaskListProps } from "../../components/TaskList";
import { gemLinksSelector } from "../../state/gem-links";
import { gemProgressFamily } from "../../state/gem-progress";
import { pobAtom } from "../../state/pob";
import {
  campaignInViewAtom,
  routeSelector,
  scrollToActiveEdgeEffect,
} from "../../state/route";
import { routeProgressFamily } from "../../state/route-progress";
import { searchStringsSelector } from "../../state/search-strings";
import { urlTreesSelector } from "../../state/tree/url-tree";
import { interactiveStyles } from "../../styles";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useAtomCallback } from "jotai/utils";
import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import { FaLink } from "react-icons/fa";
import { FiFileText, FiMap, FiSearch, FiSliders } from "react-icons/fi";
import { TbHierarchy } from "react-icons/tb";
import { useNavigate } from "react-router-dom";

/** Where a step's done flag is stored, in route order. */
interface ProgressRef {
  family: "route" | "gem";
  key: string;
}

/**
 * The guide on one page: PoB's stats on the left, and Campaign, Tree, Gems, Config,
 * Notes and Search as foldable sections, with a bar that jumps to each.
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

interface PageSectionData {
  id: string;
  label: ReactNode;
  content: ReactNode;
  bodyClassName?: string;
}

function GuidePage({ campaign }: { campaign: ReactNode }) {
  const code = useAtomValue(pobAtom);
  const pob = usePobStats();
  const sets = useLoadoutSets();
  const urlTrees = useAtomValue(urlTreesSelector);
  const gemLinks = useAtomValue(gemLinksSelector);
  const searchStrings = useAtomValue(searchStringsSelector);
  const xml = pob?.xml ?? null;
  const notes = useMemo(() => (xml ? buildNotes(xml) : null), [xml]);
  const showStats = STATS_AVAILABLE && code !== null;
  useCampaignInView();

  const sections: PageSectionData[] = [
    {
      id: "campaign",
      label: <Label icon={<FiMap />} text="Campaign" />,
      content: campaign,
    },
  ];
  if (urlTrees.length > 0)
    sections.push({
      id: "tree",
      label: <Label icon={<TbHierarchy />} text="Tree" />,
      content: (
        <SkillTreeViewer urlTrees={urlTrees} selectedTitle={sets?.tree} />
      ),
      bodyClassName: styles.treeBody,
    });
  if (gemLinks.length > 0)
    sections.push({
      id: "gems",
      label: <Label icon={<FaLink />} text="Gems" />,
      content: (
        <GemLinkViewer gemLinks={gemLinks} selectedTitle={sets?.skills} />
      ),
    });
  if (showStats)
    sections.push({
      id: "config",
      label: <Label icon={<FiSliders />} text="Config" />,
      content: <ConfigList />,
    });
  if (notes !== null)
    sections.push({
      id: "notes",
      label: <Label icon={<FiFileText />} text="Notes" />,
      content: <BuildNotes notes={notes} />,
    });
  if (searchStrings !== null && searchStrings.length > 0)
    sections.push({
      id: "search",
      label: <Label icon={<FiSearch />} text="Search" />,
      content: <SearchStrings values={searchStrings} />,
    });

  return (
    <>
      <JumpBar targets={sections.map(({ id, label }) => ({ id, label }))} />
      <div
        className={classNames(styles.page, {
          [styles.noSidebar]: !showStats,
        })}
      >
        {showStats && (
          <aside className={classNames(styles.sidebar)}>
            <StatsViewer />
          </aside>
        )}
        <div className={classNames(styles.main)}>
          {code === null && <EmptyHint />}
          {sections.map((section) => (
            <PageSection
              key={section.id}
              id={section.id}
              title={section.label}
              bodyClassName={section.bodyClassName}
            >
              {section.content}
            </PageSection>
          ))}
        </div>
      </div>
    </>
  );
}

function Label({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <>
      <span className={classNames(styles.icon)}>{icon}</span>
      {text}
    </>
  );
}

/**
 * Tracks whether Campaign fills the top of the window. Auto-progress only scrolls to
 * your zone then, so it never pulls you away from a section you jumped to.
 */
function useCampaignInView() {
  const setInView = useSetAtom(campaignInViewAtom);
  useEffect(() => {
    const element = document.getElementById(pageSectionId("campaign"));
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => setInView(entry.isIntersecting),
      // Only the top 40% of the window counts.
      { rootMargin: "0px 0px -60% 0px" },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      setInView(true);
    };
  }, []);
}

function EmptyHint() {
  const navigate = useNavigate();
  return (
    <div className={classNames(styles.empty)}>
      <span>No build yet</span>
      <button
        className={classNames(
          styles.emptyButton,
          interactiveStyles.hoverPrimary,
        )}
        onClick={() => navigate("/build")}
      >
        Import
      </button>
    </div>
  );
}
