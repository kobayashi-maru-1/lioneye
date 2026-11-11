import { gemMaxLevel, useTradeLeague, useTradeOptions } from "../Gear/data";
import { gemTradeUrl, wikiUrl } from "../Gear/trade-query";
import { GemCost } from "../GemCost";
import { InlineFakeBlock } from "../InlineFakeBlock";
import { PoeTooltip, TooltipProperty, tooltipStyles } from "../PoeTooltip";
import { usePobStats } from "../PobStats";
import { Popover, PopoverAction, usePopover } from "../Popover";
import { SetPager, useFollowAct } from "../SetPager";
import styles from "./styles.module.css";
import classNames from "classnames";
import { Data, type RouteData } from "common";
import React from "react";
import { useMemo } from "react";
import { FaBalanceScale } from "react-icons/fa";
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
  // pob.codes-style: hover a gem for its tooltip; click to pin it (Wiki and Trade).
  const popover = usePopover<RouteData.GemLink>();
  const { league } = useTradeLeague();
  const [options] = useTradeOptions();
  const maxLevels = usePobStats()?.stats?.gemMaxLevels;

  const activeGemLinks: RouteData.GemLinkGroup[] = gemLinks.filter(
    (link) => link.title === gemSections[curIndex],
  );
  const shown = popover.state;
  const shownGem = shown ? Data.Gems[shown.value.id] : undefined;
  return (
    <div className={classNames(styles.gemLinks)}>
      {shown && shownGem && (
        <Popover
          anchor={shown.anchor}
          pinned={shown.pinned}
          onClose={popover.close}
          actions={
            <>
              <PopoverAction label="Wiki" href={wikiUrl(shownGem.name)}>
                W
              </PopoverAction>
              {league && (
                <PopoverAction
                  label="Trade"
                  href={gemTradeUrl(
                    shownGem.name,
                    shown.value.level,
                    shown.value.quality,
                    league,
                    options,
                    gemMaxLevel(maxLevels, shown.value.id),
                  )}
                >
                  <FaBalanceScale aria-hidden />
                </PopoverAction>
              )}
            </>
          }
        >
          <GemTooltip gemLink={shown.value} />
        </Popover>
      )}
      {selectedIndex < 0 && (
        <SetPager titles={gemSections} index={curIndex} onIndex={setCurIndex} />
      )}
      {activeGemLinks.length > 0 && (
        <div className={classNames(styles.gemLinkSection)}>
          {flattenChildren(
            activeGemLinks.map(
              ({ label, slot, primaryGems, secondaryGems }, g) => (
                <>
                  <div className={classNames(styles.gemLinkRow)}>
                    {(label || slot) && (
                      <div className={classNames(styles.gemLinkHead)}>
                        <span
                          className={classNames(styles.gemLinkLabel)}
                          title={label}
                        >
                          {label}
                        </span>
                        {slot && (
                          <span className={classNames(styles.gemLinkSlot)}>
                            {slot}
                          </span>
                        )}
                      </div>
                    )}
                    {flattenChildren(
                      [...primaryGems, ...secondaryGems].map((gem, i) => {
                        const key = `${g}-${i}-${gem.id}`;
                        return (
                          <GemLink
                            key={key}
                            gemLink={gem}
                            isPrimary={i < primaryGems.length}
                            open={popover.state?.key === key}
                            handlers={popover.bind(gem, key)}
                          />
                        );
                      }),
                    )}
                  </div>
                </>
              ),
            ),
          )}
        </div>
      )}
    </div>
  );
}

interface GemLinkProps {
  gemLink: RouteData.GemLink;
  isPrimary: boolean;
  open: boolean;
  handlers: ReturnType<
    ReturnType<typeof usePopover<RouteData.GemLink>>["bind"]
  >;
}

function GemLink({ gemLink, isPrimary, open, handlers }: GemLinkProps) {
  const gem = Data.Gems[gemLink.id];
  const levelQuality =
    gemLink.level !== undefined
      ? `${gemLink.level}/${gemLink.quality ?? 0}`
      : undefined;
  return (
    <button
      className={classNames(
        styles.gemLink,
        isPrimary ? styles.gemPrimary : styles.gemSecondary,
        { [styles.open]: open, [styles.off]: gemLink.off },
      )}
      aria-label={gemLink.off ? `${gem.name}, off in PoB` : gem.name}
      {...handlers}
    >
      <span>
        <MdCircle
          color={Data.GemColours[gem.primary_attribute]}
          className={classNames("inlineIcon")}
        />
        {gem.name}
      </span>
      {levelQuality && (
        <span
          className={classNames(styles.levelQuality)}
          title="Level / quality"
        >
          {levelQuality}
        </span>
      )}
    </button>
  );
}

interface GemTooltipProps {
  gemLink: RouteData.GemLink;
}

/** The gem as an in-game tooltip, with where to get it while leveling. */
export function GemTooltip({ gemLink }: GemTooltipProps) {
  const gem = Data.Gems[gemLink.id];

  return (
    <PoeTooltip kind="gem" name={gem.name}>
      <>
        {gemLink.off && (
          <div className={classNames(tooltipStyles.note)}>Off in PoB</div>
        )}
        {gemLink.level !== undefined && (
          <TooltipProperty label="Level:" value={gemLink.level} />
        )}
        {(gemLink.quality ?? 0) > 0 && (
          <TooltipProperty label="Quality:" value={`+${gemLink.quality}%`} />
        )}
        <TooltipProperty
          label="Cost:"
          value={<InlineFakeBlock child={<GemCost gem={gem} />} />}
        />
      </>
      {gemLink.quests.length > 0 && (
        <div className={classNames(styles.gemLinkQuestInfo)}>
          {gemLink.quests.flatMap((x, i) => {
            const quest = Data.Quests[x.questId];
            const npc =
              quest.reward_offers[x.rewardOfferId]?.vendor[gem.id]?.npc;
            return (
              <React.Fragment key={i}>
                <span className={classNames(tooltipStyles.description)}>
                  {quest.name}
                </span>
                <span>{npc}</span>
                <span className={classNames(tooltipStyles.note)}>
                  Act {quest.act}
                </span>
              </React.Fragment>
            );
          })}
        </div>
      )}
    </PoeTooltip>
  );
}
