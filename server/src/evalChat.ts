import fs from "node:fs/promises";
import path from "node:path";
import { planChat } from "./ai/chatIntent";

interface ChatCase {
  id: string;
  instruction: string;
  expect: Record<string, unknown>;
}

async function main(): Promise<void> {
  const fixturePath = path.resolve("fixtures", "agent-eval", "chat-routing.json");
  const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8")) as {
    cases: ChatCase[];
  };
  const results: {
    id: string;
    pass: boolean;
    failures: string[];
    plan: ReturnType<typeof planChat>;
  }[] = [];

  for (const testCase of fixture.cases) {
    const plan = planChat(testCase.instruction);
    const failures: string[] = [];
    for (const [key, expected] of Object.entries(testCase.expect)) {
      if (key === "skillSlugsInclude") {
        for (const slug of expected as string[]) {
          if (!plan.skillSlugs.includes(slug)) {
            failures.push(`skill ${slug} missing (got ${plan.skillSlugs.join(", ") || "none"})`);
          }
        }
        continue;
      }
      const actual = (plan as unknown as Record<string, unknown>)[key];
      if (actual !== expected) {
        failures.push(`${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    }
    results.push({ id: testCase.id, pass: failures.length === 0, failures, plan });
  }

  const passed = results.filter((result) => result.pass).length;
  for (const result of results) {
    console.log(
      `${result.pass ? "PASS" : "FAIL"} [chat] ${result.id} · ${result.plan.mode} · ${
        result.plan.promptId
      }${result.plan.skillSlugs.length ? ` · ${result.plan.skillSlugs.join(",")}` : ""}`,
    );
    for (const failure of result.failures) console.log(`   - ${failure}`);
  }
  console.log(`\n${passed}/${results.length} chat routing checks passed`);

  const reportsDir = path.join(path.dirname(fixturePath), "reports");
  await fs.mkdir(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(reportsDir, `chat-routing-${stamp}.json`);
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
