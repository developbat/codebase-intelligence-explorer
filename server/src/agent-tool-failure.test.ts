import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgentTask } from "./ai/service";
import { updateAiSettings } from "./ai/settings";
import { analyzeProject } from "./analyzer";
import { saveAnalysis } from "./store";

function mockServer(replies: string[]) {
  let index = 0;
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      if (request.method === "GET" && request.url?.endsWith("/models")) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "mock-coder" }] }));
        return;
      }
      if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "not found" }));
        return;
      }
      const payload = JSON.parse(body) as { stream?: boolean };
      const content = replies[Math.min(index, replies.length - 1)];
      index += 1;
      if (payload.stream) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
        response.write(
          `data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
    });
  });
  return server;
}

async function withAgentProject(
  files: Record<string, string>,
  replies: string[],
  run: (projectId: string, root: string) => Promise<void>,
) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cie-tool-data-"));
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cie-tool-project-"));
  const previousDataDir = process.env.CIE_DATA_DIR;
  process.env.CIE_DATA_DIR = dataDir;
  const server = mockServer(replies);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    for (const [file, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(projectRoot, file)), { recursive: true });
      await fs.writeFile(path.join(projectRoot, file), content);
    }
    const analysis = await analyzeProject(projectRoot);
    await saveAnalysis(analysis);
    await updateAiSettings({
      provider: "custom",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "mock-coder",
      defaultProvider: "custom",
      defaultModel: "mock-coder",
      reviewEdits: false,
    });
    await run(analysis.id, projectRoot);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousDataDir === undefined) delete process.env.CIE_DATA_DIR;
    else process.env.CIE_DATA_DIR = previousDataDir;
    await fs.rm(projectRoot, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

const baseOptions = {
  provider: "custom",
  model: "mock-coder",
  workspaceMode: "build" as const,
  mode: "auto" as const,
  allowWrite: true,
  allowCommands: false,
  interactive: true,
  maxSteps: 6,
};

test("a corrected tool call clears the earlier failure and allows finish", async () => {
  const app = "export const value = 1;\n";
  await withAgentProject(
    { "src/app.ts": app, "tsconfig.json": "{}" },
    [
      JSON.stringify({ action: "find_in_file", args: { path: "src/app.ts", query: "" } }),
      JSON.stringify({ action: "find_in_file", args: { path: "src/app.ts", query: "value" } }),
      JSON.stringify({
        action: "finish",
        args: { summary: "Reviewed src/app.ts; no changes are needed." },
      }),
    ],
    async (projectId) => {
      const result = await runAgentTask(
        projectId,
        "Review src/app.ts. This is a read-only inspection; do not edit.",
        { ...baseOptions, forceWrite: false, inspection: true },
        () => undefined,
      );
      assert.equal(result.stoppedReason, "finished", result.summary);
      assert.ok(
        result.steps.some(
          (step) => step.action === "find_in_file" && !step.ok && /requires one of: query|query is required/i.test(step.observation),
        ),
      );
      assert.ok(result.steps.some((step) => step.action === "find_in_file" && step.ok));
      assert.ok(
        !result.steps.some(
          (step) => step.action === "invalid" && /Finish rejected/.test(step.observation),
        ),
        "a corrected tool call must not keep blocking finish",
      );
    },
  );
});

test("focused reads clamp the range instead of failing over one line", async () => {
  const source = Array.from({ length: 1_100 }, (_, index) => `export const line${index + 1} = ${index + 1};`).join("\n");
  await withAgentProject(
    { "src/large.ts": `${source}\n`, "tsconfig.json": "{}" },
    [
      JSON.stringify({
        action: "read_file",
        args: { path: "src/large.ts", startLine: 1, endLine: 200 },
      }),
      JSON.stringify({
        action: "finish",
        args: { summary: "The requested behavior is already present; no edit is needed." },
      }),
    ],
    async (projectId) => {
      const result = await runAgentTask(
        projectId,
        "Inspect src/large.ts and apply the smallest change if needed.",
        {
          ...baseOptions,
          forceWrite: true,
          intent: {
            kind: "edit",
            scope: "small",
            understanding: "Inspect the large file.",
            language: "en",
            needsClarification: false,
            mode: "single",
            areas: ["src/large.ts"],
            verification: "none",
            context: "focused",
            history: "recent",
            toolGroups: [],
            approach: "",
            needsExhaustiveEvidence: false,
            assumptions: [],
          },
        },
        () => undefined,
      );
      const read = result.steps.find((step) => step.action === "read_file");
      assert.ok(read?.ok, read?.observation);
      assert.match(read?.observation ?? "", /Focused read limited to 160 lines/);
      assert.match(read?.observation ?? "", /showing 1-160/);
    },
  );
});


test("parseable DSML tool calls are executed instead of stopping the run", async () => {
  await withAgentProject(
    { "src/app.ts": "export const value = 1;\n", "tsconfig.json": "{}" },
    [
      '<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="read_file">\n<｜｜DSML｜｜parameter name="args" string="false">{"path": "src/app.ts"}</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>',
      JSON.stringify({
        action: "finish",
        args: { summary: "Read src/app.ts; no changes are needed." },
      }),
    ],
    async (projectId) => {
      const result = await runAgentTask(
        projectId,
        "Review src/app.ts. This is a read-only inspection; do not edit.",
        { ...baseOptions, forceWrite: false, inspection: true },
        () => undefined,
      );
      assert.equal(result.stoppedReason, "finished", result.summary);
      assert.ok(
        result.steps.some((step) => step.action === "read_file" && step.ok),
        "the DSML read should have been parsed and executed",
      );
      assert.ok(
        !result.steps.some(
          (step) => step.action === "invalid" && /provider-native/i.test(step.observation),
        ),
      );
    },
  );
});


test("a 500-line source file can be read fully in one call", async () => {
  const source = Array.from({ length: 574 }, (_, index) => `export const line${index + 1} = ${index + 1};`).join("\n");
  await withAgentProject(
    { "src/game.js": source, "tsconfig.json": "{}" },
    [
      JSON.stringify({ action: "read_file", args: { path: "src/game.js" } }),
      JSON.stringify({
        action: "finish",
        args: { summary: "The requested behavior is already present; no edit is needed." },
      }),
    ],
    async (projectId) => {
      const result = await runAgentTask(
        projectId,
        "Inspect src/game.js and apply the smallest change if needed.",
        {
          ...baseOptions,
          forceWrite: true,
          intent: {
            kind: "edit",
            scope: "small",
            understanding: "Inspect the game file.",
            language: "en",
            needsClarification: false,
            mode: "single",
            areas: ["src/game.js"],
            verification: "none",
            context: "focused",
            history: "recent",
            toolGroups: [],
            approach: "",
            needsExhaustiveEvidence: false,
            assumptions: [],
          },
        },
        () => undefined,
      );
      const read = result.steps.find((step) => step.action === "read_file");
      assert.ok(read?.ok, read?.observation);
      assert.match(read?.observation ?? "", /showing 1-574/);
      assert.doesNotMatch(read?.observation ?? "", /Focused read limited/);
    },
  );
});
