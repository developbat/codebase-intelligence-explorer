import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AiAgentStep } from "../../shared/ai";
import { analyzeProject } from "./analyzer";
import {
  buildFeatureQueries,
  featurePreflightHints,
  isInteractiveUiCheck,
  softTaskTokenBudget,
  summarizeToolIssues,
  summaryAllowsNoChanges,
  summaryClaimsAlreadyPresent,
  taskBehaviorEvidence,
  isMicroEditTask,
  intentTask,
  taskBudgetEffort,
  taskLooksLikeWrite,
  taskTargetFiles,
  tasksOverlap,
} from "./ai/loop";
import { withCommandLock } from "./ai/commandLock";

function step(overrides: Partial<AiAgentStep>): AiAgentStep {
  return {
    index: 1,
    action: "browser_check",
    args: {},
    observation: "",
    ok: true,
    durationMs: 10,
    ...overrides,
  };
}

test("buildFeatureQueries extracts feature terms from a multi-item goal", () => {
  const queries = buildFeatureQueries(
    "Satışları CSV dışında JSON olarak da dışa aktar.\nEn yüksek satış yapılan günü göster.",
  );
  assert.ok(queries.some((query) => /json/i.test(query)));
  assert.ok(queries.some((query) => /satış|satis|sales/i.test(query)));
  assert.ok(queries.length <= 8);
});

