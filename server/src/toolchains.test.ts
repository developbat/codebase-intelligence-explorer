import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { installToolchain, normalizeLanguages, recommendedToolIds } from "./toolchains";
import { toolchainPath } from "./shellPath";

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

test("project-local tools require an open project", async () => {
  const result = await installToolchain("eslint", undefined);
  assert.equal(result.ok, false);
  assert.match(result.output, /Open a project first/);
  assert.equal(result.command.includes("npm install -D eslint"), true);
});

test("toolchain PATH is non-empty and deduplicated", () => {
  const entries = toolchainPath().split(path.delimiter);
  assert.ok(entries.length > 0);
  assert.equal(entries.some((entry) => entry.trim() === ""), false);
  assert.equal(toolchainPath(), toolchainPath());
});
