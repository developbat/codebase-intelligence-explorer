import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "./store";
import { isWithin } from "./scanner";

const MAX_WRITE_BYTES = 900_000;
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

async function resolveProjectFile(rootPath: string, filePath: string): Promise<{
  relative: string;
  absolute: string;
}> {
  const relative = filePath.replace(/^\/+/, "");
  const absolute = path.resolve(rootPath, relative);
  if (!isWithin(rootPath, absolute)) throw new Error("Access outside the project root was denied.");
  const [realRoot, realFile] = await Promise.all([
    fs.realpath(rootPath),
    fs.realpath(absolute).catch(() => absolute),
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
  const previous = await fs.readFile(absolute, "utf8").catch(() => null);
  let backupPath: string | undefined;
  if (previous !== null) {
    const backupDir = path.join(getDataDir(), "editor-backups", projectId);
    await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeName = relative.replace(/[\\/]/g, "__");
    backupPath = path.join(backupDir, `${stamp}-${safeName}`);
    await fs.writeFile(backupPath, previous, { encoding: "utf8", mode: 0o600 });
  }
  await fs.writeFile(absolute, content, { encoding: "utf8" });
  return { filePath: relative, bytes: Buffer.byteLength(content, "utf8"), backupPath };
}

export async function runProjectCommand(
  rootPath: string,
  command: string,
  cwd?: string,
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

    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= MAX_OUTPUT_CHARS) {
        truncated = true;
        return current;
      }
      const next = current + chunk.toString("utf8");
      if (next.length > MAX_OUTPUT_CHARS) {
        truncated = true;
        return next.slice(0, MAX_OUTPUT_CHARS);
      }
      return next;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, COMMAND_TIMEOUT_MS);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (exitCode) => {
      clearTimeout(timer);
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
