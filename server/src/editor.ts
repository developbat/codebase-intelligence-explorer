import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "./store";
import { updateIndexedFile } from "./indexer";
import { isWithin } from "./scanner";

const MAX_WRITE_BYTES = 900_000;
const MAX_ASSET_BYTES = 15_000_000;
const MAX_COMMAND_LENGTH = 2_000;
const MAX_OUTPUT_CHARS = 300_000;
const COMMAND_TIMEOUT_MS = 120_000;

export interface SourceFileContent {
  filePath: string;
  content: string;
  bytes: number;
}

export interface RunCommandResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

async function realpathAllowMissing(target: string): Promise<string> {
  let current = target;
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return suffix.length > 0 ? path.join(real, ...suffix.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

async function resolveProjectFile(rootPath: string, filePath: string): Promise<{
  relative: string;
  absolute: string;
}> {
  const relative = filePath.replace(/^\/+/, "");
  const absolute = path.resolve(rootPath, relative);
  if (!isWithin(rootPath, absolute)) throw new Error("Access outside the project root was denied.");
  const [realRoot, realFile] = await Promise.all([
    fs.realpath(rootPath),
    realpathAllowMissing(absolute),
  ]);
  if (!isWithin(realRoot, realFile)) throw new Error("Access outside the project root was denied.");
  return { relative, absolute: realFile };
}

export async function readSourceFile(rootPath: string, filePath: string): Promise<SourceFileContent> {
  const { relative, absolute } = await resolveProjectFile(rootPath, filePath);
  const stat = await fs.stat(absolute);
  if (!stat.isFile()) throw new Error("This path is not a file.");
  if (stat.size > MAX_WRITE_BYTES) throw new Error("This file is too large for the code editor.");
  const content = await fs.readFile(absolute, "utf8");
  return { filePath: relative, content, bytes: Buffer.byteLength(content, "utf8") };
}

export async function createSourceFile(
  projectId: string,
  rootPath: string,
  filePath: string,
): Promise<SourceFileContent> {
  const { relative, absolute } = await resolveProjectFile(rootPath, filePath);
  if (!relative || relative.endsWith("/")) throw new Error("A file path is required.");
  if (isProtectedProjectPath(relative) || isSecretProjectPath(relative)) {
    throw new Error("Environment, key and Git internals files cannot be created from the editor.");
  }
  const exists = await fs.access(absolute).then(() => true).catch(() => false);
  if (exists) throw new Error("This path already exists.");
  await fs.mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
  await fs.writeFile(absolute, "", { encoding: "utf8", mode: 0o600 });
  await updateIndexedFile(projectId, rootPath, relative, "").catch(() => {
    // index update is best-effort
  });
  return { filePath: relative, content: "", bytes: 0 };
}

export async function writeSourceFile(
  projectId: string,
  rootPath: string,
  filePath: string,
  content: string,
): Promise<{ filePath: string; bytes: number; backupPath?: string }> {
  if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
    throw new Error("The file is too large to save from the editor.");
  }
  const { relative, absolute } = await resolveProjectFile(rootPath, filePath);
  if (isSecretProjectPath(relative)) {
    throw new Error("Environment and private key files cannot be written from the editor.");
  }
  const previous = await fs.readFile(absolute, "utf8").catch(() => null);
  let backupPath: string | undefined;
  if (previous !== null) {
    const backupDir = path.join(getDataDir(), "editor-backups", projectId);
    await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeName = relative.replace(/[\\/]/g, "__");
    backupPath = path.join(backupDir, `${stamp}-${crypto.randomUUID().slice(0, 8)}-${safeName}`);
    await fs.writeFile(backupPath, previous, { encoding: "utf8", mode: 0o600 });
  }
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, { encoding: "utf8" });
  await updateIndexedFile(projectId, rootPath, relative, content).catch(() => {
    // index updates must not fail a save
  });
  return { filePath: relative, bytes: Buffer.byteLength(content, "utf8"), backupPath };
}

export interface EditorBackupInfo {
  filePath: string;
  backupPath: string;
  createdAt: string;
}

export async function listEditorBackups(
  projectId: string,
  rootPath: string,
  filePath: string,
): Promise<EditorBackupInfo[]> {
  const { relative } = await resolveProjectFile(rootPath, filePath);
  const backupDir = path.join(getDataDir(), "editor-backups", projectId);
  const safeName = relative.replace(/[\\/]/g, "__");
  const entries = await fs.readdir(backupDir).catch(() => [] as string[]);
  const backups = await Promise.all(
    entries
      .filter((name) => name.endsWith(`-${safeName}`))
      .map(async (name) => {
        const backupPath = path.join(backupDir, name);
        const stat = await fs.stat(backupPath).catch(() => null);
        return {
          filePath: relative,
          backupPath,
          createdAt: name.slice(0, name.length - safeName.length - 1),
          mtimeMs: stat?.mtimeMs ?? 0,
        };
      }),
  );
  return backups
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.createdAt.localeCompare(a.createdAt))
    .map(({ mtimeMs: _mtimeMs, ...backup }) => backup);
}

export async function restoreLatestEditorBackup(
  projectId: string,
  rootPath: string,
  filePath: string,
): Promise<{ filePath: string; backupPath: string; bytes: number; backupOfCurrent?: string }> {
  const backups = await listEditorBackups(projectId, rootPath, filePath);
  const latest = backups[0];
  if (!latest) {
    throw new Error(`No editor backup was found for ${filePath}.`);
  }
  const content = await fs.readFile(latest.backupPath, "utf8");
  const written = await writeSourceFile(projectId, rootPath, latest.filePath, content);
  return {
    filePath: written.filePath,
    backupPath: latest.backupPath,
    bytes: written.bytes,
    backupOfCurrent: written.backupPath,
  };
}

