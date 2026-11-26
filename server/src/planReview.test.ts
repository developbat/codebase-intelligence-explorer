import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectTaskQueue } from "../../shared/tasks";
import {
  PLAN_VERSION,
  createPlanMeta,
  goalHash,
  isLowImpactPlanQuestion,
  shouldReviewPlan,
} from "./ai/planReview";
import { applyPlanReview } from "./ai/loop";

function queue(overrides: Partial<ProjectTaskQueue> = {}): ProjectTaskQueue {
  return {
    version: 1,
    projectId: "p1",
    goal: "HUD ikonlarını 20px yap ve hedefin rengini beyaza çevir",
    status: "failed",
    createdAt: "",
    updatedAt: "",
    tasks: [
      {
        id: "task-1",
        title: "Do the work",
        detail: "Do the work",
        status: "blocked",
        effort: "standard",
        role: "main",
        dependsOn: [],
        attempts: 1,
        changedFiles: [],
        commands: [],
        createdAt: "",
        updatedAt: "",
      },
    ],
    notesPath: ".cie/agent/TASKS.md",
    planPath: ".cie/agent/SESSION.md",
    contextPath: ".cie/agent/context.md",
    digestPath: ".cie/agent/context-digest.md",
    ...overrides,
  };
}

test("plan meta records version, goal hash and review count", () => {
  const meta = createPlanMeta("buton rengini koyu mavi yap");
  assert.equal(meta.version, PLAN_VERSION);
  assert.equal(meta.goalHash, goalHash("buton rengini koyu mavi yap"));
  assert.equal(meta.reviewCount, 0);
  const reviewed = createPlanMeta("buton rengini koyu mavi yap", undefined, 1);
  assert.equal(reviewed.reviewCount, 1);
});

test("a fresh large build plan is reviewed once for coverage", () => {
  const largeGoal = "NEON MAZE\n" + "Build a playable maze with movement, key, exit and restart.\n".repeat(20);
  const fresh = queue({
    goal: largeGoal,
    planMeta: createPlanMeta(largeGoal),
    tasks: [
      { ...queue().tasks[0], id: "task-1", status: "pending" as const },
      { ...queue().tasks[0], id: "task-2", status: "pending" as const },
      { ...queue().tasks[0], id: "task-3", status: "pending" as const },
    ],
  });
  assert.equal(shouldReviewPlan(fresh, largeGoal, { workspaceMode: "build" }), true);
  assert.equal(
    shouldReviewPlan(
      { ...fresh, planMeta: createPlanMeta(largeGoal, undefined, 1) },
      largeGoal,
      { workspaceMode: "build" },
    ),
    false,
  );
});

test("stale, failed and multi-behavior queues need a plan review", () => {
  const goal = "HUD ikonlarını 20px yap ve hedefin rengini beyaza çevir";
  assert.equal(shouldReviewPlan(queue(), goal, { workspaceMode: "build" }), true);
  const current = queue({
    planMeta: createPlanMeta(goal),
    tasks: [
      { ...queue().tasks[0], status: "pending" as const },
      {
        ...queue().tasks[0],
        id: "task-2",
        title: "Second",
        detail: "Second",
        status: "pending" as const,
      },
    ],
  });
  assert.equal(shouldReviewPlan(current, goal, { workspaceMode: "build" }), false);
  assert.equal(
    shouldReviewPlan({ ...current, status: "failed", tasks: [queue().tasks[0]] }, goal, {
      workspaceMode: "build",
    }),
    true,
  );
  assert.equal(
    shouldReviewPlan(
      {
        ...current,
        tasks: [queue().tasks[0]],
        planMeta: createPlanMeta(goal, undefined, 1),
      },
      goal,
      { workspaceMode: "build" },
    ),
    false,
  );
  assert.equal(shouldReviewPlan(queue(), goal, { workspaceMode: "ask" }), false);
});

test("auto-replan replaces a stale single task and preserves changed files in the note", () => {
  const goal = "HUD ikonlarını 20px yap ve hedefin rengini beyaza çevir";
  const stale = queue();
  stale.tasks[0].changedFiles = ["styles.css"];
  const next = applyPlanReview(stale, goal, {
    verdict: "replan",
    requirements: ["icon size", "target color"],
    missing: ["target color"],
    assumptions: [],
    questions: [],
    tasks: [
      { title: "Set HUD icon size", detail: "Make the icons 20px.", acceptance: "20px.", effort: "simple" },
      { title: "Make target white", detail: "Use white for the target.", acceptance: "White.", effort: "simple" },
    ],
    source: "model",
  });
  assert.equal(next.tasks.length, 2);
  assert.ok(next.tasks.every((task) => task.status === "pending"));
  assert.match(next.tasks[0].detail, /Previous attempt changed styles\.css/);
  assert.equal(next.planMeta?.reviewCount, 1);
  assert.equal(next.planMeta?.version, PLAN_VERSION);
  // A replan must keep structured fields; otherwise forceWrite and the
  // focused-edit profile are lost and the agent falls back to inspection.
  assert.ok(next.tasks.every((task) => task.action === "update"));
  assert.ok(next.tasks.every((task) => task.surface === "other"));

  const explicit = applyPlanReview(stale, goal, {
    verdict: "replan",
    requirements: ["move"],
    missing: [],
    assumptions: [],
    questions: [],
    tasks: [
      {
        title: "Move the player",
        detail: "Handle WASD.",
        acceptance: "Player moves.",
        effort: "standard",
        action: "update",
        surface: "game",
      },
    ],
    source: "model",
  });
  assert.equal(explicit.tasks[0].action, "update");
  assert.equal(explicit.tasks[0].surface, "game");
});

test("random/repeat policy questions are auto-resolved instead of blocking", () => {
  assert.equal(
    isLowImpactPlanQuestion("Should the random map be allowed to repeat on consecutive starts?"),
    true,
  );
  assert.equal(
    isLowImpactPlanQuestion("Ardışık start'larda aynı harita tekrar etsin mi?"),
    true,
  );
  assert.equal(
    isLowImpactPlanQuestion("Should the removed list be deleted from the DOM or only hidden?"),
    false,
  );
});
