import fs from "node:fs/promises";
import path from "node:path";
import type {
  ProjectTask,
  ProjectTaskQueue,
  ProjectTaskStatus,
} from "../../shared/tasks";

const AGENT_DIR = "agent";
const TASKS_FILE = "tasks.json";
const PLAN_FILE = "TASKS.md";
const CONTEXT_FILE = "context.md";
const MAX_CONTEXT_BYTES = 40_000;

function agentDir(rootPath: string): string {
  return path.join(rootPath, ".cie", AGENT_DIR);
}

function tasksPath(rootPath: string): string {
  return path.join(agentDir(rootPath), TASKS_FILE);
}

function planPath(rootPath: string): string {
  return path.join(agentDir(rootPath), PLAN_FILE);
}

function contextPath(rootPath: string): string {
  return path.join(agentDir(rootPath), CONTEXT_FILE);
}

function relativeAgentPath(file: string): string {
  return `.cie/${AGENT_DIR}/${file}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function emptyQueue(projectId: string, goal: string): ProjectTaskQueue {
  const at = nowIso();
  return {
    version: 1,
    projectId,
    goal,
    status: "idle",
    createdAt: at,
    updatedAt: at,
    tasks: [],
    notesPath: relativeAgentPath(CONTEXT_FILE),
    planPath: relativeAgentPath(PLAN_FILE),
    contextPath: relativeAgentPath(CONTEXT_FILE),
  };
}

function statusMark(status: ProjectTaskStatus): string {
  if (status === "done") return "x";
  if (status === "failed") return "!";
  if (status === "in_progress") return "~";
  if (status === "blocked") return "?";
  return " ";
}

function taskMarkdown(task: ProjectTask): string {
  const lines = [
    `- [${statusMark(task.status)}] \`${task.id}\` **${task.title}**`,
    `  - status: ${task.status} · effort: ${task.effort} · role: ${task.role}${
      task.provider ? ` · ${task.provider}/${task.model ?? ""}` : ""
    }`,
  ];
  if (task.detail) lines.push(`  - detail: ${task.detail.replace(/\n+/g, " ")}`);
  if (task.acceptance) lines.push(`  - acceptance: ${task.acceptance.replace(/\n+/g, " ")}`);
  if (task.dependsOn.length > 0) lines.push(`  - depends on: ${task.dependsOn.join(", ")}`);
  if (task.resultSummary) {
    lines.push(`  - result: ${task.resultSummary.replace(/\n+/g, " ").slice(0, 500)}`);
  }
  if (task.verification?.command) {
    lines.push(
      `  - verification: ${task.verification.ok ? "passed" : "failed"} · ${task.verification.command}`,
    );
  }
  return lines.join("\n");
}

export function queueMarkdown(queue: ProjectTaskQueue): string {
  return [
    `# Agent tasks — ${queue.goal}`,
    "",
    `Status: **${queue.status}** · Updated: ${queue.updatedAt}`,
    "",
    `Context notes: \`${queue.contextPath}\``,
    "",
    ...(queue.tasks.length > 0 ? queue.tasks.map(taskMarkdown) : ["_No tasks yet._"]),
    "",
  ].join("\n");
}

async function writeTextAtomic(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, content, "utf8");
  await fs.rename(temp, file);
}

export async function saveQueue(rootPath: string, queue: ProjectTaskQueue): Promise<ProjectTaskQueue> {
  const next: ProjectTaskQueue = {
    ...queue,
    version: 1,
    updatedAt: nowIso(),
    notesPath: relativeAgentPath(CONTEXT_FILE),
    planPath: relativeAgentPath(PLAN_FILE),
    contextPath: relativeAgentPath(CONTEXT_FILE),
  };
  await fs.mkdir(agentDir(rootPath), { recursive: true });
  await writeTextAtomic(tasksPath(rootPath), JSON.stringify(next, null, 2));
  await writeTextAtomic(planPath(rootPath), queueMarkdown(next));
  return next;
}

export async function loadQueue(rootPath: string, projectId: string): Promise<ProjectTaskQueue | null> {
  try {
    const raw = await fs.readFile(tasksPath(rootPath), "utf8");
    const parsed = JSON.parse(raw) as ProjectTaskQueue;
    if (!parsed || !Array.isArray(parsed.tasks)) return null;
    return {
      ...emptyQueue(projectId, parsed.goal ?? ""),
      ...parsed,
      version: 1,
      projectId,
      tasks: parsed.tasks.map((task) => ({
        ...task,
        dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn : [],
        changedFiles: Array.isArray(task.changedFiles) ? task.changedFiles : [],
        commands: Array.isArray(task.commands) ? task.commands : [],
        attempts: Number(task.attempts) || 0,
      })),
    };
  } catch {
    return null;
  }
}

export async function createQueue(
  rootPath: string,
  projectId: string,
  goal: string,
  tasks: ProjectTask[],
): Promise<ProjectTaskQueue> {
  const queue = { ...emptyQueue(projectId, goal), tasks, status: "idle" as const };
  return saveQueue(rootPath, queue);
}

export async function clearQueue(rootPath: string): Promise<void> {
  await fs.rm(tasksPath(rootPath), { force: true });
  await fs.rm(planPath(rootPath), { force: true });
}

export async function appendTaskContext(
  rootPath: string,
  heading: string,
  body: string,
): Promise<void> {
  const file = contextPath(rootPath);
  let current = "";
  try {
    current = await fs.readFile(file, "utf8");
  } catch {
    current = `# Agent context\n\nThis file is maintained by the experimental task loop. The agent may read it for continuity.\n`;
  }
  const entry = `\n## ${heading}\n\n${body.trim().slice(0, 1_600)}\n`;
  let next = `${current}${entry}`;
  if (Buffer.byteLength(next) > MAX_CONTEXT_BYTES) {
    next = `${current.slice(-Math.floor(MAX_CONTEXT_BYTES * 0.6))}${entry}`;
  }
  await writeTextAtomic(file, next);
}

export function nextPendingTask(queue: ProjectTaskQueue): ProjectTask | undefined {
  const done = new Set(queue.tasks.filter((task) => task.status === "done").map((task) => task.id));
  return queue.tasks.find(
    (task) =>
      task.status === "pending" &&
      task.dependsOn.every((dependency) => done.has(dependency)),
  );
}

export function taskById(queue: ProjectTaskQueue, id: string): ProjectTask | undefined {
  return queue.tasks.find((task) => task.id === id);
}

export function markTask(
  queue: ProjectTaskQueue,
  id: string,
  patch: Partial<ProjectTask>,
): ProjectTaskQueue {
  return {
    ...queue,
    tasks: queue.tasks.map((task) => (task.id === id ? { ...task, ...patch, updatedAt: nowIso() } : task)),
  };
}
