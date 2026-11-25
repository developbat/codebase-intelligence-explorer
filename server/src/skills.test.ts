import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getSkill,
  listSkills,
  loadEnabledSkills,
  loadSkillForRun,
  loadSkillsForPrompt,
  renderSkillIndex,
  readSkillFile,
  runSkillScript,
  renderSkillsForPrompt,
  setSkillEnabled,
  type EnabledSkill,
} from "./skills";
import type { SkillRecord } from "../../shared/skills";

async function roots(): Promise<{ project: string; dataDir: string; homeDir: string; cleanup: string }> {
  const cleanup = await fs.mkdtemp(path.join(os.tmpdir(), "cie-skills-"));
  const project = path.join(cleanup, "project");
  const dataDir = path.join(cleanup, "data");
  const homeDir = path.join(cleanup, "home");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(homeDir, { recursive: true });
  return { project, dataDir, homeDir, cleanup };
}

async function writeSkill(
  skillsRoot: string,
  directory: string,
  frontmatter: string,
  body: string,
): Promise<string> {
  const skillDir = path.join(skillsRoot, directory);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`, "utf8");
  return skillDir;
}

test("discovers project, global and external skills with metadata", async () => {
  const { project, dataDir, homeDir, cleanup } = await roots();
  try {
    const reviewDir = await writeSkill(
      path.join(project, ".cie", "skills"),
      "ui-review",
      "name: UI Review\ndescription: Reviews spacing and contrast.\nallowed-tools: Read, Grep",
      "# UI Review\nCheck contrast and spacing.",
    );
    await fs.mkdir(path.join(reviewDir, "references"), { recursive: true });
    await fs.writeFile(path.join(reviewDir, "references", "checklist.md"), "- contrast\n- spacing\n");
    await fs.mkdir(path.join(reviewDir, "scripts"), { recursive: true });
    await fs.writeFile(path.join(reviewDir, "scripts", "check.sh"), "echo check\n");

    await writeSkill(
      path.join(project, ".agents", "skills"),
      "no-description",
      "name: No Description",
      "This skill has no description.",
    );
    await writeSkill(
      path.join(dataDir, "skills"),
      "global-skill",
      "name: Global Skill\ndescription: Available to every project.",
      "Global instructions.",
    );
    await writeSkill(
      path.join(homeDir, ".claude", "skills"),
      "external-skill",
      "name: External Skill\ndescription: Discovered from Claude.",
      "External instructions.",
    );

    const result = await listSkills(project, "project-1", { dataDir, homeDir });
    assert.equal(result.skills.length, 4);
    const review = result.skills.find((skill) => skill.name === "UI Review");
    assert.ok(review);
    assert.equal(review.scope, "project");
    assert.equal(review.enabled, true);
    assert.equal(review.hasScripts, true);
    assert.equal(review.hasReferences, true);
    assert.equal(review.allowedTools, "Read, Grep");
    assert.ok(review.files.some((file) => file.path === "references/checklist.md"));
    assert.equal(review.files.filter((file) => file.path === "SKILL.md").length, 1);
    assert.ok(review.bytes > 0);

    const missing = result.skills.find((skill) => skill.name === "No Description");
    assert.match(missing?.warning ?? "", /no description/i);
    assert.equal(result.sources.find((source) => source.id === "project-cie")?.skillCount, 1);
    assert.equal(result.enabledCount, 4);
  } finally {
    await fs.rm(cleanup, { recursive: true, force: true });
  }
});

test("enable state is persisted per project", async () => {
  const { project, dataDir, homeDir, cleanup } = await roots();
  try {
    await writeSkill(
      path.join(project, ".cie", "skills"),
      "writer",
      "name: Writer\ndescription: Writes release notes.",
      "# Writer\nUse short sentences.",
    );
    const before = await listSkills(project, "project-a", { dataDir, homeDir });
    const key = before.skills[0]?.key;
    assert.ok(key);
    const updated = await setSkillEnabled(project, "project-a", key, true, { dataDir, homeDir });
    assert.equal(updated.enabled, true);

    const after = await listSkills(project, "project-a", { dataDir, homeDir });
    assert.equal(after.skills[0]?.enabled, true);
    assert.equal(after.enabledCount, 1);
    const otherProject = await listSkills(project, "project-b", { dataDir, homeDir });
    assert.equal(otherProject.skills[0]?.enabled, true);

    await setSkillEnabled(project, "project-b", otherProject.skills[0].key, false, { dataDir, homeDir });
    const disabledProject = await listSkills(project, "project-b", { dataDir, homeDir });
    assert.equal(disabledProject.skills[0]?.enabled, false);

    const enabled = await loadEnabledSkills(project, "project-a", { dataDir, homeDir });
    assert.equal(enabled.length, 1);
    assert.match(enabled[0].content, /short sentences/i);
    const prompt = renderSkillsForPrompt(enabled);
    assert.match(prompt, /Available skills/);
    assert.match(prompt, /user instructions always override/i);
    assert.match(prompt, /<skill name="Writer"/);
  } finally {
    await fs.rm(cleanup, { recursive: true, force: true });
  }
});

test("project skills win when names collide during injection", async () => {
  const { project, dataDir, homeDir, cleanup } = await roots();
  try {
    await writeSkill(
      path.join(project, ".cie", "skills"),
      "shared",
      "name: Shared\ndescription: Project copy.",
      "PROJECT COPY",
    );
    await writeSkill(
      path.join(dataDir, "skills"),
      "shared",
      "name: Shared\ndescription: Global copy.",
      "GLOBAL COPY",
    );
    const result = await listSkills(project, "project-c", { dataDir, homeDir });
    for (const skill of result.skills) {
      await setSkillEnabled(project, "project-c", skill.key, true, { dataDir, homeDir });
    }
    const enabled = await loadEnabledSkills(project, "project-c", { dataDir, homeDir });
    assert.equal(enabled.length, 1);
    assert.equal(enabled[0].record.scope, "project");
    assert.match(enabled[0].content, /PROJECT COPY/);
  } finally {
    await fs.rm(cleanup, { recursive: true, force: true });
  }
});

test("skill file previews are confined to the skill directory", async () => {
  const { project, dataDir, homeDir, cleanup } = await roots();
  try {
    const skillDir = await writeSkill(
      path.join(project, ".cie", "skills"),
      "safe",
      "name: Safe\ndescription: Safe preview.",
      "Body",
    );
    await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "references", "notes.md"), "safe notes");
    await fs.writeFile(path.join(project, "secret.txt"), "TOP SECRET");
    const key = (await listSkills(project, "project-d", { dataDir, homeDir })).skills[0].key;

    const file = await readSkillFile(project, "project-d", key, "references/notes.md", {
      dataDir,
      homeDir,
    });
    assert.equal(file.content, "safe notes");
    await assert.rejects(
      () => readSkillFile(project, "project-d", key, "../secret.txt", { dataDir, homeDir }),
      /outside the skill folder/i,
    );
    await assert.rejects(
      () => readSkillFile(project, "project-d", key, "references/../../../secret.txt", {
        dataDir,
        homeDir,
      }),
      /outside the skill folder/i,
    );
    const detail = await getSkill(project, "project-d", key, { dataDir, homeDir });
    assert.match(detail.content, /---/);
    assert.equal(detail.body, "Body");
  } finally {
    await fs.rm(cleanup, { recursive: true, force: true });
  }
});

test("@skill mention loads a disabled skill for that run only", async () => {
  const { project, dataDir, homeDir, cleanup } = await roots();
  try {
    await writeSkill(
      path.join(project, ".cie", "skills"),
      "code-review",
      "name: Code Review\ndescription: Reviews a diff.",
      "CHECK THE DIFF",
    );
    const result = await loadSkillsForPrompt(
      project,
      "project-mention",
      "Please @code-review this change",
      { dataDir, homeDir },
    );
    assert.deepEqual(result.mentions, ["Code Review"]);
    assert.equal(result.skills.length, 1);
    assert.match(result.skills[0].content, /CHECK THE DIFF/);
    const plain = await loadSkillsForPrompt(project, "project-mention", "normal question", {
      dataDir,
      homeDir,
    });
    assert.equal(plain.mentions.length, 0);
    assert.equal(plain.skills.length, 1);
    assert.match(plain.index, /project:project-cie:code-review/);
  } finally {
    await fs.rm(cleanup, { recursive: true, force: true });
  }
});

test("capability index lists enabled skills and loads their text on demand", async () => {
  const { project, dataDir, homeDir, cleanup } = await roots();
  try {
    await writeSkill(
      path.join(project, ".cie", "skills"),
      "code-review",
      "name: Code Review\ndescription: Reviews a diff.",
      "CHECK THE DIFF",
    );
    const result = await listSkills(project, "capability", { dataDir, homeDir });
    const index = renderSkillIndex(result.skills);
    assert.match(index, /Capability index/);
    assert.match(index, /Code Review/);
    assert.match(index, /load_skill/);
    const loaded = await loadSkillForRun(project, "capability", result.skills[0].key, {
      dataDir,
      homeDir,
    });
    assert.match(loaded.content, /CHECK THE DIFF/);
    await setSkillEnabled(project, "capability", result.skills[0].key, false, { dataDir, homeDir });
    await assert.rejects(
      () => loadSkillForRun(project, "capability", result.skills[0].key, { dataDir, homeDir }),
      /disabled/i,
    );
  } finally {
    await fs.rm(cleanup, { recursive: true, force: true });
  }
});

test("skill scripts run only from listed script files", async () => {
  const { project, dataDir, homeDir, cleanup } = await roots();
  try {
    const skillDir = await writeSkill(
      path.join(project, ".cie", "skills"),
      "scripted",
      "name: Scripted\ndescription: Has a script.",
      "Use the script.",
    );
    await fs.mkdir(path.join(skillDir, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "scripts", "hello.py"),
      'print("script-ok")\n',
      "utf8",
    );
    await fs.writeFile(path.join(project, "secret.py"), 'print("secret")\n', "utf8");
    const key = (await listSkills(project, "project-script", { dataDir, homeDir })).skills[0].key;
    const result = await runSkillScript(
      project,
      "project-script",
      key,
      "scripts/hello.py",
      [],
      { dataDir, homeDir },
    );
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /script-ok/);
    await assert.rejects(
      () => runSkillScript(project, "project-script", key, "../secret.py", [], { dataDir, homeDir }),
      /only script files|outside/i,
    );
    await assert.rejects(
      () => runSkillScript(project, "project-script", key, "SKILL.md", [], { dataDir, homeDir }),
      /only script files/i,
    );
  } finally {
    await fs.rm(cleanup, { recursive: true, force: true });
  }
});

test("prompt rendering enforces skill count and character limits", () => {
  const records: EnabledSkill[] = [];
  for (let index = 0; index < 7; index += 1) {
    const record: SkillRecord = {
      key: `project:test:${index}`,
      name: `Skill ${index}`,
      description: "",
      scope: "project",
      source: "test",
      sourceLabel: "Test",
      directory: "/tmp",
      enabled: true,
      hasScripts: false,
      hasReferences: false,
      files: [],
      bytes: 0,
      updatedAt: new Date(0).toISOString(),
    };
    records.push({ record, content: `CONTENT-${index}-` + "x".repeat(9_000) });
  }
  const prompt = renderSkillsForPrompt(records);
  assert.match(prompt, /Skill 0/);
  assert.match(prompt, /\[skill content truncated\]/);
  assert.doesNotMatch(prompt, /Skill 5/);
  assert.ok(prompt.length < 21_500, `prompt too large: ${prompt.length}`);
});

test("auto-matches a relevant skill from the request text", async () => {
  const { project, dataDir, homeDir, cleanup } = await roots();
  try {
    await writeSkill(
      path.join(project, ".cie", "skills"),
      "ui-review",
      "name: Runtime UI Debugging\ndescription: Diagnose invisible icons, HUD contrast and layout.",
      "CHECK UI",
    );
    const result = await loadSkillsForPrompt(
      project,
      "project-auto",
      "HUD ikonları görünmez, kontrast ve hizalama bozuk",
      { dataDir, homeDir },
    );
    assert.ok(result.relevant.includes("Runtime UI Debugging"));
    assert.ok(result.skills.some((skill) => skill.record.name === "Runtime UI Debugging"));
  } finally {
    await fs.rm(cleanup, { recursive: true, force: true });
  }
});
