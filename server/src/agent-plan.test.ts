import assert from "node:assert/strict";
import test from "node:test";
import type { AnalysisResult } from "../../shared/types";
import { buildAgentPlan, buildReadOnlyFallbackPlan } from "./ai/service";

const analysis = {
  rootPath: "/tmp/project",
  files: [
    { path: "src/index.ts" },
    { path: "src/repositories/user.repository.ts" },
    { path: "src/services/order.service.ts" },
    { path: "src/controllers/order.controller.ts" },
    { path: "src/routes/order.routes.ts" },
    { path: "package.json" },
  ],
} as unknown as AnalysisResult;

test("plan preview classifies questions as read-only", () => {
  const plan = buildAgentPlan(analysis, "Bu projeyi analiz edilen graph üzerinden açıkla", {
    askMode: true,
  });
  assert.equal(plan.intent, "explain");
  assert.equal(plan.needsWrite, false);
  assert.equal(plan.needsCommand, false);
  assert.equal(plan.risk, "low");
  assert.ok(plan.steps.some((step) => step.label.includes("citations")));
});

test("plan preview classifies a small edit and includes verification", () => {
  const plan = buildAgentPlan(analysis, "projeye users get servisi oluştur", {
    verificationCommand: "npx tsc --noEmit",
  });
  assert.equal(plan.needsWrite, true);
  assert.equal(plan.verification, "npx tsc --noEmit");
  assert.ok(plan.scope.includes("src/repositories/user.repository.ts"));
  assert.ok(plan.steps.some((step) => step.label === "Run typecheck/build"));
});

test("plan preview recognizes run-only and destructive instructions", () => {
  const run = buildAgentPlan(analysis, "run the tests", {});
  assert.equal(run.intent, "run");
  assert.equal(run.needsWrite, false);
  assert.equal(run.needsCommand, true);

  const destructive = buildAgentPlan(analysis, "delete src/repositories/user.repository.ts", {
    verificationCommand: "npx tsc --noEmit",
  });
  assert.equal(destructive.needsWrite, true);
  assert.equal(destructive.risk, "high");
});


test("permission denial produces a read-only fallback plan", () => {
  const plan = buildAgentPlan(analysis, "add users get service", {
    verificationCommand: "npx tsc --noEmit",
  });
  const fallback = buildReadOnlyFallbackPlan(plan);
  assert.equal(fallback.intent, "explain");
  assert.equal(fallback.needsWrite, false);
  assert.equal(fallback.needsCommand, false);
  assert.equal(fallback.verification, undefined);
  assert.equal(fallback.risk, "low");
  assert.ok(fallback.steps.some((step) => step.label.includes("read-only")));
  assert.ok(fallback.steps.some((step) => step.label.includes("permission")));
});
