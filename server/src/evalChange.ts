import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { analyzeProject } from "./analyzer";
import { removeAnalysis, loadAnalysis, saveAnalysis } from "./store";
import { runAgentTask } from "./ai/service";

interface ChangeCase {
  id: string;
  projectId: string;
  files: string[];
  language: string;
  instruction: string;
  expectChanged: string[];
  absent: string[];
  present: string[];
  unchanged?: string[];
}

interface ChangeFixture {
  provider?: string;
  model?: string;
  cases: ChangeCase[];
}

async function headless() {
  const fixtureDir = path.resolve("fixtures", "agent-eval");
  const fixture = JSON.parse(
    await fs.readFile(path.join(fixtureDir, "change.json"), "utf8"),
  ) as ChangeFixture;
  const results: {
    id: string;
    pass: boolean;
    failures: string[];
    tokens?: number;
    steps?: { index: number; action: string; ok: boolean }[];
    summary?: string;
  }[] = [];

  for (const testCase of fixture.cases) {
    const source = await loadAnalysis(testCase.projectId);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `cie-change-${testCase.id}-`));
    let projectId: string | undefined;
    const failures: string[] = [];
    try {
      for (const file of testCase.files) {
        const from = path.resolve(source.rootPath, file);
        const to = path.resolve(root, file);
        // eslint-disable-next-line no-await-in-loop
        await fs.mkdir(path.dirname(to), { recursive: true });
        // eslint-disable-next-line no-await-in-loop
        await fs.copyFile(from, to);
      }
      const analysis = await analyzeProject(root);
      projectId = analysis.id;
      await saveAnalysis(analysis);
      const result = await runAgentTask(
        analysis.id,
        testCase.instruction,
        {
          provider: fixture.provider as never,
          model: fixture.model,
          language: testCase.language,
          mode: "coding",
          workspaceMode: "build",
          allowWrite: true,
          allowCommands: false,
          maxSteps: 12,
        },
        () => undefined,
      );
      if (result.stoppedReason !== "finished") {
        failures.push(`stopped=${result.stoppedReason}`);
      }
      for (const expected of testCase.expectChanged) {
        if (!result.changedFiles.includes(expected)) {
          failures.push(`not changed: ${expected}`);
        }
      }
      const contents = await Promise.all(
        testCase.files.map(async (file) => ({
          file,
          text: await fs.readFile(path.resolve(root, file), "utf8").catch(() => ""),
        })),
      );
      const combined = contents.map((entry) => entry.text).join("\n");
      for (const needle of testCase.absent) {
        if (combined.toLowerCase().includes(needle.toLowerCase())) {
          failures.push(`still present: ${needle}`);
        }
      }
      for (const needle of testCase.present) {
        if (!combined.toLowerCase().includes(needle.toLowerCase())) {
          failures.push(`missing: ${needle}`);
        }
      }
      for (const needle of testCase.unchanged ?? []) {
        if (!combined.toLowerCase().includes(needle.toLowerCase())) {
          failures.push(`unrelated value changed: ${needle}`);
        }
      }
      results.push({
        id: testCase.id,
        pass: failures.length === 0,
        failures,
        tokens: result.tokenUsage?.totalTokens,
        steps: result.steps.map((step) => ({
          index: step.index,
          action: step.action,
          ok: step.ok,
        })),
        summary: result.summary,
      });
    } catch (error) {
      failures.push(error instanceof Error ? error.message : "change failed");
      results.push({ id: testCase.id, pass: false, failures });
    } finally {
      if (projectId) await removeAnalysis(projectId).catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  const passed = results.filter((result) => result.pass).length;
  for (const result of results) {
    console.log(
      `${result.pass ? "PASS" : "FAIL"} [change] ${result.id}${result.tokens ? ` · ${result.tokens} tokens` : ""}`,
    );
    for (const failure of result.failures) console.log(`   - ${failure}`);
  }
  console.log(`\n${passed}/${results.length} change checks passed`);

  const reportsDir = path.join(fixtureDir, "reports");
  await fs.mkdir(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(reportsDir, `change-${stamp}.json`);
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

headless().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
