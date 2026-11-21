import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  findProjectTool,
  listProjectTools,
  recordProjectToolRun,
} from "./projectTools";

test("auto-registers reusable scripts under .cie/agent/tools", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-tools-"));
  try {
    const toolsDir = path.join(root, ".cie", "agent", "tools");
    await fs.mkdir(toolsDir, { recursive: true });
    await fs.writeFile(path.join(toolsDir, "ui-check.js"), "console.log('ok')\\n");
    await fs.writeFile(path.join(toolsDir, "smoke.py"), "print('ok')\\n");
    await fs.writeFile(path.join(toolsDir, "ignore.txt"), "not a script\\n");

    const list = await listProjectTools(root);
    assert.equal(list.tools.length, 2);
    const uiCheck = list.tools.find((tool) => tool.name === "ui-check");
    assert.ok(uiCheck);
    assert.equal(uiCheck.command, "node '.cie/agent/tools/ui-check.js'");
    assert.equal(uiCheck.source, "auto");
    assert.equal(list.tools.find((tool) => tool.name === "smoke")?.command, "python3 '.cie/agent/tools/smoke.py'");

    await recordProjectToolRun(root, "ui-check", true);
    await recordProjectToolRun(root, "ui-check", false);
    const updated = await findProjectTool(root, "ui-check");
    assert.equal(updated?.successCount, 1);
    assert.equal(updated?.failureCount, 1);
    assert.ok(updated?.lastRunAt);

    const registry = JSON.parse(
      await fs.readFile(path.join(root, ".cie", "agent", "tools.json"), "utf8"),
    ) as { tools: { name: string }[] };
    assert.deepEqual(registry.tools.map((tool) => tool.name).sort(), ["smoke", "ui-check"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
