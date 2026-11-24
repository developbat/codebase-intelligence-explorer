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

    const document = await runRegisteredTool(
      "read_document",
      context(root, { path: "reports/summary.csv" }),
    );
    assert.equal(document?.ok, true);
    assert.match(document?.observation ?? "", /alpha/);

    const docSearch = await runRegisteredTool(
      "search_document",
      context(root, { path: "reports/summary.csv", query: "alpha" }),
    );
    assert.equal(docSearch?.ok, true);
    assert.match(docSearch?.observation ?? "", /line 2/);

    const note = await runRegisteredTool(
      "save_note",
      context(root, {
        title: "Release notes",
        content: "Shipped the handler registry.",
        tags: ["release"],
      }),
    );
    assert.equal(note?.ok, true);
    const notes = await runRegisteredTool("list_notes", context(root, {}));
    assert.match(notes?.observation ?? "", /Release notes/);
    const searched = await runRegisteredTool(
      "search_notes",
      context(root, { query: "registry" }),
    );
    assert.match(searched?.observation ?? "", /Release notes/);

    const skills = await runRegisteredTool("list_skills", context(root, {}));
    assert.equal(skills?.ok, true);
    assert.match(skills?.observation ?? "", /skills/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
