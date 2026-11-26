import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { getDataDir } from "./store";
import {
  fileKind,
  listSkills,
  parseSkillMd,
  setSkillEnabled,
} from "./skills";
import type {
  InstalledSkillInfo,
  SkillCandidate,
  SkillFile,
  SkillInstallRequest,
  SkillInstallResult,
  SkillInstallScope,
  SkillSourcePreview,
} from "../../shared/skills";

const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 30 * 1024 * 1024;
const MAX_FILES = 8_000;
const MAX_SKILL_BYTES = 8 * 1024 * 1024;
const IGNORED_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv"]);
const LOCK_FILE = "skills-lock.json";

interface SourceFiles {
  files: Map<string, Buffer>;
  repository?: string;
  ref: string;
  source: string;
  hash: string;
  commitSha?: string;
  warnings: string[];
}

interface CandidateInternal {
  candidate: SkillCandidate;
  files: Map<string, Buffer>;
}

interface LockEntry {
  name: string;
  directory: string;
  source: string;
  repository?: string;
  ref: string;
  hash: string;
  commitSha?: string;
  installedAt: string;
  updatedAt: string;
}

interface LockFile {
  version: 1;
  skills: Record<string, LockEntry>;
}

function sourceIdFor(scope: SkillInstallScope): string {
  return scope === "project" ? "project-cie" : "app-global";
}

function targetRoot(projectRoot: string, scope: SkillInstallScope, dataDir: string): string {
  return scope === "project"
    ? path.join(projectRoot, ".cie", "skills")
    : path.join(dataDir, "skills");
}

function lockPath(root: string): string {
  return path.join(root, LOCK_FILE);
}

async function readLock(root: string): Promise<LockFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath(root), "utf8")) as LockFile;
    return { version: 1, skills: parsed.skills ?? {} };
  } catch {
    return { version: 1, skills: {} };
  }
}

async function writeLock(root: string, lock: LockFile): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  const target = lockPath(root);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(lock, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.rename(temp, target);
}

function hashFiles(files: Map<string, Buffer>): string {
  const hash = crypto.createHash("sha256");
  for (const [name, data] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(name);
    hash.update("\0");
    hash.update(data);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

function parseSource(source: string): { kind: "local" | "github"; path?: string; owner?: string; repo?: string; ref?: string; skill?: string } {
  const trimmed = source.trim();
  if (!trimmed) throw new Error("A skill source is required.");
  if (trimmed.startsWith("file://")) {
    return { kind: "local", path: decodeURIComponent(trimmed.slice(7)) };
  }
  if (trimmed.startsWith("/") || trimmed.startsWith("~") || trimmed.startsWith("./") || trimmed.startsWith("../")) {
    return { kind: "local", path: trimmed.startsWith("~") ? path.join(process.env.HOME || "", trimmed.slice(1)) : trimmed };
  }
  let value = trimmed.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  let ref: string | undefined;
  const hashIndex = value.indexOf("#");
  if (hashIndex >= 0) {
    ref = value.slice(hashIndex + 1);
    value = value.slice(0, hashIndex);
  }
  let skill: string | undefined;
  const atIndex = value.lastIndexOf("@");
  if (atIndex > 0) {
    skill = value.slice(atIndex + 1);
    value = value.slice(0, atIndex);
  }
  const parts = value.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("Use owner/repo, a GitHub URL or a local folder.");
  return { kind: "github", owner: parts[0], repo: parts[1], ref, skill };
}

function stripArchiveRoot(files: Map<string, Buffer>): Map<string, Buffer> {
  const roots = new Set<string>();
  for (const name of files.keys()) {
    const [first, ...rest] = name.split("/");
    if (rest.length === 0) return files;
    roots.add(first);
    if (roots.size > 1) return files;
  }
  const [root] = [...roots];
  if (!root) return files;
  const stripped = new Map<string, Buffer>();
  for (const [name, data] of files) {
    stripped.set(name.slice(root.length + 1), data);
  }
  return stripped;
}

function safeArchivePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((segment) => segment === ".." || segment === "")) {
    throw new Error("Archive contains an unsafe path.");
  }
  return normalized;
}

