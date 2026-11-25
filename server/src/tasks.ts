import fs from "node:fs/promises";
import path from "node:path";
import type { AiAgentEvent } from "../../shared/ai";
import type {
  ProjectTask,
  ProjectTaskQueue,
  ProjectTaskStatus,
} from "../../shared/tasks";

const AGENT_DIR = "agent";
const TASKS_FILE = "tasks.json";
const PLAN_FILE = "TASKS.md";
const CONTEXT_FILE = "context.md";
const DIGEST_FILE = "context-digest.md";
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

export function emptyQueue(projectId: string, goal: string): ProjectTaskQueue {
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
    digestPath: relativeAgentPath(DIGEST_FILE),
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

export function digestMarkdown(queue: ProjectTaskQueue): string {
  return [
    `# Task digest — ${queue.goal}`,
    "",
    `Status: **${queue.status}** · Updated: ${queue.updatedAt}`,
    "",
    ...queue.tasks.map(
      (task) =>
        `- ${task.status === "done" ? "✅" : task.status === "failed" ? "❌" : task.status === "in_progress" ? "🔄" : "⏳"} ${task.id} ${task.title} · ${task.role}/${task.effort}${
          task.resultSummary
            ? ` — ${task.resultSummary.replace(/\n+/g, " ").slice(0, 260)}`
            : ""
        }${task.changedFiles.length > 0 ? ` · files: ${task.changedFiles.join(", ")}` : ""}`,
    ),
    "",
    `Full notes: ${relativeAgentPath(CONTEXT_FILE)}`,
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
    digestPath: relativeAgentPath(DIGEST_FILE),
  };
  await fs.mkdir(agentDir(rootPath), { recursive: true });
  await writeTextAtomic(tasksPath(rootPath), JSON.stringify(next, null, 2));
  await writeTextAtomic(planPath(rootPath), queueMarkdown(next));
  await writeTextAtomic(path.join(agentDir(rootPath), DIGEST_FILE), digestMarkdown(next));
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

function lessonsPath(rootPath: string): string {
  return path.join(rootPath, ".cie", "agent", "LESSONS.md");
}

export async function appendLesson(rootPath: string, lesson: string): Promise<void> {
  const text = lesson.trim();
  if (!text) return;
  const file = lessonsPath(rootPath);
  let current = "";
  try {
    current = await fs.readFile(file, "utf8");
  } catch {
    current = "# Agent lessons\n\nShort, reusable lessons from previous failures. Read this before starting a task.\n";
  }
  const entry = `\n- ${new Date().toISOString().slice(0, 16).replace("T", " ")} · ${text.slice(0, 800)}\n`;
  let next = `${current}${entry}`;
  if (Buffer.byteLength(next) > 24_000) next = `${current.slice(-16_000)}${entry}`;
  await writeTextAtomic(file, next);
}

export async function readLessons(rootPath: string): Promise<string> {
  try {
    return (await fs.readFile(lessonsPath(rootPath), "utf8")).slice(-6_000);
  } catch {
    return "";
  }
}

export interface AgentRunStepRecord {
  index: number;
  action: string;
  ok: boolean;
  observation: string;
  args?: string;
  durationMs?: number;
}

export interface AgentRunRecord {
  version: 1;
  taskId: string;
  attempt: number;
  /** Unique per execution, so a retry with the same attempt number does not overwrite evidence. */
  runKey?: string;
  goal: string;
  stoppedReason: string;
  summary: string;
  changedFiles: string[];
  failedSteps: AgentRunStepRecord[];
  steps: AgentRunStepRecord[];
  createdAt: string;
}

function clip(value: unknown, limit: number): string {
  const text = typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit)}\u2026` : text;
}

function safeTaskId(value: string): string {
  return value.replace(/[^\w.-]+/g, "-").slice(0, 60) || "task";
}

function safeRunKey(value: string | undefined): string {
  return value ? value.replace(/[^\w.-]+/g, "-").slice(0, 40) : "";
}

function runFilePath(
  rootPath: string,
  taskId: string,
  attempt: number,
  extension: string,
  runKey?: string,
): string {
  const suffix = runKey ? `-${safeRunKey(runKey)}` : "";
  return path.join(
    agentDir(rootPath),
    "runs",
    `${safeTaskId(taskId)}-a${attempt}${suffix}.${extension}`,
  );
}

/** Start a per-attempt live log so an aborted or killed run still leaves evidence. */
export async function startAgentRunLive(
  rootPath: string,
  taskId: string,
  attempt: number,
  runKey?: string,
): Promise<void> {
  const directory = path.join(agentDir(rootPath), "runs");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = runFilePath(rootPath, taskId, attempt, "live.jsonl", runKey);
  await fs.writeFile(
    file,
    `${JSON.stringify({ at: nowIso(), type: "start", taskId, attempt })}\n`,
    { mode: 0o600 },
  );
}

/** Append one event to the live run log. Token chunks are skipped. */
export async function appendAgentRunEvent(
  rootPath: string,
  taskId: string,
  attempt: number,
  event: AiAgentEvent,
  runKey?: string,
): Promise<void> {
  if (event.type === "token" || event.type === "done") return;
  const entry: Record<string, unknown> = { at: nowIso(), type: event.type };
  if (event.type === "step") {
    entry.index = event.step.index;
    entry.action = event.step.action;
    entry.ok = event.step.ok;
    entry.observation = clip(event.step.observation, 800);
    entry.args = clip(event.step.args, 400);
    entry.tokenUsage = event.step.tokenUsage;
    entry.durationMs = event.step.durationMs;
  } else if (event.type === "log") {
    entry.level = event.entry.level;
    entry.label = event.entry.label;
    entry.detail = clip(event.entry.detail, 300);
  } else if (event.type === "model") {
    entry.from = event.from;
    entry.to = event.to;
    entry.reason = clip(event.reason, 300);
  } else if (event.type === "error") {
    entry.message = clip(event.message, 500);
  } else if (event.type === "task") {
    entry.taskId = event.task?.id;
    entry.status = event.task?.status;
  } else if (event.type === "intent") {
    entry.scope = event.intent.scope;
    entry.kind = event.intent.kind;
  }
  const file = runFilePath(rootPath, taskId, attempt, "live.jsonl", runKey);
  await fs.appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

export async function saveAgentRun(
  rootPath: string,
  record: Omit<AgentRunRecord, "version" | "createdAt" | "steps" | "failedSteps"> & {
    steps: { index: number; action: string; ok: boolean; observation: string; args?: unknown; durationMs?: number }[];
  },
): Promise<string> {
  const steps: AgentRunStepRecord[] = record.steps.slice(-160).map((step) => ({
    index: step.index,
    action: step.action,
    ok: step.ok,
    observation: clip(step.observation, 1_600),
    args: step.args === undefined ? undefined : clip(step.args, 600),
    durationMs: step.durationMs,
  }));
  const failedSteps = steps.filter(
    (step) => !step.ok && step.action !== "invalid" && step.action !== "finish",
  );
  const data: AgentRunRecord = {
    version: 1,
    createdAt: nowIso(),
    ...record,
    steps,
    failedSteps,
  };
  const directory = path.join(agentDir(rootPath), "runs");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = runFilePath(
    rootPath,
    record.taskId,
    record.attempt,
    "json",
    record.runKey,
  );
  await writeTextAtomic(file, JSON.stringify(data, null, 2));
  // Keep diagnostics bounded: retain the newest 40 run records.
  try {
    const entries = (await fs.readdir(directory)).filter(
      (name) => name.endsWith(".json") || name.endsWith(".jsonl"),
    );
    if (entries.length > 40) {
      const stats = await Promise.all(
        entries.map(async (name) => ({
          name,
          at: (await fs.stat(path.join(directory, name)).catch(() => null))?.mtimeMs ?? 0,
        })),
      );
      stats.sort((a, b) => a.at - b.at);
      for (const stale of stats.slice(0, entries.length - 40)) {
        // eslint-disable-next-line no-await-in-loop
        await fs.rm(path.join(directory, stale.name), { force: true }).catch(() => {});
      }
    }
  } catch {
    // pruning is best-effort
  }
  return path.relative(rootPath, file).split(path.sep).join("/");
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

export function updateTask(
  queue: ProjectTaskQueue,
  id: string,
  patch: Partial<ProjectTask>,
): ProjectTaskQueue {
  return {
    ...queue,
    tasks: queue.tasks.map((task) =>
      task.id === id ? { ...task, ...patch, id: task.id, updatedAt: nowIso() } : task,
    ),
  };
}

export function removeTask(queue: ProjectTaskQueue, id: string): ProjectTaskQueue {
  return {
    ...queue,
    tasks: queue.tasks
      .filter((task) => task.id !== id)
      .map((task) => ({
        ...task,
        dependsOn: task.dependsOn.filter((dependency) => dependency !== id),
      })),
  };
}

export function reorderTasks(queue: ProjectTaskQueue, order: string[]): ProjectTaskQueue {
  const byId = new Map(queue.tasks.map((task) => [task.id, task]));
  const ordered = [
    ...order.map((id) => byId.get(id)).filter((task): task is ProjectTask => Boolean(task)),
    ...queue.tasks.filter((task) => !order.includes(task.id)),
  ];
  return { ...queue, tasks: ordered };
}
