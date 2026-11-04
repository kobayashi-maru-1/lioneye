import { useAtomValue } from "jotai";
import { gemLinksSelector } from "../../state/gem-links";
import { searchStringsSelector } from "../../state/search-strings";
import { urlTreesSelector } from "../../state/tree/url-tree";
import { interactiveStyles } from "../../styles";
import { AutoProgressStatus } from "../AutoProgress";
import { GemLinkViewer } from "../GemLinkViewer";
import { SearchStrings } from "../SearchStrings";
import { SkillTreeViewer } from "../SkillTreeViewer";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useMemo, useState } from "react";
import React from "react";
import { FaLink, FaListUl } from "react-icons/fa";
import { FiChevronLeft, FiChevronRight, FiSearch } from "react-icons/fi";
import { TbHierarchy } from "react-icons/tb";
import { useNavigate } from "react-router-dom";

const ALL = -1;

interface SidebarProps {
  expand: boolean;
  onToggleExpand: (expand: boolean) => void;
}

/** Right-hand panel: tree, gem links and search strings, all shown by default. */
export function Sidebar({ expand, onToggleExpand }: SidebarProps) {
  const [activeTab, setActiveTab] = useState<number>(ALL);
  const sections = useSections();

  return (
    <aside
      className={classNames(styles.sidebar, { [styles.collapsed]: !expand })}
    >
      <Header
        expand={expand}
        sections={sections}
        activeTab={activeTab}
        onActiveTab={setActiveTab}
        onToggleExpand={onToggleExpand}
      />
      {expand && sections.length === 0 && <EmptyHint />}
      {expand && sections.length > 0 && (
        <div className={classNames(styles.contents)}>
          {sections.map((section, i) => (
            <section
              key={section.key}
              className={classNames(styles.content, styles[section.key], {
                [styles.hidden]: activeTab !== i && activeTab !== ALL,
                [styles.solo]: activeTab === i,
              })}
            >
              {activeTab === ALL && (
                <h2 className={classNames(styles.contentTitle)}>
                  {section.tab}
                </h2>
              )}
              {section.content}
            </section>
          ))}
        </div>
      )}
    </aside>
  );
}

function EmptyHint() {
  const navigate = useNavigate();
  return (
    <div className={classNames(styles.empty)}>
      <p>No build yet.</p>
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

interface Section {
  key: "tree" | "gems" | "search";
  tab: React.ReactNode;
  content: React.ReactNode;
}

function useSections() {
  const searchStrings = useAtomValue(searchStringsSelector);
  const urlTrees = useAtomValue(urlTreesSelector);
  const gemLinks = useAtomValue(gemLinksSelector);

  return useMemo(() => {
    const sections: Section[] = [];

    if (urlTrees.length > 0) {
      sections.push({
        key: "tree",
        tab: (
          <>
            <TbHierarchy className={classNames("inlineIcon")} />
            Tree
          </>
        ),
        content: <SkillTreeViewer urlTrees={urlTrees} />,
      });
    }

    if (gemLinks.length > 0) {
      sections.push({
        key: "gems",
        tab: (
          <>
            <FaLink className={classNames("inlineIcon")} />
            Gems
          </>
        ),
        content: <GemLinkViewer gemLinks={gemLinks} />,
      });
    }

    if (searchStrings !== null && searchStrings.length > 0) {
      sections.push({
        key: "search",
        tab: (
          <>
            <FiSearch className={classNames("inlineIcon")} />
            Search
          </>
        ),
        content: <SearchStrings values={searchStrings} />,
      });
    }

    return sections;
  }, [urlTrees, gemLinks, searchStrings]);
}

interface HeaderProps {
  expand: boolean;
  sections: Section[];
  activeTab: number;
  onToggleExpand: (expand: boolean) => void;
  onActiveTab: (activeTab: number) => void;
}

function Header({
  expand,
  sections,
  activeTab,
  onToggleExpand,
  onActiveTab,
}: HeaderProps) {
  return (
    <div className={classNames(styles.header)}>
      <button
        className={classNames(styles.toggle, interactiveStyles.activeSecondary)}
        aria-label={expand ? "Hide panel" : "Show panel"}
        title={expand ? "Hide panel" : "Show panel"}
        onClick={() => onToggleExpand(!expand)}
      >
        {expand ? <FiChevronRight /> : <FiChevronLeft />}
      </button>
      {expand && (
        <>
          {sections.length > 1 && (
            <>
              <TabButton
                active={activeTab === ALL}
                onClick={() => onActiveTab(ALL)}
              >
                <FaListUl className={classNames("inlineIcon")} />
                All
              </TabButton>
              {sections.map((section, i) => (
                <TabButton
                  key={section.key}
                  active={activeTab === i}
                  onClick={() => onActiveTab(i)}
                >
                  {section.tab}
                </TabButton>
              ))}
            </>
          )}
          <span className={classNames(styles.spacer)} />
          <AutoProgressStatus />
        </>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: React.PropsWithChildren<{ active: boolean; onClick: () => void }>) {
  return (
    <button
      className={classNames(styles.tab, interactiveStyles.activeSecondary, {
        [styles.activeTab]: active,
      })}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
