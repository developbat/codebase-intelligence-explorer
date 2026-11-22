import fs from "node:fs/promises";
import path from "node:path";
import type { AiProviderId, AiTokenUsage } from "../../../shared/ai";
import {
  findModelPrice,
  type ModelPricing,
  type PricingReport,
  type PricingSource,
} from "../../../shared/pricing";
import { getDataDir } from "../store";
import { getPublicSettings } from "./settings";

interface PricingFile {
  version: 1;
  updatedAt?: string;
  prices: ModelPricing[];
  sources: PricingSource[];
}

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const PROVIDER_PREFIX: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  deepseek: "deepseek",
  gemini: "google",
  nvidia: "nvidia",
  xai: "x-ai",
  openrouter: "openrouter",
};
const CACHE_MS = 30_000;

let cache: { file: PricingFile; at: number } | null = null;

function pricingPath(): string {
  return path.join(getDataDir(), "model-pricing.json");
}

async function readFile(): Promise<PricingFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(pricingPath(), "utf8")) as Partial<PricingFile>;
    return {
      version: 1,
      updatedAt: parsed.updatedAt,
      prices: Array.isArray(parsed.prices) ? parsed.prices : [],
      sources: Array.isArray(parsed.sources) ? parsed.sources : [],
    };
  } catch {
    return { version: 1, prices: [], sources: [] };
  }
}

async function writeFile(file: PricingFile): Promise<void> {
  const target = pricingPath();
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(file, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.rename(temp, target);
  cache = { file, at: Date.now() };
}

async function loadFile(): Promise<PricingFile> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.file;
  const file = await readFile();
  cache = { file, at: Date.now() };
  return file;
}

function perMillion(value: unknown): number | undefined {
  const perToken = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  if (!Number.isFinite(perToken) || perToken < 0) return undefined;
  return Number((perToken * 1_000_000).toFixed(6));
}

function normalizeModel(value: string): string {
  return value.trim().toLowerCase();
}

function openRouterPricing(payload: unknown): Map<string, Omit<ModelPricing, "provider" | "model" | "updatedAt">> {
  const data = (payload as { data?: { id?: string; pricing?: Record<string, unknown> }[] }).data ?? [];
  const map = new Map<string, Omit<ModelPricing, "provider" | "model" | "updatedAt">>();
  for (const item of data) {
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) continue;
    const input = perMillion(item.pricing?.prompt);
    const output = perMillion(item.pricing?.completion);
    if (input === undefined && output === undefined) continue;
    map.set(normalizeModel(id), {
      inputPerMillion: input,
      outputPerMillion: output,
      cacheReadPerMillion: perMillion(item.pricing?.input_cache_read),
      cacheWritePerMillion: perMillion(item.pricing?.input_cache_write),
      currency: "USD",
      source: "openrouter",
      matchedModel: id,
    });
  }
  return map;
}

export async function refreshPricing(): Promise<PricingReport> {
  const settings = await getPublicSettings().catch(() => null);
  const sources: PricingSource[] = [];
  const prices: ModelPricing[] = [];
  const updatedAt = new Date().toISOString();

  let catalog = new Map<string, Omit<ModelPricing, "provider" | "model" | "updatedAt">>();
  try {
    const response = await fetch(OPENROUTER_MODELS_URL, {
      headers: {
        Accept: "application/json",
        "User-Agent": "codebase-intelligence-explorer/0.2 pricing",
      },
      signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    catalog = openRouterPricing(await response.json());
    sources.push({
      id: "openrouter",
      label: "OpenRouter public model catalog",
      ok: true,
      count: catalog.size,
    });
  } catch (error) {
    sources.push({
      id: "openrouter",
      label: "OpenRouter public model catalog",
      ok: false,
      count: 0,
      error: error instanceof Error ? error.message : "pricing fetch failed",
    });
  }

  for (const [id, price] of catalog) {
    prices.push({
      provider: "openrouter",
      model: price.matchedModel ?? id,
      inputPerMillion: price.inputPerMillion,
      outputPerMillion: price.outputPerMillion,
      cacheReadPerMillion: price.cacheReadPerMillion,
      cacheWritePerMillion: price.cacheWritePerMillion,
      currency: "USD",
      source: price.source,
      matchedModel: price.matchedModel ?? id,
      updatedAt,
    });
  }

  const byLastSegment = new Map<string, string[]>();
  for (const id of catalog.keys()) {
    const segment = id.split("/").pop() ?? id;
    byLastSegment.set(segment, [...(byLastSegment.get(segment) ?? []), id]);
  }

  if (settings) {
    const providers = settings.providers.filter((provider) => provider.hasKey || provider.custom);
    for (const provider of providers) {
      const models =
        provider.models.length > 0 ? provider.models : provider.model ? [provider.model] : [];
      const prefix = PROVIDER_PREFIX[provider.id] ?? provider.id;
      for (const model of models) {
        if (!model) continue;
        const normalized = normalizeModel(model);
        let matched: string | undefined;
        const direct = catalog.get(normalizeModel(`${prefix}/${model}`));
        if (direct) {
          matched = normalizeModel(`${prefix}/${model}`);
        } else if (catalog.has(normalized)) {
          matched = normalized;
        } else {
          const candidates = byLastSegment.get(normalized.split("/").pop() ?? normalized) ?? [];
          if (candidates.length === 1) matched = candidates[0];
        }
        if (!matched) continue;
        const price = catalog.get(matched);
        if (!price) continue;
        prices.push({
          provider: provider.id,
          model,
          inputPerMillion: price.inputPerMillion,
          outputPerMillion: price.outputPerMillion,
          cacheReadPerMillion: price.cacheReadPerMillion,
          cacheWritePerMillion: price.cacheWritePerMillion,
          currency: "USD",
          source: price.source,
          matchedModel: price.matchedModel,
          updatedAt,
        });
      }
    }
  }

  const unique = new Map<string, ModelPricing>();
  for (const price of prices) {
    const key = `${price.provider.toLowerCase()}::${price.model.toLowerCase()}`;
    if (!unique.has(key)) unique.set(key, price);
  }
  const file: PricingFile = { version: 1, updatedAt, prices: [...unique.values()], sources };
  await writeFile(file);
  return { prices: file.prices, updatedAt, sources };
}

export async function getPricingReport(): Promise<PricingReport> {
  const file = await loadFile();
  return { prices: file.prices, updatedAt: file.updatedAt, sources: file.sources };
}

export function findPrice(
  prices: ModelPricing[],
  provider: string,
  model: string,
): ModelPricing | undefined {
  return findModelPrice(prices, provider, model);
}


export async function priceFor(
  provider: string,
  model: string,
): Promise<ModelPricing | undefined> {
  const file = await loadFile();
  return findPrice(file.prices, provider, model);
}

export function usageCost(
  usage: AiTokenUsage,
  price: ModelPricing | undefined,
): number | undefined {
  if (!price) return undefined;
  const input = price.inputPerMillion;
  const output = price.outputPerMillion;
  if (input === undefined && output === undefined) return undefined;
  const cost =
    (usage.inputTokens / 1_000_000) * (input ?? 0) +
    (usage.outputTokens / 1_000_000) * (output ?? 0);
  return Number(cost.toFixed(6));
}

export async function estimateUsageCost(
  provider: string,
  model: string,
  usage: AiTokenUsage | undefined,
): Promise<number | undefined> {
  if (!usage || usage.totalTokens <= 0) return undefined;
  return usageCost(usage, await priceFor(provider, model));
}

