import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TerminalSessionInfo } from "../../shared/types";
import {
  closeTerminalSession,
  createTerminalSession,
  listTerminalSessions,
  resizeTerminal,
  subscribeTerminal,
  writeTerminalInput,
} from "./terminals";

const hasPython = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

test("interactive PTY terminal accepts input and streams output", { skip: !hasPython }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-pty-"));
  let session: TerminalSessionInfo | null = null;
  let unsubscribe: (() => void) | null = null;
  try {
    session = await createTerminalSession(root, "pty-test-project");
    assert.equal(session.cwd, await fs.realpath(root));
    assert.equal(session.status, "running");
    assert.equal(listTerminalSessions("pty-test-project").length, 1);

    let output = "";
    unsubscribe = subscribeTerminal("pty-test-project", session.id, (event) => {
      if (event.type === "start") output += event.buffer;
      else if (event.type === "output") output += event.chunk;
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    writeTerminalInput("pty-test-project", session.id, "printf 'terminal-pty-ok\\n'\n");

    for (let attempt = 0; attempt < 40 && !output.includes("terminal-pty-ok"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(output.includes("terminal-pty-ok"), `terminal output missing: ${output.slice(-600)}`);

    resizeTerminal("pty-test-project", session.id, 72, 18);
    writeTerminalInput("pty-test-project", session.id, "stty size\n");
    // Linux PTYs may report the size with CR-only line endings, so do not
    // require a preceding \n here.
    for (let attempt = 0; attempt < 40 && !/\b18 72\b/.test(output); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.match(output, /\b18 72\b/, `terminal resize missing: ${output.slice(-600)}`);

    unsubscribe();
    unsubscribe = null;
    const closed = closeTerminalSession("pty-test-project", session.id);
    session = null;
    assert.equal(closed.status, "exited");
    assert.equal(listTerminalSessions("pty-test-project").length, 0);
  } finally {
    // A failed assertion used to leave the PTY child running, which kept the
    // node:test process alive forever on CI.
    unsubscribe?.();
    if (session) {
      try {
        closeTerminalSession("pty-test-project", session.id);
      } catch {
        // The session may already have exited.
      }
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
