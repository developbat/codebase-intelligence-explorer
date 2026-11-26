import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { updateAiSettings } from "./ai/settings";
import { runProjectLoop } from "./ai/loop";
import { analyzeProject } from "./analyzer";
import { saveAnalysis } from "./store";
import { createQueue } from "./tasks";

interface ScenarioTask {
  id: string;
  title: string;
  file: string;
  content: string;
}

interface ScenarioResult {
  completed: number;
  failed: number;
  summary: string;
  statuses: string[];
  maxActiveAgentRequests: number;
  agentRequests: number;
  files: Record<string, string>;
}

async function runScenario(tasks: ScenarioTask[], parallelTasks: number): Promise<ScenarioResult> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cie-parallel-data-"));
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cie-parallel-project-"));
  const previousDataDir = process.env.CIE_DATA_DIR;
  process.env.CIE_DATA_DIR = dataDir;
  let activeAgentRequests = 0;
  let maxActiveAgentRequests = 0;
  let agentRequests = 0;
  const writesByTask = new Map<string, number>();

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
      const payload = JSON.parse(body) as {
        stream?: boolean;
        messages?: { content?: string }[];
      };
      const text = (payload.messages ?? []).map((message) => message.content ?? "").join("\n");
      const send = (content: string) => {
        if (payload.stream) {
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
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
      };
      // A later task's prompt can mention an earlier task's title. The current
      // task line is always the last matching one in the prompt.
      const scenarioTask = tasks
        .map((candidate) => ({ candidate, index: text.lastIndexOf(`Task: ${candidate.title}`) }))
        .filter((entry) => entry.index >= 0)
        .sort((left, right) => right.index - left.index)[0]?.candidate;

      if (!scenarioTask) {
        send(JSON.stringify({ action: "finish", args: { summary: "Nothing to do." } }));
        return;
      }
      agentRequests += 1;
      activeAgentRequests += 1;
      maxActiveAgentRequests = Math.max(maxActiveAgentRequests, activeAgentRequests);
      setTimeout(() => {
        activeAgentRequests -= 1;
        const writes = writesByTask.get(scenarioTask.id) ?? 0;
        writesByTask.set(scenarioTask.id, writes + 1);
        send(
          writes === 0
            ? JSON.stringify({
                action: "write_file",
                args: { path: scenarioTask.file, content: scenarioTask.content },
              })
            : JSON.stringify({
                action: "finish",
                args: { summary: `Updated ${scenarioTask.file}` },
              }),
        );
      }, 150);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  try {
    await fs.writeFile(
      path.join(projectRoot, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ["src"],
      }),
    );
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
    const at = new Date().toISOString();
    const goal = "Run the prepared tasks.";
    await createQueue(
      projectRoot,
      analysis.id,
      goal,
      tasks.map((task) => ({
        id: task.id,
        title: task.title,
        detail: task.content ? `Write ${task.file}.` : task.title,
        acceptance: "The file exists.",
        status: "pending" as const,
        effort: "standard" as const,
        role: "main" as const,
        action: "update" as const,
        surface: "other" as const,
        dependsOn: [],
        attempts: 0,
        changedFiles: [],
        commands: [],
        createdAt: at,
        updatedAt: at,
      })),
    );

    const result = await runProjectLoop(
      analysis.id,
      goal,
      { allowWrite: true, allowCommands: false, maxTasks: tasks.length, maxMinutes: 2, parallelTasks },
      () => undefined,
    );
    const files: Record<string, string> = {};
    for (const task of tasks) {
      files[task.file] = await fs
        .readFile(path.join(projectRoot, task.file), "utf8")
        .catch(() => "");
    }
    return {
      completed: result.completed,
      failed: result.failed,
      summary: result.summary,
      statuses: result.queue.tasks.map((task) => task.status),
      maxActiveAgentRequests,
      agentRequests,
      files,
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousDataDir === undefined) delete process.env.CIE_DATA_DIR;
    else process.env.CIE_DATA_DIR = previousDataDir;
    await fs.rm(projectRoot, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

test("task loop runs disjoint write tasks in parallel", async () => {
  const result = await runScenario(
    [
      { id: "task-1", title: "Create src/one.ts", file: "src/one.ts", content: "export const one = 1;\n" },
      { id: "task-2", title: "Create src/two.ts", file: "src/two.ts", content: "export const two = 2;\n" },
    ],
    2,
  );

  assert.equal(result.completed, 2, result.summary);
  assert.equal(result.failed, 0, result.summary);
  assert.ok(
    result.maxActiveAgentRequests >= 2,
    `max parallel requests: ${result.maxActiveAgentRequests}`,
  );
  assert.ok(result.agentRequests >= 4);
  assert.match(result.files["src/one.ts"], /one = 1/);
  assert.match(result.files["src/two.ts"], /two = 2/);
  assert.deepEqual(result.statuses, ["done", "done"]);
});

test("task loop serializes write tasks that target the same file", async () => {
  const result = await runScenario(
    [
      { id: "task-1", title: "Create src/shared.ts", file: "src/shared.ts", content: "export const value = 1;\n" },
      { id: "task-2", title: "Update src/shared.ts", file: "src/shared.ts", content: "export const value = 2;\n" },
    ],
    2,
  );

  assert.equal(result.completed, 2, result.summary);
  assert.equal(result.failed, 0, result.summary);
  assert.equal(
    result.maxActiveAgentRequests,
    1,
    `overlapping targets ran concurrently: ${result.maxActiveAgentRequests}`,
  );
  assert.match(result.files["src/shared.ts"], /value = 2/);
  assert.deepEqual(result.statuses, ["done", "done"]);
});