export function parseTarGz(buffer: Buffer): Map<string, Buffer> {
  let unpacked: Buffer;
  try {
    unpacked = zlib.gunzipSync(buffer, { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch {
    throw new Error("Skill archive is corrupt or too large after unpacking.");
  }
  if (unpacked.length > MAX_UNPACKED_BYTES) throw new Error("Skill archive is too large after unpacking.");
  const files = new Map<string, Buffer>();
  let offset = 0;
  let pendingName: string | undefined;
  while (offset + 512 <= unpacked.length) {
    const header = unpacked.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const size = Number.parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    offset += 512;
    const body = unpacked.subarray(offset, offset + size);
    if (type === "5") {
      offset += Math.ceil(size / 512) * 512;
      continue;
    }
    const headerName = safeArchivePath(prefix ? `${prefix}/${name}` : name);
    if (type === "0" || type === "\0") {
      if (!Number.isFinite(size) || size < 0) throw new Error("Invalid tar entry.");
      if (files.size >= MAX_FILES) throw new Error("Skill archive has too many files.");
      files.set(pendingName ?? headerName, Buffer.from(body));
      pendingName = undefined;
    } else if (type === "x" || type === "L") {
      const text = body.toString("utf8");
      const paxPath = /(?:^|\n)\d* ?path=([^\n]+)/.exec(text)?.[1];
      pendingName = (type === "L" ? text.replace(/\0.*/s, "") : paxPath)?.trim()
        ? safeArchivePath((type === "L" ? text.replace(/\0.*/s, "") : (paxPath ?? "")).trim())
        : undefined;
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}

async function readLocalFiles(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  let total = 0;
  async function walk(relative: string): Promise<void> {
    if (files.size >= MAX_FILES) throw new Error("Skill source has too many files.");
    const absolute = path.join(root, relative);
    const entries = await fs.readdir(absolute, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.name.startsWith("._")) continue;
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await walk(next);
      } else if (entry.isFile()) {
        const data = await fs.readFile(path.join(root, next));
        total += data.length;
        if (total > MAX_UNPACKED_BYTES) throw new Error("Skill source is too large.");
        files.set(next, data);
      }
    }
  }
  await walk("");
  return files;
}

async function resolveCommitSha(owner: string, repo: string, ref: string): Promise<string | undefined> {
  if (!owner || !repo) return undefined;
  try {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,
      {
        headers: {
          "User-Agent": "codebase-intelligence-explorer",
          Accept: "application/vnd.github+json",
        },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) return undefined;
    const payload = (await response.json()) as { sha?: unknown };
    return typeof payload.sha === "string" && /^[a-f0-9]{40}$/i.test(payload.sha)
      ? payload.sha
      : undefined;
  } catch {
    return undefined;
  }
}

async function loadSource(source: string, ref?: string): Promise<SourceFiles> {
  const parsed = parseSource(source);
  if (parsed.kind === "local") {
    const root = path.resolve(parsed.path ?? "");
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) throw new Error("Local skill source is not a folder.");
    const files = await readLocalFiles(root);
    return {
      files,
      source,
      ref: ref ?? parsed.ref ?? "local",
      hash: hashFiles(files),
      warnings: [],
    };
  }
  const owner = parsed.owner ?? "";
  const repo = parsed.repo ?? "";
  const targetRef = ref ?? parsed.ref ?? "HEAD";
  const response = await fetch(`https://codeload.github.com/${owner}/${repo}/tar.gz/${encodeURIComponent(targetRef)}`, {
    headers: { "User-Agent": "codebase-intelligence-explorer", Accept: "application/gzip" },
    signal: AbortSignal.timeout(60_000),
  }).catch(() => {
    throw new Error("GitHub skill download failed.");
  });
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}.`);
  const contentLength = Number(response.headers.get("content-length")) || 0;
  if (contentLength > MAX_DOWNLOAD_BYTES) throw new Error("Skill archive is too large.");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_DOWNLOAD_BYTES) throw new Error("Skill archive is too large.");
  const files = stripArchiveRoot(parseTarGz(buffer));
  const commitSha = await resolveCommitSha(owner, repo, targetRef);
  return {
    files,
    source,
    repository: `${owner}/${repo}`,
    ref: targetRef,
    hash: hashFiles(files),
    commitSha,
    warnings: parsed.skill ? [`Filtered to skill "${parsed.skill}".`] : [],
  };
}

function candidatesFrom(source: SourceFiles, filter?: string): CandidateInternal[] {
  const candidates: CandidateInternal[] = [];
  const mdFiles = [...source.files.keys()].filter((file) => file.endsWith("/SKILL.md") || file === "SKILL.md");
  for (const mdPath of mdFiles) {
    const base = path.posix.dirname(mdPath) === "." ? "" : path.posix.dirname(mdPath);
    const raw = source.files.get(mdPath);
    if (!raw) continue;
    const parsed = parseSkillMd(raw.toString("utf8"));
    const relativePath = base || ".";
    const name = (parsed.name ?? path.posix.basename(base || "skill")).trim();
    if (filter && filter.toLowerCase() !== name.toLowerCase() && filter.toLowerCase() !== path.posix.basename(base).toLowerCase()) {
      continue;
    }
    const files = new Map<string, Buffer>();
    for (const [filePath, data] of source.files) {
      if (base ? filePath.startsWith(`${base}/`) : true) {
        files.set(base ? filePath.slice(base.length + 1) : filePath, data);
      }
    }
    const skillFiles: SkillFile[] = [...files.entries()]
      .map(([filePath, data]) => ({ path: filePath, bytes: data.length, kind: fileKind(filePath) }))
      .sort((a, b) => a.path.localeCompare(b.path));
    const bytes = skillFiles.reduce((sum, file) => sum + file.bytes, 0);
    if (bytes > MAX_SKILL_BYTES) {
      source.warnings.push(`${name} is larger than the 8 MB skill limit and was skipped.`);
      continue;
    }
    candidates.push({
      candidate: {
        id: relativePath,
        name,
        description: parsed.description ?? "",
        relativePath,
        body: parsed.body.slice(0, 12_000),
        files: skillFiles,
        bytes,
        hasScripts: skillFiles.some((file) => file.kind === "script"),
        hasReferences: skillFiles.some((file) => file.kind === "reference" || file.kind === "asset"),
        allowedTools: parsed.allowedTools,
      },
      files,
    });
  }
  return candidates.sort((a, b) => a.candidate.name.localeCompare(b.candidate.name));
}

export async function previewSkillSource(source: string, ref?: string): Promise<SkillSourcePreview> {
  const parsed = parseSource(source);
  const loaded = await loadSource(source, ref);
  const candidates = candidatesFrom(loaded, parsed.skill);
  if (candidates.length === 0) throw new Error("No SKILL.md files were found in this source.");
  return {
    source,
    repository: loaded.repository,
    ref: loaded.ref,
    hash: loaded.hash,
    candidates: candidates.map((item) => item.candidate),
    warnings: loaded.warnings,
  };
}

function safeDirectoryName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "skill";
}

async function copySkillFiles(target: string, files: Map<string, Buffer>): Promise<void> {
  for (const [relative, data] of files) {
    const absolute = path.resolve(target, relative);
    if (!absolute.startsWith(`${target}${path.sep}`)) {
      throw new Error("Skill file escaped the install folder.");
    }
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, data);
  }
}

export async function installSkills(
  projectRoot: string,
  projectId: string,
  request: SkillInstallRequest,
  options: { dataDir?: string; homeDir?: string } = {},
): Promise<SkillInstallResult> {
  const scope = request.scope === "global" ? "global" : "project";
  const dataDir = options.dataDir ?? getDataDir();
  const loaded = await loadSource(request.source, request.ref);
  const parsed = parseSource(request.source);
  const candidates = candidatesFrom(loaded, parsed.skill);
  const selected = candidates.filter((item) => request.skills.includes(item.candidate.id));
  if (selected.length === 0) throw new Error("Select at least one skill to install.");
  const root = targetRoot(projectRoot, scope, dataDir);
  await fs.mkdir(root, { recursive: true });
  const lock = await readLock(root);
  const installed: InstalledSkillInfo[] = [];
  const skipped: string[] = [];
  const warnings = [...loaded.warnings];

  for (const { candidate, files } of selected) {
    let directory = safeDirectoryName(candidate.name);
    let counter = 2;
    while (
      (await fs.stat(path.join(root, directory)).then(() => true).catch(() => false)) ||
      Object.values(lock.skills).some((entry) => entry.directory === directory)
    ) {
      directory = `${safeDirectoryName(candidate.name)}-${counter}`;
      counter += 1;
    }
    const target = path.join(root, directory);
    await copySkillFiles(target, files);
    const hash = hashFiles(files);
    const key = `${scope}:${sourceIdFor(scope)}:${directory}`;
    lock.skills[key] = {
      name: candidate.name,
      directory,
      source: request.source,
      repository: loaded.repository,
      ref: loaded.ref,
      hash,
      commitSha: loaded.commitSha,
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (request.enable === true) {
      await setSkillEnabled(projectRoot, projectId, key, true, { dataDir, homeDir: options.homeDir }).catch(() => undefined);
    } else if (request.enable === false) {
      // New skills default to enabled in the scanner; discovery installs must
      // stay disabled until the user has reviewed SKILL.md.
      await setSkillEnabled(projectRoot, projectId, key, false, { dataDir, homeDir: options.homeDir }).catch(() => undefined);
    }
    installed.push({
      key,
      name: candidate.name,
      directory,
      scope,
      source: request.source,
      ref: loaded.ref,
      hash,
      commitSha: loaded.commitSha,
      enabled: request.enable !== false,
    });
  }
  await writeLock(root, lock);
  return { installed, skipped, registryPath: lockPath(root), warnings };
}

export async function removeInstalledSkill(
  projectRoot: string,
  projectId: string,
  key: string,
  options: { dataDir?: string; homeDir?: string } = {},
): Promise<void> {
  const [scopeValue, sourceId, directory] = key.split(":");
  if ((scopeValue !== "project" && scopeValue !== "global") || !directory) {
    throw new Error("Only installed project/global skills can be removed.");
  }
  const scope = scopeValue as SkillInstallScope;
  if (sourceId !== sourceIdFor(scope)) throw new Error("This skill is external and read-only.");
  const dataDir = options.dataDir ?? getDataDir();
  const root = targetRoot(projectRoot, scope, dataDir);
  const lock = await readLock(root);
  const entry = lock.skills[key];
  if (!entry) throw new Error("This is not a managed installed skill.");
  await setSkillEnabled(projectRoot, projectId, key, false, { dataDir, homeDir: options.homeDir }).catch(() => undefined);
  await fs.rm(path.join(root, directory), { recursive: true, force: true });
  delete lock.skills[key];
  await writeLock(root, lock);
}

export async function updateInstalledSkill(
  projectRoot: string,
  projectId: string,
  key: string,
  options: { dataDir?: string; homeDir?: string } = {},
): Promise<InstalledSkillInfo> {
  const [scopeValue, sourceId, directory] = key.split(":");
  if ((scopeValue !== "project" && scopeValue !== "global") || !directory) {
    throw new Error("Only installed project/global skills can be updated.");
  }
  const scope = scopeValue as SkillInstallScope;
  if (sourceId !== sourceIdFor(scope)) throw new Error("This skill is external and read-only.");
  const dataDir = options.dataDir ?? getDataDir();
  const root = targetRoot(projectRoot, scope, dataDir);
  const lock = await readLock(root);
  const entry = lock.skills[key];
  if (!entry) throw new Error("This is not a managed installed skill.");
  const loaded = await loadSource(entry.source, entry.ref);
  const candidates = candidatesFrom(loaded);
  const match = candidates.find(
    (item) =>
      item.candidate.name.toLowerCase() === entry.name.toLowerCase() ||
      item.candidate.id.toLowerCase() === entry.name.toLowerCase(),
  );
  if (!match) throw new Error(`The source no longer contains "${entry.name}".`);
  const target = path.join(root, entry.directory);
  const staging = `${target}.${process.pid}.${Date.now()}.update`;
  try {
    await copySkillFiles(staging, match.files);
    await fs.rm(target, { recursive: true, force: true });
    await fs.rename(staging, target);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  const hash = hashFiles(match.files);
  lock.skills[key] = {
    ...entry,
    ref: loaded.ref,
    hash,
    commitSha: loaded.commitSha,
    updatedAt: new Date().toISOString(),
  };
  await writeLock(root, lock);
  const enabled =
    (await listSkills(projectRoot, projectId, { dataDir, homeDir: options.homeDir }))
      .skills.find((skill) => skill.key === key)?.enabled ?? false;
  return {
    key,
    name: entry.name,
    directory: entry.directory,
    scope,
    source: entry.source,
    ref: loaded.ref,
    hash,
    commitSha: loaded.commitSha,
    enabled,
  };
}

export async function createSkill(
  projectRoot: string,
  projectId: string,
  input: {
    name: string;
    description: string;
    body: string;
    allowedTools?: string;
    enable?: boolean;
  },
  options: { dataDir?: string; homeDir?: string } = {},
): Promise<{
  key: string;
  name: string;
  directory: string;
  path: string;
  enabled: boolean;
}> {
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new Error("A skill name is required.");
  const description = input.description.trim().slice(0, 300);
  if (!description) throw new Error("A skill description is required.");
  const body = input.body.trim();
  if (!body) throw new Error("Skill instructions are required.");
  if (body.length > 12_000) throw new Error("Skill instructions are too large (12k character limit).");
  const root = targetRoot(projectRoot, "project", options.dataDir ?? getDataDir());
  await fs.mkdir(root, { recursive: true });
  let directory = safeDirectoryName(name);
  let counter = 2;
  while (await fs.stat(path.join(root, directory)).then(() => true).catch(() => false)) {
    directory = `${safeDirectoryName(name)}-${counter}`;
    counter += 1;
    if (counter > 50) throw new Error("Could not choose a free skill folder name.");
  }
  const target = path.join(root, directory);
  await fs.mkdir(target, { recursive: true });
  const allowed = input.allowedTools?.trim();
  const lines = ["---", `name: ${name}`, `description: ${description}`];
  if (allowed) lines.push(`allowed-tools: ${allowed}`);
  lines.push("---", "", body, "");
  const document = lines.join("\n");
  await fs.writeFile(path.join(target, "SKILL.md"), document, "utf8");
  const key = `project:project-cie:${directory}`;
  if (input.enable !== false) {
    await setSkillEnabled(projectRoot, projectId, key, true, options).catch(() => undefined);
  }
  const lock = await readLock(root);
  lock.skills[key] = {
    name,
    directory,
    source: "generated",
    ref: "local",
    hash: crypto.createHash("sha1").update(document).digest("hex").slice(0, 16),
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeLock(root, lock);
  return {
    key,
    name,
    directory,
    path: path.relative(projectRoot, path.join(target, "SKILL.md")),
    enabled: input.enable !== false,
  };
}
