import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectTask, ProjectTaskQueue } from "../../shared/tasks";
import { decideTaskRelation } from "./ai/taskRelation";

const bigList = `oyunda listedeki güncellemelerin yapılmasını istiyorum:
1. Bölüm sistemi
Tek labirent yerine 5 farklı bölüm oluştur.
2. Savaş sistemi
Space ile ateş edilsin.
3. Envanter
Toplanan nesneler envantere eklensin.`;

function task(status: ProjectTask["status"]): ProjectTask {
  return {
    id: "task-1",
    title: "Work",
    detail: "Do the work.",
    status,
    effort: "standard",
    role: "main",
    dependsOn: [],
    attempts: 0,
    changedFiles: [],
    commands: [],
    createdAt: "2026-11-26T00:00:00.000Z",
    updatedAt: "2026-11-26T00:00:00.000Z",
  };
}

function queue(
  goal: string,
  status: ProjectTaskQueue["status"],
  taskStatus: ProjectTask["status"],
): ProjectTaskQueue {
  return {
    version: 1,
    projectId: "p",
    goal,
    status,
    createdAt: "2026-11-26T00:00:00.000Z",
    updatedAt: "2026-11-26T00:00:00.000Z",
    notesPath: "",
    planPath: "",
    contextPath: "",
    digestPath: "",
    tasks: [task(taskStatus)],
  };
}

test("devam resumes the unfinished queue and retries blocked work", () => {
  const decision = decideTaskRelation({
    instruction: "devam",
    history: [
      { role: "user", content: bigList },
      { role: "assistant", content: "Plan hazır." },
    ],
    queue: queue(bigList, "failed", "blocked"),
  });
  assert.equal(decision.relation, "continue");
  assert.equal(decision.goal, bigList);
  assert.equal(decision.retryFailed, true);
});

test("a queue whose goal is itself a continuation falls back to the real request", () => {
  const decision = decideTaskRelation({
    instruction: "devam",
    history: [
      { role: "user", content: bigList },
      { role: "assistant", content: "Plan hazır." },
    ],
    queue: queue("listeyi yap", "failed", "blocked"),
  });
  assert.equal(decision.relation, "continue");
  assert.equal(decision.goal, bigList);
  assert.equal(decision.retryFailed, true);
});

test("ok after an assistant question is an answer and does not replan", () => {
  const decision = decideTaskRelation({
    instruction: "ok",
    history: [
      { role: "user", content: bigList },
      { role: "assistant", content: "Bu planla devam edeyim mi?" },
    ],
    queue: queue(bigList, "failed", "blocked"),
  });
  assert.equal(decision.relation, "answer");
  assert.equal(decision.goal, bigList);
  assert.equal(decision.clarified, true);
  assert.equal(decision.retryFailed, true);
});

test("listeyi yap resolves to the previous list, never to a patch", () => {
  const decision = decideTaskRelation({
    instruction: "listeyi yap",
    history: [
      { role: "user", content: bigList },
      { role: "assistant", content: "Anladım." },
    ],
    queue: null,
  });
  assert.equal(decision.relation, "reference");
  assert.equal(decision.goal, bigList);
  assert.deepEqual(decision.history, []);
});

test("a short command with a concrete target is a new task, not a continuation", () => {
  const decision = decideTaskRelation({
    instruction: "başlığı mor yap",
    history: [
      { role: "user", content: bigList },
      { role: "assistant", content: "Tamam." },
    ],
    queue: queue(bigList, "completed", "done"),
  });
  assert.equal(decision.relation, "new_task");
  assert.equal(decision.goal, "başlığı mor yap");
  assert.deepEqual(decision.history, []);
});

test("a bare continuation with no history or queue is ambiguous", () => {
  const decision = decideTaskRelation({
    instruction: "yap",
    history: [],
    queue: null,
  });
  assert.equal(decision.relation, "ambiguous");
});
