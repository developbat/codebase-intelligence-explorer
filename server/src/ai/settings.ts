import fs from "node:fs/promises";
import path from "node:path";
import type {
  AiAgentRole,
  AiAgentRoleConfig,
  AiCustomProviderInput,
  AiModelHealthSettings,
  AiProviderId,
  AiSettingsInput,
  AiSettingsPublic,
} from "../../../shared/ai";
import {
  AI_PROVIDERS,
  CUSTOM_PROVIDER_PREFIX,
  providerInfo,
} from "../../../shared/ai";
import { getDataDir } from "../store";

interface StoredProvider {
  apiKey?: string;
  baseUrl: string;
  model: string;
  models?: string[];
  modelsUpdatedAt?: string;
}

interface StoredCustomProvider {
  id: string;
  name: string;
  baseUrl: string;
  modelListUrl?: string;
  apiKey?: string;
  model: string;
  models: string[];
  modelsUpdatedAt?: string;
}

type StoredAgentRoles = Record<AiAgentRole, AiAgentRoleConfig>;

interface StoredSettings {
  version: 3;
  defaultProvider: AiProviderId;
  defaultModel: string;
  providers: Partial<Record<AiProviderId, StoredProvider>>;
  customProviders: StoredCustomProvider[];
  agentRoles: StoredAgentRoles;
  modelHealth: AiModelHealthSettings;
  autoSwitchModels: boolean;
}

export const AI_AGENT_ROLES: AiAgentRole[] = ["main", "planner", "fast", "reviewer"];
const DEFAULT_MODEL_HEALTH: AiModelHealthSettings = {
  protocolFailureLimit: 2,
  emptyFailureLimit: 2,
  penaltyPerFailure: 10,
};

function normalizeModelHealth(input?: Partial<AiModelHealthSettings>): AiModelHealthSettings {
  return {
    protocolFailureLimit: Math.max(
      1,
      Math.min(10, Math.round(input?.protocolFailureLimit ?? DEFAULT_MODEL_HEALTH.protocolFailureLimit)),
    ),
    emptyFailureLimit: Math.max(
      1,
      Math.min(10, Math.round(input?.emptyFailureLimit ?? DEFAULT_MODEL_HEALTH.emptyFailureLimit)),
    ),
    penaltyPerFailure: Math.max(
      1,
      Math.min(100, Math.round(input?.penaltyPerFailure ?? DEFAULT_MODEL_HEALTH.penaltyPerFailure)),
    ),
  };
}

export interface ResolvedProvider {
  id: AiProviderId;
  name: string;
  kind: "openai" | "anthropic" | "gemini";
  baseUrl: string;
  model: string;
  apiKey: string;
  models: string[];
  modelListUrl?: string;
  custom?: boolean;
}

function settingsPath(): string {
  return path.join(getDataDir(), "ai-settings.json");
}

function normalizeBaseUrl(value: string): string {
  return value
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/i, "")
    .replace(/\/+$/, "");
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "provider";
}

function uniqueCustomId(name: string, existing: StoredCustomProvider[], keep?: string): string {
  const base = `${CUSTOM_PROVIDER_PREFIX}${slugify(name)}`;
  let candidate = base;
  let counter = 2;
  while (existing.some((provider) => provider.id === candidate && provider.id !== keep)) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  return candidate;
}

function defaults(): StoredSettings {
  const providers: Partial<Record<AiProviderId, StoredProvider>> = {};
  for (const provider of AI_PROVIDERS) {
    providers[provider.id] = {
      baseUrl: provider.baseUrl,
      model: provider.models[0] ?? "",
    };
  }
  const first = AI_PROVIDERS[0];
  const main = { provider: first.id, model: first.models[0] ?? "" };
  return {
    version: 3,
    defaultProvider: main.provider,
    defaultModel: main.model,
    providers,
    customProviders: [],
    agentRoles: { main, planner: main, fast: main, reviewer: main },
    modelHealth: DEFAULT_MODEL_HEALTH,
    autoSwitchModels: true,
  };
}

