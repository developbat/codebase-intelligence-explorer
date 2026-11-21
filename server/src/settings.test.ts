import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getPublicSettings,
  resolveProvider,
  saveProviderModels,
  updateAiSettings,
} from "./ai/settings";
import { autoConfigureAgents } from "./ai/agents";

test("custom OpenAI-compatible providers can be added, resolved and removed", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cie-settings-"));
  const previous = process.env.CIE_DATA_DIR;
  process.env.CIE_DATA_DIR = dataDir;
  try {
    const afterAdd = await updateAiSettings({
      customProvider: {
        name: "Evren LLM",
        baseUrl: "https://evren-llmapi.ssyz.org.tr/v1/chat/completions",
        apiKey: "evren-secret",
        models: ["deepseek-v4.1-flash", "qwen3-coder"],
        modelListUrl: "https://evren-llmapi.ssyz.org.tr/v1/models",
      },
    });
    const custom = afterAdd.providers.find((provider) => provider.custom);
    assert.ok(custom);
    assert.equal(custom.name, "Evren LLM");
    assert.equal(custom.id, "custom:evren-llm");
    assert.deepEqual(custom.models, ["deepseek-v4.1-flash", "qwen3-coder"]);
    assert.equal(custom.hasKey, true);
    assert.ok(custom.keyHint?.endsWith("cret"));

    const resolved = await resolveProvider(custom.id, "deepseek-v4.1-flash");
    assert.equal(resolved.baseUrl, "https://evren-llmapi.ssyz.org.tr/v1");
    assert.equal(resolved.apiKey, "evren-secret");
    assert.equal(resolved.name, "Evren LLM");
    assert.equal(resolved.model, "deepseek-v4.1-flash");

    const afterUpdate = await updateAiSettings({
      customProvider: {
        id: custom.id,
        name: "Evren LLM 2",
        baseUrl: "https://evren-llmapi.ssyz.org.tr/v1",
        models: ["deepseek-v4.1-flash"],
      },
    });
    const updated = afterUpdate.providers.find((provider) => provider.id === custom.id);
    assert.equal(updated?.name, "Evren LLM 2");
    assert.equal(updated?.hasKey, true);

    const afterRemove = await updateAiSettings({ removeProviderId: custom.id });
    assert.equal(afterRemove.providers.some((provider) => provider.id === custom.id), false);

    const publicSettings = await getPublicSettings();
    assert.equal(publicSettings.providers.some((provider) => provider.custom), false);
  } finally {
    if (previous === undefined) delete process.env.CIE_DATA_DIR;
    else process.env.CIE_DATA_DIR = previous;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("provider model lists are cached and agent roles can be configured", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cie-settings-"));
  const previous = process.env.CIE_DATA_DIR;
  process.env.CIE_DATA_DIR = dataDir;
  try {
    await updateAiSettings({ provider: "openai", apiKey: "test-key" });
    const cached = await saveProviderModels("openai", ["gpt-test-small", "gpt-test-large"]);
    assert.deepEqual(cached, ["gpt-test-small", "gpt-test-large"]);
    const settings = await getPublicSettings();
    const openai = settings.providers.find((provider) => provider.id === "openai");
    assert.deepEqual(openai?.models, ["gpt-test-small", "gpt-test-large"]);
    assert.ok(openai?.modelsUpdatedAt);
    const resolved = await resolveProvider("openai", "gpt-test-small");
    assert.deepEqual(resolved.models, ["gpt-test-small", "gpt-test-large"]);

    const configured = await updateAiSettings({
      agentRoles: {
        main: { provider: "openai", model: "gpt-test-large" },
        fast: { provider: "openai", model: "gpt-test-small" },
        planner: { provider: "openai", model: "gpt-test-large" },
        reviewer: { provider: "openai", model: "gpt-test-large" },
      },
    });
    assert.equal(configured.defaultProvider, "openai");
    assert.equal(configured.defaultModel, "gpt-test-large");
    assert.deepEqual(
      configured.agentRoles.map((role) => [role.role, role.model]),
      [
        ["main", "gpt-test-large"],
        ["planner", "gpt-test-large"],
        ["fast", "gpt-test-small"],
        ["reviewer", "gpt-test-large"],
      ],
    );

    const afterAdd = await updateAiSettings({
      customProvider: {
        name: "Local Router",
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "local",
        models: ["local-large-pro", "local-mini-fast"],
      },
    });
    const custom = afterAdd.providers.find((provider) => provider.custom);
    assert.ok(custom);
    await updateAiSettings({ defaultProvider: custom.id, defaultModel: "local-large-pro" });
    const auto = await autoConfigureAgents();
    assert.equal(auto.picks.find((pick) => pick.role === "main")?.provider, custom.id);
    assert.equal(auto.picks.find((pick) => pick.role === "fast")?.model, "local-mini-fast");
  } finally {
    if (previous === undefined) delete process.env.CIE_DATA_DIR;
    else process.env.CIE_DATA_DIR = previous;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
