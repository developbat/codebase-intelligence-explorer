import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AnalysisResult } from "../../shared/types";
import type { ProjectTask, ProjectTaskQueue } from "../../shared/tasks";
import { auditCompletedWork } from "./ai/completionAudit";

const NO_CHANGE_SUMMARY =
  "No file was changed; the requested behavior already meets the acceptance criteria.";

const TRUNCATED_BROWSER_CHECK = JSON.stringify({
  path: "index.html",
  steps: [
    { action: "click", selector: "#start-btn" },
    {
      action: "eval",
      value: "(()=>{return 'respawnOk=111'})()",
      expectText: "respawnOk=111",
    },
  ],
}).slice(0, 150);

async function addRun(
  root: string,
  name: string,
  run: Record<string, unknown>,
  mtimeMs = Date.now(),
): Promise<void> {
  const runs = path.join(root, ".cie", "agent", "runs");
  await fs.mkdir(runs, { recursive: true });
  const file = path.join(runs, name);
  await fs.writeFile(
    file,
    JSON.stringify({
      taskId: "task-1",
      changedFiles: [],
      summary: NO_CHANGE_SUMMARY,
      steps: [
        {
          index: 1,
          action: "browser_check",
          ok: true,
          args: TRUNCATED_BROWSER_CHECK,
        },
      ],
      ...run,
    }),
  );
  const at = new Date(mtimeMs);
  await fs.utimes(file, at, at);
}

async function fixture(
  run: Record<string, unknown> = {},
  taskPatch: Partial<ProjectTask> = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-continuation-audit-"));
  await addRun(root, "task-1-a1-test.json", run, Date.now() - 5_000);
  const task = {
    id: "task-1",
    title: "Fix the fallback",
    detail: "",
    status: "failed",
    effort: "standard",
    role: "main",
    dependsOn: [],
    attempts: 2,
    changedFiles: [],
    commands: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    resultSummary: NO_CHANGE_SUMMARY,
    ...taskPatch,
  } as unknown as ProjectTask;
  const queue = {
    version: 1,
    projectId: "p1",
    goal: "Fix the fallback",
    status: "failed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    notesPath: ".cie/agent/context.md",
    planPath: ".cie/agent/TASKS.md",
    contextPath: ".cie/agent/context.md",
    digestPath: ".cie/agent/context-digest.md",
    tasks: [task],
  } as unknown as ProjectTaskQueue;
  const analysis = { id: "p1", rootPath: root } as AnalysisResult;
  return { root, queue, analysis };
}

test("continuation audit completes a no-change task with truncated but passing real-page evidence", async (t) => {
  const { root, queue, analysis } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await auditCompletedWork(analysis, queue);
  assert.equal(result.completed, true);
  assert.equal(result.queue.status, "completed");
  assert.equal(result.queue.tasks[0].status, "done");
  assert.match(result.queue.tasks[0].notes ?? "", /Continuation audit/i);
});

test("continuation audit rejects changed files or missing runtime assertions", async (t) => {
  const changed = await fixture({ changedFiles: ["game.js"] });
  t.after(() => fs.rm(changed.root, { recursive: true, force: true }));
  assert.equal((await auditCompletedWork(changed.analysis, changed.queue)).completed, false);

  const noAssertion = await fixture({
    steps: [
      {
        index: 1,
        action: "browser_check",
        ok: true,
        args: JSON.stringify({ steps: [{ action: "click", selector: "#start-btn" }] }),
      },
    ],
  });
  t.after(() => fs.rm(noAssertion.root, { recursive: true, force: true }));
  assert.equal((await auditCompletedWork(noAssertion.analysis, noAssertion.queue)).completed, false);
});

test("continuation audit does not accept a task that changed files or has no no-change summary", async (t) => {
  const changedTask = await fixture({}, { changedFiles: ["game.js"] });
  t.after(() => fs.rm(changedTask.root, { recursive: true, force: true }));
  assert.equal((await auditCompletedWork(changedTask.analysis, changedTask.queue)).completed, false);

  const applied = await fixture({ summary: "Applied the fix and verified it." });
  t.after(() => fs.rm(applied.root, { recursive: true, force: true }));
  applied.queue.tasks[0].resultSummary = "Applied the fix and verified it.";
  assert.equal((await auditCompletedWork(applied.analysis, applied.queue)).completed, false);
});

test("continuation audit accepts the previous verified run when the newest run failed before verification", async (t) => {
  const { root, queue, analysis } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // Newer protocol failure: no browser check, no file changes.
  await addRun(root, "task-1-a2-test.json", {
    summary: "The model repeatedly returned an invalid tool protocol.",
    steps: [{ index: 1, action: "read_file", ok: true, args: {} }],
  }, Date.now());
  const result = await auditCompletedWork(analysis, queue);
  assert.equal(result.completed, true);
  assert.equal(result.queue.tasks[0].status, "done");
});

test("continuation audit rejects stale evidence when a newer run changed a file", async (t) => {
  const { root, queue, analysis } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await addRun(root, "task-1-a2-test.json", {
    changedFiles: ["game.js"],
    summary: "Applied the fix.",
    steps: [{ index: 1, action: "write_file", ok: true, args: {} }],
  }, Date.now());
  const result = await auditCompletedWork(analysis, queue);
  assert.equal(result.completed, false);
});
