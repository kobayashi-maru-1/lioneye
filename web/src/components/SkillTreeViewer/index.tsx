import { TREE_DATA_LOOKUP } from "../../state/tree";
import type { UrlTree } from "../../state/tree/url-tree";
import { randomId } from "../../utility";
import { ItemTooltip, RARITY_COLOURS } from "../Gear";
import type { GearItem, TreeExtras, TreeJewel } from "../PobStats";
import { PoeTooltip, TooltipProperty, tooltipStyles } from "../PoeTooltip";
import { Popover } from "../Popover";
import { SetPager, useFollowAct } from "../SetPager";
import { Viewport, type ViewportProps } from "../Viewport";
import { drawExtras, extrasStyle } from "./extras";
import styles from "./styles.module.css";
import {
  type UrlTreeDelta,
  buildUrlTreeDelta,
  calculateBounds,
} from "./url-tree-delta";
import classNames from "classnames";
import type { SkillTree } from "common";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface SkillTreeViewerProps {
  urlTrees: UrlTree.Data[];
  /** Show this tree (by position) instead of following the act; the pager then hides. */
  selectedIndex?: number;
  /**
   * Compare with these nodes (your character's) instead of the loadout before: taken ones
   * show as active, the loadout's others as added (to take), yours it lacks as removed.
   */
  against?: string[] | null;
  /** PoB's extras for each of `urlTrees` (jewels, timeless jewels, clusters), if known. */
  extras?: (TreeExtras | null)[];
  /** The build's items by id, for the jewels' tooltips. */
  items?: Record<string, GearItem>;
}

interface RenderData {
  svg: string;
  style: string;
  skillTree: SkillTree.Data;
  nodes: SkillTree.NodeLookup;
  intialFocus: ViewportProps["intialFocus"];
  masteries: UrlTreeDelta["masteries"];
  extras: TreeExtras | null;
  /** The set before's, for the tooltips of its cluster passives drawn as removed. */
  previousExtras: TreeExtras | null;
}

/** The hovered node (or jewel socket) and its element, for the tooltip beside it. */
interface Hovered {
  id: string;
  anchor: Element;
}

const NO_ITEMS: Record<string, GearItem> = {};

