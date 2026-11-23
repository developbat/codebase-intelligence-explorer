import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AnalysisResult } from "../../shared/types";
import { checkFileSyntax } from "./syntax";

test("diagnostics report a syntax error in a changed JavaScript file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-syntax-"));
  try {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "app.js"), "const value = ;\n", "utf8");
    const analysis = {
      rootPath: root,
      files: [{ path: "src/app.js" }],
    } as unknown as AnalysisResult;
    const result = await checkFileSyntax(analysis, "src/app.js");
    assert.equal(result.supported, true);
    assert.equal(result.ok, false);
    assert.match(result.output, /SyntaxError|Unexpected token/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("diagnostics pass for valid JavaScript", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-syntax-"));
  try {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "app.js"), "const value = 1;\n", "utf8");
    const analysis = {
      rootPath: root,
      files: [{ path: "src/app.js" }],
    } as unknown as AnalysisResult;
    const result = await checkFileSyntax(analysis, "src/app.js");
    assert.equal(result.supported, true);
    assert.equal(result.ok, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
