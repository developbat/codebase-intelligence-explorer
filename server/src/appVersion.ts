import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.CIE_APP_ROOT
  ? path.resolve(process.env.CIE_APP_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function git(args: string[], timeout = 8_000): string | null {
  try {
    return execFileSync("git", ["-C", ROOT, ...args], {
      encoding: "utf8",
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "echo",
      },
    }).trim();
  } catch {
    return null;
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, "").split(".").map((part) => Number(part) || 0);
  const pb = b.replace(/^v/i, "").split(".").map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(pa.length, pb.length); index += 1) {
    const diff = (pa[index] ?? 0) - (pb[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function releaseUrl(remote: string | null): string | null {
  const match = remote?.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/i);
  return match ? `https://github.com/${match[1]}/${match[2]}/releases` : null;
}

export interface AppVersionInfo {
  version: string;
  commit: string | null;
  branch: string | null;
  dirty: boolean;
  remote: string | null;
  releaseUrl: string | null;
  platform: string;
  arch: string;
  node: string;
  electron: string | null;
}

export async function getAppVersionInfo(): Promise<AppVersionInfo> {
  const packageJson = JSON.parse(
    await fs.readFile(path.join(ROOT, "package.json"), "utf8").catch(() => "{}"),
  ) as { version?: string };
  const remote = git(["remote", "get-url", "origin"]);
  const status = git(["status", "--porcelain"]);
  return {
    version: packageJson.version ?? "0.0.0",
    commit: git(["rev-parse", "HEAD"]),
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    dirty: Boolean(status),
    remote,
    releaseUrl: releaseUrl(remote),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    electron: process.versions.electron ?? null,
  };
}

export interface AppUpdateCheck {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  source: "git-tags" | "unavailable";
  releaseUrl: string | null;
  note: string;
}

/**
 * Read-only update check for a source checkout. It never pulls, downloads or
 * executes code; packaged builds use signed electron-updater releases.
 */
export async function checkGitUpdate(): Promise<AppUpdateCheck> {
  const info = await getAppVersionInfo();
  const tags = git(["ls-remote", "--tags", "--refs", "origin"], 12_000);
  if (!tags) {
    return {
      current: info.version,
      latest: null,
      updateAvailable: false,
      source: "unavailable",
      releaseUrl: info.releaseUrl,
      note: "Remote tags could not be read (offline, private repo, or no Git remote).",
    };
  }
  const versions = tags
    .split("\n")
    .map((line) => line.match(/refs\/tags\/(v?\d+\.\d+\.\d+)$/)?.[1] ?? null)
    .filter((value): value is string => Boolean(value))
    .sort(compareVersions);
  const latest = versions.at(-1) ?? null;
  if (!latest) {
    return {
      current: info.version,
      latest: null,
      updateAvailable: false,
      source: "git-tags",
      releaseUrl: info.releaseUrl,
      note: "No semver release tags were found. Create a vX.Y.Z tag to publish an update.",
    };
  }
  const updateAvailable = compareVersions(latest, info.version) > 0;
  return {
    current: info.version,
    latest,
    updateAvailable,
    source: "git-tags",
    releaseUrl: info.releaseUrl,
    note: updateAvailable
      ? "A newer tag exists. Source checkouts can pull it; packaged apps must download the signed release."
      : "Already on the latest tagged version.",
  };
}