test("featurePreflightHints finds an existing download button in source", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-preflight-"));
  try {
    await fs.writeFile(
      path.join(root, "app.py"),
      [
        "import streamlit as st",
        "st.download_button('JSON indir', data='[]', file_name='sales.json', mime='application/json')",
        "",
      ].join("\n"),
    );
    const analysis = await analyzeProject(root);
    const hints = await featurePreflightHints(analysis, "Satışları JSON olarak dışa aktar");
    assert.ok(
      hints.some((hint) => /app\.py/.test(hint) && /json/i.test(hint)),
      `hints: ${hints.join(" | ")}`,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("isInteractiveUiCheck requires both an interaction and an assertion", () => {
  assert.equal(
    isInteractiveUiCheck(
      step({
        args: {
          steps: [
            { action: "click", selector: "#start" },
            { action: "expectText", selector: "#status", text: "Started" },
          ],
        },
        observation: "Browser check passed.",
      }),
    ),
    true,
  );
  assert.equal(
    isInteractiveUiCheck(
      step({
        args: { steps: [{ action: "expectVisible", selector: "canvas" }] },
        observation: "Browser check passed.",
      }),
    ),
    false,
  );
  assert.equal(
    isInteractiveUiCheck(
      step({
        args: { steps: [{ action: "click", selector: "#start" }] },
        observation: "Browser check passed.",
      }),
    ),
    false,
  );
  assert.equal(
    isInteractiveUiCheck(
      step({
        action: "game_check",
        args: {
          steps: [
            { action: "eval", value: "click key", expectText: "playing" },
          ],
        },
        observation: "Game check passed.",
      }),
    ),
    true,
  );
  assert.equal(
    isInteractiveUiCheck(
      step({
        ok: false,
        args: {
          steps: [
            { action: "click", selector: "#start" },
            { action: "expectText", selector: "#status", text: "Started" },
          ],
        },
      }),
    ),
    false,
  );
});


test("soft task budgets leave room for a focused retry", () => {
  assert.equal(softTaskTokenBudget("simple"), 100_000);
  assert.equal(softTaskTokenBudget("standard"), 200_000);
  assert.equal(softTaskTokenBudget("hard"), 400_000);
});

test("summarizeToolIssues groups failed tools for the task card", () => {
  const issues = summarizeToolIssues([
    step({
      action: "browser_check",
      ok: false,
      observation: "Browser check found problems: expectVisible timeout",
    }),
    step({
      action: "invalid",
      ok: false,
      observation: "Provider-native tool call rejected; reply with JSON",
    }),
    step({
      action: "run_command",
      ok: false,
      observation: "Command finished: exit 1",
    }),
    step({ action: "finish", ok: true, observation: "done" }),
  ]);
  assert.equal(issues.length, 3);
  assert.ok(issues.some((issue) => /browser_check ×1/.test(issue)));
  assert.ok(issues.some((issue) => /protocol ×1/.test(issue)));
  assert.ok(issues.some((issue) => /run_command ×1/.test(issue)));
});


test("taskTargetFiles claims files mentioned in a task", () => {
  const analysis = {
    files: [
      { path: "app.py" },
      { path: "analytics.py" },
      { path: "tests/test_analytics.py" },
    ],
    symbols: [],
  } as unknown as Parameters<typeof taskTargetFiles>[0];
  const task = {
    id: "task-1",
    title: "Add JSON export",
    detail: "Update app.py and tests/test_analytics.py; do not touch analytics.py.",
    acceptance: "The export works.",
    status: "pending",
    effort: "standard",
    role: "main",
    dependsOn: [],
    attempts: 0,
    changedFiles: ["analytics.py"],
    commands: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as Parameters<typeof taskTargetFiles>[1];
  const targets = taskTargetFiles(analysis, task);
  assert.ok(targets.includes("app.py"));
  assert.ok(targets.includes("tests/test_analytics.py"));
  assert.ok(targets.includes("analytics.py"));
});

test("agent commands are serialized per project", async () => {
  const order: string[] = [];
  await Promise.all([
    withCommandLock("project-a", async () => {
      order.push("one-start");
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push("one-end");
    }),
    withCommandLock("project-a", async () => {
      order.push("two-start");
      order.push("two-end");
    }),
  ]);
  assert.deepEqual(order, ["one-start", "one-end", "two-start", "two-end"]);
});

test("task locks match case-insensitively across separators", () => {
  const locks = new Set(["src/app.tsx"]);
  assert.equal(tasksOverlap(["SRC\\App.tsx"], locks), true);
  assert.equal(tasksOverlap(["./src/other.ts"], locks), false);
});


test("turkish number words are not mistaken for an inspection request", () => {
  const task = {
    id: "task-1",
    title: "hedef sayıya ulaşmaya çalış",
    detail: "Bu davranışı oyuna ekle.",
    acceptance: "Çalışır.",
    action: "update",
    status: "pending",
    effort: "simple",
    role: "main",
    dependsOn: [],
    attempts: 0,
    changedFiles: [],
    commands: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as Parameters<typeof taskLooksLikeWrite>[0];
  assert.equal(taskLooksLikeWrite(task), true);
});

test("UI and verification tasks get a standard budget even when planned simple", () => {
  const base = {
    id: "task-1",
    status: "pending",
    role: "main",
    dependsOn: [],
    attempts: 0,
    changedFiles: [],
    commands: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const uiTask = {
    ...base,
    title: "Hedef sayı turunu doğrula",
    detail: "Canvas oyununu browser ile kontrol et.",
    acceptance: "Doğrulandı.",
    surface: "ui",
    verificationOnly: true,
    effort: "simple",
  } as unknown as Parameters<typeof taskBudgetEffort>[0];
  const textTask = {
    ...base,
    title: "Fix typo",
    detail: "Fix the typo in README.",
    acceptance: "Fixed.",
    surface: "other",
    effort: "simple",
  } as unknown as Parameters<typeof taskBudgetEffort>[0];
  assert.equal(taskBudgetEffort(uiTask), "standard");
  assert.equal(taskBudgetEffort(textTask), "simple");
});

test("turkish no-change summaries pass the verification gate", () => {
  assert.equal(
    summaryAllowsNoChanges("İstenen davranış zaten uygulanmış ve doğrulanmış"),
    true,
  );
});

test("summarizeToolIssues marks recovered failures separately", () => {
  const issues = summarizeToolIssues([
    step({ index: 1, action: "read_file", ok: false, observation: "Narrow edit: read at most 160 lines" }),
    step({ index: 2, action: "read_file", ok: true, observation: "read ok" }),
    step({ index: 3, action: "browser_check", ok: false, observation: "Browser check found problems" }),
  ]);
  assert.ok(issues.some((issue) => /recovered read_file ×1/.test(issue)));
  assert.ok(issues.some((issue) => /^browser_check ×1/.test(issue)));
});


test("turkish end-state goals are classified as edits, not inspection", () => {
  const task = {
    id: "task-1",
    title: "işlem yukarda gösterilmeyecek, sadece çarpma butonu aktif olacak",
    detail: "hedef ve puan tek bir barda olacak.",
    acceptance: "The requested change is implemented and verified.",
    action: "update",
    surface: "ui",
    status: "pending",
    effort: "simple",
    role: "main",
    dependsOn: [],
    attempts: 0,
    changedFiles: [],
    commands: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as Parameters<typeof taskLooksLikeWrite>[0];
  assert.equal(taskLooksLikeWrite(task), true);
  assert.equal(taskBudgetEffort(task), "standard");
});


test("exact file-line micro tasks use the short edit profile", () => {
  const base = {
    id: "task-1",
    status: "pending",
    effort: "standard",
    role: "main",
    dependsOn: [],
    attempts: 0,
    changedFiles: [],
    commands: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  assert.equal(
    isMicroEditTask({
      ...base,
      title: "Add division to OPS",
      detail: "In game.js line 476 change OPS to include ÷. Change only that line.",
      acceptance: "OPS contains ÷.",
      microEdit: true,
    } as unknown as Parameters<typeof isMicroEditTask>[0]),
    true,
  );
  assert.equal(
    isMicroEditTask({
      ...base,
      title: "Refactor the whole project",
      detail: "Redesign all files and the architecture.",
      acceptance: "Everything is clean.",
      microEdit: false,
    } as unknown as Parameters<typeof isMicroEditTask>[0]),
    false,
  );
});

test("fallback or multi-part intents are not collapsed into a single patch", () => {
  const intent = {
    kind: "edit",
    understanding: "birkaç oyun değişikliği",
    language: "tr",
    needsClarification: false,
    scope: "small",
    mode: "single",
    areas: ["game.js"],
    verification: "browser",
    context: "project",
    history: "recent",
    toolGroups: ["edit", "browser"],
    behaviors: [
      {
        id: "b1",
        action: "update",
        surface: "game",
        target: "the game",
        details: "",
        acceptance: "",
      },
    ],
    constraints: [],
    ambiguities: [],
    confidence: 0.45,
    approach: "",
    needsExhaustiveEvidence: false,
    assumptions: ["Intent analyst could not parse its reply; proceeding with one focused task."],
  } as never;
  const task = intentTask(
    "oyunda birkaç değişiklik yap; maz üret ve duvarları patlat",
    intent,
    undefined,
    "build",
  );
  assert.equal(task.patch, undefined);
  assert.equal(task.stepBudget, undefined);
});

test("a smoke browser check does not prove maze generation, fog reveal or wall breaking", () => {
  const task = {
    id: "task-1",
    title: "oyunda birkaç değişiklik: maz otomatik üret, alt kademeleri görünür yap, duvarları patlat",
    detail: "",
    acceptance: "",
    status: "done",
    effort: "standard",
    role: "main",
    dependsOn: [],
    attempts: 1,
    changedFiles: ["game.js"],
    commands: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
  } as never;
  const result = {
    changedFiles: ["game.js"],
    steps: [
      step({
        args: {
          steps: [
            { action: "click", selector: "#start-btn" },
            { action: "eval", value: "return {energy:100}", expectText: "100" },
            { action: "expectVisible", selector: "#game" },
          ],
        },
        observation: 'PASS #2 {"energyBefore":"100","canvasW":640} PASS #4 {"energyAfter":"100","score":"100"}',
      }),
    ],
  };
  const evidence = taskBehaviorEvidence(task, result as never, true);
  assert.equal(evidence.ok, false);
  assert.deepEqual(evidence.missing, [
    "procedural maze generation",
    "fog / explored reveal",
    "wall breaking",
  ]);
});

test("a behavior-bound check proves wall breaking when energy changes", () => {
  const task = {
    id: "task-1",
    title: "duvarları patlatarak yol aç",
    detail: "",
    acceptance: "",
    status: "done",
    effort: "standard",
    role: "main",
    dependsOn: [],
    attempts: 1,
    changedFiles: ["game.js"],
    commands: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
  } as never;
  const result = {
    changedFiles: ["game.js"],
    steps: [
      step({
        args: {
          steps: [
            { action: "click", selector: "#start-btn" },
            {
              action: "eval",
              value:
                "const before=state.energy; state.player={x:1,y:1}; isWall(2,1); move(1,0); return 'wallBroken='+(state.energy<before)",
              expectText: "wallBroken=true",
            },
          ],
        },
        observation: "PASS energyBefore=100 energyAfter=90 wallBroken=true",
      }),
    ],
  };
  const evidence = taskBehaviorEvidence(task, result as never, true);
  assert.equal(evidence.ok, true, evidence.reason);
});

test("non-game tasks do not require game behavior evidence", () => {
  const task = {
    id: "task-1",
    title: "buton rengini mavi yap",
    detail: "",
    acceptance: "",
    status: "done",
    effort: "simple",
    role: "fast",
    dependsOn: [],
    attempts: 1,
    changedFiles: ["styles.css"],
    commands: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
  } as never;
  const evidence = taskBehaviorEvidence(task, { changedFiles: ["styles.css"], steps: [] } as never, true);
  assert.equal(evidence.ok, true);
});

test("already generates/produces claims require no-change evidence", () => {
  assert.equal(
    summaryClaimsAlreadyPresent(
      "The maze already generates procedurally per level (LEVELS + shuffleLevels).",
    ),
    true,
  );
});
