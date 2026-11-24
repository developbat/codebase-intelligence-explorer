import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AnalysisResult } from "../../shared/types";
import {
  auditProjectKnowledge,
  ensureProjectMap,
  renderProjectMap,
} from "./projectMap";

test("project map reports missing files and indexes functions/classes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-map-"));
  try {
    await fs.writeFile(path.join(root, "app.js"), "function run() { return 1; }\n");
    await fs.writeFile(path.join(root, "extra.ts"), "export class Worker {}\n");
    const analysis = {
      id: "map-test",
      rootPath: root,
      createdAt: new Date().toISOString(),
      files: [{ path: "app.js", loc: 1 }],
      symbols: [
        { name: "run", kind: "function", filePath: "app.js", startLine: 1, loc: 1 },
        { name: "Worker", kind: "class", filePath: "extra.ts", startLine: 1, loc: 1 },
      ],
    } as unknown as AnalysisResult;
    const audit = await auditProjectKnowledge(analysis);
    assert.ok(audit.missingFromIndex.includes("extra.ts"));
    assert.equal(audit.symbols.kinds.function, 1);
    assert.equal(audit.symbols.kinds.class, 1);
    const map = renderProjectMap(analysis, audit);
    assert.match(map, /app\.js/);
    assert.match(map, /function run/);
    assert.match(map, /class Worker/);
    assert.match(map, /extra\.ts/);
    const written = await ensureProjectMap(analysis);
    assert.match(written, /## Files/);
    const onDisk = await fs.readFile(path.join(root, ".cie", "agent", "PROJECT_MAP.md"), "utf8");
    assert.match(onDisk, /## Symbols/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
