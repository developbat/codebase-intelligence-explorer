import type { IntentAnalysis } from "./intent";

export type ProjectTaskStatus = "pending" | "in_progress" | "done" | "failed" | "blocked";

export type ProjectTaskEffort = "simple" | "standard" | "hard";

export type ProjectTaskRole = "main" | "fast" | "planner" | "reviewer";

export interface ProjectTask {
  id: string;
  title: string;
  detail: string;
  acceptance?: string;
  status: ProjectTaskStatus;
  effort: ProjectTaskEffort;
  role: ProjectTaskRole;
  dependsOn: string[];
  provider?: string;
  model?: string;
  modelOverride?: {
    provider: string;
    model: string;
  };
  attempts: number;
  notes?: string;
  resultSummary?: string;
  changedFiles: string[];
  commands: string[];
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  costUsd?: number;
  verification?: {
    command?: string;
    ok?: boolean;
    output?: string;
  };
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
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
}

export interface ProjectTaskLoopOptions {
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
  intent?: IntentAnalysis;
}

export interface ProjectTaskLoopResult {
  queue: ProjectTaskQueue;
  summary: string;
  completed: number;
  failed: number;
  stopped: boolean;
}
