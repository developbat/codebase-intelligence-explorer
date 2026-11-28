import assert from "node:assert/strict";
import test from "node:test";
import type { AnalysisResult } from "../../shared/types";
import type { IntentAnalysis } from "../../shared/intent";
import {
  analyzeRequestFrame,
  isEffectivelyEmptyProject,
  requestMentionsExtra,
} from "./ai/requestFrame";
import {
  applyRequestFrame,
  fallbackIntentFromFrame,
  projectMismatchClarification,
} from "./ai/intent";

function analysisWith(files: string[], projectName = "audit"): AnalysisResult {
  return {
    id: "audit",
    projectName,
    rootPath: "/tmp/audit",
    files: files.map((path) => ({ path })),
    languages: {},
    tooling: {},
  } as unknown as AnalysisResult;
}

function intent(patch: Partial<IntentAnalysis> = {}): IntentAnalysis {
  return {
    kind: "edit",
    understanding: "change something",
    language: "en",
    needsClarification: false,
    scope: "small",
    mode: "single",
    areas: [],
    verification: "none",
    context: "project",
    history: "recent",
    toolGroups: [],
    approach: "",
    needsExhaustiveEvidence: false,
    assumptions: [],
    ...patch,
  };
}

test("reads a cat-themed chess build as a new build", () => {
  const frame = analyzeRequestFrame(
    "Kedili bir satranç oyunu yap",
    analysisWith(["README.md"]),
    "tr",
  );
  assert.equal(frame.action, "build");
  assert.equal(frame.newBuild, true);
  assert.equal(frame.emptyProject, true);
  assert.equal(frame.domain?.card.id, "chess");
  assert.equal(frame.surface, "game");
  assert.equal(frame.language, "tr");
  assert.deepEqual(frame.extras, ["cat theme"]);
});

test("reads a style edit as an edit, not a new build", () => {
  const frame = analyzeRequestFrame(
    "satranç tahtasını mavi yap",
    analysisWith(["src/app.ts"]),
    "tr",
  );
  assert.equal(frame.action, "edit");
  assert.equal(frame.newBuild, false);
  assert.deepEqual(frame.extras, ["blue accent"]);
});

test("does not invent a domain for ordinary analysis", () => {
  const frame = analyzeRequestFrame(
    "dosyayı oku ve hatayı açıkla",
    analysisWith(["src/app.ts"]),
    "tr",
  );
  assert.notEqual(frame.action, "build");
  assert.equal(frame.domain, undefined);
});

test("detects docs-only projects as effectively empty", () => {
  assert.equal(isEffectivelyEmptyProject(analysisWith(["README.md"])), true);
  assert.equal(
    isEffectivelyEmptyProject(analysisWith(["README.md", "package.json", "tsconfig.json"])),
    true,
  );
  assert.equal(
    isEffectivelyEmptyProject(analysisWith(["README.md", "src/app.ts"])),
    false,
  );
  assert.equal(isEffectivelyEmptyProject(analysisWith(["index.html"])), false);
});

test("fallback intent keeps domain, extra and acceptance", () => {
  const frame = analyzeRequestFrame(
    "Kedili bir satranç oyunu yap",
    analysisWith(["README.md"]),
    "tr",
  );
  const fallback = fallbackIntentFromFrame(frame, "Kedili bir satranç oyunu yap");
  assert.equal(fallback.kind, "scaffold");
  assert.deepEqual(fallback.extras, ["cat theme"]);
  assert.equal(fallback.behaviors?.length, 2);
  assert.ok(fallback.behaviors?.[1]?.details.includes("cat theme"));
  assert.equal(fallback.needsClarification, false);
});

test("request frame upgrades a misread edit into scaffold", () => {
  const frame = analyzeRequestFrame(
    "Kedili bir satranç oyunu yap",
    analysisWith(["README.md"]),
    "tr",
  );
  const upgraded = applyRequestFrame(intent({ kind: "edit" }), frame);
  assert.equal(upgraded.kind, "scaffold");
  assert.ok(upgraded.behaviors?.some((behavior) => behavior.target.includes("cat theme")));
});

test("empty project does not trigger the project-mismatch question", () => {
  const mismatch = projectMismatchClarification(
    intent({ kind: "edit" }),
    "kedili bir satranç oyunu yap",
    analysisWith(["README.md"]),
    [],
    "tr",
  );
  assert.equal(mismatch, null);
});

test("extra labels match their source language", () => {
  assert.equal(requestMentionsExtra("cat theme", "kedili bir oyun"), true);
  assert.equal(requestMentionsExtra("cat theme", "uzay temalı oyun"), false);
});
