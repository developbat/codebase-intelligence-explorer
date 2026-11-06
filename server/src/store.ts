import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AnalysisResult, RecentProject } from "../../shared/types";

const ID_PATTERN = /^[a-f0-9]{16}$/;

export function getDataDir(): string {
  return process.env.CIE_DATA_DIR || path.join(os.homedir(), ".codebase-intelligence-explorer");
}

function projectsDir(): string {
  return path.join(getDataDir(), "projects");
}

function indexPath(): string {
  return path.join(getDataDir(), "index.json");
}

interface StoreIndex {
  projects: RecentProject[];
}

function summaryOf(result: AnalysisResult): RecentProject {
  return {
    id: result.id,
    projectName: result.projectName,
    rootPath: result.rootPath,
    createdAt: result.createdAt,
    lastOpenedAt: new Date().toISOString(),
    stats: result.stats,
    warnings: result.warnings,
    languages: result.languages,
    frameworks: result.frameworks,
    git: result.git,
  };
}

async function readIndex(): Promise<StoreIndex> {
  try {
    const raw = await fs.readFile(indexPath(), "utf8");
    const parsed = JSON.parse(raw) as StoreIndex;
    return { projects: Array.isArray(parsed.projects) ? parsed.projects : [] };
  } catch {
    return { projects: [] };
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  await fs.rename(temp, filePath);
}

async function writeIndex(index: StoreIndex): Promise<void> {
  await writeJsonAtomic(indexPath(), index);
}

export function isValidProjectId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export async function saveAnalysis(result: AnalysisResult): Promise<RecentProject> {
  if (!isValidProjectId(result.id)) throw new Error("Invalid project id.");
  const resultPath = path.join(projectsDir(), result.id, "analysis.json");
  await writeJsonAtomic(resultPath, result);

  const index = await readIndex();
  const withoutCurrent = index.projects.filter((project) => project.id !== result.id);
  const summary = summaryOf(result);
  const projects = [summary, ...withoutCurrent]
    .sort((a, b) => (a.lastOpenedAt < b.lastOpenedAt ? 1 : -1))
    .slice(0, 20);
  await writeIndex({ projects });
  return summary;
}

export async function loadAnalysis(id: string): Promise<AnalysisResult> {
  if (!isValidProjectId(id)) throw new Error("Invalid project id.");
  const raw = await fs.readFile(path.join(projectsDir(), id, "analysis.json"), "utf8");
  return JSON.parse(raw) as AnalysisResult;
}

export async function touchProject(id: string): Promise<void> {
  if (!isValidProjectId(id)) return;
  const index = await readIndex();
  const project = index.projects.find((item) => item.id === id);
  if (!project) return;
  project.lastOpenedAt = new Date().toISOString();
  const projects = index.projects
    .filter((item) => item.id !== id)
    .concat(project)
    .sort((a, b) => (a.lastOpenedAt < b.lastOpenedAt ? 1 : -1));
  await writeIndex({ projects });
}

export async function listRecent(): Promise<RecentProject[]> {
  return (await readIndex()).projects;
}

export async function removeAnalysis(id: string): Promise<void> {
  if (!isValidProjectId(id)) throw new Error("Invalid project id.");
  const index = await readIndex();
  await writeIndex({ projects: index.projects.filter((project) => project.id !== id) });
  await fs.rm(path.join(projectsDir(), id), { recursive: true, force: true });
}
