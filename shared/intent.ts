export type IntentKind = "edit" | "question" | "run" | "scaffold" | "analyze";
export type IntentScope = "trivial" | "small" | "medium" | "large";
export type IntentMode = "single" | "loop";
export type IntentVerification = "none" | "browser" | "test" | "build";
/** How much project context the request actually needs. */
export type IntentContext = "none" | "focused" | "project";
/** How much earlier conversation the request actually needs. */
export type IntentHistory = "none" | "recent" | "extended";
/** Optional tool families for the executor; core read/search tools are always included. */
export type AgentToolGroup =
  | "core"
  | "edit"
  | "command"
  | "document"
  | "web"
  | "git"
  | "browser"
  | "skills"
  | "media"
  | "mobile"
  | "notes"
  | "tools";

export interface IntentOption {
  id: string;
  label: string;
  /** Text appended to the original instruction when the user picks this option. */
  instructionSuffix: string;
  /** When set, the UI should switch to this project and rerun the original request. */
  projectId?: string;
  projectName?: string;
}

export type IntentBehaviorAction =
  | "create"
  | "update"
  | "remove"
  | "move"
  | "verify"
  | "run"
  | "document"
  | "other";

export type IntentBehaviorSurface =
  | "ui"
  | "api"
  | "data"
  | "config"
  | "docs"
  | "game"
  | "other";

export interface IntentBehavior {
  id: string;
  action: IntentBehaviorAction;
  surface: IntentBehaviorSurface;
  target: string;
  details: string;
  acceptance: string;
}

export interface IntentAmbiguity {
  id: string;
  question: string;
  impact: "low" | "high";
  options: IntentOption[];
}

export interface IntentAnalysis {
  kind: IntentKind;
  understanding: string;
  language: string;
  needsClarification: boolean;
  question?: string;
  options?: IntentOption[];
  scope: IntentScope;
  mode: IntentMode;
  areas: string[];
  verification: IntentVerification;
  context: IntentContext;
  history: IntentHistory;
  toolGroups: AgentToolGroup[];
  /** Skill slugs the intent analyst selected for this run (0-3). */
  skills?: string[];
  /** Canonical, language-neutral restatement used by planning/execution. */
  normalizedRequest?: string;
  /** One entry per independent behavior the user asked for. */
  behaviors?: IntentBehavior[];
  /** Explicit user constraints (do not change X, only Y, preserve Z). */
  constraints?: string[];
  /** Required preferences such as a cat theme; separate from domain rules. */
  extras?: string[];
  /** Product decisions that would change the outcome if guessed wrong. */
  ambiguities?: IntentAmbiguity[];
  /** Intent confidence from 0 to 1. */
  confidence?: number;
  approach: string;
  needsExhaustiveEvidence: boolean;
  assumptions: string[];
}

export interface ClarificationRequest {
  question: string;
  options: IntentOption[];
  original: string;
}

export const INTENT_KINDS: IntentKind[] = ["edit", "question", "run", "scaffold", "analyze"];
export const INTENT_SCOPES: IntentScope[] = ["trivial", "small", "medium", "large"];
export const INTENT_MODES: IntentMode[] = ["single", "loop"];
export const INTENT_VERIFICATIONS: IntentVerification[] = ["none", "browser", "test", "build"];
export const INTENT_CONTEXTS: IntentContext[] = ["none", "focused", "project"];
export const INTENT_HISTORIES: IntentHistory[] = ["none", "recent", "extended"];
export const AGENT_TOOL_GROUPS: AgentToolGroup[] = [
  "core",
  "edit",
  "command",
  "document",
  "web",
  "git",
  "browser",
  "skills",
  "media",
  "mobile",
  "notes",
  "tools",
];
