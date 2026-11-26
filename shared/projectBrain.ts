/**
 * Persistent project memory. This is intentionally separate from the static
 * analysis graph: the graph answers "where is X", the brain answers "what is
 * this project, what did we build, what did we decide, and what must not break".
 *
 * The brain is stored under `.cie/agent/project-brain.json` and is injected as a
 * compact brief into every task/chat prompt. It is updated incrementally after
 * each task so a new chat or a follow-up task never starts from zero.
 */

export type ProjectBrainKind =
  | "game"
  | "web-app"
  | "api"
  | "library"
  | "cli"
  | "mobile"
  | "static-site"
  | "unknown";

export interface ProjectBrainCommands {
  run: string[];
  test: string[];
  build: string[];
  typecheck: string[];
  lint: string[];
  format: string[];
}

export interface ProjectBrainGit {
  available: boolean;
  branch?: string;
  head?: string;
  dirty?: boolean;
}

export interface ProjectBrainIdentity {
  name: string;
  kind: ProjectBrainKind;
  stack: string[];
  frameworks: string[];
  languages: string[];
  entryPoints: string[];
  packageManagers: string[];
  commands: ProjectBrainCommands;
  git?: ProjectBrainGit;
}

export interface ProjectBrainModule {
  name: string;
  path: string;
  role: string;
  files: string[];
  symbols: string[];
}

export interface ProjectBrainRoute {
  label: string;
  filePath?: string;
  startLine?: number;
  framework?: string;
}

export interface ProjectBrainDatabaseObject {
  label: string;
  filePath?: string;
  startLine?: number;
}

export interface ProjectBrainArchitecture {
  summary: string;
  modules: ProjectBrainModule[];
  routes: ProjectBrainRoute[];
  dataModel: ProjectBrainDatabaseObject[];
  externalServices: string[];
  stateManagement?: string;
}

export interface ProjectBrainFile {
  path: string;
  role: string;
  loc: number;
  symbols: number;
  /** A few `name:line` entries for fast navigation without re-reading the file. */
  topSymbols?: string[];
  why?: string;
}

export interface ProjectBrainFeature {
  id: string;
  name: string;
  status: "done" | "active" | "planned" | "broken";
  files: string[];
  notes?: string;
  updatedAt: string;
}

export interface ProjectBrainChange {
  at: string;
  kind: "task" | "analysis" | "decision" | "issue";
  summary: string;
  files: string[];
  taskId?: string;
  status?: string;
}

export interface ProjectBrainConstraint {
  id: string;
  text: string;
  kind: "path" | "behavior" | "security" | "style" | "other";
  value?: string;
  source?: string;
}

export interface ProjectBrainDecision {
  at: string;
  text: string;
  reason?: string;
  files?: string[];
}

export interface ProjectBrainIssue {
  text: string;
  severity?: "low" | "medium" | "high";
  files?: string[];
  at?: string;
}

export interface ProjectBrainVerification {
  commands: string[];
  preview?: string;
  checks: string[];
}

export interface ProjectBrainGlossaryEntry {
  term: string;
  meaning: string;
}

export interface ProjectBrain {
  version: 1;
  generatorVersion: number;
  projectId: string;
  rootPath: string;
  generatedAt: string;
  updatedAt: string;
  analysisAt: string;
  identity: ProjectBrainIdentity;
  architecture: ProjectBrainArchitecture;
  inventory: {
    files: ProjectBrainFile[];
    directories: { path: string; role: string }[];
  };
  features: ProjectBrainFeature[];
  conventions: string[];
  decisions: ProjectBrainDecision[];
  constraints: ProjectBrainConstraint[];
  knownIssues: ProjectBrainIssue[];
  recentChanges: ProjectBrainChange[];
  verification: ProjectBrainVerification;
  glossary: ProjectBrainGlossaryEntry[];
  openQuestions: string[];
}

export interface ProjectBrainView {
  brain: ProjectBrain;
  brief: string;
  paths: { json: string; markdown: string };
}
