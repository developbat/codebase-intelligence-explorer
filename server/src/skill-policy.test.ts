import assert from "node:assert/strict";
import test from "node:test";
import { shouldForceRequirementsFirst } from "./skillPolicy";

test("forces requirements-first from the structured intent spec", () => {
  assert.equal(
    shouldForceRequirementsFirst("butonları mavi yap", { kind: "edit" }),
    true,
  );
  assert.equal(
    shouldForceRequirementsFirst("butonları mavi yap", {
      kind: "edit",
      confidence: 0.95,
      behaviors: [
        {
          id: "b1",
          action: "update",
          surface: "ui",
          target: "buttons",
          details: "blue",
          acceptance: "buttons are blue",
        },
      ],
      ambiguities: [],
    }),
    false,
  );
  assert.equal(
    shouldForceRequirementsFirst("run the tests", {
      kind: "run",
      confidence: 0.9,
    }),
    false,
  );
  assert.equal(
    shouldForceRequirementsFirst("butonları mavi yap", { kind: "question", confidence: 0.2 }),
    false,
  );
  assert.equal(
    shouldForceRequirementsFirst("butonları mavi yap", { kind: "edit", confidence: 0.2 }, true),
    false,
  );
});
