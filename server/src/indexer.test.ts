import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AnalysisResult } from "../../shared/types";
import {
  buildProjectIndex,
  getProjectIndexStatus,
  recordConversation,
  removeIndexedPath,
  searchConversations,
  searchProjectIndex,
  updateIndexedFile,
} from "./indexer";

function mockAnalysis(rootPath: string): AnalysisResult {
  return {
    id: "index-test-project",
    projectName: "Index Test",
    rootPath,
    createdAt: new Date().toISOString(),
    stats: {
      files: 2,
      folders: 0,
      lines: 10,
      symbols: 1,
      functions: 1,
      classes: 0,
      nodes: 2,
      edges: 0,
      confirmedEdges: 0,
      inferredEdges: 0,
      unresolvedEdges: 0,
      routes: 0,
      databases: 0,
      events: 0,
      sourceBytes: 100,
      durationMs: 1,
      truncated: false,
    },
    warnings: [],
    languages: { typescript: 1, other: 1 },
    frameworks: ["TypeScript"],
    tooling: {
      ecosystems: ["Node.js"],
      packageManagers: ["npm"],
      frameworks: ["Node.js"],
      testCommands: ["npm test"],
      buildCommands: ["npm run build"],
      lintCommands: [],
      formatCommands: [],
      manifests: ["package.json"],
      testFileCount: 0,
      hasTests: false,
    },
    files: [
      {
        id: "file:src/math.ts",
        path: "src/math.ts",
        language: "typescript",
        bytes: 60,
        loc: 3,
        hash: "hash-math",
        imports: [],
      },
      {
        id: "file:README.md",
        path: "README.md",
        language: "other",
        bytes: 20,
        loc: 1,
        hash: "hash-readme",
        imports: [],
      },
    ],
    symbols: [
      {
        id: "symbol:add",
        name: "add",
        qualifiedName: "add",
        kind: "function",
        filePath: "src/math.ts",
        startLine: 1,
        endLine: 3,
        signature: "function add(a: number, b: number): number",
        parameters: ["a", "b"],
        exported: true,
        async: false,
      },
    ],
    nodes: [
      {
        id: "file:src/math.ts",
        kind: "file",
        label: "math.ts",
        filePath: "src/math.ts",
      },
    ],
    edges: [],
    externalModules: [],
  } as unknown as AnalysisResult;
}

test("project index builds, searches, updates and stores conversations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-index-root-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cie-index-data-"));
  const previous = process.env.CIE_DATA_DIR;
  process.env.CIE_DATA_DIR = dataDir;
  try {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "math.ts"), "export function add(a: number, b: number) { return a + b; }\n");
    await fs.writeFile(path.join(root, "README.md"), "Project documentation and setup.\n");

    const analysis = mockAnalysis(root);
    const status = await buildProjectIndex(analysis.id, analysis);
    assert.equal(status.ready, true);
    assert.ok(status.documents >= 4);

    const hits = await searchProjectIndex(analysis.id, "add numbers", 10);
    assert.ok(hits.some((hit) => hit.kind === "symbol" && hit.title === "add"));
    assert.ok(hits.some((hit) => hit.path === "src/math.ts"));

    await updateIndexedFile(analysis.id, root, "src/math.ts", "export function zebraUnicorn() { return 42; }\n");
    const updated = await searchProjectIndex(analysis.id, "zebraUnicorn", 10);
    assert.ok(updated.some((hit) => hit.path === "src/math.ts"));

    await recordConversation(
      analysis.id,
      "projede kac tane editor var",
      "Projede 40 editor var.",
      "mock",
      "mock-model",
    );
    const conversationHits = await searchConversations(analysis.id, "editor", 10);
    assert.ok(conversationHits.some((hit) => hit.kind === "conversation" && hit.answer?.includes("40")));

    await removeIndexedPath(analysis.id, "src/math.ts");
    const afterDelete = await searchProjectIndex(analysis.id, "zebraUnicorn", 10);
    assert.equal(afterDelete.some((hit) => hit.path === "src/math.ts"), false);

    const finalStatus = await getProjectIndexStatus(analysis.id, analysis);
    assert.equal(finalStatus.ready, true);
    assert.equal(finalStatus.partial, true);
  } finally {
    if (previous === undefined) delete process.env.CIE_DATA_DIR;
    else process.env.CIE_DATA_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
