import type { AnalysisResult, GraphEdge, GraphNode } from "../../../shared/types";

const MAX_NODES = 1000;
const MAX_EDGES = 3000;

const KIND_PRIORITY: Record<string, number> = {
  project: 0,
  module: 1,
  folder: 2,
  file: 3,
  class: 4,
  interface: 4,
  type: 4,
  enum: 4,
  route: 5,
  database: 5,
  event: 5,
  function: 6,
  method: 6,
};

function score(node: GraphNode): number {
  const callers = typeof node.metadata?.callerCount === "number" ? node.metadata.callerCount : 0;
  const calls = typeof node.metadata?.callCount === "number" ? node.metadata.callCount : 0;
  return callers * 3 + calls + (typeof node.metadata?.fileCount === "number" ? node.metadata.fileCount : 0);
}

/**
 * The 3D explorer intentionally receives a wider graph than the current 2D
 * view so it can show project → module → folder → file → function layers.
 * LOD in the renderer decides which layers are visible at the current zoom.
 */
export function build3DGraph(analysis: AnalysisResult): {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
} {
  const ordered = [...analysis.nodes].sort((a, b) => {
    const kind = (KIND_PRIORITY[a.kind] ?? 9) - (KIND_PRIORITY[b.kind] ?? 9);
    if (kind !== 0) return kind;
    return score(b) - score(a) || a.label.localeCompare(b.label);
  });

  const nodes = ordered.slice(0, MAX_NODES);
  const included = new Set(nodes.map((node) => node.id));
  const edges = analysis.edges
    .filter((edge) => included.has(edge.source) && included.has(edge.target))
    .slice(0, MAX_EDGES);

  return {
    nodes,
    edges,
    truncated: ordered.length > MAX_NODES || analysis.edges.length > MAX_EDGES,
  };
}
