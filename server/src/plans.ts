import fs from "node:fs/promises";
import path from "node:path";
import { isWithin } from "./scanner";

export interface PlanSummary {
  name: string;
  path: string;
  title: string;
  createdAt: string;
  bytes: number;
}

const PROJECT_PLAN_RELATIVE = ".cie/agent/PLAN.md";

function plansDir(rootPath: string): string {
  return path.join(rootPath, ".cie", "agent", "plans");
}

function projectPlanAbsolute(rootPath: string): string {
  return path.resolve(rootPath, PROJECT_PLAN_RELATIVE);
}

export function projectPlanPath(): string {
  return PROJECT_PLAN_RELATIVE;
}

export async function readLatestProjectPlan(
  rootPath: string,
  maxChars = 6_000,
): Promise<string> {
  try {
    const content = await fs.readFile(projectPlanAbsolute(rootPath), "utf8");
    return content.trim().slice(-Math.max(500, maxChars));
  } catch {
    return "";
  }
}

export async function appendProjectPlan(
  rootPath: string,
  content: string,
  title: string,
): Promise<string> {
  const clean = content.trim();
  if (!clean) return "";
  const absolute = projectPlanAbsolute(rootPath);
  if (!isWithin(rootPath, absolute)) throw new Error("Project plan path is outside the project.");
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  let existing = "";
  try {
    existing = await fs.readFile(absolute, "utf8");
  } catch {
    existing = "# Project plan\n";
  }
  const stamp = new Date().toISOString();
  const section = `\n\n---\n\n## ${stamp.slice(0, 16).replace("T", " ")} — ${title}\n\n${clean}\n`;
  await fs.writeFile(absolute, `${existing.trimEnd()}${section}`, "utf8");
  return PROJECT_PLAN_RELATIVE;
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function safePlanName(name: string): string {
  const base = path.basename(name).trim();
  if (!base || base === "." || base === ".." || !/\.md$/i.test(base)) {
    throw new Error("A Markdown plan name is required.");
  }
  return base;
}

export async function savePlan(
  rootPath: string,
  content: string,
  options: { title?: string; goal?: string } = {},
): Promise<PlanSummary> {
  const clean = content.trim();
  if (!clean) throw new Error("A plan cannot be empty.");
  const firstHeading = clean.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const title =
    options.title?.trim() ||
    firstHeading ||
    options.goal?.trim().slice(0, 80) ||
    "Plan";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const name = `${stamp}-${slugify(title) || "plan"}.md`;
  const directory = plansDir(rootPath);
  await fs.mkdir(directory, { recursive: true });
  const absolute = path.resolve(directory, name);
  if (!isWithin(rootPath, absolute)) throw new Error("Plan path is outside the project.");
  await fs.writeFile(absolute, `${clean}\n`, "utf8");
  await appendProjectPlan(rootPath, clean, title).catch(() => undefined);
  const stat = await fs.stat(absolute);
  return {
    name,
    path: path.relative(rootPath, absolute).split(path.sep).join("/"),
    title,
    createdAt: stat.birthtime.toISOString(),
    bytes: stat.size,
  };
}

export async function listPlans(rootPath: string): Promise<PlanSummary[]> {
  const directory = plansDir(rootPath);
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const plans: PlanSummary[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith("._") || !/\.md$/i.test(entry.name)) {
      continue;
    }
    const absolute = path.resolve(directory, entry.name);
    try {
      // eslint-disable-next-line no-await-in-loop
      const [content, stat] = await Promise.all([
        fs.readFile(absolute, "utf8"),
        fs.stat(absolute),
      ]);
      plans.push({
        name: entry.name,
        path: path.relative(rootPath, absolute).split(path.sep).join("/"),
        title: content.match(/^#\s+(.+)$/m)?.[1]?.trim() || entry.name.replace(/\.md$/i, ""),
        createdAt: stat.birthtime.toISOString(),
        bytes: stat.size,
      });
    } catch {
      // ignore unreadable plans
    }
  }
  return plans.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function readPlan(
  rootPath: string,
  name: string,
): Promise<{ path: string; content: string }> {
  const safe = safePlanName(name);
  const absolute = path.resolve(plansDir(rootPath), safe);
  if (!isWithin(rootPath, absolute)) throw new Error("Plan path is outside the project.");
  const content = await fs.readFile(absolute, "utf8");
  return {
    path: path.relative(rootPath, absolute).split(path.sep).join("/"),
    content,
  };
}
