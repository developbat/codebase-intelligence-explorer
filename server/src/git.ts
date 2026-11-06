import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AnalysisResult,
  GitChangedFile,
  GitCommit,
  GitSnapshotSummary,
  GitStatus,
} from "../../shared/types";
import { isWithin } from "./scanner";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 12 * 1024 * 1024;

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    encoding: "utf8",
  });
  return stdout;
}

export async function getGitSnapshot(rootPath: string): Promise<GitSnapshotSummary> {
  try {
    const inside = (await git(rootPath, ["rev-parse", "--is-inside-work-tree"])).trim();
    if (inside !== "true") return { available: false };
    const branch = (await git(rootPath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    const head = (await git(rootPath, ["rev-parse", "HEAD"])).trim();
    const headSubject = (await git(rootPath, ["log", "-1", "--format=%s"])).trim();
    const status = await git(rootPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    return {
      available: true,
      branch,
      head,
      headSubject,
      dirty: status.length > 0,
      changedFiles: parseStatus(status).length,
    };
  } catch {
    return { available: false };
  }
}

interface ParsedStatus {
  code: string;
  path: string;
  oldPath?: string;
}

function parseStatus(output: string): ParsedStatus[] {
  const tokens = output.split("\0");
  const entries: ParsedStatus[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token.length < 4) continue;
    const code = token.slice(0, 2);
    const filePath = token.slice(3);
    if (!filePath) continue;
    let oldPath: string | undefined;
    if (code.includes("R") || code.includes("C")) {
      oldPath = tokens[index + 1];
      index += 1;
    }
    entries.push({ code, path: filePath.replace(/\\/g, "/"), oldPath });
  }
  return entries;
}

function statusType(code: string): GitChangedFile["status"] {
  if (code === "??") return "untracked";
  if (code.includes("U") || code === "AA" || code === "DD") return "conflicted";
  if (code.includes("R")) return "renamed";
  if (code.includes("A")) return "added";
  if (code.includes("D")) return "deleted";
  return "modified";
}

function hashContent(content: string): string {
  return crypto.createHash("sha1").update(content).digest("hex");
}

async function fileHash(absolutePath: string): Promise<string | null> {
  try {
    return hashContent(await fs.readFile(absolutePath, "utf8"));
  } catch {
    return null;
  }
}

async function numstatMap(root: string, from?: string): Promise<Map<string, { additions: number; deletions: number }>> {
  const map = new Map<string, { additions: number; deletions: number }>();
  try {
    const output = await git(root, ["diff", "--numstat", from ?? "HEAD", "--"]);
    for (const line of output.split("\n")) {
      const [additions, deletions, ...pathParts] = line.split("\t");
      if (!pathParts.length) continue;
      map.set(pathParts.join("\t"), {
        additions: Number.parseInt(additions, 10) || 0,
        deletions: Number.parseInt(deletions, 10) || 0,
      });
    }
  } catch {
    // numstat is optional
  }
  return map;
}

async function commitsBetween(root: string, from: string, to: string): Promise<GitCommit[]> {
  if (!from || from === to) return [];
  try {
    const output = await git(root, [
      "log",
      `--format=%H%x00%h%x00%s%x00%an%x00%aI%x00%D`,
      "--max-count=50",
      `${from}..${to}`,
    ]);
    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, shortHash, subject, author, date, refs] = line.split("\0");
        return { hash, shortHash, subject, author, date, refs: refs || undefined };
      });
  } catch {
    return [];
  }
}

function nodeImpact(analysis: AnalysisResult, changedPath: string, changedPaths: Set<string>): GitChangedFile["affectedNodes"] {
  const nodeById = new Map(analysis.nodes.map((node) => [node.id, node]));
  const affected = new Map<string, { id: string; label: string; kind: AnalysisResult["nodes"][number]["kind"]; directedCallers?: number }>();
  const fileNodeId = `file:${changedPath}`;
  const fileNode = nodeById.get(fileNodeId);
  if (fileNode) affected.set(fileNode.id, { id: fileNode.id, label: fileNode.label, kind: fileNode.kind });

  for (const symbol of analysis.symbols.filter((item) => item.filePath === changedPath)) {
    affected.set(symbol.id, {
      id: symbol.id,
      label: symbol.qualifiedName,
      kind: symbol.kind,
      directedCallers: analysis.edges.filter((edge) => edge.kind === "CALLS" && edge.target === symbol.id).length,
    });
  }

  // Direct dependents from other files are the first impact ring.
  for (const edge of analysis.edges) {
    if (edge.kind !== "CALLS" && edge.kind !== "IMPORTS" && edge.kind !== "ROUTES_TO" && edge.kind !== "READS_FROM" && edge.kind !== "WRITES_TO") {
      continue;
    }
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) continue;
    const touchesChanged = target.filePath === changedPath || (target.kind === "database" && source.filePath === changedPath);
    if (!touchesChanged) continue;
    if (source.filePath && changedPaths.has(source.filePath)) continue;
    affected.set(source.id, { id: source.id, label: source.metadata?.qualifiedName ?? source.label, kind: source.kind });
  }

  return [...affected.values()].slice(0, 24);
}

