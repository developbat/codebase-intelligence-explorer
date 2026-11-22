import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;

async function git(rootPath: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<string> {
  const result = await execFileAsync("git", ["-C", rootPath, ...args], {
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "git failed.";
    throw new Error(message.slice(-1_200));
  });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

export type GitInfoOperation = "status" | "diff" | "log" | "branches" | "remotes";

export async function gitInfo(
  rootPath: string,
  operation: GitInfoOperation,
  options: { path?: string; limit?: number; staged?: boolean } = {},
): Promise<string> {
  const limit = Math.max(1, Math.min(100, Math.round(options.limit ?? 20)));
  if (operation === "status") {
    return (await git(rootPath, ["status", "--short", "--branch"])).slice(0, 16_000) || "Working tree clean.";
  }
  if (operation === "diff") {
    const args = ["diff", "--stat", "--patch"];
    if (options.staged) args.push("--cached");
    if (options.path) args.push("--", options.path);
    return (await git(rootPath, args)).slice(0, 24_000) || "No diff.";
  }
  if (operation === "log") {
    return (
      await git(rootPath, [
        "log",
        `-n`,
        String(limit),
        "--date=short",
        "--pretty=format:%h %ad %d %s",
      ])
    ).slice(0, 16_000);
  }
  if (operation === "branches") {
    return (await git(rootPath, ["branch", "-vv", "--all"])).slice(0, 16_000);
  }
  return (await git(rootPath, ["remote", "-v"])).slice(0, 8_000) || "No remotes configured.";
}

export async function gitCommit(
  rootPath: string,
  message: string,
  options: { files?: string[]; stageAll?: boolean } = {},
): Promise<{ output: string; commit?: string }> {
  const cleanMessage = message.trim().slice(0, 500);
  if (!cleanMessage) throw new Error("A commit message is required.");
  if (options.stageAll) {
    await git(rootPath, ["add", "-A"]);
  } else if (options.files && options.files.length > 0) {
    const files = options.files
      .map((file) => file.trim())
      .filter(Boolean)
      .filter((file) => !file.includes(".."))
      .slice(0, 100);
    if (files.length === 0) throw new Error("No valid files to stage.");
    await git(rootPath, ["add", "--", ...files]);
  }
  const output = await git(rootPath, ["commit", "-m", cleanMessage]);
  const commit = await git(rootPath, ["rev-parse", "--short", "HEAD"]).catch(() => "");
  return { output: output.slice(0, 8_000), commit: commit || undefined };
}

export async function gitCreateBranch(
  rootPath: string,
  name: string,
  checkout = true,
): Promise<{ branch: string; output: string }> {
  const branch = name.trim();
  if (!/^[A-Za-z0-9._/-]{1,120}$/.test(branch) || branch.startsWith("-") || branch.includes("..")) {
    throw new Error("Invalid branch name.");
  }
  const output = await git(rootPath, checkout ? ["switch", "-c", branch] : ["branch", branch]);
  const current = await git(rootPath, ["branch", "--show-current"]);
  return { branch: current, output: output.slice(0, 4_000) };
}

export async function gitSetRemote(
  rootPath: string,
  name: string,
  url: string,
  remove = false,
): Promise<string> {
  const remote = name.trim();
  if (!/^[A-Za-z0-9._-]{1,60}$/.test(remote)) throw new Error("Invalid remote name.");
  if (remove) {
    return (await git(rootPath, ["remote", "remove", remote])).slice(0, 2_000);
  }
  const target = url.trim();
  if (!/^(https?:\/\/|ssh:\/\/|git@|git:\/\/)/i.test(target) || /\s/.test(target)) {
    throw new Error("Remote URL must be an http(s), ssh or git URL without spaces.");
  }
  const existing = await git(rootPath, ["remote"]).catch(() => "");
  const has = existing.split("\n").map((line) => line.trim()).includes(remote);
  const output = await git(rootPath, ["remote", has ? "set-url" : "add", remote, target]);
  return output.slice(0, 2_000) || `${remote} → ${target}`;
}

export async function gitPush(
  rootPath: string,
  options: { remote?: string; branch?: string; setUpstream?: boolean } = {},
): Promise<{ output: string; remote: string; branch: string }> {
  const remotes = (await git(rootPath, ["remote"]).catch(() => ""))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (remotes.length === 0) throw new Error("No Git remote is configured. Use git_remote first.");
  const remote = options.remote?.trim() || (remotes.includes("origin") ? "origin" : remotes[0]);
  if (!remotes.includes(remote)) throw new Error(`Unknown remote: ${remote}`);
  const current = await git(rootPath, ["branch", "--show-current"]).catch(() => "");
  const branch = options.branch?.trim() || current.trim();
  if (!branch) throw new Error("Detached HEAD; provide a branch name to push.");
  const args = ["push"];
  if (options.setUpstream !== false) args.push("-u");
  args.push(remote, branch);
  const output = await git(rootPath, args, 180_000);
  return { output: output.slice(0, 8_000), remote, branch };
}
