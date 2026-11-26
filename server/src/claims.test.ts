import assert from "node:assert/strict";
import test from "node:test";
import { auditClaims, type ClaimEvidence } from "./ai/claims";

const base: ClaimEvidence = {
  changedFiles: [],
  readFiles: [],
  commands: [],
  verification: { ran: false, ok: false },
  browserChecks: [],
};

test("rejects a claimed change without a changed file", () => {
  assert.ok(auditClaims("Fixed the login bug.", base).issues.some((issue) => /no file/i.test(issue)));
  assert.equal(
    auditClaims("Fixed the login bug.", { ...base, changedFiles: ["src/login.ts"] }).issues.length,
    0,
  );
});

test("rejects verification and test claims without evidence", () => {
  assert.ok(auditClaims("Verified. All tests passed.", base).issues.length > 0);
  assert.equal(
    auditClaims("Verified. All tests passed.", {
      ...base,
      verification: { ran: true, ok: true, command: "npm test" },
    }).issues.length,
    0,
  );
  assert.ok(
    auditClaims("All tests passed.", {
      ...base,
      commands: [{ command: "npm test", ok: false }],
      verification: { ran: true, ok: false, command: "npm test" },
    }).issues.some((issue) => /tests/i.test(issue)),
  );
});

test("accepts extraction and mapped-change evidence", () => {
  assert.equal(
    auditClaims("Listed every button and verified the total.", {
      ...base,
      extractionComplete: true,
      readOnly: true,
    }).issues.length,
    0,
  );
  assert.equal(
    auditClaims("Changed the color and verified it.", {
      ...base,
      changedFiles: ["styles.css"],
      mappedChangeVerified: true,
    }).issues.length,
    0,
  );
});

test("rejects read and browser claims without matching evidence", () => {
  assert.ok(
    auditClaims("I read src/missing.ts and verified it.", base).issues.some((issue) =>
      /read of src\/missing\.ts/i.test(issue),
    ),
  );
  assert.equal(
    auditClaims("I read src/app.ts.", { ...base, readFiles: ["src/app.ts"], readOnly: true }).issues
      .length,
    0,
  );
  assert.ok(
    auditClaims("Browser verification passed.", base).issues.some((issue) => /browser/i.test(issue)),
  );
  assert.equal(
    auditClaims("Browser verification passed.", {
      ...base,
      browserChecks: [{ ok: true, assertions: 2 }],
    }).issues.length,
    0,
  );
});

test("does not flag explicit negative statements", () => {
  assert.equal(auditClaims("No file was changed; tests were not run.", base).issues.length, 0);
});

test("does not treat the harness verification note as a test claim", () => {
  const summary = `## Sonuç
İstenen üç davranış gerçek sayfada browser_check ile doğrulandı (tüm adımlar PASS).

## Değişen dosyalar
- game.js

**Verification:** No lint/typecheck/test/build command was detected for this project.`;
  assert.equal(
    auditClaims(summary, {
      ...base,
      changedFiles: ["game.js"],
      browserChecks: [{ ok: true, assertions: 3 }],
    }).issues.length,
    0,
  );
});
