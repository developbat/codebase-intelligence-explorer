import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verificationCommandsForChanges } from "./ai/service";

test("selects the nearest Go module for changed files in a multi-module repo", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-go-modules-"));
  try {
    await fs.mkdir(path.join(root, "modA"), { recursive: true });
    await fs.mkdir(path.join(root, "modB"), { recursive: true });
    await fs.writeFile(path.join(root, "modA", "go.mod"), "module example.com/a\n");
    await fs.writeFile(path.join(root, "modB", "go.mod"), "module example.com/b\n");
    await fs.writeFile(path.join(root, "modA", "main.go"), "package main\n");
    await fs.writeFile(path.join(root, "modB", "main.go"), "package main\n");

    const commands = await verificationCommandsForChanges(
      root,
      ["modA/main.go", "modB/main.go"],
      [],
    );
    assert.deepEqual(commands, [
      "(cd 'modA' && go test ./...)",
      "(cd 'modB' && go test ./...)",
    ]);

    const withBase = await verificationCommandsForChanges(root, ["modA/main.go"], [
      "npm test",
      "go test ./...",
    ]);
    assert.deepEqual(withBase, ["npm test", "go test ./..."]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("keeps existing commands when a root Go module exists", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-go-root-"));
  try {
    await fs.writeFile(path.join(root, "go.mod"), "module example.com/root\n");
    await fs.writeFile(path.join(root, "main.go"), "package main\n");
    const commands = await verificationCommandsForChanges(
      root,
      ["main.go"],
      ["go build ./...", "go test ./..."],
    );
    assert.deepEqual(commands, ["go build ./...", "go test ./..."]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
