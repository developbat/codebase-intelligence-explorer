import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AnalysisResult } from "../../shared/types";
import { runRegisteredTool } from "./ai/tools/registry";
import type { AgentToolContext } from "./ai/tools/types";

function context(rootPath: string, args: Record<string, unknown>): AgentToolContext {
  return {
    projectId: "handler-test",
    analysis: {
      id: "handler-test",
      rootPath,
      createdAt: new Date().toISOString(),
      files: [],
    } as unknown as AnalysisResult,
    args,
    readOnly: false,
    liveBrowser: false,
    log: () => undefined,
    requirePermission: async () => true,
    evidence: [],
    changedFiles: [],
    invalidate: () => undefined,
    normalizePath: (value) => String(value ?? "").replace(/^\/+/, ""),
    pathFromArgs: (input) => input.path,
    isSecretPath: () => false,
  };
}

test("registry handlers create documents, archives and graphics", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-tool-handlers-"));
  try {
    const doc = await runRegisteredTool(
      "create_document",
      context(root, {
        path: "reports/summary.csv",
        format: "csv",
        rows: [
          ["name", "value"],
          ["alpha", "1"],
        ],
      }),
    );
    assert.equal(doc?.ok, true);
    assert.match(await fs.readFile(path.join(root, "reports/summary.csv"), "utf8"), /alpha/);

    const zip = await runRegisteredTool(
      "create_zip",
      context(root, { path: "reports/bundle.zip", entries: ["reports/summary.csv"] }),
    );
    assert.equal(zip?.ok, true);
    assert.match(zip?.observation ?? "", /Created archive/);

    const graphic = await runRegisteredTool(
      "create_graphic",
      context(root, {
        path: "reports/chart.svg",
        kind: "bar",
        title: "Weekly",
        data: [{ label: "Mon", value: 2 }],
      }),
    );
    assert.equal(graphic?.ok, true);
    const check = await runRegisteredTool(
      "graphic_check",
      context(root, { path: "reports/chart.svg", expectText: "Weekly" }),
    );
    assert.equal(check?.ok, true);

    const empty = await runRegisteredTool("list_project_tools", context(root, {}));
    assert.equal(empty?.ok, true);
    assert.match(empty?.observation ?? "", /No saved project tools/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
