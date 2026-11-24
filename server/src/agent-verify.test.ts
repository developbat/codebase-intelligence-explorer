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

test("agent runs the project typecheck before accepting finish and fixes reported errors", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cie-agent-verify-data-"));
  const previousDataDir = process.env.CIE_DATA_DIR;
  process.env.CIE_DATA_DIR = dataDir;

  const projectRoot = await fs.mkdtemp(path.join(path.resolve("fixtures"), ".agent-verify-"));
  const calls: string[] = [];
  let requestCount = 0;

  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      if (request.method === "GET" && request.url?.endsWith("/models")) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "mock-coder" }] }));
        return;
      }
      if (request.method === "POST" && request.url?.endsWith("/chat/completions")) {
        const payload = JSON.parse(body) as {
          stream?: boolean;
          messages?: { content?: string }[];
        };
        calls.push((payload.messages ?? []).map((message) => message.content ?? "").join("\n"));
        requestCount += 1;
        let content: string;
        if (requestCount === 1) {
          content = JSON.stringify({
            action: "write_file",
            args: {
              path: "src/bad.ts",
              content: "export const bad: number = 'oops';\n",
            },
          });
        } else if (requestCount === 2) {
          content = JSON.stringify({ action: "finish", args: { summary: "Added bad.ts" } });
        } else if (requestCount === 3) {
          content = JSON.stringify({
            action: "replace_in_file",
            args: {
              path: "src/bad.ts",
              find: "export const bad: number = 'oops';",
              replace: "export const bad: number = 1;",
            },
          });
        } else {
          content = JSON.stringify({ action: "finish", args: { summary: "Added and verified bad.ts" } });
        }

        if (payload.stream) {
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
          );
          response.write(
            `data: ${JSON.stringify({
              choices: [{ delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
            })}\n\n`,
          );
          response.end("data: [DONE]\n\n");
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
        return;
      }
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  try {
    await fs.writeFile(
      path.join(projectRoot, "package.json"),
      JSON.stringify({ name: "agent-verify", version: "1.0.0", private: true }, null, 2),
    );
    await fs.writeFile(
      path.join(projectRoot, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            strict: true,
            noEmit: true,
            skipLibCheck: true,
          },
          include: ["src"],
        },
        null,
        2,
      ),
    );

    const analysis = await analyzeProject(projectRoot);
    await saveAnalysis(analysis);
    assert.ok(
      analysis.tooling?.typecheckCommands.includes("npx tsc --noEmit"),
      "the test project must expose tsc as its typecheck command",
    );

    await updateAiSettings({
      provider: "custom",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "mock-coder",
      defaultProvider: "custom",
      defaultModel: "mock-coder",
    });

    let plan: unknown = null;
    const result = await runAgentTask(
      analysis.id,
      "Create src/bad.ts with a numeric constant.",
      { allowWrite: true, allowCommands: true, mode: "coding", maxSteps: 8 },
      (event) => {
        if (event.type === "plan") plan = event.plan;
      },
    );

    assert.equal(result.stoppedReason, "finished");
    assert.equal((plan as { needsWrite?: boolean } | null)?.needsWrite, true);
    assert.equal(result.plan?.intent, "edit");
    assert.ok(result.steps.some((step) => step.action === "run_command" && !step.ok), "verification failure should be recorded");
    assert.ok(result.logs?.some((entry) => entry.label === "Verification failed"));
    assert.ok(result.logs?.some((entry) => entry.label === "Verification passed"));
    assert.match(result.summary, /Verification.*passed/is);
    assert.ok(requestCount >= 4, `expected verification retry, got ${requestCount} model calls`);
    assert.equal(await fs.readFile(path.join(projectRoot, "src", "bad.ts"), "utf8"), "export const bad: number = 1;\n");
    assert.ok(calls.some((call) => call.includes("Verification failed")));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousDataDir === undefined) delete process.env.CIE_DATA_DIR;
    else process.env.CIE_DATA_DIR = previousDataDir;
    await fs.rm(projectRoot, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
