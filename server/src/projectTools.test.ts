import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runProjectCommand } from "./editor";
import {
  createProjectTool,
  findProjectTool,
  listProjectTools,
  recordProjectToolRun,
  validateProjectToolInput,
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
    const created = await createProjectTool(root, {
      name: "typed-check",
      description: "Checks a URL.",
      whenToUse: "Use before shipping a page.",
      inputSchema: {
        type: "object",
        required: ["url"],
        properties: { url: { type: "string" } },
      },
      timeoutMs: 45_000,
      language: "js",
      code: "console.log(process.env.CIE_TOOL_INPUT || '{}')",
    });
    assert.equal(created.whenToUse, "Use before shipping a page.");
    assert.equal(created.timeoutMs, 45_000);
    assert.equal(validateProjectToolInput(created, {}), 'Project tool "typed-check" requires input.url.');
    assert.equal(validateProjectToolInput(created, { url: 3 }), 'Project tool "typed-check" input.url must be string, got number.');
    assert.equal(validateProjectToolInput(created, { url: "https://example.com" }), null);
    const reloaded = await findProjectTool(root, "typed-check");
    assert.equal(reloaded?.inputSchema?.required?.[0], "url");

    await fs.writeFile(
      path.join(root, "echo-input.js"),
      "process.stdout.write(process.env.CIE_TOOL_INPUT || '');\n",
      "utf8",
    );
    const envResult = await runProjectCommand(root, "node echo-input.js", undefined, {
      env: { CIE_TOOL_INPUT: '{"url":"https://example.com"}' },
    });
    assert.equal(envResult.exitCode, 0);
    assert.match(envResult.stdout, /example\.com/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
