import assert from "node:assert/strict";
import test from "node:test";
import { pythonEnvironmentHint } from "./ai/pythonHints";

test("pythonEnvironmentHint explains externally managed interpreters", () => {
  const hint = pythonEnvironmentHint(
    "python3 -m pip install pandas",
    1,
    "error: externally-managed-environment\n",
  );
  assert.match(hint, /virtual environment/u);
  assert.match(hint, /--break-system-packages/u);
});

test("pythonEnvironmentHint stops retries after a segfault", () => {
  const hint = pythonEnvironmentHint(
    "python3 -c 'import pandas'",
    139,
    "Fatal Python error: Segmentation fault",
  );
  assert.match(hint, /exit 139/u);
  assert.match(hint, /Do not retry/u);
  assert.match(hint, /python3\.13/u);
});

test("pythonEnvironmentHint stays quiet for non-Python commands", () => {
  assert.equal(pythonEnvironmentHint("npm test", 1, "TypeError: boom"), "");
});
