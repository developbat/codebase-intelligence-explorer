import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  checkToolchains,
  installToolchain,
  normalizeLanguages,
  recommendedToolIds,
} from "./toolchains";
import {
  bundledNodeBin,
  managedToolsBin,
  resetToolchainPathCache,
  toolchainPath,
} from "./shellPath";

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


test("detects project tools hoisted to a workspace root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-hoisted-"));
  try {
    const app = path.join(root, "packages", "app");
    await fs.mkdir(path.join(root, "node_modules", "eslint"), { recursive: true });
    await fs.writeFile(
      path.join(root, "node_modules", "eslint", "package.json"),
      '{"name":"eslint","version":"9.1.2"}',
      "utf8",
    );
    await fs.mkdir(app, { recursive: true });
    const report = await checkToolchains(true, {
      rootPath: app,
      languages: ["typescript"],
      files: ["src/app.ts"],
    });
    const eslint = report.tools.find((tool) => tool.id === "eslint");
    assert.equal(eslint?.installed, true);
    assert.match(eslint?.version ?? "", /9\.1\.2/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});


test("PATH starts with app-managed tools and includes the bundled runtime", () => {
  const previous = process.env.CIE_DATA_DIR;
  process.env.CIE_DATA_DIR = path.join(os.tmpdir(), "cie-path-test");
  try {
    resetToolchainPathCache();
    const entries = toolchainPath().split(path.delimiter);
    assert.equal(entries[0], managedToolsBin());
    const bundled = bundledNodeBin();
    if (bundled) assert.ok(entries.includes(bundled));
  } finally {
    if (previous === undefined) delete process.env.CIE_DATA_DIR;
    else process.env.CIE_DATA_DIR = previous;
    resetToolchainPathCache();
  }
});
