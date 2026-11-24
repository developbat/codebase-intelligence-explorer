import assert from "node:assert/strict";
import test from "node:test";
import { browserCheckTarget } from "./browserCheck";

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
