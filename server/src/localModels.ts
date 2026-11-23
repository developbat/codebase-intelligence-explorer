import { execFile, spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getPublicSettings } from "./ai/settings";

const execFileAsync = promisify(execFile);
const OLLAMA_BASE = "http://127.0.0.1:11434";
const TAGS_URL = `${OLLAMA_BASE}/api/tags`;

export interface LocalModelStatus {
  installed: boolean;
  running: boolean;
  models: string[];
  /** Model names found on disk even while the server is stopped. */
  diskModels: string[];
  baseUrl: string;
  modelsDir: string;
  /** True when models were loaded from the folder instead of the running server. */
  fromDisk: boolean;
  error?: string;
}

export interface LocalModelPullResult {
  ok: boolean;
  model: string;
  output: string;
}

async function ollamaInstalled(): Promise<boolean> {
  try {
    await execFileAsync(process.platform === "win32" ? "where" : "which", ["ollama"], {
      timeout: 3_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function configuredDir(): Promise<string> {
  try {
    const settings = await getPublicSettings();
    if (settings.localModelsDir.trim()) return settings.localModelsDir.trim();
  } catch {
    // Fall back to the default location below.
  }
  return path.join(os.homedir(), ".ollama", "models");
}

/**
 * Ollama stores `manifests/<registry>/<namespace>/<name>/<tag>` files for every
 * downloaded model. Reading them lets us show downloaded models even when the
 * local server is not running.
 */
async function scanModelsDir(dir: string): Promise<string[]> {
  const manifests = path.join(dir, "manifests");
  const models = new Set<string>();
  try {
    await fs.access(manifests);
  } catch {
    return [];
  }
  async function walk(current: string, parts: string[]) {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const next = path.join(current, entry.name);
      const nextParts = [...parts, entry.name];
      if (entry.isDirectory()) {
        await walk(next, nextParts);
        continue;
      }
      // Manifests live at <registry>/<namespace>/<name>/<tag>.
      if (nextParts.length < 4) continue;
      const tag = nextParts[nextParts.length - 1] ?? "";
      const name = nextParts[nextParts.length - 2] ?? "";
      const namespace = nextParts[nextParts.length - 3] ?? "library";
      if (!name || !tag) continue;
      models.add(
        namespace === "library"
          ? tag === "latest"
            ? name
            : `${name}:${tag}`
          : `${namespace}/${name}:${tag}`,
      );
    }
  }
  await walk(manifests, []);
  return [...models].sort();
}

async function listModels(): Promise<{ running: boolean; models: string[]; error?: string }> {
  try {
    const response = await fetch(TAGS_URL, { signal: AbortSignal.timeout(2_500) });
    if (!response.ok) {
      return { running: false, models: [], error: `HTTP ${response.status}` };
    }
    const payload = (await response.json()) as { models?: { name?: string; model?: string }[] };
    return {
      running: true,
      models: (payload.models ?? [])
        .map((model) => model.name ?? model.model ?? "")
        .filter(Boolean)
        .sort(),
    };
  } catch (error) {
    return {
      running: false,
      models: [],
      error: error instanceof Error ? error.message : "Ollama is not reachable.",
    };
  }
}

export async function localModelStatus(): Promise<LocalModelStatus> {
  const [installed, list, modelsDir] = await Promise.all([
    ollamaInstalled(),
    listModels(),
    configuredDir(),
  ]);
  const diskModels = await scanModelsDir(modelsDir);
  const models = list.models.length > 0 ? list.models : diskModels;
  return {
    installed,
    running: list.running,
    models,
    diskModels,
    baseUrl: OLLAMA_BASE,
    modelsDir,
    fromDisk: !list.running && diskModels.length > 0,
    error: list.error,
  };
}

export async function startLocalServer(): Promise<LocalModelStatus> {
  const current = await localModelStatus();
  if (current.running) return current;
  if (!current.installed) {
    throw new Error("Ollama is not installed. Install it from https://ollama.com, then retry.");
  }
  const child = spawn("ollama", ["serve"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, OLLAMA_MODELS: current.modelsDir },
  });
  child.unref();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    // Wait for the local HTTP server to accept connections.
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 500));
    // eslint-disable-next-line no-await-in-loop
    const next = await localModelStatus();
    if (next.running) return next;
  }
  return localModelStatus();
}

export async function pullLocalModel(model: string): Promise<LocalModelPullResult> {
  const name = model.trim();
  if (!name || !/^[a-zA-Z0-9._:/-]+$/.test(name)) {
    throw new Error("Enter a valid Ollama model name, for example qwen2.5-coder:1.5b.");
  }
  const status = await localModelStatus();
  if (!status.installed) {
    throw new Error("Ollama is not installed. Install it from https://ollama.com, then retry.");
  }
  if (!status.running) {
    await startLocalServer();
  }
  try {
    const result = await execFileAsync("ollama", ["pull", name], {
      timeout: 30 * 60_000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, OLLAMA_MODELS: status.modelsDir },
    });
    return {
      ok: true,
      model: name,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().slice(-8_000),
    };
  } catch (error) {
    return {
      ok: false,
      model: name,
      output: (error instanceof Error ? error.message : "Model download failed.").slice(-8_000),
    };
  }
}

/**
 * Finds folders that already contain Ollama models so an existing download can
 * be reused instead of pulled again.
 */
export async function discoverLocalModelDirs(): Promise<
  { dir: string; models: string[]; sizeBytes: number }[]
> {
  const candidates = new Set<string>([await configuredDir(), path.join(os.homedir(), ".ollama", "models")]);

  // Look for `models` folders up to three levels below volume roots. This is
  // where tools such as Agent Studio keep their managed Ollama downloads.
  const roots = ["/Volumes", os.homedir()];
  const stack: { dir: string; depth: number }[] = roots.map((dir) => ({ dir, depth: 0 }));
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (item.depth >= 4) continue;
    let entries: Dirent[];
    try {
      // eslint-disable-next-line no-await-in-loop
      entries = await fs.readdir(item.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.name.startsWith(".") ||
        entry.name === "node_modules" ||
        entry.name === "Library" ||
        entry.name === "Applications" ||
        entry.name === "System"
      ) {
        continue;
      }
      const next = path.join(item.dir, entry.name);
      if (entry.name === "models") {
        try {
          // eslint-disable-next-line no-await-in-loop
          await fs.access(path.join(next, "manifests"));
          candidates.add(next);
        } catch {
          // Not an Ollama model folder.
        }
      } else {
        stack.push({ dir: next, depth: item.depth + 1 });
      }
    }
  }

  const found: { dir: string; models: string[]; sizeBytes: number }[] = [];
  for (const dir of candidates) {
    const models = await scanModelsDir(dir);
    if (models.length === 0) continue;
    found.push({ dir, models, sizeBytes: await dirSize(path.join(dir, "blobs")) });
  }
  return found.sort((a, b) => b.models.length - a.models.length);
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.name.startsWith("._")) continue;
    const target = path.join(dir, entry.name);
    if (entry.isFile()) {
      try {
        // eslint-disable-next-line no-await-in-loop
        total += (await fs.stat(target)).size;
      } catch {
        // Ignore unreadable files.
      }
    }
  }
  return total;
}
