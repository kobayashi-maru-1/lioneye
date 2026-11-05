import { TREE_DATA_LOOKUP } from "../../state/tree";
import type { UrlTree } from "../../state/tree/url-tree";
import { randomId } from "../../utility";
import { SetPager, useFollowAct } from "../SetPager";
import { SidebarTooltip } from "../SidebarTooltip";
import { Viewport, type ViewportProps } from "../Viewport";
import styles from "./styles.module.css";
import {
  type UrlTreeDelta,
  buildUrlTreeDelta,
  calculateBounds,
} from "./url-tree-delta";
import classNames from "classnames";
import type { SkillTree } from "common";
import React, { type JSX } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

interface SkillTreeViewerProps {
  urlTrees: UrlTree.Data[];
  /** Show this tree (by position) instead of following the act; the pager then hides. */
  selectedIndex?: number;
}

interface RenderData {
  svg: string;
  style: string;
  skillTree: SkillTree.Data;
  nodes: SkillTree.NodeLookup;
  intialFocus: ViewportProps["intialFocus"];
  masteries: UrlTreeDelta["masteries"];
}

export function SkillTreeViewer({
  urlTrees,
  selectedIndex: chosenIndex,
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
  const [tooltipNodeId, setTooltipNodeId] = useState<string | null>(null);

  useEffect(() => {
    async function fn() {
      if (urlTrees.length == 0) return;

      const currentTree = urlTrees[curIndex];
      let previousTree: UrlTree.Data;
      if (curIndex != 0) previousTree = urlTrees[curIndex - 1];
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

        nodesActive: urlTreeDelta.nodesActive,
        nodesAdded: urlTreeDelta.nodesAdded,
        nodesRemoved: urlTreeDelta.nodesRemoved,

        connectionsActive: urlTreeDelta.connectionsActive,
        connectionsAdded: urlTreeDelta.connectionsAdded,
        connectionsRemoved: urlTreeDelta.connectionsRemoved,
      });

      setRenderData({
        svg,
        style,
        skillTree,
        nodes,
        intialFocus: bounds,
        masteries: urlTreeDelta.masteries,
      });
    }

    fn();
  }, [urlTrees, curIndex]);

  useEffect(() => {
    if (svgDivRef.current === null) return;
    if (renderData === undefined) return;

    const handleEnter = (ev: PointerEvent) => {
      const target = ev.target as SVGElement | null;
      if (target !== null && target.id.startsWith("n")) {
        setTooltipNodeId(target.id.slice(1));
      }
    };
    const handleLeave = (_ev: PointerEvent) => {
      setTooltipNodeId(null);
    };

    svgDivRef.current.addEventListener("pointerover", handleEnter);
    svgDivRef.current.addEventListener("pointerout", handleLeave);

    return () => {
      if (svgDivRef.current === null) return;

      svgDivRef.current.removeEventListener("pointerover", handleEnter);
      svgDivRef.current.removeEventListener("pointerout", handleLeave);
    };
  }, [svgDivRef, renderData]);

  return (
    <>
      {renderData && (
        <div className={classNames(styles.viewer)}>
          {tooltipNodeId && (
            <NodeTooltip
              skillTree={renderData.skillTree}
              nodes={renderData.nodes}
              masteries={renderData.masteries}
              nodeId={tooltipNodeId}
            />
          )}
          {selectedIndex < 0 && (
            <SetPager titles={titles} index={curIndex} onIndex={setCurIndex} />
          )}
          <div className={styles.viewport}>
            <Viewport
              intialFocus={renderData.intialFocus}
              resizeHandling="contain"
            >
              <style dangerouslySetInnerHTML={{ __html: renderData.style }} />
              <div
                id={styleId}
                ref={svgDivRef}
                dangerouslySetInnerHTML={{ __html: renderData.svg }}
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
}

function NodeTooltip({
  skillTree,
  nodes,
  masteries,
  nodeId,
}: NodeTooltipProps) {
  const node = nodes[nodeId];

  let parts = [];

  if (node.stats && node.stats.length > 0) {
    for (const stat of node.stats.flatMap((x) => x.split("\n"))) {
      parts.push(<span>{stat}</span>);
    }
  }

  const masteryEffectId = masteries[nodeId];
  if (masteryEffectId) {
    const mastery = skillTree.masteryEffects[masteryEffectId];
    if (mastery.stats.length > 0) {
      for (const stat of mastery.stats.flatMap((x) => x.split("\n"))) {
        parts.push(<span>{stat}</span>);
      }
    }
  }

  return (
    <SidebarTooltip title={node.text}>
      {parts.flatMap<JSX.Element>((x, i) => (
        <React.Fragment key={i}>
          {i !== 0 && <hr />}
          {x}
        </React.Fragment>
      ))}
    </SidebarTooltip>
  );
}
