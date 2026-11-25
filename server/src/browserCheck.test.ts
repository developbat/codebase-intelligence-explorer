import assert from "node:assert/strict";
import test from "node:test";
import { browserCheckTarget } from "./browserCheck";
import { normalizeBrowserSteps } from "../../shared/browserCheck";

test("browser check treats a dev-server URL as url even when passed in path", () => {
  assert.equal(
    browserCheckTarget("demo", "http://127.0.0.1:8501"),
    "http://127.0.0.1:8501/",
  );
  assert.equal(
    browserCheckTarget("demo", "localhost:8501"),
    "http://localhost:8501/",
  );
  assert.equal(
    browserCheckTarget("demo", "127.0.0.1:8501/app"),
    "http://127.0.0.1:8501/app",
  );
  assert.match(browserCheckTarget("demo", "index.html"), /\/preview\/index\.html$/);
  assert.equal(
    browserCheckTarget("demo", "index.html", "http://127.0.0.1:8501"),
    "http://127.0.0.1:8501/",
  );
  assert.throws(() => browserCheckTarget("demo", "https://example.com"), /localhost/);
});


test("browser steps accept model aliases before launch", () => {
  const steps = normalizeBrowserSteps([
    { action: "click", selector: "#play" },
    { action: "press", key: "Enter" },
    { action: "wait", selector: ".score" },
    { action: "wait", text: "Ready" },
    {
      action: "eval",
      expression: "document.querySelector('#score').textContent",
      expected: "0",
    },
    { action: "expectStable", selector: ".score", maxChanges: 1, durationMs: 900 },
  ]);
  assert.equal(steps[0].action, "click");
  assert.equal(steps[1].action, "press");
  assert.equal(steps[1].selector, "body");
  assert.equal(steps[1].value, "Enter");
  assert.equal(steps[2].action, "waitForSelector");
  assert.equal(steps[3].action, "waitForText");
  assert.equal(steps[4].action, "eval");
  assert.equal(steps[4].value, "document.querySelector('#score').textContent");
  assert.equal(steps[4].expectText, "0");
  assert.equal(steps[5].maxChanges, 1);
});

test("browser steps report every invalid step with the accepted shape", () => {
  assert.throws(
    () =>
      normalizeBrowserSteps([
        { action: "eval", expression: "" },
        { action: "wait" },
        { action: "click" },
        { action: "teleport" },
      ]),
    (error: Error) => {
      assert.match(error.message, /Step 1 \(eval\): "value"/);
      assert.match(error.message, /Step 2: "wait" needs/);
      assert.match(error.message, /Step 3 \(click\): "selector"/);
      assert.match(error.message, /Step 4: unknown action "teleport"/);
      return true;
    },
  );
});
