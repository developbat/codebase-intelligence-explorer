import type { Certainty, GraphEdgeKind, GraphNodeKind } from "../../../shared/types";

/** English source labels; pass them through `t()` for localization. */
export const KIND_LABEL: Record<GraphNodeKind, string> = {
  project: "Project",
  module: "Package",
  folder: "Folder",
  file: "File",
  class: "Class",
  interface: "Interface",
  type: "Type",
  enum: "Enum",
  function: "Function",
  method: "Method",
  route: "Route",
  database: "Database",
  event: "Event",
};

export const KIND_COLOR: Record<GraphNodeKind, string> = {
  project: "#a78bfa",
  module: "#94a3b8",
  folder: "#f5b84b",
  file: "#38bdf8",
  class: "#f472b6",
  interface: "#c084fc",
  type: "#d8b4fe",
  enum: "#e879f9",
  function: "#34d399",
  method: "#2dd4bf",
  route: "#fb923c",
  database: "#f87171",
  event: "#facc15",
};

export const EDGE_LABEL: Record<GraphEdgeKind, string> = {
  CONTAINS: "contains",
  IMPORTS: "imports",
  EXPORTS: "exports",
  CALLS: "calls",
  EXTENDS: "extends",
  IMPLEMENTS: "implements",
  ROUTES_TO: "routes to",
  READS_FROM: "reads from",
  WRITES_TO: "writes to",
  PUBLISHES: "publishes",
  SUBSCRIBES_TO: "subscribes to",
  MAPS_TO: "maps to",
  RELATES_TO: "relates to",
};

export const CERTAINTY_LABEL: Record<Certainty, string> = {
  confirmed: "Confirmed",
  inferred: "Inferred",
  unresolved: "Unresolved",
};

export const CERTAINTY_COLOR: Record<Certainty, string> = {
  confirmed: "#6ea8fe",
  inferred: "#f5b84b",
  unresolved: "#fb7185",
};

export const EDGE_STYLE: Record<Certainty, { dash?: string; color: string; width: number }> = {
  confirmed: { color: "#4d6fa9", width: 1.4 },
  inferred: { color: "#c99a3e", width: 1.5, dash: "6 4" },
  unresolved: { color: "#c4576a", width: 1.5, dash: "2 4" },
};

export function truncate(value: string, max = 60): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function formatNumber(value: number, locale = "en-US"): string {
  return new Intl.NumberFormat(locale).format(value);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function shortPath(filePath: string | undefined, max = 46): string {
  if (!filePath) return "";
  return filePath.length > max ? `…${filePath.slice(-(max - 1))}` : filePath;
}