async function loadStored(): Promise<StoredSettings> {
  const base = defaults();
  try {
    const parsed = JSON.parse(await fs.readFile(settingsPath(), "utf8")) as Partial<StoredSettings> & {
      customProviders?: StoredCustomProvider[];
    };
    const customProviders = Array.isArray(parsed.customProviders)
      ? parsed.customProviders
          .filter(
            (provider): provider is StoredCustomProvider =>
              Boolean(
                provider &&
                  typeof provider.id === "string" &&
                  provider.id.startsWith(CUSTOM_PROVIDER_PREFIX) &&
                  typeof provider.name === "string" &&
                  typeof provider.baseUrl === "string",
              ),
          )
          .map((provider) => ({
            ...provider,
            model: provider.model ?? provider.models?.[0] ?? "",
            models: Array.isArray(provider.models) ? provider.models.filter(Boolean) : [],
          }))
      : [];
    const defaultProvider = parsed.defaultProvider ?? base.defaultProvider;
    const defaultModel = parsed.defaultModel ?? base.defaultModel;
    const fallbackRole = { provider: defaultProvider, model: defaultModel };
    const parsedRoles: Partial<StoredAgentRoles> =
      (parsed as { agentRoles?: Partial<StoredAgentRoles> }).agentRoles ?? {};
    const agentRoles: StoredAgentRoles = {
      main:
        parsedRoles.main && typeof parsedRoles.main.provider === "string"
          ? parsedRoles.main
          : fallbackRole,
      planner:
        parsedRoles.planner && typeof parsedRoles.planner.provider === "string"
          ? parsedRoles.planner
          : fallbackRole,
      fast:
        parsedRoles.fast && typeof parsedRoles.fast.provider === "string"
          ? parsedRoles.fast
          : fallbackRole,
      reviewer:
        parsedRoles.reviewer && typeof parsedRoles.reviewer.provider === "string"
          ? parsedRoles.reviewer
          : fallbackRole,
    };
    const providers: Partial<Record<AiProviderId, StoredProvider>> = {
      ...base.providers,
      ...(parsed.providers ?? {}),
    };
    for (const [id, provider] of Object.entries(providers)) {
      if (!provider) continue;
      providers[id] = {
        ...provider,
        models: Array.isArray(provider.models) ? provider.models.filter(Boolean) : undefined,
      };
    }
    return {
      version: 3,
      defaultProvider,
      defaultModel,
      providers,
      customProviders,
      agentRoles,
      modelHealth: normalizeModelHealth(parsed.modelHealth),
      autoSwitchModels: parsed.autoSwitchModels !== false,
    };
  } catch {
    return base;
  }
}

