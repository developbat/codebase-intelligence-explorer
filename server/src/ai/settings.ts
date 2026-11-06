import fs from "node:fs/promises";
import path from "node:path";
import type { AiProviderId, AiSettingsInput, AiSettingsPublic } from "../../../shared/ai";
import { AI_PROVIDERS, providerInfo } from "../../../shared/ai";
import { getDataDir } from "../store";

interface StoredProvider {
  apiKey?: string;
  baseUrl: string;
  model: string;
}

interface StoredSettings {
  version: 1;
  defaultProvider: AiProviderId;
  defaultModel: string;
  providers: Partial<Record<AiProviderId, StoredProvider>>;
}

export interface ResolvedProvider {
  id: AiProviderId;
  kind: "openai" | "anthropic" | "gemini";
  baseUrl: string;
  model: string;
  apiKey: string;
}

function settingsPath(): string {
  return path.join(getDataDir(), "ai-settings.json");
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
  return {
    version: 1,
    defaultProvider: first.id,
    defaultModel: first.models[0] ?? "",
    providers,
  };
}

async function loadStored(): Promise<StoredSettings> {
  const base = defaults();
  try {
    const parsed = JSON.parse(await fs.readFile(settingsPath(), "utf8")) as Partial<StoredSettings>;
    return {
      version: 1,
      defaultProvider: parsed.defaultProvider ?? base.defaultProvider,
      defaultModel: parsed.defaultModel ?? base.defaultModel,
      providers: { ...base.providers, ...(parsed.providers ?? {}) },
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
  return {
    defaultProvider: stored.defaultProvider,
    defaultModel: stored.defaultModel,
    providers: AI_PROVIDERS.map((provider) => {
      const config = stored.providers[provider.id];
      const key = config?.apiKey;
      return {
        id: provider.id,
        baseUrl: config?.baseUrl ?? provider.baseUrl,
        model: config?.model ?? provider.models[0] ?? "",
        hasKey: Boolean(key),
        keyHint: key ? `••••${key.slice(-4)}` : undefined,
      };
    }),
  };
}

export async function updateAiSettings(input: AiSettingsInput): Promise<AiSettingsPublic> {
  const stored = await loadStored();
  const providerId = input.provider ?? input.defaultProvider;
  if (providerId && !AI_PROVIDERS.some((provider) => provider.id === providerId)) {
    throw new Error("Unknown AI provider.");
  }

  if (input.defaultProvider) {
    stored.defaultProvider = input.defaultProvider;
    if (!input.defaultModel) {
      stored.defaultModel = stored.providers[input.defaultProvider]?.model ?? stored.defaultModel;
    }
  }
  if (input.defaultModel !== undefined) stored.defaultModel = input.defaultModel;

  if (providerId) {
    const info = providerInfo(providerId);
    const current = stored.providers[providerId] ?? { baseUrl: info.baseUrl, model: info.models[0] ?? "" };
    const next: StoredProvider = {
      baseUrl: input.baseUrl?.trim() || current.baseUrl || info.baseUrl,
      model: input.model?.trim() || current.model || info.models[0] || "",
    };
    if (input.clearKey) next.apiKey = undefined;
    else if (input.apiKey !== undefined && input.apiKey.trim()) next.apiKey = input.apiKey.trim();
    else next.apiKey = current.apiKey;
    stored.providers[providerId] = next;

    if (stored.defaultProvider === providerId && input.model) stored.defaultModel = next.model;
  }

  await saveStored(stored);
  return getPublicSettings();
}

export async function resolveProvider(provider?: AiProviderId, model?: string): Promise<ResolvedProvider> {
  const stored = await loadStored();
  const id = provider ?? stored.defaultProvider;
  const info = providerInfo(id);
  const config = stored.providers[id];
  const apiKey = config?.apiKey ?? "";
  if (!apiKey && id !== "custom") {
    throw new Error(`${info.name} is not configured. Add an API key in AI settings.`);
  }
  return {
    id,
    kind: info.kind,
    baseUrl: (config?.baseUrl || info.baseUrl).replace(/\/+$/, ""),
    model: model?.trim() || config?.model || stored.defaultModel || info.models[0] || "",
    apiKey,
  };
}

export async function hasAnyConfiguredKey(): Promise<boolean> {
  const stored = await loadStored();
  return AI_PROVIDERS.some((provider) => Boolean(stored.providers[provider.id]?.apiKey));
}
