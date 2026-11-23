import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getModelHealth,
  getModelHealthReport,
  healthKey,
  modelHealthByProviderModel,
  modelHealthPenalty,
  recordModelFallback,
  recordModelOutcome,
} from "./ai/modelStats";

test("records model reliability and penalizes protocol failures", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cie-health-"));
  const previous = process.env.CIE_DATA_DIR;
  process.env.CIE_DATA_DIR = dataDir;
  try {
    await recordModelOutcome("openrouter", "bad-flash", { success: true });
    await recordModelOutcome("openrouter", "bad-flash", { success: false, protocolFailure: true });
    await recordModelOutcome("openrouter", "bad-flash", { success: false, protocolFailure: true });
    const health = await getModelHealth();
    const entry = health[healthKey("openrouter", "bad-flash")];
    assert.equal(entry?.successCount, 1);
    assert.equal(entry?.protocolFailures, 2);
    assert.ok(modelHealthPenalty(entry) <= -18);

    for (let index = 0; index < 6; index += 1) {
      await recordModelOutcome("deepseek", "deepseek-chat", { success: true });
    }
    const map = await modelHealthByProviderModel();
    assert.equal(map.get(healthKey("deepseek", "deepseek-chat"))?.successCount, 6);
    assert.equal(modelHealthPenalty(map.get(healthKey("deepseek", "deepseek-chat"))), 0);
  } finally {
    if (previous === undefined) delete process.env.CIE_DATA_DIR;
    else process.env.CIE_DATA_DIR = previous;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("records fallback events with from/to models and reason", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cie-health-"));
  const previous = process.env.CIE_DATA_DIR;
  process.env.CIE_DATA_DIR = dataDir;
  try {
    await recordModelFallback({
      fromProvider: "openrouter",
      fromModel: "ling-3.0-flash",
      toProvider: "deepseek",
      toModel: "deepseek-chat",
      reason: "The task failed with openrouter/ling-3.0-flash; retrying with a working model.",
    });
    const report = await getModelHealthReport();
    assert.equal(report.fallbacks.length, 1);
    assert.equal(report.fallbacks[0].fromModel, "ling-3.0-flash");
    assert.equal(report.fallbacks[0].toModel, "deepseek-chat");
    assert.match(report.fallbacks[0].reason, /retrying/i);
  } finally {
    if (previous === undefined) delete process.env.CIE_DATA_DIR;
    else process.env.CIE_DATA_DIR = previous;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
