import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  CatalogAgent,
  CatalogImportInput,
  CatalogImportResult,
  CatalogModel,
  ModelCatalog,
} from "../../../shared/catalog";
import { getDataDir } from "../store";

const MAX_MODELS = 5_000;
const MAX_AGENTS = 500;
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 25_000;

function catalogPath(): string {
  return path.join(getDataDir(), "ai-catalog.json");
}

function text(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[$€£,\s]/g, "").toLowerCase();
  const match = /^(-?\d+(?:\.\d+)?)(k|m)?$/.exec(cleaned);
  if (!match) return undefined;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return undefined;
  if (match[2] === "k") return base * 1_000;
  if (match[2] === "m") return base * 1_000_000;
  return base;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : text(item)))
      .filter((item): item is string => Boolean(item));
  }
  if (typeof value === "string") {
    return value
      .split(/[,;|]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function pick(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== "") return record[key];
  }
  return undefined;
}

function nested(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._:/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 160);
}

function normalizeRoles(record: Record<string, unknown>): string[] {
  const raw = stringList(
    pick(record, "roles", "agent_roles", "agentRoles", "use_cases", "useCases", "agents"),
  );
  const roles = new Set(raw.map((role) => role.toLowerCase()));
  const haystack = `${text(pick(record, "name", "title", "label")) ?? ""} ${raw.join(" ")} ${stringList(
    pick(record, "tags", "categories"),
  ).join(" ")}`.toLowerCase();
  if (/(coder|code|swe|engineering)/.test(haystack)) roles.add("main");
  if (/(fast|mini|small|flash|haiku|light|nano|economy|cheap)/.test(haystack)) roles.add("fast");
  if (/(reason|plan|planner|thinking|o1|o3)/.test(haystack)) roles.add("planner");
  if (/(review|critic|judge|verify)/.test(haystack)) roles.add("reviewer");
  return [...roles];
}

function normalizeModel(value: unknown, inheritedProvider?: string): CatalogModel | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const rawProvider = text(pick(record, "provider", "provider_id", "providerId", "vendor", "maker"));
  const rawId = text(pick(record, "id", "model", "model_id", "modelId", "slug", "api_id", "apiId"));
  const name = text(pick(record, "name", "title", "label"));
  const idCandidate = rawId ?? name;
  if (!idCandidate) return null;
  let provider = rawProvider ?? inheritedProvider ?? "";
  if (!provider && idCandidate.includes("/")) provider = idCandidate.split("/")[0];
  if (!provider) provider = "unknown";
  const id = idCandidate.includes("/") ? idCandidate.split("/").slice(1).join("/") : idCandidate;
  const pricing = nested(record, "pricing") ?? nested(record, "price") ?? nested(record, "cost");
  const inputPrice =
    numberValue(pick(record, "input_price", "inputPrice", "prompt_price", "promptPrice", "input")) ??
    (pricing ? numberValue(pick(pricing, "input", "prompt", "input_per_million")) : undefined);
  const outputPrice =
    numberValue(pick(record, "output_price", "outputPrice", "completion_price", "completionPrice", "output")) ??
    (pricing ? numberValue(pick(pricing, "output", "completion", "output_per_million")) : undefined);
  const license = text(pick(record, "license", "licence"));
  const openSourceRaw = pick(record, "open_source", "openSource", "is_open_source");
  const openSource =
    typeof openSourceRaw === "boolean"
      ? openSourceRaw
      : license
        ? !/proprietary|closed/i.test(license)
        : undefined;
  return {
    id: slug(id),
    provider: slug(provider),
    name,
    contextWindow:
      numberValue(pick(record, "context_window", "contextWindow", "context", "max_context", "maxContext", "context_length")) ??
      undefined,
    inputPrice,
    outputPrice,
    speed: text(pick(record, "speed", "latency", "tier")),
    quality: numberValue(pick(record, "quality", "score", "rating", "benchmark")),
    openSource,
    roles: normalizeRoles(record),
    tags: stringList(pick(record, "tags", "categories", "modalities", "features")),
    description: text(pick(record, "description", "summary", "notes", "tagline")),
  };
}

function normalizeAgent(value: unknown): CatalogAgent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const provider = text(pick(record, "provider", "provider_id", "providerId", "vendor"));
  const model = text(pick(record, "model", "model_id", "modelId"));
  const name = text(pick(record, "name", "title", "label", "id"));
  if (!provider || !model || !name) return null;
  return {
    id: slug(text(pick(record, "id", "slug")) ?? name),
    name,
    role: text(pick(record, "role", "agent_role", "agentRole", "type"))?.toLowerCase(),
    provider: slug(provider),
    model: slug(model),
    description: text(pick(record, "description", "summary", "notes")),
  };
}

