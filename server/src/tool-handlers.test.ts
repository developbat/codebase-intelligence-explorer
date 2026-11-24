import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AnalysisResult } from "../../shared/types";
import { runRegisteredTool } from "./ai/tools/registry";
import { withToolTimeout } from "./ai/tools/sandbox";
import { safeProcessEnv } from "./editor";
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
    ranCommands: [],
    invalidate: () => undefined,
    normalizePath: (value) => String(value ?? "").replace(/^\/+/, ""),
    pathFromArgs: (input) => input.path,
    isSecretPath: () => false,
  };
}

test("safe env drops secrets and tool timeout rejects", async () => {
  process.env.CIE_TEST_SECRET_KEY = "secret-value";
  const env = safeProcessEnv({ CIE_TOOL_INPUT: "{}" });
  assert.equal(env.CIE_TEST_SECRET_KEY, undefined);
  assert.equal(env.CIE_TOOL_INPUT, "{}");
  assert.ok(env.PATH);
  assert.equal(await withToolTimeout(Promise.resolve("ok"), 100), "ok");
  await assert.rejects(
    () => withToolTimeout(new Promise(() => undefined), 20),
    /timed out/,
  );
  delete process.env.CIE_TEST_SECRET_KEY;
});

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

    const asset = await runRegisteredTool(
      "placeholder_asset",
      context(root, { path: "assets/icon.svg", kind: "icon", width: 64, height: 64 }),
    );
    assert.equal(asset?.ok, true);
    assert.match(await fs.readFile(path.join(root, "assets/icon.svg"), "utf8"), /<svg/i);

    const createdTool = await runRegisteredTool(
      "create_project_tool",
      context(root, {
        name: "echo-input",
        language: "js",
        description: "Echoes typed input.",
        whenToUse: "Use to verify CIE_TOOL_INPUT.",
        inputSchema: { type: "object", required: ["url"], properties: { url: { type: "string" } } },
        code: "process.stdout.write(process.env.CIE_TOOL_INPUT || '');",
      }),
    );
    assert.equal(createdTool?.ok, true);
    const ranTool = await runRegisteredTool(
      "run_project_tool",
      context(root, { name: "echo-input", input: { url: "https://example.com" } }),
    );
    assert.equal(ranTool?.ok, true);
    assert.match(ranTool?.observation ?? "", /example\.com/);
    const invalidToolRun = await runRegisteredTool(
      "run_project_tool",
      context(root, { name: "echo-input", input: {} }),
    ).catch((error: unknown) => error);
    assert.match(String(invalidToolRun), /requires input\.url/);

    const skill = await runRegisteredTool(
      "create_skill",
      context(root, {
        name: "demo-skill",
        description: "A demo capability.",
        body: "Do the demo.",
        enable: true,
      }),
    );
    assert.equal(skill?.ok, true);
    assert.match(skill?.observation ?? "", /demo-skill/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
