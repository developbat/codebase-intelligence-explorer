import fs from "node:fs/promises";
import path from "node:path";
import type { ProjectTool, ProjectToolList } from "../../shared/projectTools";

const MAX_TOOLS = 80;
const TOOLS_DIR = ".cie/agent/tools";
const REGISTRY = ".cie/agent/tools.json";
const SCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".py", ".sh", ".bash", ".php", ".rb"]);

interface RegistryFile {
  version: 1;
  tools: ProjectTool[];
}

function registryPath(rootPath: string): string {
  return path.join(rootPath, REGISTRY);
}

function toolsDirectory(rootPath: string): string {
  return path.join(rootPath, TOOLS_DIR);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function commandFor(relativePath: string): string | undefined {
  const extension = path.extname(relativePath).toLowerCase();
  if (!SCRIPT_EXTENSIONS.has(extension)) return undefined;
  const quoted = shellQuote(relativePath);
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return `node ${quoted}`;
  if (extension === ".ts") return `npx tsx ${quoted}`;
  if (extension === ".py") return `python3 ${quoted}`;
  if (extension === ".sh" || extension === ".bash") return `bash ${quoted}`;
  if (extension === ".php") return `php ${quoted}`;
  if (extension === ".rb") return `ruby ${quoted}`;
  return undefined;
}

function toolName(fileName: string): string {
  return fileName
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function readRegistry(rootPath: string): Promise<RegistryFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(registryPath(rootPath), "utf8")) as RegistryFile;
    return {
      version: 1,
      tools: Array.isArray(parsed.tools)
        ? parsed.tools.filter(
            (tool) =>
              tool &&
              typeof tool.name === "string" &&
              typeof tool.command === "string" &&
              tool.command.trim(),
          )
        : [],
    };
  } catch {
    return { version: 1, tools: [] };
  }
}

async function writeRegistry(rootPath: string, registry: RegistryFile): Promise<void> {
  const file = registryPath(rootPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(registry, null, 2), "utf8");
  await fs.rename(temp, file);
}

export async function syncProjectTools(rootPath: string): Promise<ProjectToolList> {
  const registry = await readRegistry(rootPath);
  const manual = registry.tools.filter((tool) => tool.source === "manual");
  const previousAuto = new Map(
    registry.tools.filter((tool) => tool.source === "auto").map((tool) => [tool.name, tool]),
  );
  const auto: ProjectTool[] = [];
  let hasToolsDir = false;
  try {
    const entries = await fs.readdir(toolsDirectory(rootPath), { withFileTypes: true });
    hasToolsDir = true;
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (auto.length >= MAX_TOOLS) break;
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".") || entry.name.endsWith(".json")) continue;
      const relative = `${TOOLS_DIR}/${entry.name}`;
      const command = commandFor(relative);
      if (!command) continue;
      const name = toolName(entry.name);
      if (!name) continue;
      const previous = previousAuto.get(name);
      let updatedAt = new Date().toISOString();
      try {
        const stat = await fs.stat(path.join(toolsDirectory(rootPath), entry.name));
        updatedAt = stat.mtime.toISOString();
      } catch {
        // keep now
      }
      auto.push({
        name,
        description:
          previous?.description ??
          `Auto-registered project script. Run this instead of rewriting the same check.`,
        command: previous?.command === command && previous.source === "auto" ? previous.command : command,
        tags: previous?.tags ?? ["auto", "script"],
        source: "auto",
        path: relative,
        createdAt: previous?.createdAt ?? updatedAt,
        updatedAt,
        lastRunAt: previous?.lastRunAt,
        successCount: previous?.successCount ?? 0,
        failureCount: previous?.failureCount ?? 0,
      });
    }
  } catch {
    // no tools directory
  }
  const all = [...manual, ...auto].slice(0, MAX_TOOLS);
  if (hasToolsDir || manual.length > 0 || registry.tools.length > 0) {
    await writeRegistry(rootPath, { version: 1, tools: all });
  }
  return {
    tools: all,
    directory: TOOLS_DIR,
    registryPath: REGISTRY,
  };
}

export async function listProjectTools(rootPath: string): Promise<ProjectToolList> {
  return syncProjectTools(rootPath);
}

export async function findProjectTool(rootPath: string, name: string): Promise<ProjectTool | null> {
  const { tools } = await syncProjectTools(rootPath);
  return tools.find((tool) => tool.name === name) ?? null;
}

export async function nextProjectToolName(rootPath: string, preferred: string): Promise<string> {
  const { tools } = await syncProjectTools(rootPath);
  const base = toolName(preferred) || "tool";
  const names = new Set(tools.map((tool) => tool.name));
  let candidate = base;
  let index = 2;
  while (names.has(candidate)) {
    candidate = `${base}-${index}`;
    index += 1;
  }
  return candidate;
}

export async function recordProjectToolRun(
  rootPath: string,
  name: string,
  ok: boolean,
): Promise<void> {
  const registry = await readRegistry(rootPath);
  registry.tools = registry.tools.map((tool) =>
    tool.name === name
      ? {
          ...tool,
          lastRunAt: new Date().toISOString(),
          successCount: tool.successCount + (ok ? 1 : 0),
          failureCount: tool.failureCount + (ok ? 0 : 1),
        }
      : tool,
  );
  await writeRegistry(rootPath, registry);
}
