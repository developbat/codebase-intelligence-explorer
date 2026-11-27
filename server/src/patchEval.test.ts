import assert from "node:assert/strict";
import test from "node:test";
import { parsePatchForEval } from "./evalPatch";

const PATCH = `diff --git a/game.js b/game.js
index 1111111..2222222 100644
--- a/game.js
+++ b/game.js
@@ -420,6 +420,16 @@ function move(dx, dy) {
-  if (isWall(nx, ny)) return;
+  if (isWall(nx, ny)) {
+    if (!blastWall(nx, ny)) return;
+  }
+function blastWall(x, y) {
+  if (state.energy < 10) return false;
+  state.energy -= 10;
+  currentLevel().map[y][x] = 0;
+  return true;
+}
`;

test("patch eval extracts changed files, identifiers and line counts", () => {
  const summary = parsePatchForEval(PATCH);
  assert.deepEqual(summary.files, ["game.js"]);
  assert.ok(summary.identifiers.includes("blastWall"));
  assert.ok(summary.identifiers.includes("move"));
  assert.ok(summary.added > 0);
  assert.ok(summary.removed > 0);
});
