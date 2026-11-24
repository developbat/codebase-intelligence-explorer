import fs from "node:fs/promises";
import path from "node:path";
import type { AiAgentStep } from "../../shared/ai";
import { runAgentTask } from "./ai/service";

interface AskCase {
  id: string;
  projectId: string;
  language: string;
  instruction: string;
  expect: string[];
}

const WRITE_ACTIONS = new Set([
  "write_file",
  "replace_in_file",
  "replace_many",
  "append_text",
  "delete_file",
  "rename_path",
  "format_file",
]);

async function main(): Promise<void> {
  const fixtureDir = path.resolve("fixtures", "agent-eval");
  const fixture = JSON.parse(await fs.readFile(path.join(fixtureDir, "ask.json"), "utf8")) as {
    provider?: string;
    model?: string;
    cases: AskCase[];
  };
  const results: {
    id: string;
    pass: boolean;
    failures: string[];
    tokens?: number;
    summary?: string;
    steps?: { index: number; action: string; ok: boolean }[];
  }[] = [];

  for (const testCase of fixture.cases) {
    try {
      const result = await runAgentTask(
        testCase.projectId,
        testCase.instruction,
        {
          provider: fixture.provider as never,
          model: fixture.model,
          language: testCase.language,
          mode: "ask",
          workspaceMode: "ask",
          allowWrite: false,
          allowCommands: false,
          maxSteps: 6,
        },
        () => undefined,
      );
      const failures: string[] = [];
      const summary = (result.summary || "").toLowerCase();
      if (result.stoppedReason !== "finished") {
        failures.push(`stopped=${result.stoppedReason}`);
      }
      if (!testCase.expect.some((expected) => summary.includes(expected.toLowerCase()))) {
        failures.push(`summary missing ${testCase.expect.join(" | ")}`);
      }
      if (result.changedFiles.length > 0) {
        failures.push(`changed files: ${result.changedFiles.join(", ")}`);
      }
      const writes = result.steps.filter((step: AiAgentStep) => WRITE_ACTIONS.has(step.action));
      if (writes.length > 0) {
        failures.push(`write actions: ${writes.map((step) => step.action).join(", ")}`);
      }
      results.push({
        id: testCase.id,
        pass: failures.length === 0,
        failures,
        tokens: result.tokenUsage?.totalTokens,
        summary: result.summary,
        steps: result.steps.map((step) => ({ index: step.index, action: step.action, ok: step.ok })),
      });
    } catch (error) {
      results.push({
        id: testCase.id,
        pass: false,
        failures: [error instanceof Error ? error.message : "ask failed"],
      });
    }
  }

  const passed = results.filter((result) => result.pass).length;
  for (const result of results) {
    console.log(`${result.pass ? "PASS" : "FAIL"} [ask] ${result.id}${result.tokens ? ` · ${result.tokens} tokens` : ""}`);
    for (const failure of result.failures) console.log(`   - ${failure}`);
  }
  console.log(`\n${passed}/${results.length} ask checks passed`);

  const reportsDir = path.join(fixtureDir, "reports");
  await fs.mkdir(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(reportsDir, `ask-${stamp}.json`);
  await fs.writeFile(
    reportPath,
    JSON.stringify(
      { createdAt: new Date().toISOString(), passed, total: results.length, results },
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
