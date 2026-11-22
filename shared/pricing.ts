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
  if (value === undefined || !Number.isFinite(value)) return "free";
  if (value === 0) return "free";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}
