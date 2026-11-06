import type { GraphEdge, GraphNode, GraphNodeKind } from "../../../shared/types";
import { KIND_COLOR } from "./constants";

export type Layout3DKind = "hybrid" | "hierarchical" | "clustered" | "force";

export interface Positioned3D {
  node: GraphNode;
  position: [number, number, number];
  level: number;
  size: number;
  /** Explicit block dimensions for folder plinths and file cards. */
  block?: [number, number, number];
  parentFileId?: string;
}

export interface Cluster3D {
  id: string;
  label: string;
  center: [number, number, number];
  width: number;
  depth: number;
  nodeIds: string[];
  color: string;
  rootId?: string;
}

export interface Layout3DResult {
  nodes: Positioned3D[];
  clusters: Cluster3D[];
  center: [number, number, number];
  radius: number;
  maxLevel: number;
  visibleCountHint: number;
}

interface Hierarchy {
  byId: Map<string, GraphNode>;
  parentById: Map<string, string>;
  childrenById: Map<string, GraphNode[]>;
  levels: Map<string, number>;
  descendantCounts: Map<string, number>;
}

interface ClusterBucket {
  id: string;
  label: string;
  kind: GraphNodeKind;
  color: string;
  root?: GraphNode;
  nodeIds: string[];
  fileCount: number;
  folderCount: number;
  symbolCount: number;
}

