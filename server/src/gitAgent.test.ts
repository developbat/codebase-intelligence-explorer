import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { gitCommit, gitCreateBranch, gitInfo, gitSetRemote } from "./gitAgent";

const run = promisify(execFile);

async function git(root: string, args: string[]) {
  return run("git", ["-C", root, ...args]);
}

test("agent git tools read, commit, branch and set remotes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-git-"));
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Test"]);
    await fs.writeFile(path.join(root, "a.txt"), "one\n");
    const first = await gitCommit(root, "feat: first", { stageAll: true });
    assert.ok(first.commit);
    assert.match(await gitInfo(root, "status"), /##/);
    assert.match(await gitInfo(root, "log"), /feat: first/);
    const branch = await gitCreateBranch(root, "feature/test");
    assert.equal(branch.branch, "feature/test");
    assert.match(await gitInfo(root, "branches"), /feature\/test/);
    await gitSetRemote(root, "origin", "https://example.com/owner/repo.git");
    assert.match(await gitInfo(root, "remotes"), /origin/);
    await fs.writeFile(path.join(root, "a.txt"), "two\n");
    const second = await gitCommit(root, "fix: second", { files: ["a.txt"] });
    assert.ok(second.commit);
    assert.match(second.output, /fix: second/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
