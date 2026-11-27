import assert from "node:assert/strict";
import test from "node:test";
import { getCurrentTime } from "./time";

test("returns the current time in the requested timezone", () => {
  const time = getCurrentTime("Europe/Istanbul");
  assert.equal(time.timezone, "Europe/Istanbul");
  assert.match(time.formatted, /2026/);
  assert.match(time.iso, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(time.utc.length > 0);
});

test("rejects an unknown timezone", () => {
  assert.throws(() => getCurrentTime("Mars/Olympus"), /Unknown timezone/);
});
