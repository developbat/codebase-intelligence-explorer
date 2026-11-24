import fs from "node:fs/promises";
import path from "node:path";
import type {
  ProjectTool,
  ProjectToolInputSchema,
  ProjectToolList,
} from "../../shared/projectTools";

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

async function scriptDescription(
  rootPath: string,
  relative: string,
  name: string,
): Promise<string | undefined> {
  try {
    const content = await fs.readFile(path.join(rootPath, relative), "utf8");
    const lines = content.split("\n").slice(0, 24);
    for (const line of lines) {
      const tagged = /^\s*(?:\/\/|#)\s*(?:@description|description)\s*[:\-]\s*(.+)$/i.exec(line);
      if (tagged?.[1]?.trim()) return tagged[1].trim().slice(0, 300);
    }
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#!")) continue;
      if (!trimmed.startsWith("#") && !trimmed.startsWith("//")) continue;
      const text = trimmed.replace(/^[#/]+\s*/, "").trim();
      if (!text || /^usage\b/i.test(text)) continue;
      const lower = text.toLowerCase();
      if (lower.startsWith(`${name.toLowerCase()}:`)) {
        return text.slice(name.length + 1).trim().slice(0, 300);
      }
      if (text.length >= 12) return text.slice(0, 300);
    }
  } catch {
    // description is optional
  }
  return undefined;
}

export async function syncProjectTools(rootPath: string): Promise<ProjectToolList> {
  const registry = await readRegistry(rootPath);
  const manual = registry.tools.filter((tool) => tool.source === "manual");
  const manualPaths = new Set(manual.map((tool) => tool.path).filter(Boolean));
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
      if (manualPaths.has(relative)) continue;
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
      const parsedDescription = await scriptDescription(rootPath, relative, name);
      auto.push({
        name,
        description:
          parsedDescription ??
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


export function validateProjectToolInput(
  tool: ProjectTool,
  input: unknown,
): string | null {
  const record =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const schema = tool.inputSchema;
  if (!schema) return null;
  for (const key of schema.required ?? []) {
    const value = record[key];
    if (value === undefined || value === null || value === "") {
      return `Project tool "${tool.name}" requires input.${key}.`;
    }
  }
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    if (property.enum && !property.enum.includes(value as string | number | boolean)) {
      return `Project tool "${tool.name}" input.${key} must be one of: ${property.enum.join(", ")}.`;
    }
    if (property.type) {
      const actual = Array.isArray(value) ? "array" : typeof value;
      if (actual !== property.type) {
        return `Project tool "${tool.name}" input.${key} must be ${property.type}, got ${actual}.`;
      }
    }
  }
  return null;
}

export async function createProjectTool(
  rootPath: string,
  input: {
    name: string;
    description?: string;
    whenToUse?: string;
    inputSchema?: ProjectToolInputSchema;
    timeoutMs?: number;
    language?: "js" | "ts" | "py" | "sh";
    code: string;
  },
): Promise<ProjectTool> {
  const language = input.language ?? "js";
  const extension = language === "ts" ? ".ts" : language === "py" ? ".py" : language === "sh" ? ".sh" : ".js";
  const name = await nextProjectToolName(rootPath, input.name);
  if (!/^[a-z0-9._-]{1,60}$/.test(name)) throw new Error("Invalid tool name.");
  const code = input.code.trim();
  if (!code) throw new Error("Tool code is required.");
  if (Buffer.byteLength(code, "utf8") > 300_000) throw new Error("Tool code is larger than the 300 KB limit.");
  const relative = `${TOOLS_DIR}/${name}${extension}`;
  const absolute = path.resolve(rootPath, relative);
  if (!absolute.startsWith(`${path.resolve(rootPath, TOOLS_DIR)}${path.sep}`)) {
    throw new Error("Tool path is outside the tools folder.");
  }
  const command = commandFor(relative);
  if (!command) throw new Error("Unsupported tool language.");
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, `${code}\n`, { encoding: "utf8", mode: 0o600 });
  const registry = await readRegistry(rootPath);
  const now = new Date().toISOString();
  const inputSchema =
    input.inputSchema && typeof input.inputSchema === "object"
      ? JSON.parse(JSON.stringify(input.inputSchema)) as ProjectToolInputSchema
      : undefined;
  if (inputSchema && JSON.stringify(inputSchema).length > 20_000) {
    throw new Error("Tool input schema is larger than the 20 KB limit.");
  }
  const tool: ProjectTool = {
    name,
    description:
      input.description?.trim().slice(0, 500) ||
      `Agent-created reusable ${language} tool. Run it with run_project_tool instead of rewriting the same logic.`,
    whenToUse: input.whenToUse?.trim().slice(0, 500) || undefined,
    inputSchema,
    timeoutMs: input.timeoutMs
      ? Math.max(1_000, Math.min(600_000, Math.round(input.timeoutMs)))
      : undefined,
    command,
    tags: ["generated", language],
    source: "manual",
    path: relative,
    createdAt: now,
    updatedAt: now,
    successCount: 0,
    failureCount: 0,
  };
  registry.tools = [...registry.tools.filter((item) => item.name !== name), tool].slice(0, MAX_TOOLS);
  await writeRegistry(rootPath, registry);
  return tool;
}
