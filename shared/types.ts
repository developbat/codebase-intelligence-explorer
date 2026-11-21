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
  language: string;
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

export interface ProjectTooling {
  ecosystems: string[];
  packageManagers: string[];
  frameworks: string[];
  testFramework?: string;
  testCommands: string[];
  buildCommands: string[];
  typecheckCommands: string[];
  lintCommands: string[];
  formatCommands: string[];
  manifests: string[];
  testFileCount: number;
  hasTests: boolean;
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
  tooling?: ProjectTooling;
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
  parents?: string[];
  /** Compact git-log graph prefix for the commit row. */
  graph?: string;
}

export interface GitGraphRow {
  graph: string;
  commit?: GitCommit;
}

export interface GitCommitHistory {
  commits: GitCommit[];
  rows?: GitGraphRow[];
  hasMore: boolean;
  nextSkip: number;
  branch?: string;
  head?: string;
  message?: string;
}

export interface GitCommitDetail {
  commit: GitCommit;
  parents: string[];
  files: GitChangedFile[];
  stats: {
    files: number;
    additions: number;
    deletions: number;
  };
  merge: boolean;
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
  recentCommits: GitCommit[];
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

export interface SyntaxCheckResult {
  filePath: string;
  supported: boolean;
  command?: string;
  ok: boolean;
  exitCode: number | null;
  output: string;
}

export interface DuplicationOccurrence {
  path: string;
  startLine: number;
  endLine: number;
}

export interface DuplicationBlock {
  hash: string;
  lines: number;
  sample: string;
  occurrences: DuplicationOccurrence[];
}

export interface DuplicationReport {
  filesScanned: number;
  windowLines: number;
  blocks: DuplicationBlock[];
  duplicatedLines: number;
  generatedAt: string;
}

export interface ProjectIndexStatus {
  ready: boolean;
  building: boolean;
  processed: number;
  total: number;
  documents: number;
  updatedAt?: string;
  stale: boolean;
  partial: boolean;
  error?: string;
}

export interface ProjectIndexHit {
  id: string;
  kind: string;
  title: string;
  path?: string;
  line?: number;
  snippet?: string;
  answer?: string;
  score: number;
}

export interface PathChangeResult {
  from: string;
  to: string;
  kind: "file" | "directory";
}

export interface SourceFileContent {
  filePath: string;
  content: string;
  bytes: number;
}

export interface TestDiscovery {
  framework?: string;
  commands: string[];
  testFiles: string[];
  testFileCount: number;
  hasTests: boolean;
}

export interface TestFailure {
  name: string;
  file?: string;
  line?: number;
  message?: string;
}

export interface TestSummary {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
}

export type TestStreamEvent =
  | { type: "output"; stream: "stdout" | "stderr"; chunk: string }
  | { type: "done"; result: TestRunResult }
  | { type: "error"; message: string };

export interface TestRunResult extends RunCommandResult {
  framework?: string;
  summary: TestSummary;
  failures: TestFailure[];
  parsed: boolean;
}

export interface RunCommandResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

export interface TerminalSessionInfo {
  id: string;
  projectId: string;
  cwd: string;
  shell: string;
  pid?: number;
  startedAt: string;
  status: "running" | "exited";
  exitCode: number | null;
}

export type TerminalStreamEvent =
  | { type: "start"; session: TerminalSessionInfo; buffer: string }
  | { type: "output"; chunk: string }
  | { type: "exit"; session: TerminalSessionInfo }
  | { type: "error"; message: string };

export interface BackgroundJob {
  id: string;
  projectId: string;
  command: string;
  cwd: string;
  pid?: number;
  status: "running" | "exited" | "stopped";
  exitCode: number | null;
  startedAt: string;
  endedAt?: string;
  output: string;
  /** Local URLs detected in the process output (dev servers, previews). */
  urls?: string[];
}

export interface BackgroundJobRead {
  job: BackgroundJob;
  output: string;
  offset: number;
}

export interface DevCommandSuggestion {
  label: string;
  command: string;
  kind: "node" | "php" | "python" | "ruby" | "go" | "rust" | "elixir";
  purpose?: "dev" | "install";
}

export type ProjectTemplateId =
  | "blank"
  | "static"
  | "react-vite"
  | "node-express"
  | "python-fastapi"
  | "php-web"
  | "canvas-game"
  | "pwa-mobile"
  | "expo-mobile";

export interface ProjectTemplate {
  id: ProjectTemplateId;
  name: string;
  description: string;
  language: string;
  framework?: string;
  files: string[];
  suggestedCommands: string[];
}

export interface ScaffoldProjectRequest {
  parentPath: string;
  name: string;
  template: ProjectTemplateId;
}

export interface ScaffoldProjectResult {
  rootPath: string;
  name: string;
  template: ProjectTemplateId;
  filesCreated: string[];
  warnings: string[];
  suggestedCommands: string[];
}

export type RunStreamEvent =
  | { type: "start"; command: string; cwd: string }
  | { type: "stdout"; chunk: string }
  | { type: "stderr"; chunk: string }
  | { type: "exit"; result: RunCommandResult }
  | { type: "error"; message: string };

export interface SourceResponse {
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  lines: { number: number; text: string }[];
}
