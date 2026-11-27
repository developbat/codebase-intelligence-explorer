import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { clearProjectRulesCache, loadProjectRules } from "./projectRules";

async function makeProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-rules-"));
  await fs.writeFile(
    path.join(root, "AGENTS.md"),
    "# Root rules\nUse two-space indentation.\n",
  );
  await fs.mkdir(path.join(root, "packages", "api"), { recursive: true });
  await fs.writeFile(
    path.join(root, "packages", "api", "AGENTS.md"),
    "# API rules\nNever log secrets.\n",
  );
  await fs.mkdir(path.join(root, "node_modules", "ignored"), { recursive: true });
  await fs.writeFile(
    path.join(root, "node_modules", "ignored", "AGENTS.md"),
    "This must be ignored.\n",
  );
  return root;
}

test("loads root and nested AGENTS.md and ignores dependencies", async () => {
  const root = await makeProject();
  clearProjectRulesCache();
  try {
    const rules = await loadProjectRules(root);
    assert.ok(rules);
    assert.deepEqual(rules.files, ["AGENTS.md", "packages/api/AGENTS.md"]);
    assert.match(rules.block, /# Root rules/);
    assert.match(rules.block, /# API rules/);
    assert.doesNotMatch(rules.block, /must be ignored/);
    assert.equal(rules.truncated, false);
  } finally {
    clearProjectRulesCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("returns null when the project has no AGENTS.md", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-rules-empty-"));
  clearProjectRulesCache();
  try {
    assert.equal(await loadProjectRules(root), null);
  } finally {
    clearProjectRulesCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("truncates oversized rules instead of flooding the prompt", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-rules-large-"));
  clearProjectRulesCache();
  try {
    await fs.writeFile(path.join(root, "AGENTS.md"), "x".repeat(20_000));
    const rules = await loadProjectRules(root);
    assert.ok(rules);
    assert.equal(rules.truncated, true);
    assert.ok(rules.block.length < 14_000);
    assert.match(rules.block, /truncated/);
  } finally {
    clearProjectRulesCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});
