import { GemCost } from "../GemCost";
import { InlineFakeBlock } from "../InlineFakeBlock";
import { SetPager, useFollowAct } from "../SetPager";
import { SidebarTooltip } from "../SidebarTooltip";
import styles from "./styles.module.css";
import classNames from "classnames";
import { Data, type RouteData } from "common";
import React, { type JSX } from "react";
import { useMemo, useState } from "react";
import { MdCircle } from "react-icons/md";
import flattenChildren from "react-keyed-flatten-children";

interface GemLinkViewerProps {
  gemLinks: RouteData.GemLinkGroup[];
  /** Show this skill set (by title) instead of following the act; the pager then hides. */
  selectedTitle?: string;
}

export function GemLinkViewer({ gemLinks, selectedTitle }: GemLinkViewerProps) {
  const gemSections = useMemo(() => {
    const linkTitles = new Set<string>();
    for (const link of gemLinks) linkTitles.add(link.title);
    return [...linkTitles];
  }, [gemLinks]);
  const [followIndex, setCurIndex] = useFollowAct(gemSections);
  const selectedIndex =
    selectedTitle === undefined ? -1 : gemSections.indexOf(selectedTitle);
  const curIndex = selectedIndex >= 0 ? selectedIndex : followIndex;
  const [tooltipGemLink, setTooltipGemLink] =
    useState<RouteData.GemLink | null>(null);

  const activeGemLinks: RouteData.GemLinkGroup[] = gemLinks.filter(
    (link) => link.title === gemSections[curIndex],
  );
  return (
    <div className={classNames(styles.gemLinks)}>
      {tooltipGemLink && <GemTooltip gemLink={tooltipGemLink} />}
      {selectedIndex < 0 && (
        <SetPager titles={gemSections} index={curIndex} onIndex={setCurIndex} />
      )}
      {activeGemLinks.length > 0 && (
        <div className={classNames(styles.gemLinkSection)}>
          {flattenChildren(
            activeGemLinks.map(({ primaryGems, secondaryGems }) => (
              <>
                <div className={classNames(styles.gemLinkRow)}>
                  {flattenChildren(
                    primaryGems.map((gem) => (
                      <GemLink
                        gemLink={gem}
                        isPrimary={true}
                        onTooltip={setTooltipGemLink}
                      />
                    )),
                  )}
                  {flattenChildren(
                    secondaryGems.map((gem) => (
                      <GemLink
                        gemLink={gem}
                        isPrimary={false}
                        onTooltip={setTooltipGemLink}
                      />
                    )),
                  )}
                </div>
              </>
            )),
          )}
        </div>
      )}
    </div>
  );
}

interface GemLinkProps {
  gemLink: RouteData.GemLink;
  isPrimary: boolean;
  onTooltip: (gemlink: RouteData.GemLink | null) => void;
}

function GemLink({ gemLink, isPrimary, onTooltip }: GemLinkProps) {
  const gem = Data.Gems[gemLink.id];
  return (
    <div
      className={isPrimary ? styles.gemPrimary : styles.gemSecondary}
      onPointerEnter={() => {
        onTooltip(gemLink);
      }}
      onPointerLeave={() => {
        onTooltip(null);
      }}
    >
      <MdCircle
        color={Data.GemColours[gem.primary_attribute]}
        className={classNames("inlineIcon")}
      />
      <span>{gem.name}</span>
    </div>
  );
}

interface GemTooltipProps {
  gemLink: RouteData.GemLink;
}

function GemTooltip({ gemLink }: GemTooltipProps) {
  const gem = Data.Gems[gemLink.id];

  return (
    <SidebarTooltip
      title={
        <div className={classNames(styles.gemLinkTitleInfo)}>
          <span>
            <MdCircle
              color={Data.GemColours[gem.primary_attribute]}
              className={classNames("inlineIcon")}
            />
            {gem.name}
          </span>
          <InlineFakeBlock child={<GemCost gem={gem} />} />
        </div>
      }
    >
      <div className={classNames(styles.gemLinkQuestInfo)}>
        {gemLink.quests.flatMap<JSX.Element>((x, i) => {
          const quest = Data.Quests[x.questId];
          const npc = quest.reward_offers[x.rewardOfferId]?.vendor[gem.id]?.npc;
          const text = (
            <React.Fragment key={i}>
              {i !== 0 && <hr className={classNames(styles.questSeperator)} />}
              <span>{quest.name}</span>
              <span>{npc}</span>
              <span>Act {quest.act}</span>
            </React.Fragment>
          );

          return text;
        })}
      </div>
    </SidebarTooltip>
  );
}
