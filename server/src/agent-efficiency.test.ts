import assert from "node:assert/strict";
import test from "node:test";
import { blockDependentsOf, shouldRetryWithEditFirst, taskLooksLikeInspection } from "./ai/loop";
import {
  preferredVerificationCommand,
  readRangeCovered,
  reportsRemainingWork,
} from "./ai/service";

test("typecheck is preferred over build for automatic verification", () => {
  assert.equal(
    preferredVerificationCommand({
      typecheckCommands: ["npx tsc --noEmit"],
      buildCommands: ["npm run build"],
    }),
    "npx tsc --noEmit",
  );
  assert.equal(
    preferredVerificationCommand({ typecheckCommands: [], buildCommands: ["cargo build"] }),
    "cargo build",
  );
  assert.equal(preferredVerificationCommand({ typecheckCommands: [], buildCommands: [] }), undefined);
  assert.equal(preferredVerificationCommand(undefined), undefined);
});

test("read range coverage prevents duplicate reads", () => {
  const ranges = [{ start: 1, end: 82, wholeFile: true }];
  assert.equal(readRangeCovered(ranges, 1, true, Number.POSITIVE_INFINITY), true);
  assert.equal(readRangeCovered(ranges, 70, false, 82), true);
  assert.equal(readRangeCovered(ranges, 1, false, 120), false);
  assert.equal(readRangeCovered(ranges, 83, false, 90), false);
  assert.equal(readRangeCovered([{ start: 40, end: 82, wholeFile: false }], 1, true, Number.POSITIVE_INFINITY), false);
});


test("remaining-work summaries are detected without flagging clean completions", () => {
  assert.equal(reportsRemainingWork("## Kalan (yapılmadı)\n- route wiring"), true);
  assert.equal(reportsRemainingWork("Kalan: createContainer and index.ts"), true);
  assert.equal(reportsRemainingWork("Remaining work: wire the route"), true);
  assert.equal(reportsRemainingWork("Next step: run tests"), true);
  assert.equal(reportsRemainingWork("Kalan yok, her şey tamam."), false);
  assert.equal(reportsRemainingWork("All changes are complete; typecheck passed."), false);
});

test("step-limit failures without edits retry with the edit-first fast profile", () => {
  assert.equal(shouldRetryWithEditFirst("max_steps", []), true);
  assert.equal(shouldRetryWithEditFirst("max_steps", ["js/script.js"]), false);
  assert.equal(shouldRetryWithEditFirst("finished", []), false);
  assert.equal(shouldRetryWithEditFirst("error", []), false);
});

test("inspection tasks are recognized and may finish without edits", () => {
  assert.equal(
    taskLooksLikeInspection({
      id: "task-1",
      title: "Inspect existing project files and structure",
      detail: "Read the files and report the structure.",
      status: "in_progress",
      effort: "standard",
      role: "main",
      dependsOn: [],
      attempts: 0,
      changedFiles: [],
      commands: [],
      createdAt: "",
      updatedAt: "",
    }),
    true,
  );
  assert.equal(
    taskLooksLikeInspection({
      id: "task-2",
      title: "Add date and time input fields",
      detail: "Implement the form changes.",
      status: "pending",
      effort: "simple",
      role: "fast",
      dependsOn: [],
      attempts: 0,
      changedFiles: [],
      commands: [],
      createdAt: "",
      updatedAt: "",
    }),
    false,
  );
});

test("a failed task blocks its pending dependents instead of leaving the queue stuck", () => {
  const base = {
    version: 1 as const,
    projectId: "p",
    goal: "g",
    status: "running" as const,
    createdAt: "",
    updatedAt: "",
    notesPath: "",
    planPath: "",
    contextPath: "",
    digestPath: "",
  };
  const task = (id: string, dependsOn: string[], status: "failed" | "pending" | "done") => ({
    id,
    title: id,
    detail: id,
    status,
    effort: "standard" as const,
    role: "main" as const,
    dependsOn,
    attempts: 0,
    changedFiles: [],
    commands: [],
    createdAt: "",
    updatedAt: "",
  });
  const queue = {
    ...base,
    tasks: [
      task("a", [], "failed"),
      task("b", ["a"], "pending"),
      task("c", ["b"], "pending"),
      task("d", [], "pending"),
    ],
  };
  const blocked = blockDependentsOf(queue, "a");
  assert.equal(blocked.tasks.find((item) => item.id === "a")?.status, "failed");
  assert.equal(blocked.tasks.find((item) => item.id === "b")?.status, "blocked");
  assert.equal(blocked.tasks.find((item) => item.id === "c")?.status, "blocked");
  assert.equal(blocked.tasks.find((item) => item.id === "d")?.status, "pending");
});
