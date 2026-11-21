import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createSourceFile,
  deleteProjectPath,
  readSourceFile,
  renameProjectPath,
  runProjectCommand,
  writeProjectAsset,
  writeSourceFile,
} from "./editor";

test("Code Studio file write and command runner work inside the project root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-editor-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cie-editor-data-"));
  const previousDataDir = process.env.CIE_DATA_DIR;
  process.env.CIE_DATA_DIR = dataDir;
  const projectId = "aaaaaaaaaaaaaaaa";
  try {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "demo.ts"), "export const value = 1;\n");

    const before = await readSourceFile(root, "src/demo.ts");
    assert.equal(before.content, "export const value = 1;\n");

    const written = await writeSourceFile(projectId, root, "src/demo.ts", "export const value = 2;\n");
    assert.equal(written.filePath, "src/demo.ts");
    assert.ok(written.backupPath);
    assert.equal(await fs.readFile(path.join(root, "src", "demo.ts"), "utf8"), "export const value = 2;\n");
    assert.ok(await fs.readFile(written.backupPath!, "utf8"));

    const command = await runProjectCommand(root, "cat src/demo.ts");
    assert.equal(command.exitCode, 0);
    assert.ok(command.stdout.includes("export const value = 2;"));
    assert.equal(command.timedOut, false);

    await assert.rejects(() => readSourceFile(root, "../outside.ts"));
  } finally {
    if (previousDataDir === undefined) delete process.env.CIE_DATA_DIR;
    else process.env.CIE_DATA_DIR = previousDataDir;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("streaming command emits stdout chunks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-stream-"));
  try {
    const chunks: string[] = [];
    const result = await runProjectCommand(root, "printf 'one\\ntwo\\n'", undefined, {
      onStdout: (chunk) => chunks.push(chunk),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(chunks.join(""), "one\ntwo\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("streaming command can be aborted", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-abort-"));
  try {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 150);
    const result = await runProjectCommand(root, "sleep 30", undefined, {
      signal: controller.signal,
    });
    assert.ok(Date.now() - started < 5_000);
    assert.notEqual(result.exitCode, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("project paths can be renamed and deleted safely", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-pathops-"));
  try {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "old.ts"), "export const value = 1;\n");

    const renamed = await renameProjectPath(root, "src/old.ts", "src/nested/new.ts");
    assert.equal(renamed.from, "src/old.ts");
    assert.equal(renamed.to, "src/nested/new.ts");
    assert.equal(await fs.readFile(path.join(root, "src", "nested", "new.ts"), "utf8"), "export const value = 1;\n");
    await assert.rejects(() => fs.access(path.join(root, "src", "old.ts")));

    await assert.rejects(() =>
      renameProjectPath(root, "src/nested/new.ts", "../outside.ts"),
    );

    await fs.mkdir(path.join(root, "empty-dir"), { recursive: true });
    const removedDir = await deleteProjectPath(root, "empty-dir");
    assert.equal(removedDir.kind, "directory");

    await assert.rejects(() => deleteProjectPath(root, "src"));

    const removedFile = await deleteProjectPath(root, "src/nested/new.ts");
    assert.equal(removedFile.kind, "file");
    await assert.rejects(() => fs.access(path.join(root, "src", "nested", "new.ts")));

    await assert.rejects(() => deleteProjectPath(root, "../outside.ts"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});


test("new files can be created at any project-relative path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-create-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cie-create-data-"));
  const previousDataDir = process.env.CIE_DATA_DIR;
  process.env.CIE_DATA_DIR = dataDir;
  try {
    const created = await createSourceFile("bbbbbbbbbbbbbbbb", root, "src/nested/App.hs");
    assert.equal(created.filePath, "src/nested/App.hs");
    assert.equal(created.bytes, 0);
    assert.equal(await fs.readFile(path.join(root, "src", "nested", "App.hs"), "utf8"), "");
    await assert.rejects(() => createSourceFile("bbbbbbbbbbbbbbbb", root, "src/nested/App.hs"));
    await assert.rejects(() => createSourceFile("bbbbbbbbbbbbbbbb", root, ".git/config"));
    await assert.rejects(() => createSourceFile("bbbbbbbbbbbbbbbb", root, ".env"));
    await assert.rejects(() => createSourceFile("bbbbbbbbbbbbbbbb", root, "../outside.hs"));
  } finally {
    if (previousDataDir === undefined) delete process.env.CIE_DATA_DIR;
    else process.env.CIE_DATA_DIR = previousDataDir;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});


test("binary assets are written safely and secret paths are blocked", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-assets-"));
  try {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    const written = await writeProjectAsset(
      root,
      "assets/logo.png",
      bytes.toString("base64"),
    );
    assert.equal(written.filePath, "assets/logo.png");
    assert.equal(written.bytes, bytes.byteLength);
    assert.deepEqual(await fs.readFile(path.join(root, "assets", "logo.png")), bytes);

    await assert.rejects(() => writeProjectAsset(root, ".env", bytes.toString("base64")));
    await assert.rejects(() => writeProjectAsset(root, "../outside.png", bytes.toString("base64")));
    await assert.rejects(() => writeProjectAsset(root, "assets/bad.bin", "not-base64!!!"));
    await assert.rejects(() => writeProjectAsset(root, "assets/empty.bin", ""));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
