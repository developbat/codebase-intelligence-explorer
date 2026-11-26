import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import { listSkills, readSkillFile, setSkillEnabled } from "./skills";
import {
  installSkills,
  parseTarGz,
  previewSkillSource,
  removeInstalledSkill,
  updateInstalledSkill,
} from "./skillInstall";

async function writeSkill(root: string, name: string, description: string, note: string) {
  await fs.mkdir(path.join(root, name), { recursive: true });
  await fs.writeFile(
    path.join(root, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${note}\n`,
  );
  await fs.writeFile(path.join(root, name, "notes.md"), note);
}

function tarHeader(name: string, size: number, type = "0"): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, "utf8");
  header.write("0000644", 100, 8, "ascii");
  header.write("0000000", 108, 8, "ascii");
  header.write("0000000", 116, 8, "ascii");
  header.write(size.toString(8).padStart(11, "0"), 124, 12, "ascii");
  header.write("00000000000", 136, 12, "ascii");
  header.write("        ", 148, 8, "ascii");
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return header;
}

function tarEntry(name: string, content: string, type = "0"): Buffer[] {
  const body = Buffer.from(content, "utf8");
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512, 0);
  body.copy(padded);
  return [tarHeader(name, body.length, type), padded];
}

test("GitHub-style tar archives parse skill files and pax long paths", () => {
  const entries = [
    ...tarEntry("pax_global_header", "52 comment=abc\n", "g"),
    ...tarEntry("repo-main/", "", "5"),
    ...tarEntry("repo-main/demo/SKILL.md", "---\nname: demo\n---\nbody\n"),
    ...tarEntry("pax", "path=repo-main/demo/" + "nested/".repeat(20) + "deep.md\n", "x"),
    ...tarEntry("repo-main/demo/truncated", "deep content\n"),
  ];
  const archive = zlib.gzipSync(Buffer.concat([...entries, Buffer.alloc(1024, 0)]));
  const files = parseTarGz(archive);
  assert.ok(files.has("repo-main/demo/SKILL.md"));
  const deep = [...files.keys()].find((name) => name.endsWith("deep.md"));
  assert.ok(deep, "pax long path should be preserved");
  assert.equal(files.get(deep!)?.toString("utf8"), "deep content\n");
});

test("installs a reviewed skill as disabled when enable is false", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cie-skills-off-"));
  const source = path.join(base, "source");
  const project = path.join(base, "project");
  const dataDir = path.join(base, "data");
  await fs.mkdir(project, { recursive: true });
  await writeSkill(source, "gamma", "Gamma helper", "Gamma body");
  try {
    const preview = await previewSkillSource(source);
    const gamma = preview.candidates.find((candidate) => candidate.name === "gamma");
    assert.ok(gamma);
    const installed = await installSkills(
      project,
      "project-off",
      { source, skills: [gamma.id], scope: "project", enable: false },
      { dataDir },
    );
    assert.equal(installed.installed[0]?.enabled, false);
    const listed = await listSkills(project, "project-off", { dataDir });
    assert.equal(
      listed.skills.find((skill) => skill.key === installed.installed[0]?.key)?.enabled,
      false,
    );
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("previews, installs, updates and removes a local skill pack", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cie-skills-"));
  const source = path.join(base, "source");
  const project = path.join(base, "project");
  const dataDir = path.join(base, "data");
  await fs.mkdir(project, { recursive: true });
  await writeSkill(source, "alpha", "Alpha helper", "Alpha body");
  await writeSkill(source, "beta", "Beta helper", "Beta body");
  try {
    const preview = await previewSkillSource(source);
    assert.equal(preview.candidates.length, 2);
    const alpha = preview.candidates.find((candidate) => candidate.name === "alpha");
    assert.ok(alpha);
    assert.equal(alpha.files.length, 2);

    const installed = await installSkills(
      project,
      "project-1",
      {
        source,
        skills: [alpha.id],
        scope: "project",
        enable: true,
      },
      { dataDir },
    );
    assert.equal(installed.installed.length, 1);
    const key = installed.installed[0].key;
    assert.equal(installed.installed[0].enabled, true);

    const listed = await listSkills(project, "project-1", { dataDir });
    const record = listed.skills.find((skill) => skill.key === key);
    assert.ok(record);
    assert.equal(record.enabled, true);
    assert.equal(record.name, "alpha");

    const file = await readSkillFile(project, "project-1", key, "notes.md", { dataDir });
    assert.match(file.content, /Alpha body/);

    await fs.writeFile(path.join(source, "alpha", "notes.md"), "Alpha body v2");
    const updated = await updateInstalledSkill(project, "project-1", key, { dataDir });
    assert.equal(updated.enabled, true);
    const refreshed = await readSkillFile(project, "project-1", key, "notes.md", { dataDir });
    assert.match(refreshed.content, /Alpha body v2/);

    await setSkillEnabled(project, "project-1", key, false, { dataDir });
    const disabled = await listSkills(project, "project-1", { dataDir });
    assert.equal(disabled.skills.find((skill) => skill.key === key)?.enabled, false);

    await removeInstalledSkill(project, "project-1", key, { dataDir });
    const afterRemove = await listSkills(project, "project-1", { dataDir });
    assert.equal(afterRemove.skills.some((skill) => skill.key === key), false);
    await assert.rejects(
      () => removeInstalledSkill(project, "project-1", key, { dataDir }),
      /not a managed installed skill/i,
    );
    await assert.rejects(
      () => updateInstalledSkill(project, "project-1", "project:project-agents:alpha", { dataDir }),
      /read-only/i,
    );
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
