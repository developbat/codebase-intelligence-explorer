import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * GUI-launched apps inherit a minimal PATH (`/usr/bin:/bin:...`), so Homebrew,
 * nvm, pyenv, cargo and friends are invisible. That made every "Install"
 * button in Settings fail with "command not found" even though the tool works
 * in the user's terminal.
 *
 * Build a PATH from the user's login shell plus well-known install locations
 * and apply it once to the server process, so project commands, terminals and
 * toolchain installs all see the same tools the user sees.
 */

let ensured = false;
let cachedPath: string | null = null;

function existingDirectories(directories: string[]): string[] {
  return directories.filter((directory) => {
    try {
      return fs.statSync(directory).isDirectory();
    } catch {
      return false;
    }
  });
}

function nvmDirectories(home: string): string[] {
  const versions = path.join(home, ".nvm", "versions", "node");
  try {
    return fs
      .readdirSync(versions)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
      .map((version) => path.join(versions, version, "bin"));
  } catch {
    return [];
  }
}

function knownDirectories(): string[] {
  if (process.platform === "win32") return [];
  const home = os.homedir();
  return existingDirectories([
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    path.join(home, ".local", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".asdf", "shims"),
    path.join(home, ".asdf", "bin"),
    path.join(home, ".rbenv", "shims"),
    path.join(home, ".pyenv", "shims"),
    path.join(home, ".nodenv", "shims"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".deno", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, "go", "bin"),
    path.join(home, "Library", "pnpm"),
    path.join(home, ".local", "share", "pnpm"),
    path.join(home, "miniconda3", "bin"),
    path.join(home, "anaconda3", "bin"),
    path.join(home, "opt", "anaconda3", "bin"),
    ...nvmDirectories(home),
  ]);
}

function loginShellPath(): string | null {
  if (process.platform === "win32") return null;
  const shell =
    process.env.SHELL ||
    (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  try {
    const output = execFileSync(shell, ["-ilc", "command -p printf '%s\\n' \"$PATH\""], {
      timeout: 3_000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const lines = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("/") && line.includes(path.delimiter));
    return lines.length > 0 ? lines[lines.length - 1] : null;
  } catch {
    return null;
  }
}

function mergePath(entries: string[]): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const entry of entries) {
    for (const part of entry.split(path.delimiter)) {
      const trimmed = part.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      merged.push(trimmed);
    }
  }
  return merged.join(path.delimiter);
}

export function toolchainPath(): string {
  if (cachedPath) return cachedPath;
  cachedPath = mergePath([
    loginShellPath() ?? "",
    knownDirectories().join(path.delimiter),
    process.env.PATH ?? "",
  ]);
  return cachedPath;
}

export function ensureProcessPath(): string {
  if (ensured) return process.env.PATH ?? "";
  process.env.PATH = toolchainPath();
  ensured = true;
  return process.env.PATH;
}
