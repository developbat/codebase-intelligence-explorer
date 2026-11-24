import fs from "node:fs/promises";
import path from "node:path";
import type { IntentAnalysis } from "../../shared/intent";
import type { ProjectTask } from "../../shared/tasks";
import { analyzeIntent } from "./ai/intent";
import { planProjectTasks } from "./ai/loop";

interface UnderstandingCase {
  id: string;
  language: string;
  instruction: string;
  expect: {
    kind?: string[];
    needsWrite?: boolean;
    areas?: string[];
    clarify?: boolean;
    understandingIncludes?: string[];
    assumptionsInclude?: string[];
    assumptionsIncludeAny?: string[];
  };
}

interface PlanningCase {
  id: string;
  projectId?: string;
  goal: string;
  expect: {
    minTasks?: number;
    maxTasks?: number;
    noTestOnly?: boolean;
    noCleanup?: boolean;
    areas?: string[];
  };
}

interface CaseResult {
  id: string;
  stage: "understanding" | "planning";
  pass: boolean;
  failures: string[];
  tokens?: number;
  detail?: unknown;
}

const WRITE_VERB =
  /\b(add|fix|update|change|implement|create|remove|delete|rename|refactor|move|render|draw|spawn|collect|apply|increase|decrease|make|repair|wire|restore|ensure|enable|tune|adjust|enforce|report|expose|register|route|convert|support|extend|validate|return|reject|handle|respond)\b|düzelt|ekle|güncelle|değiştir|kaldır|sil|taşı|çiz|topla|uygula|artır|azalt|görünür|onar|bağla/i;

function isVerificationOnly(task: ProjectTask): boolean {
  const text = `${task.title} ${task.detail}`;
  if (
    /^(verify|verify and fix|final verification|run .*verification)/i.test(task.title.trim()) &&
    /(tsc|typecheck|test|build|verify|check|eslint|lint|format)/i.test(task.detail) &&
    !/[A-Za-z0-9_./-]+\.(?:js|mjs|cjs|jsx|ts|tsx|php|py|go|rs|java|kt|swift|dart|rb|html?|css|vue|svelte)/i.test(
      task.detail,
    )
  ) {
    return true;
  }
  const verify = /(verify|verification|validate|test|runtime check|doğrula|kontrol et|test et|çalışma zamanı)/i.test(text);
  return verify && !WRITE_VERB.test(text);
}

function isCleanupOnly(task: ProjectTask): boolean {
  const text = `${task.title} ${task.detail}`;
  const cleanup = /(duplicate|dedup|tekilleştir|tekrarı engelle|normalleştir|normalize)/i.test(text);
  return cleanup && !WRITE_VERB.test(text);
}

function checkUnderstanding(
  id: string,
  intent: IntentAnalysis,
  tokens: number,
  expected: UnderstandingCase["expect"],
): CaseResult {
  const failures: string[] = [];
  if (expected.kind && !expected.kind.includes(intent.kind)) {
    failures.push(`kind=${intent.kind}, expected ${expected.kind.join("|")}`);
  }
  const needsWrite = intent.kind === "edit" || intent.kind === "scaffold";
  if (expected.needsWrite !== undefined && expected.needsWrite !== needsWrite) {
    failures.push(`needsWrite=${needsWrite}, expected ${expected.needsWrite}`);
  }
  if (expected.clarify !== undefined && expected.clarify !== intent.needsClarification) {
    failures.push(`clarify=${intent.needsClarification}, expected ${expected.clarify}`);
  }
  if (expected.areas) {
    if (expected.areas.length === 0) {
      if (intent.areas.length > 0) failures.push(`areas=${intent.areas.join(",")}, expected none`);
    } else {
      const lower = intent.areas.map((area) => area.toLowerCase());
      for (const area of expected.areas) {
        if (!lower.some((item) => item.includes(area.toLowerCase()))) {
          failures.push(`missing area ${area}; got ${intent.areas.join(",") || "none"}`);
        }
      }
    }
  }
  for (const text of expected.understandingIncludes ?? []) {
    if (!intent.understanding.toLowerCase().includes(text.toLowerCase())) {
      failures.push(`understanding missing "${text}"`);
    }
  }
  const assumptionsText = intent.assumptions.join(" ").toLowerCase();
  for (const text of expected.assumptionsInclude ?? []) {
    if (!assumptionsText.includes(text.toLowerCase())) {
      failures.push(`assumptions missing "${text}"`);
    }
  }
  if (
    expected.assumptionsIncludeAny &&
    !expected.assumptionsIncludeAny.some((text) => assumptionsText.includes(text.toLowerCase()))
  ) {
    failures.push(
      `assumptions missing any of ${expected.assumptionsIncludeAny.join(" | ")}; got ${intent.assumptions.join(" | ")}`,
    );
  }
  return {
    id,
    stage: "understanding",
    pass: failures.length === 0,
    failures,
    tokens,
    detail: {
      kind: intent.kind,
      understanding: intent.understanding,
      scope: intent.scope,
      areas: intent.areas,
      assumptions: intent.assumptions,
      clarify: intent.needsClarification,
      question: intent.question,
      options: intent.options,
    },
  };
}

