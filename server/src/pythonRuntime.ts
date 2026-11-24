import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Python runtime helpers.
 *
 * The app must never fall back to a bleeding-edge system interpreter when a
 * stable one is available: Homebrew currently ships Python 3.15 as `python3`,
 * and pandas/numpy crash with SIGSEGV on some datetime operations there.
 * Every Python command therefore resolves through this module:
 *   1. the project virtual environment (`.venv` / `venv`),
 *   2. the newest stable interpreter (3.13, 3.12, 3.11, 3.14, 3.10, 3.9),
 *   3. `python3` only as the last resort.
 */

export interface PythonInterpreter {
  command: string;
  args: string[];
  shell: string;
  executable: string;
  version: string;
  major: number;
  minor: number;
}

/** Preferred interpreter order. 3.12–3.14 have reliable wheels on macOS arm64. */
const MINOR_PREFERENCE = [13, 12, 14, 11, 10, 9, 15, 16, 17];

const PROBE_SCRIPT =
  "import json,sys;print(json.dumps({'v':'.'.join(str(part) for part in sys.version_info[:3]),'exe':sys.executable}))";

let interpreterPromise: Promise<PythonInterpreter | null> | null = null;

function quoteShell(value: string): string {
  return /[\s"]/u.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function shellCommand(command: string, args: string[]): string {
  return [command, ...args].map(quoteShell).join(" ");
}

function rawCandidates(): Array<{ command: string; args: string[] }> {
  const candidates: Array<{ command: string; args: string[] }> = [];
  const explicit = process.env.CIE_PYTHON?.trim();
  if (explicit) candidates.push({ command: explicit, args: [] });

  if (process.platform === "win32") {
    for (const minor of MINOR_PREFERENCE) {
      candidates.push({ command: "py", args: [`-3.${minor}`] });
    }
    candidates.push({ command: "python", args: [] });
    candidates.push({ command: "python3", args: [] });
    return candidates;
  }

  const names = [
    ...MINOR_PREFERENCE.map((minor) => `python3.${minor}`),
    "python3",
    "python",
  ];
  for (const name of names) candidates.push({ command: name, args: [] });

  // PATH is not always populated in desktop-launched apps; check the common
  // Homebrew/pyenv locations before giving up on a versioned interpreter.
  for (const prefix of ["/opt/homebrew/bin/", "/usr/local/bin/"]) {
    for (const minor of MINOR_PREFERENCE) {
      candidates.push({ command: `${prefix}python3.${minor}`, args: [] });
    }
    candidates.push({ command: `${prefix}python3`, args: [] });
  }
  candidates.push({ command: "/usr/bin/python3", args: [] });
  return candidates;
}

export function pythonMinorSupported(minor: number): boolean {
  // 3.9 is the oldest version pandas 2.x still supports; 3.15+ is currently
  // unstable for the scientific stack on macOS, so it is ranked last.
  return minor >= 9;
}

export function pythonMinorPreferred(minor: number): boolean {
  return minor >= 9 && minor <= 14;
}

function probe(command: string, args: string[]): PythonInterpreter | null {
  const result = spawnSync(command, [...args, "-c", PROBE_SCRIPT], {
    encoding: "utf8",
    timeout: 4_000,
    windowsHide: true,
    env: process.env,
  });
  if (result.status !== 0 || !result.stdout) return null;
  try {
    const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/u).pop() ?? "") as {
      v?: string;
      exe?: string;
    };
    const [major, minor] = (parsed.v ?? "").split(".").map((part) => Number(part));
    if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
    return {
      command,
      args,
      shell: shellCommand(command, args),
      executable: parsed.exe ?? command,
      version: parsed.v ?? `${major}.${minor}`,
      major,
      minor,
    };
  } catch {
    return null;
  }
}

/**
 * Probe an arbitrary interpreter (used for project virtual environments too).
 * Returns null when the command cannot start at all.
 */
export function probePythonInterpreter(
  command: string,
  args: string[] = [],
): PythonInterpreter | null {
  return probe(command, args);
}

export async function findPythonInterpreter(): Promise<PythonInterpreter | null> {
  if (!interpreterPromise) {
    interpreterPromise = (async () => {
      for (const candidate of rawCandidates()) {
        const interpreter = probe(candidate.command, candidate.args);
        if (interpreter) return interpreter;
      }
      return null;
    })();
  }
  return interpreterPromise;
}

export function resetPythonInterpreterCache(): void {
  interpreterPromise = null;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export interface PythonVenv {
  /** Directory name relative to the project root, e.g. `.venv`. */
  dir: string;
  /** Absolute path to the virtual environment root. */
  root: string;
  /** Absolute path to `bin/` or `Scripts/`. */
  bin: string;
  /** Absolute path to the interpreter. */
  python: string;
  /** Command usable from the project root, e.g. `./.venv/bin/python`. */
  relativePython: string;
  /** Version recorded by the app, when the environment was created by B.A.D IDE. */
  version?: string;
}

export async function pythonVenvInfo(rootPath: string): Promise<PythonVenv | null> {
  for (const dir of [".venv", "venv"]) {
    const venvRoot = path.join(rootPath, dir);
    const bin = path.join(venvRoot, process.platform === "win32" ? "Scripts" : "bin");
    const interpreter =
      process.platform === "win32"
        ? path.join(bin, "python.exe")
        : path.join(bin, "python");
    const fallback =
      process.platform === "win32" ? path.join(bin, "python3.exe") : path.join(bin, "python3");
    const python = (await exists(interpreter))
      ? interpreter
      : (await exists(fallback))
        ? fallback
        : null;
    if (!python) continue;
    const relativePython =
      process.platform === "win32"
        ? `.\\${dir}\\Scripts\\${path.basename(python)}`
        : `./${dir}/bin/${path.basename(python)}`;
    let version: string | undefined;
    try {
      const marker = JSON.parse(
        await fs.readFile(path.join(venvRoot, ".cie-python.json"), "utf8"),
      ) as { version?: string };
      version = typeof marker.version === "string" ? marker.version : undefined;
    } catch {
      version = undefined;
    }
    return { dir, root: venvRoot, bin, python, relativePython, version };
  }
  return null;
}

/**
 * Environment overrides that make `python`, `python3`, `pip`, `pytest`,
 * `uvicorn`, `streamlit` and friends resolve to the project virtual
 * environment. Merged into every project command and background job.
 */
export async function projectPythonEnv(
  rootPath: string,
): Promise<Record<string, string>> {
  const venv = await pythonVenvInfo(rootPath);
  if (!venv) return {};
  return {
    VIRTUAL_ENV: venv.root,
    PATH: `${venv.bin}${path.delimiter}${process.env.PATH ?? ""}`,
    // Refuse accidental global installs while a project environment exists.
    PIP_REQUIRE_VIRTUALENV: "1",
  };
}

export async function pythonRequirementFiles(rootPath: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of ["requirements.txt", "requirements-dev.txt"]) {
    if (await exists(path.join(rootPath, name))) found.push(name);
  }
  return found;
}

