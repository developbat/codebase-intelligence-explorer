import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { detectProjectProfile } from "./projectProfile";

test("uses a project virtualenv for Python test commands", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-profile-venv-"));
  try {
    await fs.mkdir(path.join(root, ".venv/bin"), { recursive: true });
    await fs.writeFile(path.join(root, ".venv/bin/python"), "", { mode: 0o755 });
    await fs.mkdir(path.join(root, "tests"), { recursive: true });
    await fs.writeFile(path.join(root, "tests/test_app.py"), "def test_ok():\n    assert True\n");
    const profile = await detectProjectProfile(root, [
      { path: "tests/test_app.py" },
    ]);
    assert.ok(
      profile.testCommands.includes("./.venv/bin/python -m pytest -q"),
      profile.testCommands.join(", "),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
