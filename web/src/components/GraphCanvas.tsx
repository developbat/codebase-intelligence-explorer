import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useNodesState,
  useReactFlow,
  useUpdateNodeInternals,
  type Edge,
  type NodeMouseHandler,
} from "@xyflow/react";
import type { GraphNode } from "../../../shared/types";
import { CERTAINTY_COLOR, CERTAINTY_LABEL, EDGE_STYLE, KIND_COLOR } from "../lib/constants";
import { computeLayout, NODE_HEIGHT, NODE_WIDTH } from "../lib/layout";
import type { ViewGraph, ViewMode } from "../lib/viewGraph";
import { useI18n } from "../i18n";
import { EntityNode, type EntityFlowNode } from "./EntityNode";

const NODE_TYPES = { entity: EntityNode };

/**
 * React Flow normally measures nodes with a ResizeObserver. That does not run
 * in occluded/background tabs, which leaves edges unrendered. Since our node
 * dimensions are explicit, force a measurement pass and fit the view.
 */
function GraphAutoFit({ nodeIds }: { nodeIds: string[] }) {
  const updateNodeInternals = useUpdateNodeInternals();
  const { fitView } = useReactFlow();
  const idsKey = nodeIds.join("|");

  useEffect(() => {
    if (nodeIds.length === 0) return;
    const measure = window.setTimeout(() => updateNodeInternals(nodeIds), 0);
    const fit = window.setTimeout(() => {
      updateNodeInternals(nodeIds);
      fitView({ padding: 0.24, maxZoom: 1.25, duration: 180 });
    }, 120);
    return () => {
      window.clearTimeout(measure);
      window.clearTimeout(fit);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, updateNodeInternals, fitView]);

  return null;
}

/**
 * On narrow screens the inspector is a fixed drawer over the canvas. When a
 * selected node would sit underneath it, pan just enough to keep it visible.
 */
function SelectionFocus({ selectedNodeId }: { selectedNodeId: string | null }) {
  const { getInternalNode, getViewport, setViewport } = useReactFlow();

  useEffect(() => {
    if (!selectedNodeId) return;
    const timer = window.setTimeout(() => {
      const inspector = document.querySelector<HTMLElement>(".inspector");
      if (!inspector || getComputedStyle(inspector).position !== "fixed") return;
      const canvas = document.querySelector<HTMLElement>(".graph-canvas");
      const node = getInternalNode(selectedNodeId);
      if (!canvas || !node) return;

      const inset = inspector.getBoundingClientRect().width;
      const visibleRight = canvas.clientWidth - inset;
      const viewport = getViewport();
      const width = node.measured.width ?? node.width ?? 244;
      const height = node.measured.height ?? node.height ?? 78;
      const screenX = (node.internals.positionAbsolute.x + width / 2) * viewport.zoom + viewport.x;
      const screenY = (node.internals.positionAbsolute.y + height / 2) * viewport.zoom + viewport.y;
      const margin = 72;

      if (screenX > margin && screenX < visibleRight - margin) return;

      const targetX = Math.max(margin, visibleRight / 2);
      const targetY = Math.min(Math.max(margin, canvas.clientHeight / 2), canvas.clientHeight - margin);
      setViewport(
        {
          x: viewport.x + (targetX - screenX),
          y: viewport.y + (targetY - screenY),
          zoom: viewport.zoom,
        },
        { duration: 220 },
      );
    }, 320);
    return () => window.clearTimeout(timer);
  }, [selectedNodeId, getInternalNode, getViewport, setViewport]);

  return null;
}

interface GraphCanvasProps {
  view: ViewGraph;
  viewMode: ViewMode;
  viewKey: string;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  onSelectNode: (id: string | null) => void;
  onSelectEdge: (id: string | null) => void;
  onOpenFile: (filePath: string) => void;
  onOpenFolder: (folderPath: string) => void;
  onFocusNode: (id: string) => void;
}

const EDGE_HIGHLIGHT_COLOR = {
  confirmed: "#a9d4ff",
  inferred: "#ffd98f",
  unresolved: "#ff9faf",
} as const;

interface EdgeVisualData extends Record<string, unknown> {
  certainty: keyof typeof EDGE_HIGHLIGHT_COLOR;
  kind: string;
  baseColor: string;
  baseWidth: number;
  baseOpacity: number;
}

function buildFlowEdges(edges: ViewGraph["edges"]): Edge[] {
  return edges.map((edge) => {
    const style = EDGE_STYLE[edge.certainty];
    const isContains = edge.kind === "CONTAINS";
    const baseColor = isContains ? "#263345" : style.color;
    const baseWidth = isContains ? 1 : style.width;
    const baseOpacity = isContains ? 0.7 : 0.95;
    const data: EdgeVisualData = {
      certainty: edge.certainty,
      kind: edge.kind,
      baseColor,
      baseWidth,
      baseOpacity,
    };
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label,
      data,
      labelStyle: { fill: "#93a4bd", fontSize: 10, fontFamily: "inherit" },
      labelBgStyle: { fill: "#0b111b", fillOpacity: 0.86 },
      labelBgPadding: [5, 3] as [number, number],
      labelBgBorderRadius: 4,
      style: {
        stroke: baseColor,
        strokeWidth: baseWidth,
        strokeDasharray: isContains ? "2 5" : style.dash,
        opacity: baseOpacity,
      },
      markerEnd: isContains
        ? undefined
        : {
            type: MarkerType.ArrowClosed,
            color: baseColor,
            width: 14,
            height: 14,
          },
    };
  });
}