async function saveStored(settings: StoredSettings): Promise<void> {
  const file = settingsPath();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(settings, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.rename(temp, file);
}

export async function getPublicSettings(): Promise<AiSettingsPublic> {
  const stored = await loadStored();
  const builtIns = AI_PROVIDERS.map((provider) => {
    const config = stored.providers[provider.id];
    const key = config?.apiKey;
    return {
      id: provider.id,
      name: provider.name,
      kind: provider.kind,
      baseUrl: config?.baseUrl ?? provider.baseUrl,
      model: config?.model ?? provider.models[0] ?? "",
      models: config?.models?.length ? config.models : provider.models,
      custom: false,
      modelListUrl: undefined,
      modelsUpdatedAt: config?.modelsUpdatedAt,
      hasKey: Boolean(key),
      keyHint: key ? `••••${key.slice(-4)}` : undefined,
    };
  });
  const custom = stored.customProviders.map((provider) => ({
    id: provider.id,
    name: provider.name,
    kind: "openai" as const,
    baseUrl: provider.baseUrl,
    model: provider.model,
    models: provider.models,
    custom: true,
    modelListUrl: provider.modelListUrl,
    modelsUpdatedAt: provider.modelsUpdatedAt,
    hasKey: Boolean(provider.apiKey),
    keyHint: provider.apiKey ? `••••${provider.apiKey.slice(-4)}` : undefined,
  }));
  const providers = [...builtIns, ...custom];
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const defaultProvider = byId.get(stored.defaultProvider) ?? providers[0];
  const agentRoles = AI_AGENT_ROLES.map((role) => {
    const configured = stored.agentRoles[role] ?? {
      provider: defaultProvider?.id ?? "openai",
      model: defaultProvider?.model ?? "",
    };
    const provider = byId.get(configured.provider) ?? defaultProvider;
    return {
      role,
      provider: provider?.id ?? configured.provider,
      model: configured.model || provider?.model || "",
      providerName: provider?.name ?? configured.provider,
      models: provider?.models ?? [],
    };
  });
  return {
    defaultProvider: stored.defaultProvider,
    defaultModel: stored.defaultModel,
    providers,
    agentRoles,
    modelHealth: stored.modelHealth,
    autoSwitchModels: stored.autoSwitchModels !== false,
  };
}

function cleanModels(models: string[] | undefined, fallback: string[]): string[] {
  const cleaned = (models ?? [])
    .map((model) => model.trim())
    .filter(Boolean)
    .filter((model, index, list) => list.indexOf(model) === index);
  return cleaned.length > 0 ? cleaned : fallback;
}

async function upsertCustomProvider(
  stored: StoredSettings,
  input: AiCustomProviderInput,
): Promise<string> {
  const existing = input.id
    ? stored.customProviders.find((provider) => provider.id === input.id)
    : undefined;
  const name = (input.name ?? existing?.name ?? "").trim();
  const baseUrl = normalizeBaseUrl(input.baseUrl ?? existing?.baseUrl ?? "");
  if (!name) throw new Error("A provider name is required.");
  if (!baseUrl) throw new Error("A base URL is required.");
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error("The base URL must start with http:// or https://.");
  }

  const models = cleanModels(input.models, existing?.models ?? []);
  const id = existing?.id ?? uniqueCustomId(name, stored.customProviders);
  const next: StoredCustomProvider = {
    id,
    name: name.slice(0, 80),
    baseUrl,
    modelListUrl: input.modelListUrl?.trim() || undefined,
    model: existing?.model && models.includes(existing.model) ? existing.model : models[0] ?? "",
    models,
  };
  if (input.clearKey) next.apiKey = undefined;
  else if (input.apiKey !== undefined && input.apiKey.trim()) next.apiKey = input.apiKey.trim();
  else next.apiKey = existing?.apiKey;

  if (existing) {
    stored.customProviders = stored.customProviders.map((provider) =>
      provider.id === existing.id ? next : provider,
    );
  } else {
    stored.customProviders.push(next);
  }
  return id;
}

