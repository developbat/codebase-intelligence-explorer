import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  findPythonInterpreter,
  planPythonEnvironment,
  projectPythonEnv,
  pythonEnvironmentStatus,
  pythonMinorPreferred,
  pythonMinorSupported,
  pythonVenvInfo,
} from "./pythonRuntime";

async function withTempProject(
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-python-"));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function writeFakePython(pythonPath: string, version: string): Promise<void> {
  if (process.platform === "win32") return;
  await fs.writeFile(
    pythonPath,
    `#!/bin/sh\nprintf '%s\\n' '{"v":"${version}","exe":"${pythonPath}"}'\n`,
    { mode: 0o755 },
  );
}

test("pythonMinorPreferred rejects unstable new interpreters", () => {
  assert.equal(pythonMinorPreferred(13), true);
  assert.equal(pythonMinorPreferred(12), true);
  assert.equal(pythonMinorPreferred(14), true);
  assert.equal(pythonMinorPreferred(15), false);
  assert.equal(pythonMinorSupported(15), true);
  assert.equal(pythonMinorSupported(8), false);
});

test("pythonVenvInfo finds .venv and exposes a root-relative command", async () => {
  await withTempProject(async (root) => {
    const bin = path.join(root, ".venv", "bin");
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, "python"), "", { mode: 0o755 });
    await fs.writeFile(
      path.join(root, ".venv", ".cie-python.json"),
      JSON.stringify({ version: "3.13.2" }),
    );
    const venv = await pythonVenvInfo(root);
    assert.ok(venv);
    assert.equal(venv.dir, ".venv");
    assert.match(venv.relativePython, /\.venv[/\\]bin[/\\]python$/u);
    assert.equal(venv.version, "3.13.2");
  });
});

test("projectPythonEnv puts the venv first on PATH", async () => {
  await withTempProject(async (root) => {
    const bin = path.join(root, ".venv", "bin");
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, "python"), "", { mode: 0o755 });

    const env = await projectPythonEnv(root);
    assert.equal(env.VIRTUAL_ENV, path.join(root, ".venv"));
    assert.ok(env.PATH?.startsWith(bin + path.delimiter));
    assert.equal(env.PIP_REQUIRE_VIRTUALENV, "1");
  });
});

test("planPythonEnvironment installs into an existing stable venv", async () => {
  if (process.platform === "win32") return;
  await withTempProject(async (root) => {
    const bin = path.join(root, ".venv", "bin");
    await fs.mkdir(bin, { recursive: true });
    await writeFakePython(path.join(bin, "python"), "3.13.2");
    await fs.writeFile(path.join(root, "requirements.txt"), "pandas>=2.1,<3\n");

    const plan = await planPythonEnvironment(root);
    assert.ok(plan);
    assert.equal(plan.createsVenv, false);
    assert.match(plan.command, /\.venv[/\\]bin[/\\]python -m pip install -r requirements\.txt/u);
    assert.doesNotMatch(plan.command, / --break-system-packages/u);
    assert.doesNotMatch(plan.command, /unstable/u);
  });
});

test("planPythonEnvironment rebuilds a Python 3.15 venv", async () => {
  if (process.platform === "win32") return;
  if (!(await findPythonInterpreter())) return;
  await withTempProject(async (root) => {
    const bin = path.join(root, ".venv", "bin");
    await fs.mkdir(bin, { recursive: true });
    await writeFakePython(path.join(bin, "python"), "3.15.2");
    await fs.writeFile(path.join(root, "requirements.txt"), "pandas>=2.1,<3\n");

    const plan = await planPythonEnvironment(root);
    assert.ok(plan);
    assert.equal(plan.createsVenv, true);
    assert.match(plan.command, /mv \.venv \.venv-unstable-/u);
    assert.match(plan.command, /-m venv \.venv/u);
  });
});

test("planPythonEnvironment ignores projects without requirements", async () => {
  await withTempProject(async (root) => {
    assert.equal(await planPythonEnvironment(root), null);
  });
});

test("pythonEnvironmentStatus reports a broken venv as unhealthy", async () => {
  await withTempProject(async (root) => {
    const bin = path.join(root, ".venv", "bin");
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, "python"), "not an interpreter\n");
    await fs.writeFile(path.join(root, "requirements.txt"), "pandas>=2.1,<3\n");

    const status = await pythonEnvironmentStatus(root);
    assert.deepEqual(status.requirements, ["requirements.txt"]);
    assert.equal(status.venv, ".venv");
    assert.equal(status.healthy, false);
    assert.equal(status.ready, false);
  });
});
