import { gitCommit, gitCreateBranch, gitPush, gitSetRemote } from "../../gitAgent";
import type { AgentToolHandler, AgentToolResult } from "./types";

const gitCommitHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const message = String(context.args.message ?? "").trim();
  if (!message) throw new Error("A commit message is required.");
  const allowed = await context.requirePermission(
    "write",
    "git_commit",
    context.analysis.projectName,
    `Create a Git commit: ${message}`,
    { preview: message },
  );
  if (!allowed) throw new Error("The user denied permission to commit.");
  const result = await gitCommit(context.analysis.rootPath, message, {
    files: Array.isArray(context.args.files) ? context.args.files.map(String) : undefined,
    stageAll: context.args.stageAll === true,
  });
  context.log("success", "Git commit created", result.commit);
  return {
    observation: `Commit ${result.commit ?? "created"}.\n${result.output}`,
    ok: true,
  };
};

const gitCreateBranchHandler: AgentToolHandler = async (
  context,
): Promise<AgentToolResult> => {
  const name = String(context.args.name ?? "").trim();
  if (!name) throw new Error("A branch name is required.");
  const allowed = await context.requirePermission(
    "write",
    "git_create_branch",
    name,
    "Create a Git branch.",
    { preview: name },
  );
  if (!allowed) throw new Error("The user denied permission to create a branch.");
  const result = await gitCreateBranch(
    context.analysis.rootPath,
    name,
    context.args.checkout !== false,
  );
  context.log("success", "Git branch created", result.branch);
  return {
    observation: `Current branch: ${result.branch}\n${result.output}`,
    ok: true,
  };
};

const gitRemoteHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const name = String(context.args.name ?? "origin").trim();
  const url = String(context.args.url ?? "").trim();
  if (!name) throw new Error("A remote name is required.");
  if (!url && context.args.remove !== true) throw new Error("A remote URL is required.");
  const allowed = await context.requirePermission(
    "write",
    "git_remote",
    name,
    context.args.remove === true ? "Remove a Git remote." : `Set Git remote ${name} to ${url}.`,
    { preview: url || name },
  );
  if (!allowed) throw new Error("The user denied permission to update the remote.");
  const output = await gitSetRemote(
    context.analysis.rootPath,
    name,
    url,
    context.args.remove === true,
  );
  context.log("success", "Git remote updated", name);
  return { observation: output || `Remote ${name} updated.`, ok: true };
};

const gitPushHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const remote = typeof context.args.remote === "string" ? context.args.remote.trim() : "origin";
  const branch =
    typeof context.args.branch === "string" ? context.args.branch.trim() : undefined;
  const allowed = await context.requirePermission(
    "command",
    "git_push",
    `${remote}${branch ? `/${branch}` : ""}`,
    "Push local commits to a remote. This cannot be undone on the remote.",
    { destructive: true },
  );
  if (!allowed) throw new Error("The user denied permission to push.");
  const result = await gitPush(context.analysis.rootPath, {
    remote,
    branch,
    setUpstream: context.args.setUpstream !== false,
  });
  context.log("success", "Git push completed", `${result.remote}/${result.branch}`);
  return {
    observation: `Pushed ${result.branch} → ${result.remote}.\n${result.output}`,
    ok: true,
  };
};

export const GIT_WRITE_TOOL_HANDLERS: Record<string, AgentToolHandler> = {
  git_commit: gitCommitHandler,
  git_create_branch: gitCreateBranchHandler,
  git_remote: gitRemoteHandler,
  git_push: gitPushHandler,
};
