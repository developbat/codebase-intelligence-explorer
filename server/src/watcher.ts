import chokidar, { type FSWatcher } from "chokidar";
import type { Response } from "express";
import path from "node:path";
import { analyzeProject } from "./analyzer";
import { loadAnalysis, saveAnalysis } from "./store";

const WATCHED_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|prisma|json)$/i;
const IGNORED = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/.cache/**",
  "**/target/**",
  "**/vendor/**",
  "**/*.log",
];

interface WatchedProject {
  projectId: string;
  watcher: FSWatcher;
  clients: Set<Response>;
  changedPaths: Set<string>;
  timer: NodeJS.Timeout | null;
  running: boolean;
  pending: boolean;
  heartbeat: NodeJS.Timeout;
}

const watchers = new Map<string, WatchedProject>();

function send(client: Response, payload: unknown): void {
  try {
    client.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    // the close handler removes broken clients
  }
}

function broadcast(project: WatchedProject, payload: unknown): void {
  for (const client of project.clients) send(client, payload);
}

async function runRefresh(project: WatchedProject): Promise<void> {
  if (project.running) {
    project.pending = true;
    return;
  }
  project.running = true;
  const paths = [...project.changedPaths];
  project.changedPaths.clear();
  try {
    const previous = await loadAnalysis(project.projectId);
    const next = await analyzeProject(previous.rootPath);
    await saveAnalysis(next);
    broadcast(project, {
      type: "updated",
      changedPaths: paths,
      summary: {
        id: next.id,
        createdAt: next.createdAt,
        stats: next.stats,
        warnings: next.warnings,
      },
    });
  } catch (error) {
    broadcast(project, {
      type: "error",
      message: error instanceof Error ? error.message : "Background analysis failed.",
    });
  } finally {
    project.running = false;
    if (project.pending) {
      project.pending = false;
      scheduleRefresh(project);
    }
  }
}

function scheduleRefresh(project: WatchedProject): void {
  if (project.timer) clearTimeout(project.timer);
  project.timer = setTimeout(() => {
    project.timer = null;
    void runRefresh(project);
  }, 1500);
}

function closeProject(projectId: string): void {
  const project = watchers.get(projectId);
  if (!project) return;
  if (project.timer) clearTimeout(project.timer);
  clearInterval(project.heartbeat);
  void project.watcher.close();
  watchers.delete(projectId);
}

async function ensureWatcher(projectId: string): Promise<WatchedProject | null> {
  const existing = watchers.get(projectId);
  if (existing) return existing;
  let rootPath: string;
  try {
    rootPath = (await loadAnalysis(projectId)).rootPath;
  } catch {
    return null;
  }
  const project: WatchedProject = {
    projectId,
    watcher: chokidar.watch(rootPath, {
      ignored: IGNORED,
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 600, pollInterval: 100 },
    }),
    clients: new Set(),
    changedPaths: new Set(),
    timer: null,
    running: false,
    pending: false,
    heartbeat: setInterval(() => {
      for (const client of project.clients) client.write(": keep-alive\n\n");
    }, 25_000),
  };
  project.watcher.on("all", (event, changedPath) => {
    if (!["add", "change", "unlink", "addDir", "unlinkDir"].includes(event)) return;
    if (!WATCHED_EXTENSIONS.test(changedPath) && event !== "addDir" && event !== "unlinkDir") return;
    project.changedPaths.add(path.relative(rootPath, changedPath).split(path.sep).join("/"));
    scheduleRefresh(project);
  });
  project.watcher.on("error", (error) => {
    broadcast(project, { type: "error", message: String(error) });
  });
  watchers.set(projectId, project);
  return project;
}

export async function subscribeProjectEvents(projectId: string, response: Response): Promise<void> {
  const project = await ensureWatcher(projectId);
  if (!project) {
    response.status(404).json({ error: "Project not found." });
    return;
  }
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.write(`event: ready\ndata: ${JSON.stringify({ type: "ready", projectId })}\n\n`);
  project.clients.add(response);
  response.on("close", () => {
    project.clients.delete(response);
    if (project.clients.size === 0) closeProject(projectId);
  });
}