function collectRoot(value: unknown): { models: unknown[]; agents: unknown[]; warnings: string[] } {
  const warnings: string[] = [];
  if (Array.isArray(value)) return { models: value, agents: [], warnings };
  if (!value || typeof value !== "object") throw new Error("Catalog JSON must be an object or array.");
  const record = value as Record<string, unknown>;
  const models = Array.isArray(record.models)
    ? record.models
    : Array.isArray(record.items)
      ? record.items
      : Array.isArray(record.data)
        ? record.data
        : Array.isArray(record.model_list)
          ? record.model_list
          : [];
  const agents = Array.isArray(record.agents)
    ? record.agents
    : Array.isArray(record.agent_presets)
      ? record.agent_presets
      : Array.isArray(record.agentPresets)
        ? record.agentPresets
        : [];

  // Provider-grouped shape: { providers: [{ name, models: [...] }] }
  if (models.length === 0 && Array.isArray(record.providers)) {
    const flattened: unknown[] = [];
    for (const provider of record.providers) {
      if (!provider || typeof provider !== "object") continue;
      const providerRecord = provider as Record<string, unknown>;
      const providerName = text(pick(providerRecord, "name", "id", "provider"));
      const list = Array.isArray(providerRecord.models) ? providerRecord.models : [];
      for (const model of list) {
        if (model && typeof model === "object") {
          flattened.push({ ...(model as Record<string, unknown>), provider: providerName });
        }
      }
    }
    if (flattened.length > 0) {
      warnings.push("Detected a provider-grouped catalog.");
      return { models: flattened, agents, warnings };
    }
  }
  return { models, agents, warnings };
}

export function parseCatalog(value: unknown, source: string, sourceUrl?: string): ModelCatalog {
  const { models: rawModels, agents: rawAgents, warnings } = collectRoot(value);
  const models = new Map<string, CatalogModel>();
  for (const item of rawModels.slice(0, MAX_MODELS)) {
    const model = normalizeModel(item);
    if (!model) continue;
    models.set(`${model.provider}/${model.id}`.toLowerCase(), model);
  }
  const agents = new Map<string, CatalogAgent>();
  for (const item of rawAgents.slice(0, MAX_AGENTS)) {
    const agent = normalizeAgent(item);
    if (!agent) continue;
    agents.set(agent.id.toLowerCase(), agent);
  }
  if (models.size === 0 && agents.size === 0) {
    throw new Error("No usable models or agents were found in this catalog JSON.");
  }
  if (rawModels.length > models.size) {
    warnings.push(`${rawModels.length - models.size} model entries were skipped or deduplicated.`);
  }
  const normalized = {
    models: [...models.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id)),
    agents: [...agents.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
  const hash = crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 16);
  return {
    version: 1,
    source,
    sourceUrl,
    updatedAt: new Date().toISOString(),
    hash,
    models: normalized.models,
    agents: normalized.agents,
    warnings,
  };
}

async function fetchJson(url: string): Promise<unknown> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("The catalog URL is invalid.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("The catalog URL must start with http:// or https://.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(parsed, {
      signal: controller.signal,
      headers: { Accept: "application/json, text/plain;q=0.9" },
    });
    if (!response.ok) throw new Error(`Catalog URL returned HTTP ${response.status}.`);
    const contentLength = Number(response.headers.get("content-length")) || 0;
    if (contentLength > MAX_SOURCE_BYTES) throw new Error("Catalog JSON is too large (max 5 MB).");
    const body = await response.text();
    if (body.length > MAX_SOURCE_BYTES) throw new Error("Catalog JSON is too large (max 5 MB).");
    const trimmed = body.trim();
    if (trimmed.startsWith("<")) {
      throw new Error(
        "The URL returned HTML, not JSON. Paste a JSON export or point to a JSON endpoint.",
      );
    }
    return JSON.parse(trimmed) as unknown;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Catalog download timed out.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readStored(): Promise<ModelCatalog | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(catalogPath(), "utf8")) as ModelCatalog;
    if (!parsed || !Array.isArray(parsed.models)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeStored(catalog: ModelCatalog): Promise<void> {
  const file = catalogPath();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(catalog, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.rename(temp, file);
}

export async function getModelCatalog(): Promise<ModelCatalog | null> {
  return readStored();
}

export async function importModelCatalog(input: CatalogImportInput): Promise<CatalogImportResult> {
  let value: unknown;
  let source = "paste";
  let sourceUrl: string | undefined;
  if (input.url?.trim()) {
    sourceUrl = input.url.trim();
    source = sourceUrl;
    value = await fetchJson(sourceUrl);
  } else if (input.json?.trim()) {
    try {
      value = JSON.parse(input.json) as unknown;
    } catch {
      throw new Error("The pasted catalog is not valid JSON.");
    }
  } else {
    throw new Error("Provide catalog JSON or a JSON URL.");
  }

  const parsed = parseCatalog(value, source, sourceUrl);
  if (input.replace === false) {
    const existing = await readStored();
    if (existing) {
      const models = new Map(existing.models.map((model) => [`${model.provider}/${model.id}`.toLowerCase(), model]));
      for (const model of parsed.models) models.set(`${model.provider}/${model.id}`.toLowerCase(), model);
      const agents = new Map(existing.agents.map((agent) => [agent.id.toLowerCase(), agent]));
      for (const agent of parsed.agents) agents.set(agent.id.toLowerCase(), agent);
      parsed.models = [...models.values()];
      parsed.agents = [...agents.values()];
      parsed.hash = crypto
        .createHash("sha256")
        .update(
          JSON.stringify({
            models: parsed.models,
            agents: parsed.agents,
          }),
        )
        .digest("hex")
        .slice(0, 16);
      parsed.updatedAt = new Date().toISOString();
    }
  }
  await writeStored(parsed);
  return {
    catalog: parsed,
    importedModels: parsed.models.length,
    importedAgents: parsed.agents.length,
    warnings: parsed.warnings,
  };
}

export async function clearModelCatalog(): Promise<void> {
  await fs.rm(catalogPath(), { force: true });
}
