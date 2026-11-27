import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  beginCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
} from "./checkpoints";

test("checkpoint restores modified, created and deleted files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-checkpoint-root-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cie-checkpoint-data-"));
  const previousDataDir = process.env.CIE_DATA_DIR;
  process.env.CIE_DATA_DIR = dataDir;
  const projectId = "checkpointtest";
  try {
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "a.txt"), "original-a\n");
    await fs.writeFile(path.join(root, "src", "b.txt"), "original-b\n");

    const recorder = await beginCheckpoint(projectId, root, "run_1", "Change files");
    assert.ok(recorder);

    await recorder.remember("a.txt");
    await fs.writeFile(path.join(root, "a.txt"), "changed-a\n");

    await recorder.remember("new.txt");
    await fs.writeFile(path.join(root, "new.txt"), "new file\n");

    await recorder.remember("src/b.txt");
    await fs.rm(path.join(root, "src", "b.txt"));

    await recorder.finalize();
    const checkpoints = await listCheckpoints(projectId);
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0].files.length, 3);

    const result = await restoreCheckpoint(projectId, root, checkpoints[0].id);
    assert.equal(result.failed.length, 0);
    assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf8"), "original-a\n");
    assert.equal(await fs.readFile(path.join(root, "src", "b.txt"), "utf8"), "original-b\n");
    await assert.rejects(() => fs.access(path.join(root, "new.txt")));
  } finally {
    if (previousDataDir === undefined) delete process.env.CIE_DATA_DIR;
    else process.env.CIE_DATA_DIR = previousDataDir;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("checkpoint restores a renamed file and directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-checkpoint-rename-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cie-checkpoint-data-"));
  const previousDataDir = process.env.CIE_DATA_DIR;
  process.env.CIE_DATA_DIR = dataDir;
  const projectId = "checkpointrename";
  try {
    await fs.mkdir(path.join(root, "folder"));
    await fs.writeFile(path.join(root, "old.txt"), "old\n");
    await fs.writeFile(path.join(root, "folder", "nested.txt"), "nested\n");

    const recorder = await beginCheckpoint(projectId, root, "run_rename", "Rename");
    assert.ok(recorder);
    await recorder.remember("old.txt");
    await recorder.remember("new.txt");
    await fs.rename(path.join(root, "old.txt"), path.join(root, "new.txt"));
    await recorder.remember("folder");
    await recorder.remember("moved");
    await fs.rename(path.join(root, "folder"), path.join(root, "moved"));
    await recorder.finalize();

    const checkpoints = await listCheckpoints(projectId);
    const result = await restoreCheckpoint(projectId, root, checkpoints[0].id);
    assert.equal(result.failed.length, 0);
    assert.equal(await fs.readFile(path.join(root, "old.txt"), "utf8"), "old\n");
    assert.equal(
      await fs.readFile(path.join(root, "folder", "nested.txt"), "utf8"),
      "nested\n",
    );
    await assert.rejects(() => fs.access(path.join(root, "new.txt")));
    await assert.rejects(() => fs.access(path.join(root, "moved")));
  } finally {
    if (previousDataDir === undefined) delete process.env.CIE_DATA_DIR;
    else process.env.CIE_DATA_DIR = previousDataDir;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
