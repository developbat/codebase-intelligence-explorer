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

/** Same data directory the rest of the server uses. */
export function cieDataDir(): string {
  return process.env.CIE_DATA_DIR || path.join(os.homedir(), ".codebase-intelligence-explorer");
}

export function managedToolsRoot(): string {
  return path.join(cieDataDir(), "tools");
}

export function managedToolsBin(): string {
  return process.platform === "win32" ? managedToolsRoot() : path.join(managedToolsRoot(), "bin");
}

/**
 * Root of the Node runtime bundled with the app. Packaged builds put it in
 * `Resources/runtime/node`; dev builds use `vendor/node/current`.
 */
export function bundledNodeRoot(): string | null {
  const candidates: string[] = [];
  const appRoot = process.env.CIE_APP_ROOT;
  if (appRoot) {
    candidates.push(path.resolve(appRoot, "..", "runtime", "node"));
    candidates.push(path.resolve(appRoot, "runtime", "node"));
  }
  candidates.push(path.resolve(process.cwd(), "vendor", "node", "current"));
  for (const candidate of candidates) {
    const binary =
      process.platform === "win32"
        ? path.join(candidate, "node.exe")
        : path.join(candidate, "bin", "node");
    if (fs.existsSync(binary)) return candidate;
  }
  return null;
}

export function bundledNodeBin(): string | null {
  const root = bundledNodeRoot();
  if (!root) return null;
  return process.platform === "win32" ? root : path.join(root, "bin");
}

/** Absolute node + npm-cli pair for app-managed npm installs. */
export function bundledNpmExec(): { node: string; npmCli: string } | null {
  const root = bundledNodeRoot();
  if (!root) return null;
  const node =
    process.platform === "win32" ? path.join(root, "node.exe") : path.join(root, "bin", "node");
  const npmCli =
    process.platform === "win32"
      ? path.join(root, "node_modules", "npm", "bin", "npm-cli.js")
      : path.join(root, "lib", "node_modules", "npm", "bin", "npm-cli.js");
  if (!fs.existsSync(node) || !fs.existsSync(npmCli)) return null;
  return { node, npmCli };
}

/** Quote an argument for the shell used by exec(). */
export function shellQuote(value: string): string {
  if (process.platform === "win32") return `"${value.replace(/"/g, '""')}"`;
  return `'${value.replace(/'/g, `'\''`)}'`;
}

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
  const home = os.homedir();
  if (process.platform === "win32") {
    return existingDirectories([
      path.join(home, "AppData", "Roaming", "npm"),
      path.join(home, "AppData", "Local", "pnpm"),
      path.join(home, "AppData", "Local", "Microsoft", "WinGet", "Links"),
      path.join(home, "go", "bin"),
      path.join(home, ".cargo", "bin"),
      path.join(home, "scoop", "shims"),
    ]);
  }
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

export function resetToolchainPathCache(): void {
  cachedPath = null;
  ensured = false;
}

export function toolchainPath(): string {
  if (cachedPath) return cachedPath;
  cachedPath = mergePath([
    // App-managed tools first, then the bundled LTS runtime. This keeps
    // language servers and npm working on machines with no system Node.
    managedToolsBin(),
    bundledNodeBin() ?? "",
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
