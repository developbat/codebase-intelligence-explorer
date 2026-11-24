import type { AnalysisResult } from "../../../../shared/types";
import type { AiAgentLogEntry, AiContextFile } from "../../../../shared/ai";

export interface ToolPermissionOptions {
  preview?: string;
  destructive?: boolean;
  forceConfirm?: boolean;
}

export interface AgentToolContext {
  projectId: string;
  analysis: AnalysisResult;
  args: Record<string, unknown>;
  readOnly: boolean;
  liveBrowser: boolean;
  signal?: AbortSignal;
  log: (level: AiAgentLogEntry["level"], label: string, detail?: string) => void;
  requirePermission: (
    kind: "write" | "command",
    tool: string,
    target: string | undefined,
    detail: string | undefined,
    options?: ToolPermissionOptions,
  ) => Promise<boolean>;
  evidence: AiContextFile[];
  changedFiles: string[];
  ranCommands: string[];
  invalidate: (paths?: readonly string[]) => void;
  normalizePath: (value: unknown) => string;
  pathFromArgs: (args: Record<string, unknown>) => unknown;
  isSecretPath: (value: string) => boolean;
}

export interface AgentToolResult {
  observation: string;
  ok: boolean;
}

export type AgentToolHandler = (context: AgentToolContext) => Promise<AgentToolResult>;
