import assert from "node:assert/strict";
import test from "node:test";
import { permissionDiffPreview } from "./ai/service";

test("permission diff shows removed and added lines for review", () => {
  const diff = permissionDiffPreview("const a = 1;\nconsole.log(a);\n", "const a = 2;\nconsole.log(a);\n");
  assert.match(diff, /^-const a = 1;$/m);
  assert.match(diff, /^\+const a = 2;$/m);
  assert.match(diff, /^ console\.log\(a\);$/m);
});

test("permission diff labels a new file", () => {
  const diff = permissionDiffPreview(null, "hello\nworld\n");
  assert.match(diff, /^\+ \(new file\)$/m);
  assert.match(diff, /^\+hello$/m);
  assert.match(diff, /^\+world$/m);
});