export function SkillTreeViewer({
  urlTrees,
  selectedIndex: chosenIndex,
  against,
  extras,
  items = NO_ITEMS,
}: SkillTreeViewerProps) {
  const svgDivRef = useRef<HTMLDivElement>(null);
  const titles = useMemo(() => urlTrees.map((x) => x.name), [urlTrees]);
  const [followIndex, setCurIndex] = useFollowAct(titles);
  const selectedIndex =
    chosenIndex !== undefined && chosenIndex >= 0 && chosenIndex < titles.length
      ? chosenIndex
      : -1;
  const curIndex = selectedIndex >= 0 ? selectedIndex : followIndex;
  const [renderData, setRenderData] = useState<RenderData>();
  const [styleId] = useState(() => randomId(6));
  const [hovered, setHovered] = useState<Hovered | null>(null);

  const currentExtras = extras?.[curIndex] ?? null;
  const previousExtras = against ? null : (extras?.[curIndex - 1] ?? null);

  useEffect(() => {
    async function fn() {
      if (urlTrees.length == 0) return;

      const currentTree = urlTrees[curIndex];
      let previousTree: UrlTree.Data;
      if (against) {
        // Your character: its masteries count as the loadout's (the log doesn't say which).
        const yours = new Set(against);
        previousTree = {
          name: currentTree.name,
          version: currentTree.version,
          ascendancy: currentTree.ascendancy,
          nodes: against,
          masteries: Object.fromEntries(
            Object.entries(currentTree.masteries).filter(([node]) =>
              yours.has(node),
            ),
          ),
        };
      } else if (curIndex != 0) previousTree = urlTrees[curIndex - 1];
      else {
        previousTree = {
          name: currentTree.name,
          version: currentTree.version,
          ascendancy: currentTree.ascendancy,
          nodes: [],
          masteries: {},
        };
      }

      const [skillTree, nodes, svg, viewBox, compiledStyle] =
        await TREE_DATA_LOOKUP[currentTree.version];

      const urlTreeDelta = buildUrlTreeDelta(
        currentTree,
        previousTree,
        skillTree,
      );

      // Zoom to the main-tree changes; ascendancy points sit far away and would
      // shrink the view to the whole tree. Fall back to them if they're all there is.
      const ascendancyNodes = new Set<string>();
      for (const ascendancy of Object.values(skillTree.ascendancies)) {
        if (ascendancy.graphIndex === skillTree.graphIndex) continue;
        const graph = skillTree.graphs[ascendancy.graphIndex];
        if (graph) for (const id in graph.nodes) ascendancyNodes.add(id);
      }
      const mainOnly = (ids: string[]) =>
        ids.filter((id) => !ascendancyNodes.has(id));
      const focusActive = mainOnly(urlTreeDelta.nodesActive);
      const focusAdded = mainOnly(urlTreeDelta.nodesAdded);
      const focusRemoved = mainOnly(urlTreeDelta.nodesRemoved);
      const hasMainFocus =
        focusAdded.length + focusRemoved.length > 0 ||
        (urlTreeDelta.nodesAdded.length + urlTreeDelta.nodesRemoved.length ===
          0 &&
          focusActive.length > 0);

      const bounds = hasMainFocus
        ? calculateBounds(focusActive, focusAdded, focusRemoved, nodes, viewBox)
        : calculateBounds(
            urlTreeDelta.nodesActive,
            urlTreeDelta.nodesAdded,
            urlTreeDelta.nodesRemoved,
            nodes,
            viewBox,
          );

      // PoB's extras: jewel rings under the tree, cluster passives and jewel markers over it.
      const drawing = drawExtras(
        currentExtras,
        previousExtras,
        new Set(currentTree.nodes),
        new Set(previousTree.nodes),
        nodes,
        items,
        (rarity) => RARITY_COLOURS[rarity ?? "NORMAL"] ?? RARITY_COLOURS.NORMAL,
        !!against,
      );
      const drawn = svg
        .replace(/^(<svg[^>]*>\n)/, (open) => open + drawing.under)
        .replace(/<\/svg>\n?$/, () => drawing.over + "</svg>\n");

      const style = compiledStyle({
        styleId: styleId,
        backgroundColor: "#00000000",
        ascendancy: currentTree.ascendancy?.id,

        nodeColor: "hsl(215, 15%, 50%)",
        nodeActiveColor: "hsl(200, 80%, 50%)",
        nodeAddedColor: "hsl(120, 90%, 50%)",
        nodeRemovedColor: "hsl(0, 90%, 50%)",

        connectionColor: "hsl(215, 15%, 40%)",
        connectionActiveColor: "hsl(200, 80%, 40%)",
        connectionAddedColor: "hsl(120, 90%, 40%)",
        connectionRemovedColor: "hsl(0, 90%, 40%)",

        nodesActive: [...urlTreeDelta.nodesActive, ...drawing.nodesActive],
        nodesAdded: [...urlTreeDelta.nodesAdded, ...drawing.nodesAdded],
        nodesRemoved: [...urlTreeDelta.nodesRemoved, ...drawing.nodesRemoved],

        connectionsActive: [
          ...urlTreeDelta.connectionsActive,
          ...drawing.connectionsActive,
        ],
        connectionsAdded: [
          ...urlTreeDelta.connectionsAdded,
          ...drawing.connectionsAdded,
        ],
        connectionsRemoved: [
          ...urlTreeDelta.connectionsRemoved,
          ...drawing.connectionsRemoved,
        ],
      });

      setRenderData({
        svg: drawn,
        style: style + extrasStyle(styleId),
        skillTree,
        nodes,
        intialFocus: bounds,
        masteries: urlTreeDelta.masteries,
        extras: currentExtras,
        previousExtras,
      });
    }

    fn();
  }, [urlTrees, curIndex, against, currentExtras, previousExtras, items]);

  useEffect(() => {
    if (svgDivRef.current === null) return;
    if (renderData === undefined) return;

    const handleEnter = (ev: PointerEvent) => {
      const target = ev.target as SVGElement | null;
      if (target !== null && target.id.startsWith("n")) {
        setHovered({ id: target.id.slice(1), anchor: target });
      }
    };
    const handleLeave = (_ev: PointerEvent) => {
      setHovered(null);
    };

    svgDivRef.current.addEventListener("pointerover", handleEnter);
    svgDivRef.current.addEventListener("pointerout", handleLeave);

    return () => {
      if (svgDivRef.current === null) return;

      svgDivRef.current.removeEventListener("pointerover", handleEnter);
      svgDivRef.current.removeEventListener("pointerout", handleLeave);
    };
  }, [svgDivRef, renderData]);

  const jewels = useMemo(() => {
    const byNode = new Map<string, TreeJewel>();
    for (const jewel of renderData?.extras?.jewels ?? [])
      byNode.set(String(jewel.node), jewel);
    return byNode;
  }, [renderData]);
  const close = useCallback(() => setHovered(null), []);
  // The same objects while the tree is the same: React re-applies inner HTML given a new
  // one, which would swap the tree's elements under the tooltip (closing it) on each hover.
  const svgHtml = useMemo(
    () => ({ __html: renderData?.svg ?? "" }),
    [renderData?.svg],
  );
  const styleHtml = useMemo(
    () => ({ __html: renderData?.style ?? "" }),
    [renderData?.style],
  );

  const jewel = hovered && jewels.get(hovered.id);
  const jewelItem = jewel ? items[String(jewel.item)] : undefined;

  return (
    <>
      {renderData && (
        <div className={classNames(styles.viewer)}>
          {hovered && (
            <Popover anchor={hovered.anchor} pinned={false} onClose={close}>
              {jewelItem ? (
                <ItemTooltip item={jewelItem} />
              ) : (
                <NodeTooltip
                  skillTree={renderData.skillTree}
                  nodes={renderData.nodes}
                  masteries={renderData.masteries}
                  extras={renderData.extras}
                  previousExtras={renderData.previousExtras}
                  nodeId={hovered.id}
                />
              )}
            </Popover>
          )}
          {selectedIndex < 0 && (
            <SetPager titles={titles} index={curIndex} onIndex={setCurIndex} />
          )}
          <div className={styles.viewport}>
            <Viewport
              intialFocus={renderData.intialFocus}
              resizeHandling="contain"
            >
              <style dangerouslySetInnerHTML={styleHtml} />
              <div
                id={styleId}
                ref={svgDivRef}
                dangerouslySetInnerHTML={svgHtml}
              />
            </Viewport>
          </div>
        </div>
      )}
    </>
  );
}

