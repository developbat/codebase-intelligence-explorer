import fs from "node:fs/promises";
import path from "node:path";
import { answerGeneralChat } from "./ai/service";

interface ContentCase {
  id: string;
  instruction: string;
  promptId: string;
  language?: string;
  context?: string;
  expectContains?: string[];
  expectNotContains?: string[];
  expectAny?: string[][];
  noToolJson?: boolean;
}

function looksLikeToolJson(value: string): boolean {
  return (
    /^\s*\{[\s\S]{0,400}"(?:action|tool|args|name)"\s*:/i.test(value.trim()) ||
    /<tool_call>|<\/?function|DSML/i.test(value)
  );
}

async function main(): Promise<void> {
  const fixturePath = path.resolve("fixtures", "agent-eval", "chat-content.json");
  const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8")) as {
    cases: ContentCase[];
  };
  const provider = process.env.CIE_EVAL_PROVIDER;
  const model = process.env.CIE_EVAL_MODEL;
  const results: {
    id: string;
    pass: boolean;
    failures: string[];
    tokens?: number;
    model?: string;
    answer?: string;
  }[] = [];

  for (const testCase of fixture.cases) {
    try {
      const result = await answerGeneralChat(
        process.env.CIE_EVAL_PROJECT_ID ?? "chat-content-eval",
        testCase.instruction,
        {
          provider: provider as never,
          model,
          language: testCase.language ?? "tr",
          promptId: testCase.promptId,
          workState: testCase.context,
        },
      );
      const answer = result.summary.trim();
      const lower = answer.toLowerCase();
      const failures: string[] = [];
      for (const expected of testCase.expectContains ?? []) {
        if (!lower.includes(expected.toLowerCase())) failures.push(`missing "${expected}"`);
      }
      for (const expected of testCase.expectNotContains ?? []) {
        if (lower.includes(expected.toLowerCase())) failures.push(`unexpected "${expected}"`);
      }
      for (const alternatives of testCase.expectAny ?? []) {
        if (!alternatives.some((item) => lower.includes(item.toLowerCase()))) {
          failures.push(`missing any of: ${alternatives.join(" | ")}`);
        }
      }
      if (testCase.noToolJson && looksLikeToolJson(answer)) {
        failures.push("answer looks like a tool-call JSON");
      }
      results.push({
        id: testCase.id,
        pass: failures.length === 0,
        failures,
        tokens: result.tokenUsage?.totalTokens,
        model: `${result.provider}/${result.model}`,
        answer,
      });
    } catch (error) {
      results.push({
        id: testCase.id,
        pass: false,
        failures: [error instanceof Error ? error.message : "live chat eval failed"],
      });
    }
  }

  const passed = results.filter((result) => result.pass).length;
  for (const result of results) {
    console.log(
      `${result.pass ? "PASS" : "FAIL"} [chat-live] ${result.id}${
        result.tokens ? ` · ${result.tokens} tokens` : ""
      }${result.model ? ` · ${result.model}` : ""}`,
    );
    for (const failure of result.failures) console.log(`   - ${failure}`);
    if (!result.pass && result.answer) {
      console.log(`   answer: ${result.answer.replace(/\s+/g, " ").slice(0, 300)}`);
    }
  }
  console.log(`\n${passed}/${results.length} live chat content checks passed`);

  const reportsDir = path.join(path.dirname(fixturePath), "reports");
  await fs.mkdir(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(reportsDir, `chat-content-${stamp}.json`);
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
