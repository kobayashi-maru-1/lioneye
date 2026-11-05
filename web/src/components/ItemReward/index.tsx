import { displaySetName } from "../../state/current-act";
import { CopyToClipboard } from "../CopyToClipboard";
import { GemCost } from "../GemCost";
import { InlineFakeBlock } from "../InlineFakeBlock";
import { SplitRow } from "../SplitRow";
import styles from "./styles.module.css";
import classNames from "classnames";
import { Data, type RouteData } from "common";
import type { ReactNode } from "react";
import { MdCircle } from "react-icons/md";

function ItemRewardVerb(type: ItemRewardProps["rewardType"]) {
  switch (type) {
    case "quest":
      return <span>Take </span>;
    case "vendor":
      return <span>Buy </span>;
    default:
      return <></>;
  }
}

interface ItemRewardProps {
  item: string;
  count?: number;
  rewardType?: "quest" | "vendor";
  cost?: ReactNode;
}

export function ItemReward({ item, count, cost, rewardType }: ItemRewardProps) {
  return (
    <>
      {ItemRewardVerb(rewardType)}
      <span className={classNames(styles.default)}>{item}</span>
      {count && count > 1 && <span> x{count}</span>}
      {rewardType === "vendor" && cost !== undefined && (
        <div className={classNames(styles.noWrap)}>
          <span> for </span>
          <InlineFakeBlock child={cost} />
        </div>
      )}
    </>
  );
}

interface GemRewardProps {
  requiredGem: RouteData.RequiredGem;
  count: number;
  rewardType?: ItemRewardProps["rewardType"];
  /** The quest and reward offer the gem comes from, to name who gives or sells it. */
  questId?: string;
  rewardOfferId?: string;
}

/**
 * The NPC to see: who hands out the quest reward (one quest can pay out from two, as
 * The Caged Brute does from Tarkleigh and Nessa), or who sells the gem.
 */
function gemSource(
  gemId: string,
  rewardType: GemRewardProps["rewardType"],
  questId: string | undefined,
  rewardOfferId: string | undefined,
) {
  const quest = questId === undefined ? undefined : Data.Quests[questId];
  const offer =
    rewardOfferId === undefined
      ? undefined
      : quest?.reward_offers[rewardOfferId];
  if (!offer) return undefined;
  return rewardType === "quest" ? offer.quest_npc : offer.vendor[gemId]?.npc;
}

export function GemReward({
  requiredGem,
  count,
  rewardType,
  questId,
  rewardOfferId,
}: GemRewardProps) {
  const gem = Data.Gems[requiredGem.id];
  const source = gemSource(requiredGem.id, rewardType, questId, rewardOfferId);

  if (!gem)
    return (
      <div className={classNames(styles.gemError)}>
        This is awkward, <b>{requiredGem.id}</b> doesn't seem to exist
      </div>
    );

  return (
    <SplitRow
      left={
        <>
          <MdCircle
            color={Data.GemColours[gem.primary_attribute]}
            className={classNames("inlineIcon")}
          />
          <ItemReward
            item={gem.name}
            cost={<GemCost gem={gem} />}
            rewardType={rewardType}
            count={count}
          />
          {source && (
            <span className={classNames(styles.source)}> · {source}</span>
          )}
        </>
      }
      right={
        <div className={classNames(styles.rewardNote)}>
          {displaySetName(requiredGem.note)} <CopyToClipboard text={gem.name} />
        </div>
      }
    />
  );
}