interface NodeTooltipProps {
  skillTree: SkillTree.Data;
  nodes: SkillTree.NodeLookup;
  nodeId: keyof SkillTree.NodeLookup;
  masteries: Record<string, string>;
  extras: TreeExtras | null;
  previousExtras: TreeExtras | null;
}

/**
 * A passive as the build has it: a timeless jewel's version of it (and what it was), a
 * cluster jewel passive from PoB, else the tree's own (with the picked mastery effect).
 */
function NodeTooltip({
  skillTree,
  nodes,
  masteries,
  extras,
  previousExtras,
  nodeId,
}: NodeTooltipProps) {
  const node = nodes[nodeId] as SkillTree.Node | undefined;
  const conquered = extras?.conquered[nodeId];
  const find = (from: TreeExtras | null) =>
    from?.cluster.nodes.find((n) => String(n.id) === nodeId);
  const cluster = find(extras) ?? find(previousExtras);

  const name = conquered?.name ?? cluster?.name ?? node?.text ?? "";
  const lines = (stats: string[]) => stats.flatMap((x) => x.split("\n"));
  let stats: string[];
  if (conquered) stats = lines(conquered.stats);
  else if (cluster) stats = lines(cluster.stats);
  else {
    stats = lines(node?.stats ?? []);
    const masteryEffectId = masteries[nodeId];
    const mastery =
      masteryEffectId !== undefined
        ? skillTree.masteryEffects[masteryEffectId]
        : undefined;
    if (mastery) stats = [...stats, ...lines(mastery.stats)];
  }

  return (
    <PoeTooltip kind="normal" name={name}>
      {stats.length > 0 && (
        <>
          {stats.map((stat, i) => (
            <div key={i} className={classNames(tooltipStyles.mod)}>
              {stat}
            </div>
          ))}
        </>
      )}
      {conquered && node && (
        <TooltipProperty
          label={conquered.by ?? "Timeless jewel"}
          value={`was ${node.text}`}
        />
      )}
    </PoeTooltip>
  );
}
