import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { autoConfigureAgents } from "./ai/agents";
import {
  clearModelCatalog,
  getModelCatalog,
  importModelCatalog,
} from "./ai/catalog";
import { updateAiSettings } from "./ai/settings";

test("imports flexible JSON catalogs and stores them locally", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cie-catalog-"));
  const previous = process.env.CIE_DATA_DIR;
  process.env.CIE_DATA_DIR = dataDir;
  try {
    const imported = await importModelCatalog({
      json: JSON.stringify({
        models: [
          {
            id: "acme/tiny-mini",
            provider: "acme",
            name: "Tiny Mini",
            context_window: "128K",
            pricing: { input: 0.1, output: 0.2 },
            speed: "fast",
            open_source: true,
            roles: ["fast"],
            tags: ["coding"],
          },
          {
            id: "big-pro",
            vendor: "acme",
            name: "Big Pro",
            context_window: 200000,
            pricing: { input: 3, output: 15 },
            roles: ["main", "planner"],
          },
        ],
        agents: [
          {
            id: "reviewer",
            name: "Strict reviewer",
            role: "reviewer",
            provider: "acme",
            model: "big-pro",
          },
        ],
      }),
      replace: true,
    });
    assert.equal(imported.importedModels, 2);
    assert.equal(imported.importedAgents, 1);
    const catalog = await getModelCatalog();
    assert.ok(catalog);
    assert.equal(catalog.models.find((model) => model.id === "tiny-mini")?.contextWindow, 128000);
    assert.deepEqual(catalog.models.find((model) => model.id === "tiny-mini")?.roles, ["fast"]);
    assert.equal(catalog.models.find((model) => model.id === "big-pro")?.provider, "acme");
    assert.equal(catalog.agents[0]?.role, "reviewer");
    assert.match(catalog.hash, /^[a-f0-9]{16}$/);

    const grouped = await importModelCatalog({
      json: JSON.stringify({
        providers: [
          {
            name: "local",
            models: [{ id: "planner-large", roles: ["planner", "main"], context_window: 1_000_000 }],
          },
        ],
      }),
      replace: false,
    });
    assert.equal(grouped.catalog.models.length, 3);
    assert.ok(grouped.catalog.models.some((model) => model.id === "planner-large"));

    await clearModelCatalog();
    assert.equal(await getModelCatalog(), null);
  } finally {
    if (previous === undefined) delete process.env.CIE_DATA_DIR;
    else process.env.CIE_DATA_DIR = previous;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("catalog metadata drives fast-model auto-pick", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cie-catalog-"));
  const previous = process.env.CIE_DATA_DIR;
  process.env.CIE_DATA_DIR = dataDir;
  try {
    const settings = await updateAiSettings({
      customProvider: {
        name: "Local Router",
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "local",
        models: ["big-pro", "tiny-mini"],
      },
    });
    const provider = settings.providers.find((item) => item.custom);
    assert.ok(provider);
    await updateAiSettings({ defaultProvider: provider.id, defaultModel: "big-pro" });
    await importModelCatalog({
      json: JSON.stringify({
        models: [
          { id: "big-pro", provider: provider.id, roles: ["main", "planner"], output_price: 15 },
          {
            id: "tiny-mini",
            provider: provider.id,
            roles: ["fast"],
            output_price: 0.1,
            speed: "fast",
          },
        ],
      }),
      replace: true,
    });
    const auto = await autoConfigureAgents();
    assert.equal(auto.picks.find((pick) => pick.role === "fast")?.model, "tiny-mini");
    assert.match(
      auto.picks.find((pick) => pick.role === "fast")?.reason ?? "",
      /catalog/i,
    );
    assert.match(auto.warnings.join("\n"), /catalog/i);
  } finally {
    if (previous === undefined) delete process.env.CIE_DATA_DIR;
    else process.env.CIE_DATA_DIR = previous;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("rejects unsafe or non-JSON catalog sources", async () => {
  await assert.rejects(
    () => importModelCatalog({ url: "file:///tmp/catalog.json" }),
    /http/i,
  );
  await assert.rejects(
    () => importModelCatalog({ json: "not json" }),
    /valid JSON/i,
  );
  await assert.rejects(
    () => importModelCatalog({ json: JSON.stringify({ models: [] }) }),
    /No usable/i,
  );
});