export interface PathChangeResult {
  from: string;
  to: string;
  kind: "file" | "directory";
}

function isProtectedProjectPath(relative: string): boolean {
  const normalized = relative.replace(/\\/g, "/");
  return normalized === ".git" || normalized.startsWith(".git/");
}

export function isSecretProjectPath(relative: string): boolean {
  const normalized = relative.replace(/\\/g, "/");
  if (/(^|\/)\.env(?:\.|$)/i.test(normalized)) return true;
  if (/(^|\/)\.git\//i.test(normalized)) return true;
  return /\.(?:pem|key|p12|pfx|crt|cer|keystore)$/i.test(normalized);
}

export async function renameProjectPath(
  rootPath: string,
  fromPath: string,
  toPath: string,
): Promise<PathChangeResult> {
  const from = await resolveProjectFile(rootPath, fromPath);
  const to = await resolveProjectFile(rootPath, toPath);
  if (
    isProtectedProjectPath(from.relative) ||
    isProtectedProjectPath(to.relative) ||
    isSecretProjectPath(to.relative)
  ) {
    throw new Error("Renaming into environment, key or Git internals paths is not allowed.");
  }
  if (from.relative === to.relative) throw new Error("The source and target paths are the same.");
  const exists = await fs.access(to.absolute).then(() => true).catch(() => false);
  if (exists) throw new Error("The target path already exists.");
  const stat = await fs.lstat(from.absolute);
  await fs.mkdir(path.dirname(to.absolute), { recursive: true });
  await fs.rename(from.absolute, to.absolute);
  return {
    from: from.relative,
    to: to.relative,
    kind: stat.isDirectory() ? "directory" : "file",
  };
}

export async function deleteProjectPath(
  rootPath: string,
  targetPath: string,
): Promise<{ path: string; kind: "file" | "directory" }> {
  const target = await resolveProjectFile(rootPath, targetPath);
  if (isProtectedProjectPath(target.relative)) {
    throw new Error("Deleting Git internals is not allowed.");
  }
  const stat = await fs.lstat(target.absolute);
  if (stat.isDirectory()) {
    const entries = await fs.readdir(target.absolute);
    if (entries.length > 0) {
      throw new Error("Only empty directories can be deleted. Remove or move their files first.");
    }
    await fs.rmdir(target.absolute);
    return { path: target.relative, kind: "directory" };
  }
  await fs.unlink(target.absolute);
  return { path: target.relative, kind: "file" };
}

export interface AssetWriteResult {
  filePath: string;
  bytes: number;
}

export async function writeProjectAsset(
  rootPath: string,
  filePath: string,
  dataBase64: string,
): Promise<AssetWriteResult> {
  const { relative, absolute } = await resolveProjectFile(rootPath, filePath);
  if (!relative) throw new Error("A file path is required.");
  if (isProtectedProjectPath(relative) || isSecretProjectPath(relative)) {
    throw new Error("Assets cannot be written into environment, key or Git internals paths.");
  }
  const compact = dataBase64.replace(/\s+/g, "");
  if (!compact || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    throw new Error("The asset data is not valid base64.");
  }
  const buffer = Buffer.from(compact, "base64");
  if (buffer.byteLength === 0) throw new Error("The asset is empty.");
  if (buffer.byteLength > MAX_ASSET_BYTES) {
    throw new Error("The asset is too large (maximum 15 MB).");
  }
  await fs.mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
  await fs.writeFile(absolute, buffer, { mode: 0o600 });
  return { filePath: relative, bytes: buffer.byteLength };
}

export async function runProjectCommand(
  rootPath: string,
  command: string,
  cwd?: string,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
  } = {},
): Promise<RunCommandResult> {
  const trimmed = command.trim();
  if (!trimmed) throw new Error("A command is required.");
  if (trimmed.length > MAX_COMMAND_LENGTH) throw new Error("The command is too long.");

  const relativeCwd = (cwd ?? "").replace(/^\/+/, "");
  const absoluteCwd = path.resolve(rootPath, relativeCwd || ".");
  if (!isWithin(rootPath, absoluteCwd)) throw new Error("Command working directory is outside the project.");
  const realRoot = await fs.realpath(rootPath);
  const realCwd = await fs.realpath(absoluteCwd);
  if (!isWithin(realRoot, realCwd)) throw new Error("Command working directory is outside the project.");

  const timeoutMs = Math.max(1_000, Math.min(30 * 60_000, options.timeoutMs ?? COMMAND_TIMEOUT_MS));
  const started = Date.now();
  return await new Promise<RunCommandResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;

    const child = spawn(trimmed, {
      cwd: realCwd,
      shell: true,
      windowsHide: true,
      env: { ...process.env, CI: process.env.CI ?? "1" },
    });

    const append = (
      current: string,
      chunk: Buffer,
      emit?: (chunk: string) => void,
    ): string => {
      const text = chunk.toString("utf8");
      if (current.length >= MAX_OUTPUT_CHARS) {
        truncated = true;
        return current;
      }
      const next = current + text;
      if (next.length > MAX_OUTPUT_CHARS) {
        truncated = true;
        emit?.(text.slice(0, Math.max(0, MAX_OUTPUT_CHARS - current.length)));
        return next.slice(0, MAX_OUTPUT_CHARS);
      }
      emit?.(text);
      return next;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk, options.onStdout);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk, options.onStderr);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);

    const onAbort = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        command: trimmed,
        cwd: path.relative(rootPath, realCwd) || ".",
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
        truncated,
      });
    });
  });
}
