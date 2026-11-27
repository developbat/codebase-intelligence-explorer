import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { addReminder, completeReminder, listReminders } from "./reminders";

test("creates, lists and completes local reminders", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cie-reminders-"));
  const previous = process.env.CIE_DATA_DIR;
  process.env.CIE_DATA_DIR = dataDir;
  try {
    const reminder = await addReminder({
      title: "Send report",
      dueAt: "2026-11-30T09:00:00Z",
      kind: "task",
    });
    assert.equal(reminder.kind, "task");
    assert.equal(reminder.dueAt, "2026-11-30T09:00:00.000Z");

    const pending = await listReminders();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].title, "Send report");

    const completed = await completeReminder({ title: "Send report" });
    assert.equal(completed.alreadyCompleted, false);
    assert.ok(completed.reminder.completedAt);
    assert.equal((await listReminders()).length, 0);
    assert.equal((await listReminders({ includeCompleted: true })).length, 1);
  } finally {
    if (previous === undefined) delete process.env.CIE_DATA_DIR;
    else process.env.CIE_DATA_DIR = previous;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("rejects an invalid due date", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cie-reminders-"));
  const previous = process.env.CIE_DATA_DIR;
  process.env.CIE_DATA_DIR = dataDir;
  try {
    await assert.rejects(() => addReminder({ title: "Bad", dueAt: "not-a-date" }), /valid date/);
  } finally {
    if (previous === undefined) delete process.env.CIE_DATA_DIR;
    else process.env.CIE_DATA_DIR = previous;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