export async function updateAiSettings(input: AiSettingsInput): Promise<AiSettingsPublic> {
  const stored = await loadStored();
  const builtInIds = new Set(AI_PROVIDERS.map((provider) => provider.id));
  const isKnownProvider = (id: string) =>
    builtInIds.has(id) || stored.customProviders.some((provider) => provider.id === id);

  if (input.removeProviderId) {
    if (!stored.customProviders.some((provider) => provider.id === input.removeProviderId)) {
      throw new Error("Unknown custom provider.");
    }
    stored.customProviders = stored.customProviders.filter(
      (provider) => provider.id !== input.removeProviderId,
    );
    if (stored.defaultProvider === input.removeProviderId) {
      stored.defaultProvider = AI_PROVIDERS[0].id;
      stored.defaultModel = stored.providers[AI_PROVIDERS[0].id]?.model ?? "";
    }
    for (const role of AI_AGENT_ROLES) {
      if (stored.agentRoles[role]?.provider === input.removeProviderId) {
        stored.agentRoles[role] = {
          provider: stored.defaultProvider,
          model: stored.defaultModel,
        };
      }
    }
    await saveStored(stored);
    return getPublicSettings();
  }

  if (input.customProvider) {
    const id = await upsertCustomProvider(stored, input.customProvider);
    if (!input.defaultProvider && stored.defaultProvider === input.customProvider.id) {
      stored.defaultProvider = id;
      stored.defaultModel =
        stored.customProviders.find((provider) => provider.id === id)?.model ?? stored.defaultModel;
    }
    await saveStored(stored);
    return getPublicSettings();
  }

  const providerId = input.provider ?? input.defaultProvider;
  if (providerId && !isKnownProvider(providerId)) {
    throw new Error("Unknown AI provider.");
  }

  if (input.defaultProvider) {
    if (!isKnownProvider(input.defaultProvider)) throw new Error("Unknown AI provider.");
    stored.defaultProvider = input.defaultProvider;
    if (!input.defaultModel) {
      stored.defaultModel =
        stored.providers[input.defaultProvider]?.model ??
        stored.customProviders.find((provider) => provider.id === input.defaultProvider)?.model ??
        stored.defaultModel;
    }
  }
  if (input.defaultModel !== undefined) stored.defaultModel = input.defaultModel;

  if (providerId && builtInIds.has(providerId)) {
    const info = providerInfo(providerId);
    const current = stored.providers[providerId] ?? {
      baseUrl: info.baseUrl,
      model: info.models[0] ?? "",
    };
    const next: StoredProvider = {
      baseUrl: input.baseUrl?.trim() || current.baseUrl || info.baseUrl,
      model: input.model?.trim() || current.model || info.models[0] || "",
      models:
        input.models !== undefined
          ? cleanModels(input.models, current.models ?? info.models)
          : current.models,
      modelsUpdatedAt: input.models !== undefined ? new Date().toISOString() : current.modelsUpdatedAt,
    };
    if (input.clearKey) next.apiKey = undefined;
    else if (input.apiKey !== undefined && input.apiKey.trim()) next.apiKey = input.apiKey.trim();
    else next.apiKey = current.apiKey;
    stored.providers[providerId] = next;

    if (stored.defaultProvider === providerId && input.model) stored.defaultModel = next.model;
  }

  if (providerId && !builtInIds.has(providerId)) {
    const custom = stored.customProviders.find((provider) => provider.id === providerId);
    if (custom) {
      if (input.baseUrl !== undefined) custom.baseUrl = normalizeBaseUrl(input.baseUrl);
      if (input.model !== undefined) custom.model = input.model.trim() || custom.model;
      if (input.clearKey) custom.apiKey = undefined;
      else if (input.apiKey !== undefined && input.apiKey.trim()) custom.apiKey = input.apiKey.trim();
      if (stored.defaultProvider === providerId && input.model) stored.defaultModel = custom.model;
    }
  }

  if (input.defaultProvider || input.defaultModel !== undefined) {
    stored.agentRoles.main = {
      provider: stored.defaultProvider,
      model: stored.defaultModel,
    };
  }

  if (input.modelHealth) {
    stored.modelHealth = normalizeModelHealth({ ...stored.modelHealth, ...input.modelHealth });
  }

  if (input.autoSwitchModels !== undefined) {
    stored.autoSwitchModels = input.autoSwitchModels === true;
  }

  if (input.agentRoles) {
    for (const role of AI_AGENT_ROLES) {
      const configured = input.agentRoles[role];
      if (!configured) continue;
      if (!isKnownProvider(configured.provider)) throw new Error("Unknown AI provider for an agent role.");
      const model = configured.model.trim();
      if (!model) throw new Error(`The ${role} agent needs a model.`);
      stored.agentRoles[role] = { provider: configured.provider, model };
    }
    const main = stored.agentRoles.main;
    stored.defaultProvider = main.provider;
    stored.defaultModel = main.model;
  }

  await saveStored(stored);
  return getPublicSettings();
}

