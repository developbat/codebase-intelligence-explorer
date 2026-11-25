import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectTask } from "../../shared/tasks";
import {
  buildResumeContract,
  environmentRepairNote,
  isEnvironmentFailure,
  isReadLoopFailure,
  cleanTaskDetail,
  narrowTaskForEditFirst,
} from "./ai/recovery";

function makeTask(overrides: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id: "task-2",
    title: "Implement Pandas analytics functions",
    detail: "Add calculate_total_sales and get_top_category in analytics.py.",
    acceptance: "The functions exist and tests pass.",
    status: "blocked",
    effort: "standard",
    role: "main",
    dependsOn: [],
    attempts: 3,
    changedFiles: ["analytics.py"],
    commands: [],
    repairAttempts: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

test("isEnvironmentFailure detects the Python runtime signature", () => {
  const steps = [
    {
      index: 1,
      action: "run_command" as const,
      args: {},
      observation: "Fatal Python error: Segmentation fault",
      ok: false,
      durationMs: 10,
    },
  ];
  assert.equal(isEnvironmentFailure(steps), true);
  assert.equal(isEnvironmentFailure([], "error: externally-managed-environment"), true);
  assert.equal(isEnvironmentFailure([], "TypeError: x is not a function"), false);
  assert.match(environmentRepairNote("SIGSEGV"), /\.venv/);
});

test("isReadLoopFailure recognizes the read-budget blocker", () => {
  assert.equal(isReadLoopFailure("Blocked: the previous attempt kept reading instead of editing"), true);
  assert.equal(isReadLoopFailure("The build failed"), false);
});

test("narrowTaskForEditFirst keeps identity, files and completed work", () => {
  const task = makeTask();
  const narrowed = narrowTaskForEditFirst(task, "kept reading instead of editing");
  assert.equal(narrowed.id, task.id);
  assert.deepEqual(narrowed.changedFiles, ["analytics.py"]);
  assert.equal(narrowed.status, "pending");
  assert.equal(narrowed.attempts, 0);
  assert.equal(narrowed.repairAttempts, 1);
  assert.equal(narrowed.tokenUsage, undefined);
  assert.match(narrowed.detail, /analytics\.py/);
  assert.doesNotMatch(narrowed.detail, /Narrow auto-repair|Read at most 2 files/);
  assert.match(narrowed.notes ?? "", /Read at most 2 files/u);
  assert.match(narrowed.notes ?? "", /Do not restart/u);
});

test("buildResumeContract lists done tasks and changed files", () => {
  const done = makeTask({
    id: "task-1",
    status: "done",
    title: "Create deterministic sales data generator",
    changedFiles: ["data_generator.py"],
  });
  const current = makeTask({ changedFiles: ["analytics.py"] });
  const contract = buildResumeContract([done], current);
  assert.match(contract, /continuation, not a restart/u);
  assert.match(contract, /data_generator\.py/u);
  assert.match(contract, /analytics\.py/u);
  assert.match(contract, /do not redo/i);
});


test("cleanTaskDetail removes stale recovery text and internal intent noise", () => {
  const detail =
    "Hedef sayı turunu doğrula.\n\nAssumptions: Intent analyst could not parse its reply; proceeding with one focused task.\n\nNarrow auto-repair #2: kept reading instead of editing.\nTarget file(s): game.js.\nRead at most 2 files.";
  assert.equal(cleanTaskDetail(detail), "Hedef sayı turunu doğrula.");
});
