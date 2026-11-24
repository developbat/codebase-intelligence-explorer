import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getPrompt,
  getPromptVersion,
  listPrompts,
  renderPrompt,
  resetPrompt,
  savePrompt,
} from "./ai/prompts";

test("prompt registry supports defaults, project overrides, render and reset", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cie-prompts-"));
  const previous = process.env.CIE_DATA_DIR;
  process.env.CIE_DATA_DIR = dataDir;
  const projectId = "prompttest000001";
  try {
    const prompts = await listPrompts(projectId);
    const ids = prompts.map((prompt) => prompt.id);
    for (const required of [
      "agent.ask",
      "agent.auto",
      "agent.test",
      "agent.coding",
      "agent.final",
      "agent.final_coding",
      "edit.file",
      "edit.file_patch",
      "task.multi_file",
      "review.diff",
      "project.summary",
      "tests.generate",
      "symbol.analyze",
      "scope.summary",
      "flows.business",
      "unresolved.investigate",
      "chat.answer",
    ]) {
      assert.ok(ids.includes(required), `missing prompt ${required}`);
    }
    for (const prompt of prompts) {
      if (["agent.ask", "agent.auto", "agent.coding"].includes(prompt.id)) {
        assert.ok(prompt.system.includes("{{tools}}"), `${prompt.id} must keep {{tools}}`);
      }
      assert.ok(prompt.system.includes("{{language}}"), `${prompt.id} must keep {{language}}`);
    }
    const defaultPrompt = await getPrompt("agent.auto", projectId);
    assert.equal(defaultPrompt.source, "default");
    assert.ok(defaultPrompt.system.includes("{{tools}}"));

    const rendered = renderPrompt(defaultPrompt.system, {
      tools: "list_files, read_file",
      language: "- Write in Turkish.",
    });
    assert.ok(rendered.includes("list_files, read_file"));
    assert.ok(!rendered.includes("{{tools}}"));

    const projectSaved = await savePrompt(
      "agent.auto",
      "PROJECT PROMPT\n{{tools}}\n{{language}}",
      projectId,
    );
    assert.equal(projectSaved.source, "project");
    assert.equal(projectSaved.version, 1);
    const projectFetched = await getPrompt("agent.auto", projectId);
    assert.equal(projectFetched.system.startsWith("PROJECT PROMPT"), true);

    const globalSaved = await savePrompt(
      "agent.auto",
      "GLOBAL PROMPT\n{{tools}}\n{{language}}",
    );
    assert.equal(globalSaved.source, "global");
    const projectWins = await getPrompt("agent.auto", projectId);
    assert.equal(projectWins.source, "project");

    const resetProject = await resetPrompt("agent.auto", projectId);
    assert.equal(resetProject.source, "global");
    assert.equal(resetProject.system.startsWith("GLOBAL PROMPT"), true);

    await resetPrompt("agent.auto");
    const backToDefault = await getPrompt("agent.auto", projectId);
    assert.equal(backToDefault.source, "default");

    await assert.rejects(() => savePrompt("agent.auto", "sk-123456789012345678901234", projectId));
    await assert.rejects(() => savePrompt("unknown.prompt", "x", projectId));
  } finally {
    if (previous === undefined) delete process.env.CIE_DATA_DIR;
    else process.env.CIE_DATA_DIR = previous;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});


test("prompt history records saved versions, survives reset and is scoped", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cie-prompt-history-"));
  const previous = process.env.CIE_DATA_DIR;
  process.env.CIE_DATA_DIR = dataDir;
  const projectId = "prompthistory001";
  try {
    const v1 = await savePrompt("review.diff", "V1 {{language}}", projectId);
    assert.equal(v1.version, 1);
    assert.equal(v1.history.length, 0);

    const v2 = await savePrompt("review.diff", "V2 {{language}}", projectId);
    assert.equal(v2.version, 2);
    assert.deepEqual(v2.history.map((entry) => entry.version), [1]);
    assert.equal(v2.history[0].scope, "project");

    const v3 = await savePrompt("review.diff", "V3 {{language}}", projectId);
    assert.equal(v3.version, 3);
    assert.deepEqual(new Set(v3.history.map((entry) => entry.version)), new Set([1, 2]));

    const same = await savePrompt("review.diff", "V3 {{language}}", projectId);
    assert.equal(same.version, 3);
    assert.equal(same.history.length, 2);

    const version1 = await getPromptVersion("review.diff", 1, "project", projectId);
    assert.equal(version1.system, "V1 {{language}}");
    assert.equal(version1.scope, "project");
    await assert.rejects(() => getPromptVersion("review.diff", 99, "project", projectId));

    const reset = await resetPrompt("review.diff", projectId);
    assert.equal(reset.source, "default");
    assert.deepEqual(new Set(reset.history.map((entry) => entry.version)), new Set([1, 2, 3]));

    const v4 = await savePrompt("review.diff", "V4 {{language}}", projectId);
    assert.equal(v4.version, 4);
    assert.ok(v4.history.some((entry) => entry.version === 3));

    const global = await savePrompt("review.diff", "GLOBAL REVIEW {{language}}");
    assert.equal(global.source, "global");
    assert.equal(global.version, 1);
    const global2 = await savePrompt("review.diff", "GLOBAL REVIEW v2 {{language}}");
    assert.equal(global2.version, 2);
    assert.ok(global2.history.some((entry) => entry.version === 1 && entry.scope === "global"));
    const globalVersion = await getPromptVersion("review.diff", 1, "global");
    assert.equal(globalVersion.system, "GLOBAL REVIEW {{language}}");
    assert.equal(globalVersion.scope, "global");
    const globalCurrent = await getPromptVersion("review.diff", 2, "global");
    assert.equal(globalCurrent.system, "GLOBAL REVIEW v2 {{language}}");

    const list = await listPrompts(projectId);
    const review = list.find((prompt) => prompt.id === "review.diff");
    assert.ok(review);
    assert.ok(review.history.some((entry) => entry.scope === "project"));
    assert.ok(review.history.some((entry) => entry.scope === "global"));
  } finally {
    if (previous === undefined) delete process.env.CIE_DATA_DIR;
    else process.env.CIE_DATA_DIR = previous;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
