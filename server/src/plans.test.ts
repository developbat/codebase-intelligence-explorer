import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listPlans, readPlan, savePlan } from "./plans";

test("plans are saved, listed and read back", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-plans-"));
  try {
    const saved = await savePlan(
      root,
      "# Add dark mode\n\n## Goal\nAdd a theme toggle.\n\n## Tasks\n1. Add the toggle.",
      { goal: "add dark mode" },
    );
    assert.match(saved.path, /^\.cie\/agent\/plans\/.+\.md$/);
    const plans = await listPlans(root);
    assert.equal(plans.length, 1);
    assert.equal(plans[0].title, "Add dark mode");
    const loaded = await readPlan(root, saved.name);
    assert.match(loaded.content, /Add a theme toggle/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("plan names cannot escape the plans directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-plans-"));
  try {
    await assert.rejects(() => readPlan(root, "../secret.md"));
    await assert.rejects(() => readPlan(root, "notes.txt"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
