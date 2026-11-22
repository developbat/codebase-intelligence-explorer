import assert from "node:assert/strict";
import test from "node:test";
import type { ModelPricing } from "../../shared/pricing";
import { formatUsd } from "../../shared/pricing";
import { findPrice, usageCost } from "./ai/pricing";

const prices: ModelPricing[] = [
  {
    provider: "openrouter",
    model: "deepseek/deepseek-chat",
    inputPerMillion: 0.25,
    outputPerMillion: 1,
    currency: "USD",
    source: "openrouter",
    updatedAt: "",
  },
  {
    provider: "openrouter",
    model: "openai/gpt-5.1",
    inputPerMillion: 1.25,
    outputPerMillion: 10,
    currency: "USD",
    source: "openrouter",
    updatedAt: "",
  },
];

test("pricing maps provider models and computes per-million cost", () => {
  const deepseek = findPrice(prices, "deepseek", "deepseek-chat");
  assert.ok(deepseek);
  assert.equal(
    usageCost({ inputTokens: 1_000_000, outputTokens: 500_000, totalTokens: 1_500_000 }, deepseek),
    0.75,
  );
  const openai = findPrice(prices, "openai", "gpt-5.1");
  assert.ok(openai);
  assert.equal(
    usageCost({ inputTokens: 200_000, outputTokens: 100_000, totalTokens: 300_000 }, openai),
    1.25,
  );
  assert.equal(usageCost({ inputTokens: 100, outputTokens: 100, totalTokens: 200 }, undefined), undefined);
});

test("free/unknown prices display as free", () => {
  assert.equal(formatUsd(undefined), "free");
  assert.equal(formatUsd(0), "free");
  assert.equal(formatUsd(0.0004), "$0.0004");
  assert.equal(formatUsd(1.234), "$1.23");
});
