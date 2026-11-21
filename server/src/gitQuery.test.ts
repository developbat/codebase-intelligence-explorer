import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getGitBlame } from "./git";

const hasGit = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

test("git_blame returns line history and enforces path/range limits", { skip: !hasGit }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-blame-"));
  try {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(
      path.join(root, "src", "app.ts"),
      "export function add(a: number, b: number) {\n  return a + b;\n}\n",
    );
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "alice@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Alice"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-m", "add function"], { cwd: root, stdio: "ignore" });

    const blame = await getGitBlame(root, "src/app.ts", 1, 3);
    assert.ok(blame.includes("Alice"));
    assert.ok(blame.includes("add(a: number"));
    const defaultBlame = await getGitBlame(root, "src/app.ts");
    assert.ok(defaultBlame.includes("Alice"));
    await assert.rejects(() => getGitBlame(root, "src/app.ts", 10, 12));
    await assert.rejects(() => getGitBlame(root, "../outside.ts", 1, 2));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
