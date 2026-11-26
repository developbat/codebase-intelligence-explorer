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
