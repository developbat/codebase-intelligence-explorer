import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readSourceFile, runProjectCommand, writeSourceFile } from "./editor";

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
