import { gitInfo } from "../../gitAgent";
import type { AgentToolHandler, AgentToolResult } from "./types";

const gitInfoHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const operation = ["status", "diff", "log", "branches", "remotes"].includes(
    String(context.args.operation),
  )
    ? (String(context.args.operation) as "status" | "diff" | "log" | "branches" | "remotes")
    : "status";
  const output = await gitInfo(context.analysis.rootPath, operation, {
    path: typeof context.args.path === "string" ? context.args.path : undefined,
    limit: Number(context.args.limit) || undefined,
    staged: context.args.staged === true,
  });
  context.log("info", "Git inspected", operation);
  return { observation: output, ok: true };
};

export const GIT_TOOL_HANDLERS: Record<string, AgentToolHandler> = {
  git_info: gitInfoHandler,
};
