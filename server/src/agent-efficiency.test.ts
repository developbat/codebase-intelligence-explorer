import assert from "node:assert/strict";
import test from "node:test";
import type { IntentAnalysis } from "../../shared/intent";
import type { AiAgentStep } from "../../shared/ai";
import {
  blockDependentsOf,
  intentTask,
  isInspectionAnswer,
  isMicroEditTask,
  shouldRetryWithEditFirst,
  summarizeVerificationSteps,
  taskBudgetForEffort,
  taskStepBudget,
  taskLooksLikeInspection,
  taskLooksLikeVerification,
  taskLooksLikeWrite,
} from "./ai/loop";
import {
  budgetExceeded,
  impactContext,
  preferredVerificationCommand,
  preferredVerificationCommands,
  readRangeCovered,
  reportsIncompleteWiring,
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
  assert.equal(
    reportsRemainingWork("Proje dosyalarında değişiklik yapılmadı. Test PASSED."),
    false,
  );
  assert.equal(reportsRemainingWork("İş yapılmadı, route wiring eksik."), true);
  assert.equal(reportsRemainingWork("All changes are complete; typecheck passed."), false);
  assert.equal(
    reportsRemainingWork(
      "## Durum: uygulama yazıldı, kabul doğrulanmadı. Davranış kanıtlanamadı.",
    ),
    true,
  );
  assert.equal(reportsRemainingWork("Davranış doğrulandı; testler geçti."), false);
  assert.equal(
    reportsIncompleteWiring("index.html'de eksik kontrol veya bağlantı yok; tümü mevcut."),
    false,
  );
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
      id: "task-list",
      title: "dosyada eksik işleri başlıkları ve iş açıklamaları ile getirip listeler misin?",
      detail: "List the unchecked items.",
      status: "pending",
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

test("inspection answers are accepted only when substantive", () => {
  assert.equal(
    isInspectionAnswer(
      "Here is the complete list of 19 items with headings and descriptions: " +
        "1) Terminal history, 2) verification, 3) streaming, 4) prompt test, " +
        "5) impact context, 6) clarification, 7) LSP, 8) rescan.",
    ),
    true,
  );
  assert.equal(
    isInspectionAnswer("The agent reached the step limit before finishing. Review the steps."),
    false,
  );
  assert.equal(isInspectionAnswer("Too short"), false);
  assert.equal(
    isInspectionAnswer(
      "Let me read the rest of index.html (120-134) and js/app.js to understand the form before I make the change.",
    ),
    false,
  );
});

test("a summary that admits missing markup is treated as incomplete", () => {
  assert.equal(
    reportsIncompleteWiring(
      "index.html içinde #task-assignee girdisinin tanımlı olduğuna dair bir gözlem yok; bu eleman HTML'de yoksa atama yapılamaz. Kabul kriterinin tam karşılanması için input'un eklenmesi gerekiyor.",
    ),
    true,
  );
  assert.equal(reportsIncompleteWiring("All changes are complete and verified."), false);
});

test("an edit task with inspection context is not a verification task", () => {
  const task = {
    id: "task-1",
    title: "form kısmında görev kişisi eklenmeli",
    detail: "Mevcut form yapısını inceleyerek alanı ekleyin.",
    status: "pending" as const,
    effort: "simple" as const,
    role: "fast" as const,
    dependsOn: [],
    attempts: 0,
    changedFiles: [],
    commands: [],
    createdAt: "",
    updatedAt: "",
  };
  assert.equal(taskLooksLikeVerification(task), false);
  assert.equal(taskLooksLikeVerification({ ...task, title: "Verify the form" }), true);
  assert.equal(taskLooksLikeWrite(task), true);
});

test("ask mode is a cheap read-only task profile", () => {
  const intent = {
    kind: "question" as const,
    understanding: "answer a question",
    language: "tr",
    needsClarification: false,
    scope: "small" as const,
    mode: "single" as const,
    areas: [],
    verification: "none" as const,
    context: "project" as const,
    history: "none" as const,
    toolGroups: [],
    approach: "",
    needsExhaustiveEvidence: false,
    assumptions: [],
  };
  const task = intentTask("başka hangi alanlar eklenebilir?", intent, undefined, "ask");
  assert.equal(task.effort, "simple");
  assert.equal(task.role, "main");
  assert.equal(task.verification, undefined);
  assert.match(task.acceptance ?? "", /question is answered/i);
});

test("read-only write detection ignores reporting and listing work", () => {
  const base = {
    id: "task-1",
    detail: "",
    status: "pending" as const,
    effort: "simple" as const,
    role: "fast" as const,
    dependsOn: [],
    attempts: 0,
    changedFiles: [],
    commands: [],
    createdAt: "",
    updatedAt: "",
  };
  assert.equal(taskLooksLikeWrite({ ...base, title: "List every button and report the result" }), false);
  assert.equal(taskLooksLikeWrite({ ...base, title: "Inspect the UI and list the buttons" }), false);
  assert.equal(taskLooksLikeWrite({ ...base, title: "Add a fire button to the game UI" }), true);
  assert.equal(taskLooksLikeWrite({ ...base, title: "Butonlari listele ve eksik olani ekle" }), true);
  assert.equal(
    taskLooksLikeWrite({
      ...base,
      title: "bana uygulamadaki buton listesini getir",
      detail:
        "Kullanıcı tüm butonları istiyor. Yaklaşım: etiketleri arayıp eksiksiz bir liste oluştur.",
    }),
    false,
  );
  assert.equal(
    taskLooksLikeWrite({
      ...base,
      title: "List the buttons",
      detail: "Create a complete inventory and report it.",
    }),
    false,
  );
});

test("task budgets scale with effort and stop runaway usage", () => {
  assert.deepEqual(taskBudgetForEffort("simple"), { tokens: 80_000, costUsd: 0.05 });
  assert.deepEqual(taskBudgetForEffort("standard"), { tokens: 160_000, costUsd: 0.12 });
  assert.deepEqual(taskBudgetForEffort("hard"), { tokens: 320_000, costUsd: 0.25 });
  assert.equal(taskStepBudget("simple"), 10);
  assert.equal(taskStepBudget("standard"), 14);
  assert.equal(taskStepBudget("hard"), 20);
  assert.equal(
    budgetExceeded({ inputTokens: 0, outputTokens: 0, totalTokens: 80_001 }, undefined, 80_000),
    true,
  );
  assert.equal(
    budgetExceeded({ inputTokens: 0, outputTokens: 0, totalTokens: 10 }, 0.051, undefined, 0.05),
    true,
  );
  assert.equal(
    budgetExceeded({ inputTokens: 0, outputTokens: 0, totalTokens: 10 }, 0.01, 80_000, 0.05),
    false,
  );
});

test("verification runs typecheck, tests and lint before build", () => {
  const commands = preferredVerificationCommands({
    typecheckCommands: ["npx tsc --noEmit"],
    testCommands: ["npm test"],
    lintCommands: ["npm run lint"],
    buildCommands: ["npm run build"],
  });
  assert.deepEqual(commands, ["npx tsc --noEmit", "npm test", "npm run lint"]);
  assert.deepEqual(
    preferredVerificationCommands({ buildCommands: ["npm run build"] }),
    ["npm run build"],
  );
});

test("impact context includes callers and callees", () => {
  const analysis = {
    nodes: [
      { id: "caller", kind: "function", label: "callerFn", filePath: "src/a.ts", startLine: 10 },
      { id: "target", kind: "function", label: "targetFn", filePath: "src/b.ts", startLine: 20 },
      { id: "callee", kind: "function", label: "calleeFn", filePath: "src/c.ts", startLine: 30 },
    ],
    edges: [
      { kind: "CALLS", source: "caller", target: "target" },
      { kind: "CALLS", source: "target", target: "callee" },
    ],
  } as unknown as import("../../shared/types").AnalysisResult;
  const lines = impactContext(analysis, new Set(["target"]));
  assert.ok(lines.some((line) => line.includes("callerFn") && line.includes("targetFn")));
  assert.ok(lines.some((line) => line.includes("targetFn") && line.includes("calleeFn")));
});

test("intentTask adds conventional UI checks for a terse prompt", () => {
  const intent: IntentAnalysis = {
    kind: "edit" as const,
    understanding: "make the buttons blue",
    language: "tr",
    needsClarification: false,
    scope: "small" as const,
    mode: "single" as const,
    areas: ["index.html"],
    verification: "browser" as const,
    context: "focused" as const,
    history: "none" as const,
    toolGroups: ["edit", "browser"],
    approach: "",
    needsExhaustiveEvidence: false,
    assumptions: [],
    normalizedRequest: "Make the buttons dark blue.",
    behaviors: [
      {
        id: "b1",
        action: "update" as const,
        surface: "ui" as const,
        target: "buttons",
        details: "dark blue",
        acceptance: "buttons are dark blue",
      },
    ],
    constraints: ["do not change scoring"],
    confidence: 0.9,
  };
  const task = intentTask("butonları koyu mavi yap", intent, "npm run build", "build");
  assert.match(task.detail, /UI quality/i);
  assert.match(task.detail, /Preserve existing behavior/i);
  assert.match(task.detail, /Verification:/i);
  assert.equal(task.action, "update");
  assert.equal(task.surface, "ui");
  assert.equal(task.readOnly, false);
  assert.match(task.detail, /Behaviors:/i);
  assert.match(task.detail, /do not change scoring/i);
  assert.match(task.acceptance ?? "", /buttons are dark blue/i);
  assert.match(task.acceptance ?? "", /UI quality is verified/i);
  assert.match(task.acceptance ?? "", /Verification \(npm run build\) passes/i);
});

test("summarizes successful verification steps for the stage trace", () => {
  const steps = [
    { index: 1, action: "browser_check", args: {}, observation: "", ok: true, durationMs: 1200 },
    { index: 2, action: "run_test_scenario", args: {}, observation: "", ok: true, durationMs: 800 },
    { index: 3, action: "browser_check", args: {}, observation: "", ok: false, durationMs: 500 },
    { index: 4, action: "read_file", args: {}, observation: "", ok: true, durationMs: 30 },
  ] as AiAgentStep[];
  assert.deepEqual(summarizeVerificationSteps(steps), { checks: 2, durationMs: 2000 });
});

test("structured task fields override legacy text heuristics", () => {
  const base = {
    id: "task-1",
    title: "Do the work and report it",
    detail: "Inspect and create a report",
    status: "pending" as const,
    effort: "simple" as const,
    role: "main" as const,
    dependsOn: [],
    attempts: 0,
    changedFiles: [],
    commands: [],
    createdAt: "",
    updatedAt: "",
  };
  assert.equal(taskLooksLikeWrite({ ...base, action: "verify", readOnly: true }), false);
  assert.equal(taskLooksLikeWrite({ ...base, action: "update" }), true);
  assert.equal(taskLooksLikeInspection({ ...base, action: "verify", readOnly: true }), true);
  assert.equal(taskLooksLikeVerification({ ...base, action: "verify", verificationOnly: true }), true);
  assert.equal(isMicroEditTask({ ...base, microEdit: true, detail: "unrelated" }), true);
});
