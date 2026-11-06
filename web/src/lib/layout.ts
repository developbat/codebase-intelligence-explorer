import type { GraphEdge, GraphNode } from "../../../shared/types";

export const NODE_WIDTH = 244;
export const NODE_HEIGHT = 78;

export interface PositionedNode {
  id: string;
  x: number;
  y: number;
}

type ElkInstance = InstanceType<(typeof import("elkjs/lib/elk.bundled.js"))["default"]>;

let elkInstance: ElkInstance | null = null;

async function getElk(): Promise<ElkInstance> {
  if (!elkInstance) {
    const module = await import("elkjs/lib/elk.bundled.js");
    elkInstance = new module.default();
  }
  return elkInstance;
}

export async function computeLayout(
  nodes: GraphNode[],
  edges: GraphEdge[],
  mode: "universe" | "files" | "functions" | "architecture" | "changes" | "3d",
): Promise<Map<string, { x: number; y: number }>> {
  const positions = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return positions;

  if (mode === "universe" || nodes.length === 1) {
    const rest = nodes.filter((node) => node.id !== "project");
    if (nodes[0]?.kind === "project" && rest.length > 0) {
      const radius = Math.max(360, (rest.length * 235) / (2 * Math.PI));
      rest.forEach((node, index) => {
        const angle = (index / rest.length) * Math.PI * 2 - Math.PI / 2;
        positions.set(node.id, {
          x: Math.cos(angle) * radius * 1.32 - NODE_WIDTH / 2,
          y: Math.sin(angle) * radius * 0.94 - NODE_HEIGHT / 2,
        });
      });
      positions.set("project", { x: -NODE_WIDTH / 2, y: -NODE_HEIGHT / 2 });
      return positions;
    }
  }

  try {
    const elk = await getElk();
    const graph = {
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.spacing.nodeNode": "52",
        "elk.layered.spacing.nodeNodeBetweenLayers": "120",
        "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
        "elk.edgeRouting": "SPLINES",
        "elk.padding": "[top=40,left=40,bottom=40,right=40]",
      },
      children: nodes.map((node) => ({
        id: node.id,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      })),
      edges: edges.map((edge) => ({
        id: edge.id,
        sources: [edge.source],
        targets: [edge.target],
      })),
    };
    const result = await elk.layout(graph as never);
    for (const child of result.children ?? []) {
      positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
    }
  } catch (error) {
    console.warn("Graph layout fallback:", error);
  }

  // Fallback grid for anything the layout engine could not place.
  let gridIndex = 0;
  for (const node of nodes) {
    if (positions.has(node.id)) continue;
    const columns = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
    positions.set(node.id, {
      x: (gridIndex % columns) * (NODE_WIDTH + 40),
      y: Math.floor(gridIndex / columns) * (NODE_HEIGHT + 40),
    });
    gridIndex += 1;
  }

  return positions;
}
