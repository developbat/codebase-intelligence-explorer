import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AnalysisResult } from "../../shared/types";
import { auditMissingSelectors } from "./ai/service";

test("a selector referenced by changed JS must exist in markup", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-selector-"));
  try {
    await fs.mkdir(path.join(root, "js"), { recursive: true });
    await fs.writeFile(
      path.join(root, "js", "app.js"),
      'const input = document.querySelector("#task-assignee");',
      "utf8",
    );
    await fs.writeFile(path.join(root, "index.html"), "<form></form>", "utf8");
    const analysis = {
      rootPath: root,
      files: [{ path: "index.html" }, { path: "js/app.js" }],
    } as unknown as AnalysisResult;

    const missing = await auditMissingSelectors(analysis, ["js/app.js"]);
    assert.deepEqual(missing, [{ id: "task-assignee", file: "js/app.js" }]);

    await fs.writeFile(
      path.join(root, "index.html"),
      '<form><input id="task-assignee" /></form>',
      "utf8",
    );
    assert.deepEqual(await auditMissingSelectors(analysis, ["js/app.js"]), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("dynamically created ids satisfy the selector audit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-selector-"));
  try {
    await fs.mkdir(path.join(root, "js"), { recursive: true });
    await fs.writeFile(
      path.join(root, "js", "app.js"),
      'const input = document.createElement("input"); input.setAttribute("id", "dynamic-field"); document.querySelector("#dynamic-field");',
      "utf8",
    );
    const analysis = {
      rootPath: root,
      files: [{ path: "js/app.js" }],
    } as unknown as AnalysisResult;
    assert.deepEqual(await auditMissingSelectors(analysis, ["js/app.js"]), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
