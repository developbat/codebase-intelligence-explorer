import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AnalysisResult } from "../../shared/types";
import {
  extractEntities,
  extractionFileCacheStats,
  invalidateExtractionCache,
  resetExtractionFileCache,
} from "./extractors";

test("caches extraction results and invalidates them after writes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-extract-cache-"));
  resetExtractionFileCache();
  try {
    await fs.writeFile(path.join(root, "notes.txt"), "needle one\n", "utf8");
    const analysis = {
      id: "cachetest0000000",
      rootPath: root,
      createdAt: new Date().toISOString(),
      files: [{ path: "notes.txt", bytes: 11, loc: 1 }],
      symbols: [],
    } as unknown as AnalysisResult;

    const first = await extractEntities(analysis, { kind: "text", query: "needle" });
    assert.equal(first.total, 1);
    assert.equal(first.fromCache, false);
    const stats = extractionFileCacheStats();
    assert.ok(stats.chars > 0);
    assert.ok(stats.extractionChars > 0);

    const second = await extractEntities(analysis, { kind: "text", query: "needle" });
    assert.equal(second.total, 1);
    assert.equal(second.fromCache, true);

    invalidateExtractionCache(analysis.id, ["unrelated.txt"]);
    const reused = await extractEntities(analysis, { kind: "text", query: "needle" });
    assert.equal(reused.fromCache, true);

    invalidateExtractionCache(analysis.id);
    await extractEntities(analysis, { kind: "text", query: "needle" });
    assert.ok(extractionFileCacheStats().hits >= 1);

    await fs.writeFile(path.join(root, "notes.txt"), "needle one\nneedle two\n", "utf8");
    invalidateExtractionCache(analysis.id);
    const third = await extractEntities(analysis, { kind: "text", query: "needle" });
    assert.equal(third.total, 2);
    assert.equal(third.fromCache, false);

    const other = await extractEntities(analysis, { kind: "text", query: "two" });
    assert.equal(other.total, 1);
    assert.equal(other.fromCache, false);
  } finally {
    invalidateExtractionCache();
    resetExtractionFileCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});
