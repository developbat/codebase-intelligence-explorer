import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { isWithin } from "./scanner";
import type { BackgroundJob, DevCommandSuggestion } from "../../shared/types";

const MAX_OUTPUT = 240_000;
const MAX_JOBS_PER_PROJECT = 8;
const MAX_COMMAND_LENGTH = 2_000;

export type { BackgroundJob };

interface JobInternal extends BackgroundJob {
  child: ChildProcess;
}

const jobs = new Map<string, Map<string, JobInternal>>();
let cleanupRegistered = false;

function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  const cleanup = () => {
    for (const map of jobs.values()) {
      for (const job of map.values()) {
        if (job.status === "running") {
          job.status = "stopped";
          killJob(job);
        }
      }
    }
  };
  process.once("exit", cleanup);
  process.once("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
}

function projectJobs(projectId: string): Map<string, JobInternal> {
  let map = jobs.get(projectId);
  if (!map) {
    map = new Map();
    jobs.set(projectId, map);
  }
  return map;
}

const LOCAL_URL_PATTERN =
  /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\])(?::\d+)?(?:\/[^\s"'<>]*)?/gi;

export function extractLocalUrls(output: string): string[] {
  const seen = new Set<string>();
  for (const match of output.matchAll(LOCAL_URL_PATTERN)) {
    let url = match[0].replace(/[),.;]+$/, "");
    if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
    try {
      const parsed = new URL(url);
      if (
        parsed.hostname === "0.0.0.0" ||
        parsed.hostname === "[::1]" ||
        parsed.hostname === "[::]"
      ) {
        parsed.hostname = "localhost";
        url = parsed.toString();
      }
      url = url.replace(/\/$/, "");
    } catch {
      continue;
    }
    seen.add(url);
  }
  return [...seen].slice(0, 6);
}

function publicJob(job: JobInternal): BackgroundJob {
  const { child: _child, ...rest } = job;
  return { ...rest, urls: extractLocalUrls(job.output) };
}

function trimOutput(current: string, chunk: string): string {
  const next = current + chunk;
  if (next.length <= MAX_OUTPUT) return next;
  return next.slice(next.length - MAX_OUTPUT);
}

function killJob(job: JobInternal): void {
  if (!job.child.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-job.child.pid, "SIGTERM");
    else job.child.kill("SIGTERM");
  } catch {
    try {
      job.child.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
  setTimeout(() => {
    if (job.status !== "running") return;
    try {
      if (process.platform !== "win32" && job.child.pid) process.kill(-job.child.pid, "SIGKILL");
      else job.child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }, 1_500).unref();
}

export async function detectDevCommands(rootPath: string): Promise<DevCommandSuggestion[]> {
  const suggestions: DevCommandSuggestion[] = [];
  const exists = async (relative: string) => {
    try {
      await fs.access(path.join(rootPath, relative));
      return true;
    } catch {
      return false;
    }
  };

  try {
    const raw = await fs.readFile(path.join(rootPath, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const scripts = parsed.scripts ?? {};
    const dependencies = { ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) };
    let manager = "npm";
    if (await exists("pnpm-lock.yaml")) manager = "pnpm";
    else if (await exists("yarn.lock")) manager = "yarn";
    else if (await exists("bun.lockb")) manager = "bun";
    const run = (script: string) => {
      if (manager === "npm") return script === "start" ? "npm start" : `npm run ${script}`;
      if (manager === "yarn") return `yarn ${script}`;
      if (manager === "pnpm") return `pnpm ${script}`;
      return `bun run ${script}`;
    };
    const install = (() => {
      if (manager === "yarn") return "yarn install";
      if (manager === "pnpm") return "pnpm install";
      if (manager === "bun") return "bun install";
      return "npm install";
    })();
    if (!(await exists("node_modules"))) {
      suggestions.push({ label: "Install dependencies", command: install, kind: "node", purpose: "install" });
    }
    for (const script of ["dev", "start", "web", "serve", "preview"]) {
      if (typeof scripts[script] === "string" && scripts[script].trim()) {
        suggestions.push({ label: script, command: run(script), kind: "node" });
      }
    }
    if (dependencies.expo && !scripts.web) {
      suggestions.push({ label: "Expo web", command: "npx expo start --web", kind: "node" });
    }
    if (dependencies["react-native"] && !dependencies.expo && !scripts.start) {
      suggestions.push({ label: "Metro", command: "npx react-native start", kind: "node" });
    }
  } catch {
    // no package.json
  }

  if ((await exists("composer.json")) && !(await exists("vendor"))) {
    suggestions.push({ label: "Install dependencies", command: "composer install", kind: "php", purpose: "install" });
  }
  if ((await exists("artisan")) && (await exists("composer.json"))) {
    suggestions.push({ label: "Laravel", command: "php artisan serve", kind: "php" });
  } else if ((await exists("composer.json")) || (await exists("public/index.php"))) {
    suggestions.push({ label: "PHP server", command: "php -S localhost:8000 -t public", kind: "php" });
  }
  if ((await exists("requirements.txt")) && !(await exists(".venv")) && !(await exists("venv"))) {
    const requirements = (await exists("requirements-dev.txt")) ? "requirements-dev.txt" : "requirements.txt";
    suggestions.push({
      label: "Install dependencies",
      command: `python3 -m venv .venv && . .venv/bin/activate && pip install -r ${requirements}`,
      kind: "python",
      purpose: "install",
    });
  }
  if (await exists("manage.py")) {
    suggestions.push({ label: "Django", command: "python3 manage.py runserver", kind: "python" });
  } else if (await exists("app/main.py")) {
    try {
      const mainPy = await fs.readFile(path.join(rootPath, "app/main.py"), "utf8");
      if (/FastAPI\(/.test(mainPy)) {
        suggestions.push({ label: "FastAPI", command: "uvicorn app.main:app --reload", kind: "python" });
      }
    } catch {
      // ignore unreadable entry file
    }
  } else if (await exists("app.py")) {
    suggestions.push({ label: "Flask", command: "flask --app app run", kind: "python" });
  }
  if ((await exists("bin/rails")) && (await exists("Gemfile"))) {
    suggestions.push({ label: "Rails", command: "bin/rails server", kind: "ruby" });
  }
  if (await exists("mix.exs")) {
    suggestions.push({ label: "Phoenix", command: "mix phx.server", kind: "elixir" });
  }
  if (await exists("pubspec.yaml")) {
    suggestions.push({ label: "Flutter web", command: "flutter run -d chrome", kind: "node" });
  }
  if ((await exists("go.mod")) && suggestions.length === 0) {
    suggestions.push({ label: "Go", command: "go run .", kind: "go" });
  }
  if ((await exists("Cargo.toml")) && suggestions.length === 0) {
    suggestions.push({ label: "Cargo", command: "cargo run", kind: "rust" });
  }
  if (suggestions.length === 0 && (await exists("index.html"))) {
    suggestions.push({ label: "Static", command: "python3 -m http.server 8000", kind: "python" });
  }
  return suggestions.slice(0, 4);
}

export async function startBackgroundProcess(
  rootPath: string,
  projectId: string,
  command: string,
  cwd?: string,
): Promise<BackgroundJob> {
  const trimmed = command.trim();
  if (!trimmed) throw new Error("A command is required.");
  if (trimmed.length > MAX_COMMAND_LENGTH) throw new Error("The command is too long.");

  registerCleanup();
  const map = projectJobs(projectId);
  const running = [...map.values()].filter((job) => job.status === "running").length;
  if (running >= MAX_JOBS_PER_PROJECT) {
    throw new Error(`Too many background jobs are running (max ${MAX_JOBS_PER_PROJECT}).`);
  }

  const relativeCwd = (cwd ?? "").replace(/^\/+/, "");
  const absoluteCwd = path.resolve(rootPath, relativeCwd || ".");
  if (!isWithin(rootPath, absoluteCwd)) throw new Error("Command working directory is outside the project.");
  const realRoot = await fs.realpath(rootPath);
  const realCwd = await fs.realpath(absoluteCwd);
  if (!isWithin(realRoot, realCwd)) throw new Error("Command working directory is outside the project.");

  const id = crypto.randomUUID();
  const child = spawn(trimmed, {
    cwd: realCwd,
    shell: true,
    windowsHide: true,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      CI: process.env.CI ?? "1",
      PYTHONUNBUFFERED: "1",
      GIT_PAGER: "cat",
      PAGER: "cat",
    },
  });

  const job: JobInternal = {
    id,
    projectId,
    command: trimmed,
    cwd: path.relative(rootPath, realCwd) || ".",
    pid: child.pid,
    status: "running",
    exitCode: null,
    startedAt: new Date().toISOString(),
    output: "",
    child,
  };
  map.set(id, job);

  const append = (chunk: Buffer) => {
    job.output = trimOutput(job.output, chunk.toString("utf8"));
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);

  child.on("error", (error) => {
    job.status = "exited";
    job.exitCode = -1;
    job.endedAt = new Date().toISOString();
    job.output = trimOutput(job.output, `\n[process error] ${error.message}\n`);
  });

  child.on("close", (exitCode) => {
    if (job.status === "running") job.status = "exited";
    job.exitCode = exitCode;
    job.endedAt = new Date().toISOString();
  });

  return publicJob(job);
}

export function listBackgroundProcesses(projectId: string): BackgroundJob[] {
  return [...projectJobs(projectId).values()]
    .map(publicJob)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

export function readBackgroundProcess(
  projectId: string,
  jobId: string,
  offset = 0,
): { job: BackgroundJob; output: string; offset: number } {
  const job = projectJobs(projectId).get(jobId);
  if (!job) throw new Error("Background job not found.");
  const safeOffset = Math.max(0, Math.min(job.output.length, Math.floor(offset)));
  return {
    job: publicJob(job),
    output: job.output.slice(safeOffset),
    offset: job.output.length,
  };
}

export function stopBackgroundProcess(projectId: string, jobId: string): BackgroundJob {
  const job = projectJobs(projectId).get(jobId);
  if (!job) throw new Error("Background job not found.");
  if (job.status === "running") {
    job.status = "stopped";
    job.endedAt = new Date().toISOString();
    killJob(job);
  }
  return publicJob(job);
}

export function removeBackgroundProcess(projectId: string, jobId: string): void {
  const map = projectJobs(projectId);
  const job = map.get(jobId);
  if (job?.status === "running") killJob(job);
  map.delete(jobId);
}