export async function resolveProvider(
  provider?: AiProviderId,
  model?: string,
): Promise<ResolvedProvider> {
  const stored = await loadStored();
  const id = provider ?? stored.defaultProvider;

  const custom = stored.customProviders.find((entry) => entry.id === id);
  if (custom) {
    return {
      id,
      name: custom.name,
      kind: "openai",
      baseUrl: normalizeBaseUrl(custom.baseUrl),
      model: model?.trim() || custom.model || custom.models[0] || "",
      apiKey: custom.apiKey ?? "",
      models: custom.models,
      modelListUrl: custom.modelListUrl,
      custom: true,
    };
  }

  const info = providerInfo(id);
  if (!AI_PROVIDERS.some((entry) => entry.id === id)) {
    throw new Error("Unknown AI provider. Add it in AI settings.");
  }
  const config = stored.providers[id];
  const apiKey = config?.apiKey ?? "";
  if (!apiKey && id !== "custom") {
    throw new Error(`${info.name} is not configured. Add an API key in AI settings.`);
  }
  return {
    id,
    name: info.name,
    kind: info.kind,
    baseUrl: normalizeBaseUrl(config?.baseUrl || info.baseUrl),
    model: model?.trim() || config?.model || stored.defaultModel || info.models[0] || "",
    apiKey,
    models: config?.models?.length ? config.models : info.models,
  };
}

export async function saveProviderModels(providerId: AiProviderId, models: string[]): Promise<string[]> {
  const stored = await loadStored();
  const cleaned = models.map((model) => model.trim()).filter(Boolean);
  const unique = [...new Set(cleaned)];
  if (unique.length === 0) return [];
  const at = new Date().toISOString();
  const builtIn = AI_PROVIDERS.find((provider) => provider.id === providerId);
  if (builtIn) {
    const current = stored.providers[providerId] ?? {
      baseUrl: builtIn.baseUrl,
      model: builtIn.models[0] ?? "",
    };
    stored.providers[providerId] = {
      ...current,
      models: unique,
      modelsUpdatedAt: at,
    };
  } else {
    const custom = stored.customProviders.find((provider) => provider.id === providerId);
    if (!custom) throw new Error("Unknown AI provider.");
    custom.models = unique;
    custom.modelsUpdatedAt = at;
    if (!unique.includes(custom.model)) custom.model = unique[0] ?? custom.model;
  }
  await saveStored(stored);
  return unique;
}

export async function resolveAgentRole(
  role: AiAgentRole,
  override?: { provider?: AiProviderId; model?: string },
): Promise<ResolvedProvider> {
  const stored = await loadStored();
  const configured = stored.agentRoles[role] ?? {
    provider: stored.defaultProvider,
    model: stored.defaultModel,
  };
  const candidates: { provider: AiProviderId; model?: string }[] = [
    { provider: override?.provider ?? configured.provider, model: override?.model ?? configured.model },
    { provider: stored.defaultProvider, model: stored.defaultModel },
    ...AI_PROVIDERS.map((provider) => ({
      provider: provider.id,
      model: stored.providers[provider.id]?.model ?? provider.models[0],
    })),
    ...stored.customProviders.map((provider) => ({
      provider: provider.id,
      model: provider.model,
    })),
  ];
  const seen = new Set<string>();
  let lastError: unknown = null;
  for (const candidate of candidates) {
    const key = `${candidate.provider}::${candidate.model ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      return await resolveProvider(candidate.provider, candidate.model);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("No configured AI provider can serve this agent role.");
}

export async function hasAnyConfiguredKey(): Promise<boolean> {
  const stored = await loadStored();
  if (stored.customProviders.length > 0) return true;
  return AI_PROVIDERS.some((provider) => Boolean(stored.providers[provider.id]?.apiKey));
}
