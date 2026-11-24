import assert from "node:assert/strict";
import test from "node:test";
import { countCheckAssertions, isSyntheticCheckPath } from "./ai/service";

test("classifies synthetic harness pages separately from real entry pages", () => {
  assert.equal(isSyntheticCheckPath("index.html"), false);
  assert.equal(isSyntheticCheckPath("./index.html"), false);
  assert.equal(isSyntheticCheckPath("src/app.js"), false);
  assert.equal(isSyntheticCheckPath(".cie/agent/harness.html"), true);
  assert.equal(isSyntheticCheckPath("./.cie/agent/harness.html"), true);
  assert.equal(isSyntheticCheckPath("tmp/harness.html"), true);
});

test("counts behavior assertions but not page-load visibility", () => {
  assert.equal(
    countCheckAssertions([
      { action: "expectVisible" },
      { action: "expectText" },
      { action: "expectStable" },
      { action: "click" },
    ]),
    2,
  );
});