export function GraphCanvas({
  view,
  viewMode,
  viewKey,
  selectedNodeId,
  selectedEdgeId,
  onSelectNode,
  onSelectEdge,
  onOpenFile,
  onOpenFolder,
  onFocusNode,
}: GraphCanvasProps) {
  const { t } = useI18n();
  const [nodes, setNodes, onNodesChange] = useNodesState<EntityFlowNode>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [layingOut, setLayingOut] = useState(true);

  const neighborIds = useMemo(() => {
    if (!selectedNodeId) return new Set<string>();
    const neighbours = new Set<string>([selectedNodeId]);
    for (const edge of view.edges) {
      if (edge.source === selectedNodeId) neighbours.add(edge.target);
      if (edge.target === selectedNodeId) neighbours.add(edge.source);
    }
    return neighbours;
  }, [selectedNodeId, view.edges]);

  // Do not fade the whole canvas when the selected node has no relationships
  // (for example the project node in the universe view).
  const dimActive = Boolean(selectedNodeId) && neighborIds.size > 1;

  useEffect(() => {
    let cancelled = false;
    setLayingOut(true);
    computeLayout(view.nodes, view.edges, viewMode)
      .then((positions) => {
        if (cancelled) return;
        const flowNodes: EntityFlowNode[] = view.nodes.map((node: GraphNode) => ({
          id: node.id,
          type: "entity",
          position: positions.get(node.id) ?? { x: 0, y: 0 },
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
          selected: node.id === selectedNodeId,
          data: {
            node,
            dimmed: dimActive && !neighborIds.has(node.id) && node.id !== selectedNodeId,
            neighbor: Boolean(selectedNodeId) && neighborIds.has(node.id) && node.id !== selectedNodeId,
          },
        }));
        setNodes(flowNodes);
        setEdges(buildFlowEdges(view.edges));
        setLayingOut(false);
      })
      .catch(() => setLayingOut(false));
    return () => {
      cancelled = true;
    };
    // Layout only when the view itself changes; selection must not reset positions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  useEffect(() => {
    setNodes((current) =>
      current.map((node) => ({
        ...node,
        selected: node.id === selectedNodeId,
        data: {
          ...node.data,
          dimmed: dimActive && !neighborIds.has(node.id) && node.id !== selectedNodeId,
          neighbor: Boolean(selectedNodeId) && neighborIds.has(node.id) && node.id !== selectedNodeId,
        },
      })),
    );
  }, [selectedNodeId, selectedEdgeId, neighborIds, dimActive, setNodes]);

  const displayEdges = useMemo(
    () =>
      edges.map((edge) => {
        const data = edge.data as EdgeVisualData | undefined;
        const connected =
          Boolean(selectedNodeId) && (edge.source === selectedNodeId || edge.target === selectedNodeId);
        const dimmed = Boolean(selectedNodeId) && !connected;
        const color = connected
          ? data
            ? EDGE_HIGHLIGHT_COLOR[data.certainty]
            : "#a9d4ff"
          : data?.baseColor ?? (edge.style?.stroke as string);
        return {
          ...edge,
          selected: edge.id === selectedEdgeId,
          className: connected ? "edge-connected" : dimmed ? "edge-dimmed" : "",
          style: {
            ...edge.style,
            stroke: color,
            strokeWidth: connected
              ? data?.kind === "CONTAINS"
                ? 1.8
                : 2.6
              : data?.baseWidth ?? edge.style?.strokeWidth,
            opacity: connected ? 1 : dimmed ? 0.14 : data?.baseOpacity ?? edge.style?.opacity,
          },
          labelStyle: {
            ...edge.labelStyle,
            opacity: dimmed ? 0.1 : 1,
          },
          ...(edge.markerEnd && typeof edge.markerEnd === "object"
            ? { markerEnd: { ...edge.markerEnd, color } }
            : {}),
        };
      }),
    [edges, selectedNodeId, selectedEdgeId],
  );

  const handleNodeClick = useCallback<NodeMouseHandler<EntityFlowNode>>(
    (_event, node) => {
      onSelectEdge(null);
      onSelectNode(node.id);
    },
    [onSelectEdge, onSelectNode],
  );

  const handleNodeDoubleClick = useCallback<NodeMouseHandler<EntityFlowNode>>(
    (_event, node) => {
      const entity = node.data.node;
      if (entity.kind === "file" && entity.filePath) onOpenFile(entity.filePath);
      else if (entity.kind === "folder" && entity.filePath) onOpenFolder(entity.filePath);
      else if (entity.kind === "function" || entity.kind === "method") onFocusNode(entity.id);
    },
    [onFocusNode, onOpenFile, onOpenFolder],
  );

  return (
    <div className="graph-canvas">
      {layingOut ? (
        <div className="canvas-loading">
          <span className="spinner" />
          {t("Calculating layout…")}
        </div>
      ) : (
        <ReactFlow
          key={viewKey}
          nodes={nodes}
          edges={displayEdges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onNodeClick={handleNodeClick}
          onNodeDoubleClick={handleNodeDoubleClick}
          onEdgeClick={(_event, edge) => {
            onSelectNode(null);
            onSelectEdge(edge.id);
          }}
          onPaneClick={() => {
            onSelectNode(null);
            onSelectEdge(null);
          }}
          fitView
          fitViewOptions={{ padding: 0.24, maxZoom: 1.25 }}
          minZoom={0.08}
          maxZoom={2.4}
          nodesConnectable={false}
          edgesFocusable
          selectionOnDrag={false}
          proOptions={{ hideAttribution: false }}
        >
          <GraphAutoFit nodeIds={nodes.map((node) => node.id)} />
          <SelectionFocus selectedNodeId={selectedNodeId} />
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.1} color="#1b2534" />
          <Controls showInteractive={false} position="bottom-right" />
          <MiniMap
            pannable
            zoomable
            position="bottom-right"
            nodeColor={(node) => {
              const data = node.data as { node?: GraphNode };
              return data.node ? KIND_COLOR[data.node.kind] : "#64748b";
            }}
            maskColor="rgba(5, 8, 13, 0.72)"
            style={{ width: 150, height: 100 }}
          />
        </ReactFlow>
      )}

      {view.notice ? <div className="canvas-notice">{view.notice}</div> : null}

      <div className="canvas-legend">
        <span className="legend-title">{t("Relationship evidence")}</span>
        {(["confirmed", "inferred", "unresolved"] as const).map((certainty) => (
          <span key={certainty} className="legend-item">
            <span
              className="legend-line"
              style={{
                background: "transparent",
                borderTop: `2px ${certainty === "confirmed" ? "solid" : certainty === "inferred" ? "dashed" : "dotted"} ${CERTAINTY_COLOR[certainty]}`,
              }}
            />
            {t(CERTAINTY_LABEL[certainty])}
          </span>
        ))}
      </div>

      <div className="canvas-hint">
        {t("Click to select · Double-click to open a file/folder or focus")}
      </div>
    </div>
  );
}
