import assert from "node:assert/strict";
import test from "node:test";
import { normalizeLanguages, recommendedToolIds } from "./toolchains";

test("language recommendation maps project languages to managed tools", () => {
  const languages = normalizeLanguages(["typescript", "tsx", "python", "go"]);
  assert.deepEqual(languages, ["go", "javascript", "python", "typescript"]);
  const recommended = recommendedToolIds(languages, ["src/app.ts", "src/main.py"]);
  assert.ok(recommended.includes("node"));
  assert.ok(recommended.includes("npm"));
  assert.ok(recommended.includes("git"));
  assert.ok(recommended.includes("typescript-language-server"));
  assert.ok(recommended.includes("pyright"));
  assert.ok(recommended.includes("gopls"));
  assert.equal(recommended.includes("rust-analyzer"), false);
});

test("eslint and prettier are recommended only when config exists", () => {
  const withoutConfig = recommendedToolIds(["typescript"], ["src/app.ts"]);
  assert.equal(withoutConfig.includes("eslint"), false);
  assert.equal(withoutConfig.includes("prettier"), false);
  const withConfig = recommendedToolIds(
    ["typescript"],
    ["src/app.ts", ".eslintrc.json", ".prettierrc"],
  );
  assert.ok(withConfig.includes("eslint"));
  assert.ok(withConfig.includes("prettier"));
});

test("docker is recommended only for a Dockerfile", () => {
  assert.equal(recommendedToolIds(["typescript"], ["src/app.ts"]).includes("docker"), false);
  assert.ok(recommendedToolIds(["typescript"], ["Dockerfile"]).includes("docker"));
});
