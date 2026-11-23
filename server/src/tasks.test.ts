import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProjectTask } from "../../shared/tasks";
import { summaryAllowsNoChanges } from "./ai/loop";
import {
  appendTaskContext,
  clearQueue,
  createQueue,
  loadQueue,
  markTask,
  nextPendingTask,
  removeTask,
  reorderTasks,
  saveQueue,
  updateTask,
} from "./tasks";

function task(id: string, dependsOn: string[] = []): ProjectTask {
  return {
    id,
    title: `Task ${id}`,
    detail: `Do ${id}`,
    status: "pending",
    effort: "standard",
    role: "main",
    dependsOn,
    attempts: 0,
    changedFiles: [],
    commands: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

test("persists a task queue as JSON and human-readable Markdown", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-tasks-"));
  try {
    const created = await createQueue(root, "project-1", "Build a feature", [task("task-1")]);
    assert.equal(created.status, "idle");
    assert.equal(created.digestPath, ".cie/agent/context-digest.md");
    const jsonPath = path.join(root, ".cie", "agent", "tasks.json");
    const markdownPath = path.join(root, ".cie", "agent", "TASKS.md");
    assert.ok((await fs.readFile(jsonPath, "utf8")).includes("Build a feature"));
    const markdown = await fs.readFile(markdownPath, "utf8");
    assert.match(markdown, /# Agent tasks — Build a feature/);
    assert.match(markdown, /task-1/);
    const digest = await fs.readFile(path.join(root, ".cie", "agent", "context-digest.md"), "utf8");
    assert.match(digest, /Task digest/);

    const loaded = await loadQueue(root, "project-1");
    assert.equal(loaded?.tasks.length, 1);
    assert.equal(loaded?.goal, "Build a feature");
    assert.equal(loaded?.contextPath, ".cie/agent/context.md");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runs tasks in dependency order and appends context notes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-tasks-"));
  try {
    let queue = await createQueue(root, "project-2", "Ship it", [
      task("task-1"),
      task("task-2", ["task-1"]),
    ]);
    assert.equal(nextPendingTask(queue)?.id, "task-1");

    queue = markTask(queue, "task-1", { status: "done" });
    queue = await saveQueue(root, queue);
    assert.equal(nextPendingTask(queue)?.id, "task-2");

    await appendTaskContext(root, "Task task-1 · done", "Changed src/app.ts");
    const context = await fs.readFile(path.join(root, ".cie", "agent", "context.md"), "utf8");
    assert.match(context, /Changed src\/app\.ts/);
    const markdown = await fs.readFile(path.join(root, ".cie", "agent", "TASKS.md"), "utf8");
    assert.match(markdown, /\[x\] `task-1`/);

    await clearQueue(root);
    assert.equal(await loadQueue(root, "project-2"), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("recognizes already-satisfied task summaries without false completion", () => {
  assert.equal(
    summaryAllowsNoChanges("Bu görev kapsamındaki script.js dosyası zaten tam işlevsel ve kabul kriterlerini karşılıyor."),
    true,
  );
  assert.equal(summaryAllowsNoChanges("Görev 2 bu mevcut index.html ile zaten karşılanmış durumda."), true);
  assert.equal(summaryAllowsNoChanges("This task is already complete and matches the acceptance criteria."), true);
  assert.equal(summaryAllowsNoChanges("No changes are needed; the file already satisfies the requirement."), true);
  assert.equal(summaryAllowsNoChanges("Task-1 complete: project folder structure created and verified."), true);
  assert.equal(summaryAllowsNoChanges("All three button colors verified; CSS variables and rules confirmed."), true);
  assert.equal(summaryAllowsNoChanges("Button colors verified, nothing was rewritten."), true);
  assert.equal(summaryAllowsNoChanges("Task is not done and the footer is missing."), false);
});

test("updates, removes and reorders queued tasks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-tasks-"));
  try {
    let queue = await createQueue(root, "project-1", "Edit tasks", [
      task("task-1"),
      task("task-2"),
      task("task-3", ["task-2"]),
    ]);
    queue = reorderTasks(queue, ["task-3", "task-1"]);
    assert.deepEqual(queue.tasks.map((item) => item.id), ["task-3", "task-1", "task-2"]);

    queue = updateTask(queue, "task-1", {
      title: "Edited task",
      tokenBudget: 50_000,
      costBudgetUsd: 0.03,
    });
    const edited = queue.tasks.find((item) => item.id === "task-1");
    assert.equal(edited?.title, "Edited task");
    assert.equal(edited?.tokenBudget, 50_000);
    assert.equal(edited?.costBudgetUsd, 0.03);

    queue = removeTask(queue, "task-2");
    assert.equal(queue.tasks.some((item) => item.id === "task-2"), false);
    assert.deepEqual(queue.tasks.find((item) => item.id === "task-3")?.dependsOn, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
