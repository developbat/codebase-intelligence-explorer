/**
 * Shared graph contract between the analysis engine and every visualization.
 * The graph is the source of truth: 2D and 3D views consume the same ids.
 */

export type GraphNodeKind =
  | "project"
  | "module"
  | "folder"
  | "file"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "function"
  | "method"
  | "route"
  | "database"
  | "event";

export type GraphEdgeKind =
  | "CONTAINS"
  | "IMPORTS"
  | "EXPORTS"
  | "CALLS"
  | "EXTENDS"
  | "IMPLEMENTS"
  | "ROUTES_TO"
  | "READS_FROM"
  | "WRITES_TO"
  | "PUBLISHES"
  | "SUBSCRIBES_TO"
  | "MAPS_TO"
  | "RELATES_TO";

export type Certainty = "confirmed" | "inferred" | "unresolved";

export interface Evidence {
  filePath: string;
  startLine?: number;
  endLine?: number;
  description?: string;
}

export interface SymbolMetadata {
  qualifiedName?: string;
  signature?: string;
  parameters?: string[];
  returnType?: string;
  exported?: boolean;
  async?: boolean;
  arrow?: boolean;
  external?: boolean;
  unresolved?: boolean;
  /** Number of call sites inside this symbol. */
  callCount?: number;
  /** Number of known callers. */
  callerCount?: number;
  /** Aggregated views only. */
  fileCount?: number;
  symbolCount?: number;
  folderCount?: number;
  aggregate?: boolean;
  packageName?: string;
  [key: string]: unknown;
}

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  language?: string;
  parentId?: string;
  metadata?: SymbolMetadata;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: GraphEdgeKind;
  certainty: Certainty;
  label?: string;
  evidence?: Evidence[];
}

export interface SymbolRecord {
  id: string;
  name: string;
  qualifiedName: string;
  kind: "class" | "interface" | "type" | "enum" | "function" | "method";
  filePath: string;
  startLine: number;
  endLine: number;
  signature: string;
  parameters: string[];
  returnType?: string;
  exported: boolean;
  async: boolean;
  parentSymbolId?: string;
  /** Hash of signature + body, used for change detection. */
  hash?: string;
  /** Truncated source body, kept server-side for AI layers and previews. */
  body?: string;
}

export interface FileRecord {
  id: string;
  path: string;
  language: "typescript" | "tsx" | "javascript" | "jsx" | "prisma" | "sql" | "other";
  bytes: number;
  loc: number;
  hash: string;
  imports: string[];
}

export interface AnalysisStats {
  files: number;
  folders: number;
  lines: number;
  symbols: number;
  functions: number;
  classes: number;
  nodes: number;
  edges: number;
  confirmedEdges: number;
  inferredEdges: number;
  unresolvedEdges: number;
  routes: number;
  databases: number;
  events: number;
  sourceBytes: number;
  durationMs: number;
  truncated: boolean;
}

export interface AiStatus {
  enabled: boolean;
  provider?: string;
  model?: string;
}

export interface AnalysisSummary {
  id: string;
  projectName: string;
  rootPath: string;
  createdAt: string;
  stats: AnalysisStats;
  warnings: string[];
  languages: Record<string, number>;
  frameworks?: string[];
  ai?: AiStatus;
  git?: GitSnapshotSummary;
}

export interface GitSnapshotSummary {
  available: boolean;
  branch?: string;
  head?: string;
  headSubject?: string;
  dirty?: boolean;
  changedFiles?: number;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string;
  refs?: string;
}

export interface GitChangedFile {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";
  oldPath?: string;
  additions?: number;
  deletions?: number;
  staged?: boolean;
  committed?: boolean;
  sinceAnalysis?: boolean;
  impactLevel?: "high" | "medium" | "low";
  affectedNodes?: { id: string; label: string; kind: GraphNodeKind; directedCallers?: number }[];
}

export interface GitStatus {
  available: boolean;
  branch?: string;
  head?: string;
  headSubject?: string;
  ahead?: number;
  behind?: number;
  clean?: boolean;
  files: GitChangedFile[];
  commitsSinceAnalysis: GitCommit[];
  commitsSinceAnalysisCount: number;
  analysisHead?: string;
  analysisCreatedAt?: string;
  message?: string;
}

export interface StructuralChange {
  path: string;
  addedSymbols: string[];
  removedSymbols: string[];
  changedSymbols: string[];
  addedEdges: number;
  removedEdges: number;
}

export interface GitDiffResult {
  filePath: string;
  base: string;
  diff: string;
  truncated: boolean;
  untracked: boolean;
}

export interface ChangeReport {
  projectId: string;
  generatedAt: string;
  git: GitStatus;
  files: GitChangedFile[];
  impact: {
    nodes: { id: string; label: string; kind: GraphNodeKind; filePath?: string; depth: number }[];
    routes: { id: string; label: string; filePath?: string }[];
    tests: { id: string; label: string; filePath?: string }[];
  };
  structural: StructuralChange[];
  summary: {
    changedFiles: number;
    addedFiles: number;
    removedFiles: number;
    changedSymbols: number;
    impactNodes: number;
    callsAffected: number;
  };
  analysis?: AnalysisResult;
  previousAnalysisId: string;
}

export interface AnalysisResult extends AnalysisSummary {
  files: FileRecord[];
  symbols: SymbolRecord[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  externalModules: string[];
}

export interface RecentProject extends AnalysisSummary {
  lastOpenedAt: string;
}

export interface FolderEntry {
  name: string;
  path: string;
  hidden: boolean;
  symlink: boolean;
}

export interface QuickLocation {
  id: string;
  label: string;
  path: string;
}

export interface FolderListing {
  path: string;
  parent: string | null;
  entries: FolderEntry[];
  quickLocations: QuickLocation[];
}

export interface CodeSearchResult {
  nodeId: string;
  label: string;
  kind: GraphNodeKind;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  score: number;
  snippet?: string;
}

export interface CodeSearchResponse {
  query: string;
  results: CodeSearchResult[];
  indexSize: number;
  tookMs: number;
}

export interface SourceResponse {
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  lines: { number: number; text: string }[];
}
