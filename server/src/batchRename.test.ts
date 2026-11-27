import assert from "node:assert/strict";
import test from "node:test";
import { planBatchRename } from "./batchRename";

const files = ["assets/icon-a.png", "assets/icon-b.png", "assets/other.png", "src/icon-c.ts"];

test("plans batch renames with scope and conflicts", () => {
  const plan = planBatchRename(files, { path: "assets", find: "icon-", replace: "asset-" });
  assert.equal(plan.ready, 2);
  assert.deepEqual(
    plan.items.filter((item) => item.status === "ready").map((item) => item.to),
    ["assets/asset-a.png", "assets/asset-b.png"],
  );
  assert.equal(plan.scanned, 3);
});

test("detects a target that already exists", () => {
  const plan = planBatchRename(["a.txt", "b.txt"], { find: "a", replace: "b" });
  assert.equal(plan.conflicts, 1);
  assert.equal(plan.items[0].status, "conflict");
});

test("supports regex rules and skips unchanged names", () => {
  const plan = planBatchRename(files, {
    find: "^icon-(\\w+)\\.png$",
    replace: "asset-$1.png",
    useRegex: true,
  });
  assert.equal(plan.ready, 2);
  assert.equal(plan.items.some((item) => item.status === "skip"), false);
});
