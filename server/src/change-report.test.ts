import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildChangeReport } from "./changes";
import { analyzeProject } from "./analyzer";
import { runProjectCommand } from "./editor";
import { removeAnalysis, saveAnalysis } from "./store";

test("change report exposes files, structural symbols, impact and git diff data", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-change-report-"));
  try {
    await fs.writeFile(
      path.join(root, "hello.ts"),
      "export function greet(name: string) {\n  return `Hello ${name}`;\n}\n",
      "utf8",
    );
    for (const command of [
      "git init -q",
      "git config user.email test@example.com",
      "git config user.name Test",
      "git add hello.ts",
      "git commit -qm baseline",
    ]) {
      const result = await runProjectCommand(root, command);
      assert.equal(result.exitCode, 0, `${command}: ${result.stderr}`);
    }
    const analysis = await analyzeProject(root);
    await saveAnalysis(analysis);
    try {
      await fs.writeFile(
        path.join(root, "hello.ts"),
        "export function greet(name: string) {\n  return `Hello ${name}`;\n}\n\nexport function shout(name: string) {\n  return greet(name).toUpperCase();\n}\n",
        "utf8",
      );
      // Simulate the file watcher saving a post-edit analysis before the agent
      // finishes: the report must compare against the run's baseline analysis.
      const postEdit = await analyzeProject(root);
      await saveAnalysis(postEdit);
      const { report, analysis: next } = await buildChangeReport(analysis.id, analysis);
      assert.equal(report.git.available, true);
      assert.ok(report.files.some((file) => file.path === "hello.ts" && file.status === "modified"));
      const structural = report.structural.find((change) => change.path === "hello.ts");
      assert.ok(structural?.addedSymbols.includes("shout"));
      assert.ok(report.impact.nodes.some((node) => node.label === "shout"));
      assert.ok(report.summary.changedFiles >= 1);
      assert.ok(next.symbols.some((symbol) => symbol.filePath === "hello.ts" && symbol.name === "shout"));
    } finally {
      await removeAnalysis(analysis.id);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
