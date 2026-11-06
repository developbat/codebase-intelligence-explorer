import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  Box,
  Boxes,
  Braces,
  CircleDot,
  FileCode2,
  Folder,
  FunctionSquare,
  Network,
  Package,
  Radio,
  Route,
  TriangleAlert,
} from "lucide-react";
import type { GraphNode } from "../../../shared/types";
import { KIND_COLOR, KIND_LABEL, truncate } from "../lib/constants";
import { useI18n } from "../i18n";

export interface EntityNodeData extends Record<string, unknown> {
  node: GraphNode;
  dimmed?: boolean;
  neighbor?: boolean;
}

export type EntityFlowNode = Node<EntityNodeData, "entity">;

const ICONS = {
  project: Network,
  module: Package,
  folder: Folder,
  file: FileCode2,
  class: Boxes,
  interface: Braces,
  type: Braces,
  enum: Box,
  function: FunctionSquare,
  method: CircleDot,
  route: Route,
  database: Box,
  event: Radio,
} as const;

function EntityNodeComponent({ data, selected }: NodeProps<EntityFlowNode>) {
  const { t, tn } = useI18n();
  const { node, dimmed, neighbor } = data;
  const color = node.metadata?.unresolved ? "#fb7185" : KIND_COLOR[node.kind];
  const Icon = node.metadata?.unresolved ? TriangleAlert : ICONS[node.kind] ?? Box;
  const fileCount = node.metadata?.fileCount;
  const symbolCount = node.metadata?.symbolCount;
  const qualified = node.metadata?.qualifiedName;

  return (
    <div
      className={`entity-node kind-${node.kind} ${selected ? "is-selected" : ""} ${neighbor ? "is-neighbor" : ""} ${dimmed ? "is-dimmed" : ""} ${node.metadata?.unresolved ? "is-unresolved" : ""}`}
      style={{ "--node-color": color } as React.CSSProperties}
    >
      <Handle type="target" position={Position.Left} className="entity-handle" />
      <div className="entity-node-icon">
        <Icon size={17} strokeWidth={1.9} />
      </div>
      <div className="entity-node-body">
        <div className="entity-node-label" title={node.label}>
          {truncate(node.label, 32)}
        </div>
        <div className="entity-node-sub" title={node.filePath ?? qualified}>
          {node.metadata?.unresolved
            ? t("unresolved")
            : node.kind === "folder"
              ? `${node.metadata?.groupPath ? `${node.metadata.groupPath} · ` : ""}${tn(
                  fileCount ?? 0,
                  "{count} file",
                  "{count} files",
                )}`
              : node.kind === "project"
                ? t("{fileCount} files · {symbolCount} symbols", {
                    fileCount: fileCount ?? 0,
                    symbolCount: symbolCount ?? 0,
                  })
                : node.kind === "module"
                  ? t("external package")
                  : qualified && qualified !== node.label
                    ? truncate(qualified, 34)
                    : node.filePath
                      ? truncate(
                          node.filePath.includes("/")
                            ? node.filePath.slice(0, node.filePath.lastIndexOf("/"))
                            : t("root file"),
                          34,
                        )
                      : t(KIND_LABEL[node.kind])}
        </div>
      </div>
      {node.metadata?.async ? <span className="entity-node-badge">async</span> : null}
      {typeof node.metadata?.callerCount === "number" && node.metadata.callerCount > 0 ? (
        <span className="entity-node-count" title={t("{count} callers", { count: node.metadata.callerCount })}>
          {node.metadata.callerCount}↘
        </span>
      ) : null}
      <Handle type="source" position={Position.Right} className="entity-handle" />
    </div>
  );
}

export const EntityNode = memo(EntityNodeComponent);