export interface PythonSetupPlan {
  command: string;
  requirements: string[];
  createsVenv: boolean;
  interpreter: PythonInterpreter | null;
}

/**
 * Build the shell command that creates the project virtual environment and
 * installs its requirements. Returns null when the project is not Python
 * (no requirements) or no usable interpreter exists.
 */
export async function planPythonEnvironment(
  rootPath: string,
): Promise<PythonSetupPlan | null> {
  const requirements = await pythonRequirementFiles(rootPath);
  if (requirements.length === 0) return null;
  let venv = await pythonVenvInfo(rootPath);
  let rebuild = false;

  // A virtual environment built on Python 3.15 can load pandas but crashes
  // with SIGSEGV on datetime operations. Move it aside and rebuild instead of
  // reusing a known-broken interpreter.
  if (venv) {
    const probe = probePythonInterpreter(venv.python);
    if (!probe || probe.major !== 3 || !pythonMinorPreferred(probe.minor)) {
      if (process.platform === "win32") {
        venv = null;
      } else {
        rebuild = true;
        venv = null;
      }
    }
  }

  const interpreter = venv ? null : await findPythonInterpreter();
  const venvPython = venv
    ? venv.relativePython
    : process.platform === "win32"
      ? ".venv\\Scripts\\python.exe"
      : ".venv/bin/python";
  const installSteps = requirements.map(
    (file) => `${venvPython} -m pip install -r ${file}`,
  );

  if (venv) {
    return {
      command: installSteps.join(" && "),
      requirements,
      createsVenv: false,
      interpreter,
    };
  }
  if (!interpreter) return null;
  const staleVenv = rebuild
    ? `mv .venv .venv-unstable-${Date.now()} 2>/dev/null || true; `
    : "";
  const parts = [
    `${staleVenv}${interpreter.shell} -m venv .venv`,
    `${venvPython} -m pip install --disable-pip-version-check --upgrade pip`,
    ...installSteps,
  ];
  return {
    command: parts.join(" && "),
    requirements,
    createsVenv: true,
    interpreter,
  };
}

export async function writePythonEnvironmentMarker(
  rootPath: string,
  version: string,
): Promise<void> {
  const venv = await pythonVenvInfo(rootPath);
  if (!venv) return;
  try {
    await fs.writeFile(
      path.join(venv.root, ".cie-python.json"),
      `${JSON.stringify({ version, createdAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // A marker is only metadata; ignore write failures.
  }
}

export interface PythonEnvironmentStatus {
  requirements: string[];
  venv: string | null;
  version: string | null;
  healthy: boolean;
  ready: boolean;
}

export async function pythonEnvironmentStatus(
  rootPath: string,
): Promise<PythonEnvironmentStatus> {
  const requirements = await pythonRequirementFiles(rootPath);
  const venv = await pythonVenvInfo(rootPath);
  if (!venv) {
    return { requirements, venv: null, version: null, healthy: false, ready: false };
  }
  const interpreter = probePythonInterpreter(venv.python);
  const version = interpreter?.version ?? venv.version ?? null;
  return {
    requirements,
    venv: venv.dir,
    version,
    healthy: Boolean(interpreter && pythonMinorPreferred(interpreter.minor)),
    ready: Boolean(interpreter),
  };
}

export const PYTHON_SETUP_LOCK = "python-setup.lock";

export function pythonSetupLockPath(rootPath: string): string {
  // Keep lock files outside the user's project so they never show up as
  // untracked files in Git.
  const digest = crypto.createHash("sha256").update(path.resolve(rootPath)).digest("hex").slice(0, 24);
  return path.join(os.tmpdir(), "badide-python-locks", `${digest}-${PYTHON_SETUP_LOCK}`);
}

/**
 * Wait while a Python environment setup job is running so a verification
 * command does not race `pip install` in the same virtual environment.
 */
export async function waitForPythonSetup(
  rootPath: string,
  signal?: AbortSignal,
  timeoutMs = 180_000,
): Promise<void> {
  const lock = pythonSetupLockPath(rootPath);
  const started = Date.now();
  while (true) {
    const info = await fs.stat(lock).catch(() => null);
    if (!info) return;
    if (Date.now() - info.mtimeMs > 15 * 60_000) {
      await fs.rm(lock, { force: true }).catch(() => undefined);
      return;
    }
    if (signal?.aborted || Date.now() - started > timeoutMs) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}
