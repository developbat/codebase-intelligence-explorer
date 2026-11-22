import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProjectTool, findProjectTool, listProjectTools } from "./projectTools";
import { createSkill } from "./skillInstall";
import { listSkills } from "./skills";

test("agent-created project tools are registered and discoverable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-tools-"));
  try {
    const tool = await createProjectTool(root, {
      name: "Check Links",
      language: "js",
      description: "Validate markdown links",
      code: "console.log('links ok');",
    });
    assert.equal(tool.name, "check-links");
    assert.equal(tool.path, ".cie/agent/tools/check-links.js");
    assert.match(tool.command, /check-links\.js/);
    const listed = await listProjectTools(root);
    assert.ok(listed.tools.some((item) => item.name === "check-links"));
    const found = await findProjectTool(root, "check-links");
    assert.equal(found?.description, "Validate markdown links");

    await fs.mkdir(path.join(root, ".cie", "agent", "tools"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".cie", "agent", "tools", "link-audit.sh"),
      "#!/bin/bash\n# link-audit: Find markdown links recursively.\n# Usage: bash link-audit.sh\necho ok\n",
    );
    const synced = await listProjectTools(root);
    const audit = synced.tools.find((item) => item.name === "link-audit");
    assert.equal(audit?.description, "Find markdown links recursively.");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("agent-created skills are written and enabled for the project", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-skill-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cie-skill-data-"));
  try {
    const skill = await createSkill(
      root,
      "project-1",
      {
        name: "Release checklist",
        description: "Use before releasing a static app",
        body: "1. Run tests.\n2. Check the preview.\n3. Commit.",
        enable: true,
      },
      { dataDir },
    );
    assert.equal(skill.enabled, true);
    assert.equal(skill.path, ".cie/skills/release-checklist/SKILL.md");
    const listed = await listSkills(root, "project-1", { dataDir });
    const record = listed.skills.find((item) => item.key === skill.key);
    assert.ok(record);
    assert.equal(record.enabled, true);
    assert.match(record.description, /before releasing/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
