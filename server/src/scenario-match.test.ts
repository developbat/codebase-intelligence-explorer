import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProjectTask } from "../../shared/tasks";
import { findTaskScenario, isScenarioVerificationTask } from "./ai/scenarioMatch";

function task(overrides: Partial<ProjectTask>): ProjectTask {
  return {
    id: "task-1",
    title: "Verify scoring",
    detail: "Verify target 30 and multiplication scoring.",
    acceptance: "30x1 adds 1 and 6x5 adds 5.",
    status: "pending",
    effort: "standard",
    role: "main",
    dependsOn: [],
    attempts: 0,
    changedFiles: [],
    commands: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

test("finds a saved scenario for a scoring verification task", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-scenario-match-"));
  try {
    await fs.mkdir(path.join(root, ".cie", "agent", "scenarios"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".cie", "agent", "scenarios", "score-30.json"),
      JSON.stringify({
        path: "index.html",
        steps: [
          { action: "pressKeys", keys: ["3", "0", "*", "1", "Enter"] },
          { action: "expectText", selector: "#score", text: "1" },
          { action: "pressKeys", keys: ["6", "*", "5", "Enter"] },
          { action: "expectText", selector: "#score", text: "6" },
        ],
      }),
    );
    const match = await findTaskScenario(
      root,
      task({
        title: "Verify 30x1 awards +1 point on target 30",
        detail: "Run the score scenario for multiplication.",
        acceptance: "30x1 adds 1 and 6x5 adds 5 on the real page.",
      }),
    );
    assert.ok(match);
    assert.equal(match.name, "score-30");
    assert.equal(match.steps.length, 4);

    const unrelated = await findTaskScenario(
      root,
      task({
        title: "Add a login form",
        detail: "Create a login form with email and password.",
        acceptance: "The form submits.",
      }),
    );
    assert.equal(unrelated, null);

    const realTask = task({
      title: "Verify target-30 scenario and ×1 scoring gives +1 with no code edits",
      detail:
        "Do not modify any file. Run the existing score-30 scenario using public keys; do not add new hooks.",
      acceptance:
        "browser_check pressKeys 30x1 then expectText on #score showing 1; git diff is empty.",
    });
    assert.equal(isScenarioVerificationTask(realTask), true);
    assert.ok(await findTaskScenario(root, realTask));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("recognizes verification-only tasks but not behavior edits", () => {
  assert.equal(
    isScenarioVerificationTask(
      task({
        title: "Run score-30 scenario without editing code",
        detail: "Verify the score deltas.",
        acceptance: "Scenario passes.",
      }),
    ),
    true,
  );
  assert.equal(
    isScenarioVerificationTask(
      task({
        title: "Award points as the smaller operand",
        detail: "Change submitRound to use Math.min.",
        acceptance: "Score matches.",
      }),
    ),
    false,
  );
  assert.equal(
    isScenarioVerificationTask(
      task({
        title: "Implement division from level 3",
        detail: "Implement OPS and makeTarget.",
        acceptance: "Division works.",
      }),
    ),
    false,
  );
  assert.equal(
    isScenarioVerificationTask(
      task({
        title: "Make feedback re-trigger reliably and verify both cases",
        detail: "Verify after the change.",
        acceptance: "Both cases pass.",
      }),
    ),
    false,
  );
});
