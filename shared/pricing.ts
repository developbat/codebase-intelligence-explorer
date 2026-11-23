export interface ModelPricing {
  provider: string;
  model: string;
  inputPerMillion?: number;
  outputPerMillion?: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
  currency: "USD";
  source: string;
  matchedModel?: string;
  updatedAt: string;
}

export interface PricingSource {
  id: string;
  label: string;
  ok: boolean;
  count: number;
  error?: string;
}

export interface PricingReport {
  prices: ModelPricing[];
  updatedAt?: string;
  sources: PricingSource[];
}

export function formatUsd(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  if (value === 0) return "free";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

const PROVIDER_PREFIX: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  deepseek: "deepseek",
  gemini: "google",
  nvidia: "nvidia",
  xai: "x-ai",
  openrouter: "openrouter",
};

function canonicalModel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[^/]+\//, "")
    .replace(/[-_\s]+/g, ".")
    .replace(/\.+/g, ".")
    .replace(/^\.|\.$/g, "");
}

export function findModelPrice(
  prices: ModelPricing[],
  provider: string,
  model: string,
): ModelPricing | undefined {
  const wantedProvider = provider.trim().toLowerCase();
  const wantedModel = model.trim().toLowerCase();
  if (wantedProvider === "local") {
    return {
      provider: "local",
      model: wantedModel,
      inputPerMillion: 0,
      outputPerMillion: 0,
      currency: "USD",
      source: "local",
      updatedAt: "",
    };
  }
  const canonicalWanted = canonicalModel(model);
  return (
    prices.find(
      (price) =>
        price.provider.toLowerCase() === wantedProvider &&
        price.model.toLowerCase() === wantedModel,
    ) ??
    prices.find(
      (price) =>
        price.provider.toLowerCase() === wantedProvider &&
        ((price.matchedModel ?? "").toLowerCase() === wantedModel ||
          (price.matchedModel ?? "").toLowerCase().endsWith(`/${wantedModel}`)),
    ) ??
    prices.find(
      (price) =>
        canonicalModel(price.model) === canonicalWanted ||
        canonicalModel(price.matchedModel ?? "") === canonicalWanted,
    ) ??
    prices.find((price) => {
      if (price.provider.toLowerCase() !== "openrouter") return false;
      const prefix = PROVIDER_PREFIX[wantedProvider] ?? wantedProvider;
      const candidate = `${prefix}/${model}`.toLowerCase();
      return (
        price.model.toLowerCase() === candidate ||
        (price.matchedModel ?? "").toLowerCase() === candidate ||
        price.model.toLowerCase().endsWith(`/${wantedModel}`)
      );
    })
  );
}
