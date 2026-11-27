import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { planChat } from "./ai/chatIntent";

interface ChatCase {
  id: string;
  instruction: string;
  expect: Record<string, unknown>;
}

test("global chat routing fixture passes every capability gate", async () => {
  const fixture = JSON.parse(
    await fs.readFile(path.resolve("fixtures/agent-eval/chat-routing.json"), "utf8"),
  ) as { cases: ChatCase[] };
  for (const testCase of fixture.cases) {
    const plan = planChat(testCase.instruction);
    for (const [key, expected] of Object.entries(testCase.expect)) {
      if (key === "skillSlugsInclude") {
        for (const slug of expected as string[]) {
          assert.ok(
            plan.skillSlugs.includes(slug),
            `${testCase.id}: expected skill ${slug}, got ${plan.skillSlugs.join(", ") || "none"}`,
          );
        }
        continue;
      }
      assert.equal(
        (plan as unknown as Record<string, unknown>)[key],
        expected,
        `${testCase.id}: ${key}`,
      );
    }
  }
});