const SYMBOL_KINDS = new Set<GraphNodeKind>(["class", "interface", "type", "enum", "function", "method"]);
const CONTAINER_KINDS = new Set<GraphNodeKind>(["folder", "module", "file"]);
const SYNTETHIC_CLUSTERS: Record<string, { label: string; kind: GraphNodeKind }> = {
  "cluster:root-files": { label: "Root files", kind: "file" },
  "cluster:routes": { label: "Routes", kind: "route" },
  "cluster:database": { label: "Database", kind: "database" },
  "cluster:events": { label: "Events", kind: "event" },
  "cluster:symbols": { label: "Symbols", kind: "function" },
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function hashOf(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function buildHierarchy(nodes: GraphNode[]): Hierarchy {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parentById = new Map<string, string>();
  const childrenById = new Map<string, GraphNode[]>();

  for (const node of nodes) {
    if (!node.parentId || !byId.has(node.parentId)) continue;
    parentById.set(node.id, node.parentId);
    const children = childrenById.get(node.parentId) ?? [];
    children.push(node);
    childrenById.set(node.parentId, children);
  }

  const levels = new Map<string, number>();
  function levelOf(node: GraphNode, guard = 0): number {
    if (guard > 64) return 1;
    const cached = levels.get(node.id);
    if (cached !== undefined) return cached;
    if (node.kind === "project" || !node.parentId) {
      levels.set(node.id, 0);
      return 0;
    }
    const parent = byId.get(node.parentId);
    const level = parent ? levelOf(parent, guard + 1) + 1 : 1;
    levels.set(node.id, level);
    return level;
  }
  for (const node of nodes) levelOf(node);

  const descendantCounts = new Map<string, number>();
  function countDescendants(node: GraphNode, guard = 0): number {
    if (guard > 64) return 0;
    const cached = descendantCounts.get(node.id);
    if (cached !== undefined) return cached;
    const children = childrenById.get(node.id) ?? [];
    const count = children.reduce((sum, child) => sum + 1 + countDescendants(child, guard + 1), 0);
    descendantCounts.set(node.id, count);
    return count;
  }
  for (const node of nodes) countDescendants(node);

  return { byId, parentById, childrenById, levels, descendantCounts };
}

function findParentFileId(node: GraphNode, hierarchy: Hierarchy): string | undefined {
  if (node.kind === "file") return node.id;
  let current = node;
  for (let guard = 0; guard < 64; guard += 1) {
    const parent = current.parentId ? hierarchy.byId.get(current.parentId) : undefined;
    if (!parent) return undefined;
    if (parent.kind === "file") return parent.id;
    current = parent;
  }
  return undefined;
}

/**
 * Route/database/event nodes and root-level files sit above the main folder
 * hierarchy. They become visible after the first module layer so the initial
 * architecture view stays readable.
 */
function displayLevel(node: GraphNode, hierarchy: Hierarchy): number {
  const level = hierarchy.levels.get(node.id) ?? (node.kind === "project" ? 0 : 1);
  if (node.kind === "route" || node.kind === "database" || node.kind === "event") {
    return Math.max(2, level);
  }
  if (node.kind === "file" && level === 1) return 2;
  return level;
}

function topClusterFor(node: GraphNode, hierarchy: Hierarchy): string {
  let current = node;
  for (let guard = 0; guard < 64; guard += 1) {
    const parent = current.parentId ? hierarchy.byId.get(current.parentId) : undefined;
    if (!parent || parent.kind === "project") break;
    current = parent;
  }
  if (current.kind === "folder" || current.kind === "module") return current.id;
  if (current.kind === "file") return "cluster:root-files";
  if (current.kind === "route") return "cluster:routes";
  if (current.kind === "database") return "cluster:database";
  if (current.kind === "event") return "cluster:events";
  return "cluster:symbols";
}

function buildClusters(nodes: GraphNode[], hierarchy: Hierarchy): ClusterBucket[] {
  const buckets = new Map<string, ClusterBucket>();
  const project = nodes.find((node) => node.kind === "project");

  for (const node of nodes) {
    if (node.kind === "project") continue;
    const key = topClusterFor(node, hierarchy);
    let bucket = buckets.get(key);
    if (!bucket) {
      const synthetic = SYNTETHIC_CLUSTERS[key];
      const root = hierarchy.byId.get(key);
      bucket = {
        id: key,
        label: root?.label ?? synthetic?.label ?? "Module",
        kind: root?.kind ?? synthetic?.kind ?? "folder",
        color: KIND_COLOR[root?.kind ?? synthetic?.kind ?? "folder"],
        root,
        nodeIds: [],
        fileCount: 0,
        folderCount: 0,
        symbolCount: 0,
      };
      buckets.set(key, bucket);
    }
    bucket.nodeIds.push(node.id);
    if (node.kind === "file") bucket.fileCount += 1;
    else if (node.kind === "folder" || node.kind === "module") bucket.folderCount += 1;
    else if (SYMBOL_KINDS.has(node.kind)) bucket.symbolCount += 1;
  }

  if (project && buckets.size === 0) {
    buckets.set("cluster:root-files", {
      id: "cluster:root-files",
      label: "Project files",
      kind: "file",
      color: KIND_COLOR.file,
      nodeIds: [],
      fileCount: 0,
      folderCount: 0,
      symbolCount: 0,
    });
  }

  return [...buckets.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function clusterSize(cluster: ClusterBucket): number {
  const content = cluster.folderCount + cluster.fileCount;
  return clamp(3.4 + Math.sqrt(content) * 1.05 + Math.sqrt(cluster.fileCount) * 0.34, 3.8, 15);
}

function folderHeight(node: GraphNode, hierarchy: Hierarchy): number {
  const descendants = hierarchy.descendantCounts.get(node.id) ?? 0;
  return clamp(0.24 + Math.log2(descendants + 1) * 0.18, 0.24, 1.35);
}

function baseNodeSize(node: GraphNode): number {
  switch (node.kind) {
    case "project":
      return 1;
    case "folder":
    case "module":
      return 0.34;
    case "file":
      return 0.2;
    case "database":
      return 0.3;
    case "class":
    case "interface":
    case "type":
    case "enum":
      return 0.16;
    case "route":
    case "event":
      return 0.15;
    default:
      return 0.1;
  }
}

function layoutSymbols(
  cluster: ClusterBucket,
  clusterCenter: [number, number, number],
  hierarchy: Hierarchy,
  positions: Map<string, Positioned3D>,
): void {
  const symbols = cluster.nodeIds
    .map((id) => hierarchy.byId.get(id))
    .filter((node): node is GraphNode => Boolean(node) && SYMBOL_KINDS.has(node!.kind));

  const byFile = new Map<string, GraphNode[]>();
  const orphans: GraphNode[] = [];
  for (const symbol of symbols) {
    const fileId = findParentFileId(symbol, hierarchy);
    const file = fileId ? hierarchy.byId.get(fileId) : undefined;
    if (!file || !positions.has(file.id)) {
      orphans.push(symbol);
      continue;
    }
    byFile.set(file.id, [...(byFile.get(file.id) ?? []), symbol]);
  }

  for (const [fileId, fileSymbols] of byFile) {
    const file = positions.get(fileId);
    if (!file) continue;
    fileSymbols.sort((a, b) => a.label.localeCompare(b.label));
    fileSymbols.forEach((symbol, index) => {
      const count = fileSymbols.length;
      const radius = 0.2 + Math.min(0.65, Math.sqrt(count) * 0.08);
      const angle = index * 2.399963229728653;
      const ring = index === 0 ? 0 : radius;
      positions.set(symbol.id, {
        node: symbol,
        position: [
          file.position[0] + Math.cos(angle) * ring,
          file.position[1] + 0.32 + (index % 3) * 0.075,
          file.position[2] + Math.sin(angle) * ring,
        ],
        level: displayLevel(symbol, hierarchy),
        size: baseNodeSize(symbol),
        parentFileId: fileId,
      });
    });
  }

  orphans.forEach((symbol, index) => {
    const angle = index * 2.399963229728653;
    const radius = 1.2 + Math.min(2.2, Math.sqrt(orphans.length) * 0.2);
    positions.set(symbol.id, {
      node: symbol,
      position: [
        clusterCenter[0] + Math.cos(angle) * radius,
        clusterCenter[1] + 0.32 + (index % 3) * 0.07,
        clusterCenter[2] + Math.sin(angle) * radius,
      ],
      level: displayLevel(symbol, hierarchy),
      size: baseNodeSize(symbol),
    });
  });
}

function layoutFolderBranch(
  folder: GraphNode,
  centerX: number,
  centerZ: number,
  areaWidth: number,
  areaDepth: number,
  baseY: number,
  hierarchy: Hierarchy,
  positions: Map<string, Positioned3D>,
): void {
  const height = folderHeight(folder, hierarchy);
  const blockWidth = Math.min(areaWidth * 0.8, 9);
  const blockDepth = Math.min(areaDepth * 0.8, 9);
  positions.set(folder.id, {
    node: folder,
    position: [centerX, baseY + height / 2, centerZ],
    level: displayLevel(folder, hierarchy),
    size: baseNodeSize(folder),
    block: [blockWidth, height, blockDepth],
  });

  const containers = (hierarchy.childrenById.get(folder.id) ?? []).filter((child) =>
    CONTAINER_KINDS.has(child.kind),
  );
  if (containers.length === 0) return;

  const columns = Math.max(1, Math.ceil(Math.sqrt(containers.length)));
  const rows = Math.max(1, Math.ceil(containers.length / columns));
  const usableWidth = blockWidth * 0.78;
  const usableDepth = blockDepth * 0.78;
  const cellWidth = usableWidth / columns;
  const cellDepth = usableDepth / rows;
  const topY = baseY + height + 0.035;

  containers.forEach((child, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = centerX - usableWidth / 2 + (column + 0.5) * cellWidth;
    const z = centerZ - usableDepth / 2 + (row + 0.5) * cellDepth;
    if (child.kind === "folder" || child.kind === "module") {
      layoutFolderBranch(
        child,
        x,
        z,
        cellWidth * 0.86,
        cellDepth * 0.86,
        topY,
        hierarchy,
        positions,
      );
      return;
    }
    positions.set(child.id, {
      node: child,
      position: [x, topY + 0.03, z],
      level: displayLevel(child, hierarchy),
      size: baseNodeSize(child),
      block: [0.92, 0.055, 0.66],
    });
  });
}

function layoutFlatCluster(
  cluster: ClusterBucket,
  centerX: number,
  centerZ: number,
  width: number,
  depth: number,
  hierarchy: Hierarchy,
  positions: Map<string, Positioned3D>,
): void {
  if (cluster.root) {
    const height = folderHeight(cluster.root, hierarchy);
    positions.set(cluster.root.id, {
      node: cluster.root,
      position: [centerX, 0.08 + height / 2, centerZ - depth * 0.33],
      level: displayLevel(cluster.root, hierarchy),
      size: baseNodeSize(cluster.root),
      block: [Math.min(width * 0.5, 6), height, Math.min(depth * 0.3, 3.4)],
    });
  }

  const flatNodes = cluster.nodeIds
    .map((id) => hierarchy.byId.get(id))
    .filter(
      (node): node is GraphNode =>
        Boolean(node) && node!.id !== cluster.root?.id && !SYMBOL_KINDS.has(node!.kind),
    )
    .sort((a, b) => {
      const kind = (CONTAINER_KINDS.has(a.kind) ? 0 : 1) - (CONTAINER_KINDS.has(b.kind) ? 0 : 1);
      return kind || a.label.localeCompare(b.label);
    });

  if (flatNodes.length === 0) return;
  const columns = Math.max(1, Math.ceil(Math.sqrt(flatNodes.length)));
  const rows = Math.max(1, Math.ceil(flatNodes.length / columns));
  const usableWidth = width * 0.8;
  const usableDepth = depth * 0.66;
  const cellWidth = usableWidth / columns;
  const cellDepth = usableDepth / rows;
  const baseZ = centerZ - depth * 0.04;

  flatNodes.forEach((node, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = centerX - usableWidth / 2 + (column + 0.5) * cellWidth;
    const z = baseZ - usableDepth / 2 + (row + 0.5) * cellDepth;
    if (node.kind === "folder" || node.kind === "module") {
      const height = clamp(folderHeight(node, hierarchy) * 0.7, 0.18, 0.7);
      positions.set(node.id, {
        node,
        position: [x, 0.08 + height / 2, z],
        level: displayLevel(node, hierarchy),
        size: baseNodeSize(node),
        block: [Math.min(cellWidth * 0.62, 2.4), height, Math.min(cellDepth * 0.62, 2.4)],
      });
      return;
    }
    if (node.kind === "file") {
      positions.set(node.id, {
        node,
        position: [x, 0.13, z],
        level: displayLevel(node, hierarchy),
        size: baseNodeSize(node),
        block: [0.92, 0.055, 0.66],
      });
      return;
    }
    positions.set(node.id, {
      node,
      position: [x, 0.28, z],
      level: displayLevel(node, hierarchy),
      size: baseNodeSize(node),
    });
  });
}

function computeBounds(nodes: Positioned3D[]): {
  center: [number, number, number];
  radius: number;
} {
  if (nodes.length === 0) return { center: [0, 0, 0], radius: 8 };
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const item of nodes) {
    minX = Math.min(minX, item.position[0]);
    minY = Math.min(minY, item.position[1]);
    minZ = Math.min(minZ, item.position[2]);
    maxX = Math.max(maxX, item.position[0]);
    maxY = Math.max(maxY, item.position[1]);
    maxZ = Math.max(maxZ, item.position[2]);
  }
  const center: [number, number, number] = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  let radius = 6;
  for (const item of nodes) {
    radius = Math.max(
      radius,
      Math.hypot(item.position[0] - center[0], item.position[1] - center[1], item.position[2] - center[2]),
    );
  }
  return { center, radius, };
}

export function layout3D(
  nodes: GraphNode[],
  edges: GraphEdge[],
  kind: Layout3DKind,
): Layout3DResult {
  const hierarchy = buildHierarchy(nodes);
  const positions = new Map<string, Positioned3D>();
  const project = nodes.find((node) => node.kind === "project");
  const maxLevel = Math.max(0, ...[...hierarchy.levels.values()]);

  if (project) {
    positions.set(project.id, {
      node: project,
      position: [0, 0, 0],
      level: 0,
      size: 1,
    });
  }

  if (kind === "force") {
    return layoutForce(nodes, edges, hierarchy, project, maxLevel);
  }

  const clusters = buildClusters(nodes, hierarchy);
  const clusterResults: Cluster3D[] = [];

  if (kind === "hierarchical") {
    const projectNode = project ?? nodes[0];
    if (projectNode) {
      const children = hierarchy.childrenById.get(projectNode.id) ?? [];
      const count = Math.max(1, children.length);
      const ringRadius = Math.max(5.5, Math.sqrt(count) * 2.2);
      children.forEach((child, index) => {
        const angle = (index / count) * Math.PI * 2;
        layoutHierarchyNode(
          child,
          [Math.cos(angle) * ringRadius, -2.8, Math.sin(angle) * ringRadius],
          hierarchy,
          positions,
          1,
          (index / count) * Math.PI * 2,
        );
      });
    }
    const all = [...positions.values()];
    const bounds = computeBounds(all);
    return {
      nodes: all,
      clusters: [],
      center: bounds.center,
      radius: bounds.radius,
      maxLevel,
      visibleCountHint: all.length,
    };
  }

  const totalWidth = clusters.reduce((sum, cluster) => sum + clusterSize(cluster), 0);
  const ringRadius =
    clusters.length <= 1
      ? Math.max(10, ...clusters.map((cluster) => clusterSize(cluster) * 1.7))
      : Math.max(10, (totalWidth + clusters.length * 2.4) / (Math.PI * 2));

  clusters.forEach((cluster, index) => {
    const angle = -Math.PI / 2 + (index / Math.max(1, clusters.length)) * Math.PI * 2;
    const centerX = Math.cos(angle) * ringRadius;
    const centerZ = Math.sin(angle) * ringRadius;
    const size = clusterSize(cluster);
    clusterResults.push({
      id: cluster.id,
      label: cluster.label,
      center: [centerX, 0, centerZ],
      width: size,
      depth: size,
      nodeIds: cluster.nodeIds,
      color: cluster.color,
      rootId: cluster.root?.id,
    });

    if (kind === "clustered") {
      layoutFlatCluster(cluster, centerX, centerZ, size, size, hierarchy, positions);
    } else if (cluster.root) {
      layoutFolderBranch(cluster.root, centerX, centerZ, size, size, 0.08, hierarchy, positions);
    } else {
      layoutFlatCluster(cluster, centerX, centerZ, size, size, hierarchy, positions);
    }
    layoutSymbols(cluster, [centerX, 0, centerZ], hierarchy, positions);
  });

  const all = [...positions.values()];
  const bounds = computeBounds(all);
  return {
    nodes: all,
    clusters: clusterResults,
    center: bounds.center,
    radius: bounds.radius,
    maxLevel,
    visibleCountHint: all.length,
  };
}

function layoutHierarchyNode(
  node: GraphNode,
  position: [number, number, number],
  hierarchy: Hierarchy,
  positions: Map<string, Positioned3D>,
  level: number,
  angleOffset: number,
): void {
  const isFile = node.kind === "file";
  positions.set(node.id, {
    node,
    position,
    level: displayLevel(node, hierarchy),
    size: baseNodeSize(node),
    block: isFile ? [0.92, 0.055, 0.66] : undefined,
  });

  const children = (hierarchy.childrenById.get(node.id) ?? []).filter((child) => child.kind !== "project");
  if (children.length === 0) return;
  const count = children.length;
  const ringRadius = Math.max(1.6, Math.sqrt(count) * 1.05);
  const childY = position[1] - 2.7;
  children.forEach((child, index) => {
    const angle = angleOffset + (index / count) * Math.PI * 2;
    layoutHierarchyNode(
      child,
      [position[0] + Math.cos(angle) * ringRadius, childY, position[2] + Math.sin(angle) * ringRadius],
      hierarchy,
      positions,
      level + 1,
      angle,
    );
  });
}

function layoutForce(
  nodes: GraphNode[],
  edges: GraphEdge[],
  hierarchy: Hierarchy,
  project: GraphNode | undefined,
  maxLevel: number,
): Layout3DResult {
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  const prioritized = [...nodes].sort((a, b) => {
    if (a.kind === "project") return -1;
    if (b.kind === "project") return 1;
    const kind = (CONTAINER_KINDS.has(a.kind) ? 0 : 1) - (CONTAINER_KINDS.has(b.kind) ? 0 : 1);
    if (kind !== 0) return kind;
    return (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0);
  });
  const selected = prioritized.slice(0, 220);
  const selectedIds = new Set(selected.map((node) => node.id));
  const forceEdges = edges.filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target));

  const positions = new Map<string, [number, number, number]>();
  selected.forEach((node, index) => {
    const hash = hashOf(node.id);
    const angle = (hash % 1000) / 1000 * Math.PI * 2;
    const y = ((hash >>> 10) % 1000) / 1000 * 2 - 1;
    const radius = 4 + (index % 7) * 1.4 + ((hash >>> 20) % 100) / 100;
    const ring = Math.sqrt(Math.max(0.05, 1 - y * y));
    positions.set(node.id, [Math.cos(angle) * ring * radius, y * radius * 0.55, Math.sin(angle) * ring * radius]);
  });

  const velocity = new Map<string, [number, number, number]>();
  for (const node of selected) velocity.set(node.id, [0, 0, 0]);

  const iterations = selected.length > 150 ? 55 : 85;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const forces = new Map<string, [number, number, number]>();
    for (const node of selected) forces.set(node.id, [0, 0, 0]);

    for (let a = 0; a < selected.length; a += 1) {
      const first = selected[a];
      const p1 = positions.get(first.id)!;
      for (let b = a + 1; b < selected.length; b += 1) {
        const second = selected[b];
        const p2 = positions.get(second.id)!;
        let dx = p1[0] - p2[0];
        let dy = p1[1] - p2[1];
        let dz = p1[2] - p2[2];
        let distanceSquared = dx * dx + dy * dy + dz * dz;
        if (distanceSquared < 0.04) {
          dx = ((a + 1) % 5) * 0.02 + 0.01;
          dy = ((b + 1) % 3) * 0.02 + 0.01;
          dz = ((a + b + 1) % 7) * 0.02 + 0.01;
          distanceSquared = dx * dx + dy * dy + dz * dz;
        }
        const strength = 26 / (distanceSquared + 0.8);
        const f1 = forces.get(first.id)!;
        const f2 = forces.get(second.id)!;
        f1[0] += dx * strength;
        f1[1] += dy * strength;
        f1[2] += dz * strength;
        f2[0] -= dx * strength;
        f2[1] -= dy * strength;
        f2[2] -= dz * strength;
      }
    }

    for (const edge of forceEdges) {
      const p1 = positions.get(edge.source);
      const p2 = positions.get(edge.target);
      if (!p1 || !p2) continue;
      const dx = p2[0] - p1[0];
      const dy = p2[1] - p1[1];
      const dz = p2[2] - p1[2];
      const distance = Math.max(0.1, Math.hypot(dx, dy, dz));
      const desired = 3.4;
      const strength = (distance - desired) * 0.012;
      const f1 = forces.get(edge.source)!;
      const f2 = forces.get(edge.target)!;
      f1[0] += dx * strength;
      f1[1] += dy * strength;
      f1[2] += dz * strength;
      f2[0] -= dx * strength;
      f2[1] -= dy * strength;
      f2[2] -= dz * strength;
    }

    for (const node of selected) {
      const p = positions.get(node.id)!;
      const v = velocity.get(node.id)!;
      const f = forces.get(node.id)!;
      f[0] += -p[0] * 0.0022;
      f[1] += -p[1] * 0.0022;
      f[2] += -p[2] * 0.0022;
      v[0] = (v[0] + f[0]) * 0.72;
      v[1] = (v[1] + f[1]) * 0.72;
      v[2] = (v[2] + f[2]) * 0.72;
      p[0] += clamp(v[0], -0.6, 0.6);
      p[1] += clamp(v[1], -0.6, 0.6);
      p[2] += clamp(v[2], -0.6, 0.6);
    }
  }

  const result: Positioned3D[] = selected.map((node) => ({
    node,
    position: positions.get(node.id)!,
    level: node.kind === "project" ? 0 : displayLevel(node, hierarchy),
    size: baseNodeSize(node),
  }));
  const bounds = computeBounds(result);
  if (project) {
    const current = result.find((item) => item.node.id === project.id);
    if (current) current.position = [bounds.center[0], bounds.center[1], bounds.center[2]];
  }
  return {
    nodes: result,
    clusters: [],
    center: bounds.center,
    radius: Math.max(9, bounds.radius),
    maxLevel,
    visibleCountHint: result.length,
  };
}
