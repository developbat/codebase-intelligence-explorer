import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProjectTask } from "../../shared/tasks";
import { splitLargeGoal, summaryAllowsNoChanges } from "./ai/loop";
import { continuationFindings } from "./ai/service";
import {
  appendAgentRunEvent,
  appendLesson,
  appendTaskContext,
  clearQueue,
  createQueue,
  loadQueue,
  loadTaskHistory,
  markTask,
  nextPendingTask,
  readLessons,
  removeTask,
  reorderTasks,
  saveAgentRun,
  saveQueue,
  startAgentRunLive,
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

test("archives the previous goal when a new goal replaces the queue", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-history-"));
  try {
    await createQueue(root, "project-1", "First goal", [task("task-1")]);
    await createQueue(root, "project-1", "Second goal", [task("task-2")]);
    const history = await loadTaskHistory(root);
    assert.equal(history.length, 1);
    assert.equal(history[0].goal, "First goal");
    assert.equal(history[0].tasks[0]?.id, "task-1");

    // Re-planning the same goal must not archive it again.
    await createQueue(root, "project-1", "Second goal", [task("task-3")]);
    assert.equal((await loadTaskHistory(root)).length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

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

test("stores a run record and extracts failed tool steps", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-run-"));
  try {
    const relative = await saveAgentRun(root, {
      taskId: "task-1",
      attempt: 2,
      goal: "fix the overlay",
      stoppedReason: "max_steps",
      summary: "stopped",
      changedFiles: ["app.js"],
      steps: [
        { index: 1, action: "read_file", ok: true, observation: "read ok", args: { path: "app.js" } },
        {
          index: 2,
          action: "append_text",
          ok: false,
          observation: "A file path is required.",
          args: { content: "x" },
        },
      ],
    });
    assert.equal(relative.endsWith("runs/task-1-a2.json"), true);
    const data = JSON.parse(await fs.readFile(path.join(root, relative), "utf8"));
    assert.equal(data.failedSteps.length, 1);
    assert.equal(data.failedSteps[0].action, "append_text");
    assert.match(data.failedSteps[0].observation, /file path/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("keeps append-only lessons readable for the next run", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-lessons-"));
  try {
    await appendLesson(root, "append_text needs path and content keys");
    await appendLesson(root, "guard one-time DOM writes outside requestAnimationFrame");
    const lessons = await readLessons(root);
    assert.match(lessons, /append_text needs path and content keys/);
    assert.match(lessons, /requestAnimationFrame/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("carries prior findings into a continuation request", () => {
  const prior = [
    "Kök neden: oyun sonu yazıları comedy.js:612 içindeki handleGameOver fonksiyonunda her karede yeniden yazılıyor.",
    "Yapılan düzeltme: gameOverHandled bayrağı ve READ_MS = 2600 ile sıralı akış eklenecek.",
    "Doğrulama: .comedy-note üzerinde expectStable 1200 ms çalıştırılacak.",
  ].join("\n");
  const findings = continuationFindings(
    [{ role: "assistant", content: prior }],
    "düzeltmeyi uygula",
  );
  assert.ok(findings?.includes("comedy.js:612"));
  assert.equal(
    continuationFindings([{ role: "assistant", content: "too short" }], "düzeltmeyi uygula"),
    null,
  );
  assert.equal(
    continuationFindings([{ role: "assistant", content: prior }], "bu proje ne yapıyor?"),
    null,
  );
});

test("splits a multi-feature goal into one task per behavior", () => {
  const goal =
    "uçağa ateş edebilme özelliği ekle . kırmızı engelleri farklı ebatlarda meteor olarak değiştir. 3 farklı ebatta meteor olsun küçüğüne 1 atışta bir büyüğü 2 en büyüğü 3 atışta patlasın. küçükler büyüğe göre daha hızlı hareket etsin. komik sahneler hala gelmedi onuda kontrol et.";
  const tasks = splitLargeGoal(goal);
  assert.ok(tasks);
  assert.equal(tasks.length, 5);
  assert.match(tasks[0].title, /ateş edebilme/);
  assert.match(tasks[4].title, /komik sahneler/);
  assert.deepEqual(tasks[1].dependsOn, ["task-1"]);
});

test("writes a live run log even before the attempt finishes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-live-"));
  try {
    await startAgentRunLive(root, "task-1", 3);
    await appendAgentRunEvent(root, "task-1", 3, {
      type: "step",
      step: {
        index: 1,
        action: "read_file",
        args: { path: "app.js" },
        observation: "read ok",
        ok: true,
        durationMs: 12,
      },
    });
    const text = await fs.readFile(
      path.join(root, ".cie/agent/runs/task-1-a3.live.jsonl"),
      "utf8",
    );
    assert.match(text, /"type":"start"/);
    assert.match(text, /read_file/);
    assert.match(text, /read ok/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});


test("run evidence stays unique when an attempt number is reused", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-run-key-"));
  try {
    const record = {
      taskId: "task-1",
      attempt: 1,
      goal: "verify existing behavior",
      stoppedReason: "finished",
      summary: "verified",
      changedFiles: [],
      steps: [
        { index: 1, action: "browser_check", ok: true, observation: "passed" },
      ],
    };
    const first = await saveAgentRun(root, { ...record, runKey: "first-run" });
    const second = await saveAgentRun(root, { ...record, runKey: "second-run" });
    assert.notEqual(first, second);
    assert.match(first, /task-1-a1-first-run\.json$/);
    assert.match(second, /task-1-a1-second-run\.json$/);
    assert.equal(
      JSON.parse(await fs.readFile(path.join(root, first), "utf8")).runKey,
      "first-run",
    );
    await startAgentRunLive(root, "task-1", 1, "first-run");
    await appendAgentRunEvent(root, "task-1", 1, {
      type: "step",
      step: {
        index: 1,
        action: "read_file",
        args: { path: "app.js" },
        observation: "read ok",
        ok: true,
        durationMs: 5,
      },
    }, "first-run");
    assert.match(
      await fs.readFile(path.join(root, ".cie/agent/runs/task-1-a1-first-run.live.jsonl"), "utf8"),
      /read ok/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
