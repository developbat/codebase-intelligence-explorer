import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectTask } from "../../shared/tasks";
import type { TaskBrief } from "./ai/taskBrief";
import { applyBriefCoverage } from "./ai/coverage";

function task(id: string, title: string, detail = "", acceptance = ""): ProjectTask {
  return {
    id,
    title,
    detail,
    acceptance,
    status: "pending",
    effort: "standard",
    role: "main",
    dependsOn: [],
    attempts: 0,
    changedFiles: [],
    commands: [],
    createdAt: "2026-11-28T00:00:00.000Z",
    updatedAt: "2026-11-28T00:00:00.000Z",
  };
}

function brief(patch: Partial<TaskBrief> = {}): TaskBrief {
  return {
    key: "chess-cat-theme-tr",
    language: "tr",
    instruction: "Kedili bir satranç oyunu yap",
    domain: { id: "chess", name: "Chess", summary: "Board game" },
    summary: "Kedili satranç.",
    invariants: [
      "Castling: king and rook move together when neither has moved.",
      "En passant: a pawn may capture a pawn that just advanced two squares.",
      "Promotion: a pawn reaching the last rank becomes a queen, rook, bishop or knight.",
      "Draws: stalemate, insufficient material, threefold repetition and the fifty-move rule.",
    ],
    norms: [],
    components: [],
    dataModel: [],
    ux: ["Highlight legal moves on selection and show the last move."],
    pitfalls: [],
    acceptance: ["Castling works both sides."],
    openDecisions: [],
    extras: ["cat theme"],
    sources: [],
    verifiedAt: "2026-11-28T00:00:00.000Z",
    cached: false,
    ...patch,
  };
}

test("coverage adds one task for missing domain rules", () => {
  const tasks = [
    task("task-1", "Add castling and en passant", "Implement both special moves."),
    task("task-2", "Add promotion picker", "Promote to queen, rook, bishop or knight."),
    task("task-3", "Highlight legal moves", "Show last move too."),
    task("task-4", "Apply cat theme", "Cat pieces and palette."),
  ];
  const result = applyBriefCoverage(tasks, brief(), "tr", "npm test");
  assert.equal(result.plan.addedTasks, 1);
  assert.equal(result.tasks.length, 5);
  const added = result.tasks[4];
  assert.match(added.title, /Eksik alan kurallarını tamamla/);
  assert.match(added.detail, /Draws:/);
  assert.equal(added.surface, "game");
  assert.equal(added.verification?.command, "npm test");
  assert.deepEqual(result.plan.missing, []);
});

test("coverage does not add tasks when every brief item is mapped", () => {
  const tasks = [
    task("task-1", "Castling and en passant", "Implement both special moves."),
    task("task-2", "Promotion picker", "Promote to queen, rook, bishop or knight."),
    task("task-3", "Draw rules", "Stalemate, insufficient material, threefold repetition and fifty-move rule."),
    task("task-4", "Legal move hints", "Highlight legal moves and last move."),
    task("task-5", "Cat theme", "Cat pieces, cat palette."),
  ];
  const result = applyBriefCoverage(tasks, brief(), "tr");
  assert.equal(result.plan.addedTasks, 0);
  assert.equal(result.tasks.length, 5);
  assert.deepEqual(result.plan.missing, []);
  assert.equal(result.plan.items.every((item) => item.coveredBy.length > 0), true);
});

test("coverage keeps English titles for English requests", () => {
  const tasks = [
    task("task-1", "Castling and en passant"),
    task("task-2", "Promotion picker"),
    task("task-3", "Legal move hints"),
    task("task-4", "Cat theme"),
  ];
  const result = applyBriefCoverage(tasks, brief({ language: "en" }), "en");
  assert.equal(result.plan.addedTasks, 1);
  assert.match(result.tasks[4].title, /Complete missing domain rules/);
});

test("coverage tasks run before the final verification task", () => {
  const verify: ProjectTask = {
    ...task("task-9", "Run final verification"),
    action: "verify",
    verificationOnly: true,
    readOnly: true,
  };
  const tasks = [
    task("task-1", "Castling and en passant"),
    task("task-2", "Promotion picker"),
    task("task-3", "Legal move hints"),
    task("task-4", "Cat theme"),
    verify,
  ];
  const result = applyBriefCoverage(tasks, brief(), "tr", "npm test");
  assert.equal(result.tasks.length, 6);
  assert.equal(result.tasks.at(-1)?.id, "task-9");
  assert.ok(result.tasks.at(-1)?.dependsOn.includes(result.tasks.at(-2)?.id ?? "missing"));
  assert.match(result.tasks.at(-2)?.title ?? "", /Eksik alan kurallarını tamamla/);
});

test("acceptance checks get a verification task before the final verification", () => {
  const verify: ProjectTask = {
    ...task("task-9", "Run final verification"),
    action: "verify",
    verificationOnly: true,
    readOnly: true,
  };
  const tasks = [task("task-1", "Castling and en passant"), verify];
  const result = applyBriefCoverage(
    tasks,
    brief({
      invariants: [],
      norms: [],
      ux: [],
      extras: [],
      components: [],
      dataModel: [],
      acceptance: ["Threefold repetition and the fifty-move rule are enforced."],
    }),
    "tr",
    "npm test",
  );
  const acceptance = result.tasks.find((item) => item.title.includes("Brief kabul"));
  assert.ok(acceptance);
  assert.equal(acceptance.action, "verify");
  assert.equal(acceptance.verificationOnly, true);
  assert.equal(acceptance.surface, "game");
  assert.equal(result.tasks.at(-1)?.id, "task-9");
  const verifyIndex = result.tasks.findIndex((item) => item.id === "task-9");
  assert.ok(result.tasks.indexOf(acceptance) < verifyIndex);
});
