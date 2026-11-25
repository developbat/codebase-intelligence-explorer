import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AnalysisResult } from "../../shared/types";
import { listRecent, saveAnalysis, touchProject } from "./store";

function makeAnalysis(index: number): AnalysisResult {
  return {
    id: index.toString(16).padStart(16, "0"),
    projectName: `project-${index}`,
    rootPath: `/tmp/project-${index}`,
    createdAt: new Date().toISOString(),
    stats: {
      files: 0,
      folders: 0,
      lines: 0,
      symbols: 0,
      functions: 0,
      classes: 0,
      nodes: 0,
      edges: 0,
      confirmedEdges: 0,
      inferredEdges: 0,
      unresolvedEdges: 0,
      routes: 0,
      databases: 0,
      events: 0,
      sourceBytes: 0,
      durationMs: 0,
      truncated: false,
    },
    warnings: [],
    languages: {},
    frameworks: ["Static HTML"],
    git: { available: false },
    files: [],
    symbols: [],
  } as unknown as AnalysisResult;
}

test("concurrent analysis saves keep the recent index intact", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cie-store-index-"));
  const previous = process.env.CIE_DATA_DIR;
  process.env.CIE_DATA_DIR = dir;
  try {
    const analyses = Array.from({ length: 12 }, (_, index) => makeAnalysis(index));
    await Promise.all(analyses.map((analysis) => saveAnalysis(analysis)));
    await Promise.all(analyses.map((analysis) => touchProject(analysis.id)));
    const recent = await listRecent();
    assert.equal(recent.length, 12);
    assert.deepEqual(
      new Set(recent.map((project) => project.id)),
      new Set(analyses.map((analysis) => analysis.id)),
    );
    const files = await fs.readdir(dir);
    assert.equal(files.some((file) => file.endsWith(".tmp")), false);
  } finally {
    if (previous === undefined) delete process.env.CIE_DATA_DIR;
    else process.env.CIE_DATA_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
