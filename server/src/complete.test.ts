import assert from "node:assert/strict";
import test from "node:test";
import { mergeContinuation } from "./ai/complete";

test("continuation chunks with an overlap are merged without duplication", () => {
  const current = "The button is wider now. The next section explains";
  const next = "The next section explains how the spacing works.";
  assert.equal(
    mergeContinuation(current, next),
    "The button is wider now. The next section explains how the spacing works.",
  );
});

test("continuation chunks without an overlap are joined", () => {
  const merged = mergeContinuation("First half.", "Second half.");
  assert.equal(merged, "First half.\nSecond half.");
});
