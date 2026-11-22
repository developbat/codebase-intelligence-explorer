import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { answerDocumentOperation } from "./documentAnswer";
import type { IntentAnalysis } from "../../shared/intent";

const baseIntent: IntentAnalysis = {
  kind: "analyze",
  understanding: "list unchecked items",
  language: "tr",
  needsClarification: false,
  scope: "trivial",
  mode: "single",
  areas: [],
  verification: "none",
  documentOperation: "list_unchecked",
  assumptions: [],
};

test("checklist extraction returns every unchecked item with line numbers", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-answer-"));
  try {
    await fs.mkdir(path.join(root, "assets"), { recursive: true });
    await fs.writeFile(
      path.join(root, "assets", "tasks.md"),
      "# Tasks\n\n- [x] done\n- [ ] first open\n- [x] done two\n- [ ] second open\n",
    );
    const answer = await answerDocumentOperation(
      root,
      "list remaining tasks\n\nEk dosya: assets/tasks.md",
      baseIntent,
    );
    assert.ok(answer);
    assert.equal(answer.total, 2);
    assert.match(answer.summary, /first open/);
    assert.match(answer.summary, /second open/);
    assert.match(answer.summary, /line 4/);
    assert.match(answer.summary, /line 6/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
