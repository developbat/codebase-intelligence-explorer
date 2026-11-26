import assert from "node:assert/strict";
import test from "node:test";
import { shouldForceRequirementsFirst } from "./skillPolicy";

test("forces requirements-first for short edit goals without acceptance terms", () => {
  assert.equal(shouldForceRequirementsFirst("butonları mavi yap", { kind: "edit" }), true);
  assert.equal(shouldForceRequirementsFirst("add a search box", { kind: "edit" }), true);
  assert.equal(shouldForceRequirementsFirst("run the tests", { kind: "run" }), false);
  assert.equal(
    shouldForceRequirementsFirst("butonları mavi yap ve kontrastı doğrula", { kind: "edit" }),
    false,
  );
  assert.equal(shouldForceRequirementsFirst("butonları mavi yap", { kind: "question" }), false);
  assert.equal(shouldForceRequirementsFirst("butonları mavi yap", { kind: "edit" }, true), false);
});