export async function getGitStatus(rootPath: string, analysis?: AnalysisResult): Promise<GitStatus> {
  const snapshot = await getGitSnapshot(rootPath);
  if (!snapshot.available) {
    return {
      available: false,
      files: [],
      commitsSinceAnalysis: [],
      commitsSinceAnalysisCount: 0,
      message: "This project is not a Git repository (or Git is not installed).",
    };
  }

  const head = snapshot.head ?? "";
  const analysisHead = analysis?.git?.head;
  const parsed = parseStatus(
    await git(rootPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).catch(() => ""),
  );
  const stats = await numstatMap(rootPath);

  const analysisHashes = new Map((analysis?.files ?? []).map((file) => [file.path, file.hash]));
  const files = new Map<string, GitChangedFile>();

  for (const entry of parsed) {
    const currentHash = entry.code.includes("D") ? null : await fileHash(path.join(rootPath, entry.path));
    const previousHash = analysisHashes.get(entry.path);
    const sinceAnalysis =
      previousHash === undefined ? true : currentHash === null ? true : currentHash !== previousHash;
    const numbers = stats.get(entry.path) ?? stats.get(entry.oldPath ?? "");
    files.set(entry.path, {
      path: entry.path,
      oldPath: entry.oldPath,
      status: statusType(entry.code),
      additions: numbers?.additions,
      deletions: numbers?.deletions,
      staged: entry.code[0] !== " " && entry.code[0] !== "?",
      sinceAnalysis,
      committed: false,
    });
  }

  // Committed changes since the analysis snapshot.
  let commits: GitCommit[] = [];
  if (analysisHead && analysisHead !== head) {
    commits = await commitsBetween(rootPath, analysisHead, head);
    try {
      const output = await git(rootPath, ["diff", "--name-status", "--find-renames", analysisHead, head]);
      for (const line of output.split("\n")) {
        if (!line.trim()) continue;
        const [code, ...pathParts] = line.split("\t");
        if (!pathParts.length) continue;
        const filePath = pathParts[pathParts.length - 1].replace(/\\/g, "/");
        const existing = files.get(filePath);
        const type: GitChangedFile["status"] = code.startsWith("A")
          ? "added"
          : code.startsWith("D")
            ? "deleted"
            : code.startsWith("R")
              ? "renamed"
              : "modified";
        files.set(filePath, {
          ...(existing ?? { path: filePath }),
          status: type,
          oldPath: code.startsWith("R") ? pathParts[0] : existing?.oldPath,
          sinceAnalysis: true,
          committed: true,
          staged: true,
        });
      }
    } catch {
      // diff between commits can fail for shallow clones
    }
  }

  let ahead: number | undefined;
  let behind: number | undefined;
  try {
    const counts = (await git(rootPath, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])).trim();
    const [aheadValue, behindValue] = counts.split(/\s+/).map((value) => Number.parseInt(value, 10));
    ahead = aheadValue;
    behind = behindValue;
  } catch {
    // no upstream configured
  }

  const changedPaths = new Set(files.keys());
  const enriched = [...files.values()].map((file) => {
    const affectedNodes = analysis ? nodeImpact(analysis, file.path, changedPaths) : undefined;
    const dependentCount = affectedNodes?.filter((node) => node.kind === "function" || node.kind === "method").length ?? 0;
    return {
      ...file,
      affectedNodes,
      impactLevel: dependentCount > 5 ? ("high" as const) : dependentCount > 0 ? ("medium" as const) : ("low" as const),
    };
  });

  return {
    available: true,
    branch: snapshot.branch,
    head,
    headSubject: snapshot.headSubject,
    ahead,
    behind,
    clean: parsed.length === 0,
    analysisHead,
    analysisCreatedAt: analysis?.createdAt,
    files: enriched.sort((a, b) => a.path.localeCompare(b.path)),
    commitsSinceAnalysis: commits,
    commitsSinceAnalysisCount: commits.length,
    message:
      enriched.length === 0
        ? "Working tree is clean and there are no commits since the last analysis."
        : undefined,
  };
}

export interface GitDiffResult {
  filePath: string;
  base: string;
  diff: string;
  truncated: boolean;
  untracked: boolean;
}

export async function getFileDiff(
  rootPath: string,
  filePath: string,
  base = "HEAD",
): Promise<GitDiffResult> {
  const safeBase = base === "HEAD" || /^[a-f0-9]{7,40}$/i.test(base) ? base : "HEAD";
  const relative = filePath.replace(/^\/+/, "");
  const absolute = path.resolve(rootPath, relative);
  if (!isWithin(rootPath, absolute)) throw new Error("Access outside the project root was denied.");

  const [realRoot, realFile] = await Promise.all([
    fs.realpath(rootPath),
    fs.realpath(absolute).catch(() => absolute),
  ]);
  if (!isWithin(realRoot, realFile)) throw new Error("Access outside the project root was denied.");

  const inside = await git(rootPath, ["rev-parse", "--is-inside-work-tree"]).catch(() => "");
  if (inside.trim() !== "true") throw new Error("This project is not a Git repository.");

  let diff = "";
  let untracked = false;
  try {
    diff = await git(rootPath, ["diff", "--no-color", "--unified=3", safeBase, "--", relative]);
  } catch {
    diff = "";
  }

  if (!diff) {
    try {
      if (await git(rootPath, ["ls-files", "--error-unmatch", "--", relative])) {
        // tracked but no diff against the base
      }
    } catch {
      // untracked file: build a synthetic all-additions diff
      try {
        const content = await fs.readFile(absolute, "utf8");
        const lines = content.split("\n");
        untracked = true;
        diff = [
          "--- /dev/null",
          `+++ b/${relative}`,
          `@@ -0,0 +1,${lines.length} @@`,
          ...lines.map((line) => `+${line}`),
        ].join("\n");
      } catch {
        diff = "";
      }
    }
  }

  const limit = 200_000;
  const truncated = diff.length > limit;
  return {
    filePath: relative,
    base: safeBase,
    diff: truncated ? `${diff.slice(0, limit)}\n… diff truncated …` : diff,
    truncated,
    untracked,
  };
}
