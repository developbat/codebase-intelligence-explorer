import type {
  IntentAnalysis,
  IntentBehaviorAction,
  IntentBehaviorSurface,
} from "./intent";
import type { ProjectDiagnosis } from "./diagnosis";

export type ProjectTaskStatus = "pending" | "in_progress" | "done" | "failed" | "blocked";

export type ProjectTaskEffort = "simple" | "standard" | "hard";

export type ProjectTaskRole = "main" | "fast" | "planner" | "reviewer";

export interface ProjectTask {
  id: string;
  title: string;
  detail: string;
  acceptance?: string;
  status: ProjectTaskStatus;
  /** Per-task safety budget; the loop stops before the next model call. */
  tokenBudget?: number;
  costBudgetUsd?: number;
  effort: ProjectTaskEffort;
  role: ProjectTaskRole;
  /** Structured action from the intent/planner spec. */
  action?: IntentBehaviorAction;
  /** Structured surface from the intent/planner spec. */
  surface?: IntentBehaviorSurface;
  /** Read-only inspection/answer task. */
  readOnly?: boolean;
  /** Verification-only task (no project writes). */
  verificationOnly?: boolean;
  /** Mechanical small edit; use the micro prompt/step budget. */
  microEdit?: boolean;
  /** Per-attempt model-turn cap override (used by narrow repairs). */
  stepBudget?: number;
  /** One agent session covers all checklist items instead of one task per item. */
  buildSession?: boolean;
  /** Small existing-project change: one patch session, no planner/review. */
  patch?: boolean;
  /** Compact failure evidence carried into a retry. */
  retryContext?: string;
  /** Behavior checklist executed inside a build session. */
  checklist?: Array<{ id: string; title: string; acceptance: string }>;
  dependsOn: string[];
  provider?: string;
  model?: string;
  modelOverride?: {
    provider: string;
    model: string;
  };
  attempts: number;
  /** Focused repair passes after a failed verification/incomplete task. */
  repairAttempts?: number;
  notes?: string;
  /** Compact summary of failed tool/protocol calls from this task. */
  toolIssues?: string[];
  resultSummary?: string;
  changedFiles: string[];
  commands: string[];
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  /** Tokens spent across every attempt, including auto-repairs. */
  lifetimeTokens?: number;
  costUsd?: number;
  verification?: {
    command?: string;
    ok?: boolean;
    output?: string;
  };
  review?: {
    verdict: "ok" | "issues";
    summary: string;
    issues: string[];
    provider: string;
    model: string;
    checkedFiles: string[];
    tokenUsage?: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    };
  };
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ProjectTaskStageUsage {
  intent?: { inputTokens: number; outputTokens: number; totalTokens: number };
  diagnosis?: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd?: number };
  planner?: { inputTokens: number; outputTokens: number; totalTokens: number };
  agent?: { inputTokens: number; outputTokens: number; totalTokens: number };
  reviewer?: { inputTokens: number; outputTokens: number; totalTokens: number };
  planReview?: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd?: number };
  verify?: {
    checks: number;
    durationMs: number;
    tokens: { inputTokens: number; outputTokens: number; totalTokens: number };
    costUsd?: number;
  };
  costUsd?: number;
}

export interface ProjectTaskQueue {
  version: 1;
  projectId: string;
  goal: string;
  status: "idle" | "running" | "completed" | "failed" | "stopped";
  createdAt: string;
  updatedAt: string;
  tasks: ProjectTask[];
  notesPath: string;
  planPath: string;
  contextPath: string;
  digestPath: string;
  stageUsage?: ProjectTaskStageUsage;
  /** The intent that created this queue; reused when the queue is resumed. */
  intent?: IntentAnalysis;
  /** Read-only diagnosis generated before planning; reused on resume. */
  diagnosis?: ProjectDiagnosis;
  diagnosisPath?: string;
  planMeta?: {
    version: number;
    goalHash: string;
    reviewedAt: string;
    verdict: "ok" | "replan";
    requirements: string[];
    missing: string[];
    assumptions: string[];
    /** How many AI plan reviews have run for this queue. */
    reviewCount?: number;
  };
}

/** An earlier goal whose queue was replaced by a newer goal. */
export interface ProjectTaskHistoryEntry {
  goal: string;
  status: ProjectTaskQueue["status"];
  createdAt: string;
  updatedAt: string;
  tasks: ProjectTask[];
}

export interface ProjectTaskLoopOptions {
  workspaceMode?: "ask" | "plan" | "build" | "research";
  tokenBudget?: number;
  costBudgetUsd?: number;
  maxTasks?: number;
  maxMinutes?: number;
  provider?: string;
  model?: string;
  allowWrite?: boolean;
  allowCommands?: boolean;
  language?: string;
  activeFile?: string;
  replan?: boolean;
  retryFailed?: boolean;
  /** The user already answered a plan/intent clarification. */
  clarified?: boolean;
  intent?: IntentAnalysis;
  history?: { role: "user" | "assistant"; content: string }[];
  /** Show the local browser window while a verification check runs. */
  liveBrowser?: boolean;
  /** Maximum independent tasks to run at once (default 2 in build mode). */
  parallelTasks?: number;
  /** Token usage of the intent analyst for this run. */
  intentUsage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  intentCostUsd?: number;
}

export interface ProjectTaskLoopResult {
  queue: ProjectTaskQueue;
  summary: string;
  completed: number;
  failed: number;
  stopped: boolean;
  stages?: ProjectTaskStageUsage;
}
