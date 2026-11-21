import assert from "node:assert/strict";
import test from "node:test";
import { shouldRetryWithEditFirst } from "./ai/loop";
import {
  isFastEditTask,
  preferredVerificationCommand,
  readRangeCovered,
  reportsRemainingWork,
} from "./ai/service";

test("typecheck is preferred over build for automatic verification", () => {
  assert.equal(
    preferredVerificationCommand({
      typecheckCommands: ["npx tsc --noEmit"],
      buildCommands: ["npm run build"],
    }),
    "npx tsc --noEmit",
  );
  assert.equal(
    preferredVerificationCommand({ typecheckCommands: [], buildCommands: ["cargo build"] }),
    "cargo build",
  );
  assert.equal(preferredVerificationCommand({ typecheckCommands: [], buildCommands: [] }), undefined);
  assert.equal(preferredVerificationCommand(undefined), undefined);
});

test("small edit instructions select the fast task profile", () => {
  assert.equal(isFastEditTask("projeye users get servisi oluştur", false), true);
  assert.equal(isFastEditTask("add a GET /users endpoint", false), true);
  assert.equal(isFastEditTask("fix the null check in order.service.ts", false), true);
  assert.equal(isFastEditTask("arka planı siyah yap", false), true);
  assert.equal(isFastEditTask("buton rengini yeşil yap", false), true);
  assert.equal(isFastEditTask("Bu projeyi analiz edilen graph üzerinden açıkla", false), false);
  assert.equal(isFastEditTask("How do I fix this?", false), false);
  assert.equal(isFastEditTask("why does the user service fail?", false), false);
  assert.equal(isFastEditTask("projeye users get servisi oluştur", true), false);
  assert.equal(isFastEditTask(`add ${"x".repeat(300)}`, false), false);
});

test("read range coverage prevents duplicate reads", () => {
  const ranges = [{ start: 1, end: 82, wholeFile: true }];
  assert.equal(readRangeCovered(ranges, 1, true, Number.POSITIVE_INFINITY), true);
  assert.equal(readRangeCovered(ranges, 70, false, 82), true);
  assert.equal(readRangeCovered(ranges, 1, false, 120), false);
  assert.equal(readRangeCovered(ranges, 83, false, 90), false);
  assert.equal(readRangeCovered([{ start: 40, end: 82, wholeFile: false }], 1, true, Number.POSITIVE_INFINITY), false);
});


test("remaining-work summaries are detected without flagging clean completions", () => {
  assert.equal(reportsRemainingWork("## Kalan (yapılmadı)\n- route wiring"), true);
  assert.equal(reportsRemainingWork("Kalan: createContainer and index.ts"), true);
  assert.equal(reportsRemainingWork("Remaining work: wire the route"), true);
  assert.equal(reportsRemainingWork("Next step: run tests"), true);
  assert.equal(reportsRemainingWork("Kalan yok, her şey tamam."), false);
  assert.equal(reportsRemainingWork("All changes are complete; typecheck passed."), false);
});

test("step-limit failures without edits retry with the edit-first fast profile", () => {
  assert.equal(shouldRetryWithEditFirst("max_steps", []), true);
  assert.equal(shouldRetryWithEditFirst("max_steps", ["js/script.js"]), false);
  assert.equal(shouldRetryWithEditFirst("finished", []), false);
  assert.equal(shouldRetryWithEditFirst("error", []), false);
});
