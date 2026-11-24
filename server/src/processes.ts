import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
  planPythonEnvironment,
  probePythonInterpreter,
  projectPythonEnv,
  pythonSetupLockPath,
  pythonVenvInfo,
  waitForPythonSetup,
  writePythonEnvironmentMarker,
} from "./pythonRuntime";
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
const setupLocks = new Set<string>();
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
    for (const lock of setupLocks) void fs.rm(lock, { force: true }).catch(() => undefined);
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
    // Server access logs look like `127.0.0.1:64646 - "GET /health"`; that is
    // a client address, not a preview URL.
    const following = output.slice((match.index ?? 0) + match[0].length);
    if (/^\s+-\s+"/u.test(following)) continue;
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

  // Python: prefer the project virtual environment so `python3`, `pip`,
  // `pytest`, `uvicorn` and `streamlit` resolve inside `.venv`.
  const pythonVenv = await pythonVenvInfo(rootPath);
  const pythonRunner = pythonVenv ? pythonVenv.relativePython : "python3";
  const requirementsPresent =
    (await exists("requirements.txt")) || (await exists("requirements-dev.txt"));
  if (requirementsPresent) {
    const plan = await planPythonEnvironment(rootPath);
    if (plan) {
      suggestions.push({
        label: "Install dependencies",
        command: plan.command,
        kind: "python",
        purpose: "install",
      });
    }
  }
  const readPython = (relative: string) =>
    fs.readFile(path.join(rootPath, relative), "utf8").catch(() => "");

  if (await exists("manage.py")) {
    suggestions.push({ label: "Django", command: `${pythonRunner} manage.py runserver`, kind: "python" });
  }

  // Streamlit entry points (app.py, streamlit_app.py, dashboard.py).
  const streamlitCandidates = ["app.py", "streamlit_app.py", "dashboard.py"];
  let streamlitEntry: string | null = null;
  let pythonAppSource = "";
  for (const candidate of streamlitCandidates) {
    if (!(await exists(candidate))) continue;
    const source = await readPython(candidate);
    if (candidate === "app.py") pythonAppSource = source;
    if (/\b(?:import|from)\s+streamlit\b/u.test(source)) {
      streamlitEntry = candidate;
      break;
    }
  }
  if (!streamlitEntry) {
    const requirementText = (
      await Promise.all(["requirements.txt", "requirements-dev.txt", "pyproject.toml"].map(readPython))
    )
      .join("\n")
      .toLowerCase();
    if (/\bstreamlit\b/u.test(requirementText)) {
      for (const candidate of streamlitCandidates) {
        if (await exists(candidate)) {
          streamlitEntry = candidate;
          break;
        }
      }
    }
  }

  if (streamlitEntry) {
    suggestions.push({
      label: "Streamlit",
      command: `${pythonRunner} -m streamlit run ${streamlitEntry} --server.headless true --server.address 127.0.0.1`,
      kind: "python",
    });
  }

  for (const entry of ["app/main.py", "main.py"]) {
    if (!(await exists(entry))) continue;
    const source = await readPython(entry);
    if (/FastAPI\(/u.test(source)) {
      const module = entry.replace(/\.py$/u, "").replace(/[\\/]/gu, ".");
      suggestions.push({
        label: "FastAPI",
        command: `${pythonRunner} -m uvicorn ${module}:app --reload`,
        kind: "python",
      });
      break;
    }
  }

  if (!streamlitEntry && (await exists("app.py"))) {
    const source = pythonAppSource || (await readPython("app.py"));
    if (/\b(?:import|from)\s+flask\b/u.test(source)) {
      suggestions.push({ label: "Flask", command: `${pythonRunner} -m flask --app app run`, kind: "python" });
    } else if (!/FastAPI\(/u.test(source)) {
      suggestions.push({ label: "Python app", command: `${pythonRunner} app.py`, kind: "python" });
    }
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
  if (await exists("project.godot")) {
    suggestions.push({ label: "Godot", command: "godot --path .", kind: "node" });
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

export interface BackgroundProcessOptions {
  /** Internal completion hook; used to record a prepared Python environment. */
  onExit?: (job: BackgroundJob) => void | Promise<void>;
  /** Restart a crashed dev server once instead of leaving a dead preview. */
  autoRestart?: boolean;
  /** @internal Number of automatic restarts already attempted. */
  restartCount?: number;
}

const DEV_SERVER_PATTERN =
  /\b(streamlit|uvicorn|gunicorn|flask\s+--app|manage\.py\s+runserver|npm\s+(run\s+)?(dev|start|serve)|pnpm\s+(dev|start)|yarn\s+(dev|start)|bun\s+(dev|start)|vite|next\s+dev|php\s+-S|http\.server|expo\s+start|react-native\s+start|flutter\s+run|go\s+run|cargo\s+run|dotnet\s+run|rails\s+server|mix\s+phx\.server)\b/i;

export function isDevServerCommand(command: string): boolean {
  return DEV_SERVER_PATTERN.test(command);
}

export async function startBackgroundProcess(
  rootPath: string,
  projectId: string,
  command: string,
  cwd?: string,
  options: BackgroundProcessOptions = {},
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
  const pythonEnv = await projectPythonEnv(rootPath);
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
      ...pythonEnv,
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
    if (options.onExit) {
      void Promise.resolve(options.onExit(publicJob(job))).catch(() => undefined);
    }
    const shouldRestart =
      Boolean(options.autoRestart) &&
      job.status === "exited" &&
      exitCode !== 0 &&
      (options.restartCount ?? 0) < 1 &&
      isDevServerCommand(trimmed);
    if (shouldRestart) {
      job.output = trimOutput(
        job.output,
        `\n[auto-restart] Server exited with code ${exitCode ?? "?"}. Restarting after the environment is ready…\n`,
      );
      setTimeout(() => {
        void waitForPythonSetup(rootPath, undefined, 120_000)
          .then(() =>
            startBackgroundProcess(rootPath, projectId, trimmed, cwd, {
              ...options,
              restartCount: (options.restartCount ?? 0) + 1,
            }),
          )
          .catch(() => undefined);
      }, 1_500).unref?.();
    }
  });

  return publicJob(job);
}

/**
 * Start the detected dev server automatically, once, after a Python project is
 * prepared. The user should never have to find and click a start button after
 * creating a project.
 */
export async function autoStartDevServer(
  projectId: string,
  rootPath: string,
): Promise<BackgroundJob | null> {
  const map = projectJobs(projectId);
  if ([...map.values()].some((job) => job.status === "running" && isDevServerCommand(job.command))) {
    return null;
  }
  const suggestions = await detectDevCommands(rootPath);
  const server = suggestions.find((suggestion) => suggestion.purpose !== "install");
  if (!server) return null;
  return startBackgroundProcess(rootPath, projectId, server.command, undefined, {
    autoRestart: true,
  });
}

/**
 * Create the project virtual environment and install requirements in the
 * background. Called automatically after a Python project is opened so the
 * user never has to run setup commands by hand.
 */
export async function startPythonEnvironment(
  projectId: string,
  rootPath: string,
): Promise<BackgroundJob | null> {
  const plan = await planPythonEnvironment(rootPath);
  if (!plan) return null;
  // `.cie-python.json` marks a completed setup; do not reinstall on every open.
  const preparedVenv = await pythonVenvInfo(rootPath);
  if (preparedVenv?.version) return null;
  const map = projectJobs(projectId);
  const existing = [...map.values()].find(
    (job) => job.status === "running" && job.command === plan.command,
  );
  if (existing) return publicJob(existing);

  const lock = pythonSetupLockPath(rootPath);
  await fs.mkdir(path.dirname(lock), { recursive: true }).catch(() => undefined);
  await fs.writeFile(lock, new Date().toISOString(), "utf8").catch(() => undefined);
  setupLocks.add(lock);
  try {
    return await startBackgroundProcess(rootPath, projectId, plan.command, undefined, {
      onExit: async (job) => {
        setupLocks.delete(lock);
        await fs.rm(lock, { force: true }).catch(() => undefined);
        if (job.exitCode !== 0) return;
        const venv = await pythonVenvInfo(rootPath);
        const version =
          probePythonInterpreter(venv?.python ?? "python3")?.version ?? plan.interpreter?.version;
        if (version) await writePythonEnvironmentMarker(rootPath, version);
        await autoStartDevServer(projectId, rootPath).catch(() => null);
      },
    });
  } catch (error) {
    setupLocks.delete(lock);
    await fs.rm(lock, { force: true }).catch(() => undefined);
    throw error;
  }
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
