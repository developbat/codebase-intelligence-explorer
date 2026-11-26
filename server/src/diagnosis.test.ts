import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProjectDiagnosis } from "../../shared/diagnosis";
import {
  compactDiagnosisBrief,
  diagnosisPaths,
  loadDiagnosis,
  renderDiagnosisMarkdown,
  saveDiagnosis,
} from "./ai/diagnosis";

function sample(): ProjectDiagnosis {
  return {
    version: 1,
    goal: "Fix the blue ball respawn and remove the level list",
    createdAt: "2026-01-01T00:00:00.000Z",
    provider: "deepseek",
    model: "deepseek-flash",
    problem: "The blue collectible can spawn inside a wall.",
    rootCause: "loadLevel copies level.rewards without validating walkability.",
    confidence: 0.8,
    facts: [
      {
        claim: "Reward coordinates are copied without isWall validation.",
        file: "game.js",
        line: 363,
        evidence: "state.rewards = level.rewards.map(...)",
      },
    ],
    constraints: ["Do not change the client UI."],
    unknowns: ["Whether every map is fully connected."],
    callSites: ["loadLevel (game.js:341) → state.rewards"],
    includes: ["index.html loads game.js"],
    impact: ["Boss Core gem", "inventory"],
    designs: [
      {
        name: "Validate at load and respawn",
        summary: "Use isWall/BFS for the initial and every respawn cell.",
        pros: ["Small", "Covers all maps"],
        cons: ["Adds a BFS helper"],
        files: ["game.js"],
        risk: "low",
      },
      {
        name: "Hardcode coordinates",
        summary: "Move Boss Core coordinates to a known floor cell.",
        pros: ["Tiny"],
        cons: ["Breaks on map edits"],
        files: ["game.js"],
        risk: "medium",
      },
    ],
    chosenDesign: "Validate at load and respawn",
    rationale: "Works for every map and future edits.",
    failureModes: [
      {
        scenario: "No walkable candidate exists",
        impact: "Reward cannot spawn",
        mitigation: "Fall back to the player start and log a warning.",
      },
    ],
    rollback: "Revert game.js to the previous reward mapping.",
    verification: {
      command: "node --check game.js",
      checks: ["Collect the gem 3 times and assert isWall=false each time."],
      expected: ["Score/inventory increase each time; no console errors."],
    },
    todos: ["Inspect loadLevel", "Add validation", "Verify 3 pickups"],
    tokenUsage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
    costUsd: 0.001,
  };
}

test("diagnosis brief carries root cause, design, verification and todos", () => {
  const brief = compactDiagnosisBrief(sample());
  assert.match(brief, /## Diagnosis/);
  assert.match(brief, /Root cause/);
  assert.match(brief, /Validate at load and respawn/);
  assert.match(brief, /node --check game\.js/);
  assert.match(brief, /Inspect loadLevel/);
  assert.ok(brief.length <= 2_800);
  assert.equal(compactDiagnosisBrief(null), "");
});

test("diagnosis markdown and persistence round-trip", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-diagnosis-"));
  try {
    const diagnosis = sample();
    await saveDiagnosis(root, diagnosis);
    const paths = diagnosisPaths(root);
    await fs.stat(paths.json);
    await fs.stat(paths.markdown);
    const loaded = await loadDiagnosis(root);
    assert.equal(loaded?.chosenDesign, diagnosis.chosenDesign);
    const markdown = renderDiagnosisMarkdown(diagnosis);
    assert.match(markdown, /## Root cause/);
    assert.match(markdown, /## Designs/);
    assert.match(markdown, /## Verification/);
    assert.match(markdown, /## Todos/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