function checkPlanning(
  id: string,
  tasks: ProjectTask[],
  expected: PlanningCase["expect"],
): CaseResult {
  const failures: string[] = [];
  if (expected.minTasks !== undefined && tasks.length < expected.minTasks) {
    failures.push(`tasks=${tasks.length}, expected >= ${expected.minTasks}`);
  }
  if (expected.maxTasks !== undefined && tasks.length > expected.maxTasks) {
    failures.push(`tasks=${tasks.length}, expected <= ${expected.maxTasks}`);
  }
  if (expected.noTestOnly) {
    const bad = tasks.filter(isVerificationOnly);
    if (bad.length > 0) failures.push(`test-only task(s): ${bad.map((task) => task.title).join(" | ")}`);
  }
  if (expected.noCleanup) {
    const bad = tasks.filter(isCleanupOnly);
    if (bad.length > 0) failures.push(`cleanup-only task(s): ${bad.map((task) => task.title).join(" | ")}`);
  }
  if (expected.areas) {
    const text = tasks
      .map((task) => `${task.title} ${task.detail} ${task.acceptance ?? ""}`)
      .join(" ")
      .toLowerCase();
    for (const area of expected.areas) {
      if (!text.includes(area.toLowerCase())) failures.push(`no task mentions ${area}`);
    }
  }
  for (let index = 1; index < tasks.length; index += 1) {
    if (tasks[index].dependsOn.join(",") !== tasks[index - 1].id) {
      failures.push(`${tasks[index].id} does not depend on ${tasks[index - 1].id}`);
    }
  }
  return {
    id,
    stage: "planning",
    pass: failures.length === 0,
    failures,
    detail: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      detail: task.detail,
      acceptance: task.acceptance,
      dependsOn: task.dependsOn,
    })),
  };
}

async function main(): Promise<void> {
  const fixtureDir = path.resolve("fixtures", "agent-eval");
  const understandingFixture = JSON.parse(
    await fs.readFile(path.join(fixtureDir, "understanding.json"), "utf8"),
  ) as {
    projectId: string;
    provider?: string;
    model?: string;
    cases: UnderstandingCase[];
  };
  const planningFixture = JSON.parse(
    await fs.readFile(path.join(fixtureDir, "planning.json"), "utf8"),
  ) as {
    projectId: string;
    language?: string;
    cases: PlanningCase[];
  };

  const results: CaseResult[] = [];
  for (const testCase of understandingFixture.cases) {
    try {
      const analyzed = await analyzeIntent(understandingFixture.projectId, testCase.instruction, {
        provider: understandingFixture.provider as never,
        model: understandingFixture.model,
        language: testCase.language,
      });
      results.push(
        checkUnderstanding(
          testCase.id,
          analyzed.intent,
          analyzed.tokenUsage.totalTokens,
          testCase.expect,
        ),
      );
    } catch (error) {
      results.push({
        id: testCase.id,
        stage: "understanding",
        pass: false,
        failures: [error instanceof Error ? error.message : "intent failed"],
      });
    }
  }

  for (const testCase of planningFixture.cases) {
    try {
      const queue = await planProjectTasks(testCase.projectId ?? planningFixture.projectId, testCase.goal, {
        dryRun: true,
        language: planningFixture.language ?? "en",
      });
      results.push(checkPlanning(testCase.id, queue.tasks, testCase.expect));
    } catch (error) {
      results.push({
        id: testCase.id,
        stage: "planning",
        pass: false,
        failures: [error instanceof Error ? error.message : "plan failed"],
      });
    }
  }

  const passed = results.filter((result) => result.pass).length;
  for (const result of results) {
    const mark = result.pass ? "PASS" : "FAIL";
    const tokenText = result.tokens ? ` · ${result.tokens} tokens` : "";
    console.log(`${mark} [${result.stage}] ${result.id}${tokenText}`);
    for (const failure of result.failures) console.log(`   - ${failure}`);
  }
  console.log(`\n${passed}/${results.length} stage checks passed`);

  const reportsDir = path.join(fixtureDir, "reports");
  await fs.mkdir(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(reportsDir, `stages-${stamp}.json`);
  await fs.writeFile(
    reportPath,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        projectId: understandingFixture.projectId,
        passed,
        total: results.length,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`Report: ${reportPath}`);
  process.exitCode = passed === results.length ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
