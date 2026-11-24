import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProjectCommand } from "./editor";
import { detectProjectProfile } from "./projectProfile";

interface VerifyCaseResult {
  id: string;
  pass: boolean;
  failures: string[];
  checks: string[];
  durationMs: number;
}

async function write(root: string, file: string, content: string): Promise<void> {
  const target = path.join(root, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

async function command(
  root: string,
  command: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; durationMs: number }> {
  return runProjectCommand(root, command, undefined, { timeoutMs: 120_000 });
}

async function clearPythonCache(root: string): Promise<void> {
  for (const dir of ["__pycache__", "tests/__pycache__"]) {
    await fs.rm(path.join(root, dir), { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runCase(
  id: string,
  test: (checks: string[], failures: string[]) => Promise<void>,
): Promise<VerifyCaseResult> {
  const started = Date.now();
  const checks: string[] = [];
  const failures: string[] = [];
  try {
    await test(checks, failures);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : "verify case failed");
  }
  return {
    id,
    pass: failures.length === 0,
    failures,
    checks,
    durationMs: Date.now() - started,
  };
}

async function pythonCase(checks: string[], failures: string[]): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-verify-python-"));
  try {
    await write(
      root,
      "app.py",
      "def add(a, b):\n    return a - b\n\n\nif __name__ == \"__main__\":\n    print(add(2, 3))\n",
    );
    await write(root, "tests/__init__.py", "");
    await write(
      root,
      "tests/test_app.py",
      "import unittest\nfrom app import add\n\n\nclass TestAdd(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n",
    );
    const profile = await detectProjectProfile(root, [
      { path: "app.py" },
      { path: "tests/test_app.py" },
    ]);
    const unittestCommand = profile.testCommands.find((item) => item.includes("unittest"));
    if (!unittestCommand) {
      failures.push(`Python unittest command not detected: ${profile.testCommands.join(", ")}`);
      return;
    }
    checks.push(`python profile: ${profile.testFramework} · ${unittestCommand}`);

    const failing = await command(root, unittestCommand);
    if (failing.exitCode === 0) failures.push("Python buggy code unexpectedly passed tests");
    else checks.push(`python test fails before fix (exit ${failing.exitCode})`);

    await write(
      root,
      "app.py",
      "def add(a, b):\n    return a + b\n\n\nif __name__ == \"__main__\":\n    print(add(2, 3))\n",
    );
    await clearPythonCache(root);
    const passing = await command(root, unittestCommand);
    if (passing.exitCode !== 0) {
      failures.push(
        `Python tests still fail after fix (exit ${passing.exitCode}): ${passing.stderr.slice(0, 500)}`,
      );
    } else {
      checks.push("python tests pass after fix");
    }
    const run = await command(root, "python3 app.py");
    if (run.exitCode !== 0 || run.stdout.trim() !== "5") {
      failures.push(`python run output: ${JSON.stringify(run.stdout.trim())} exit ${run.exitCode}`);
    } else {
      checks.push("python app runs and prints 5");
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function goCase(checks: string[], failures: string[]): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-verify-go-"));
  try {
    await write(root, "go.mod", "module example.com/cieverify\n\ngo 1.20\n");
    await write(
      root,
      "main.go",
      'package main\n\nimport "fmt"\n\nfunc Add(a, b int) int {\n\treturn a - b\n}\n\nfunc main() {\n\tfmt.Println(Add(2, 3))\n}\n',
    );
    await write(
      root,
      "main_test.go",
      'package main\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(2, 3) != 5 {\n\t\tt.Fatalf("got %d", Add(2, 3))\n\t}\n}\n',
    );
    const profile = await detectProjectProfile(root, [
      { path: "main.go" },
      { path: "main_test.go" },
    ]);
    const goTest = profile.testCommands.find((item) => item.includes("go test"));
    if (!goTest) {
      failures.push(`Go test command not detected: ${profile.testCommands.join(", ")}`);
      return;
    }
    checks.push(`go profile: ${profile.testFramework} · ${goTest}`);

    const failing = await command(root, goTest);
    if (failing.exitCode === 0) failures.push("Go buggy code unexpectedly passed tests");
    else checks.push(`go test fails before fix (exit ${failing.exitCode})`);

    await write(
      root,
      "main.go",
      'package main\n\nimport "fmt"\n\nfunc Add(a, b int) int {\n\treturn a + b\n}\n\nfunc main() {\n\tfmt.Println(Add(2, 3))\n}\n',
    );
    const passing = await command(root, goTest);
    if (passing.exitCode !== 0) {
      failures.push(`Go tests still fail after fix (exit ${passing.exitCode}): ${passing.stderr.slice(0, 500)}`);
    } else {
      checks.push("go tests pass after fix");
    }
    const run = await command(root, "go run .");
    if (run.exitCode !== 0 || run.stdout.trim() !== "5") {
      failures.push(`go run output: ${JSON.stringify(run.stdout.trim())} exit ${run.exitCode}`);
    } else {
      checks.push("go app runs and prints 5");
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function nodeCase(checks: string[], failures: string[]): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-verify-node-"));
  try {
    await write(
      root,
      "package.json",
      JSON.stringify({ name: "cie-verify-node", private: true, scripts: { test: "node --test" } }, null, 2),
    );
    await write(
      root,
      "app.js",
      "function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\nif (require.main === module) console.log(add(2, 3));\n",
    );
    await write(
      root,
      "app.test.js",
      "const test = require('node:test');\nconst assert = require('node:assert');\nconst { add } = require('./app');\ntest('add', () => assert.equal(add(2, 3), 5));\n",
    );
    const profile = await detectProjectProfile(root, [
      { path: "app.js" },
      { path: "app.test.js" },
    ]);
    const npmTest = profile.testCommands.find((item) => item.includes("npm"));
    if (!npmTest) {
      failures.push(`Node test command not detected: ${profile.testCommands.join(", ")}`);
      return;
    }
    checks.push(`node profile: ${profile.testFramework} · ${npmTest}`);

    const failing = await command(root, npmTest);
    if (failing.exitCode === 0) failures.push("Node buggy code unexpectedly passed tests");
    else checks.push(`npm test fails before fix (exit ${failing.exitCode})`);

    await write(
      root,
      "app.js",
      "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\nif (require.main === module) console.log(add(2, 3));\n",
    );
    const passing = await command(root, npmTest);
    if (passing.exitCode !== 0) {
      failures.push(`Node tests still fail after fix (exit ${passing.exitCode}): ${passing.stderr.slice(0, 500)}`);
    } else {
      checks.push("npm test passes after fix");
    }
    const run = await command(root, "node app.js");
    if (run.exitCode !== 0 || run.stdout.trim() !== "5") {
      failures.push(`node run output: ${JSON.stringify(run.stdout.trim())} exit ${run.exitCode}`);
    } else {
      checks.push("node app runs and prints 5");
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const results = [
    await runCase("python-unittest", pythonCase),
    await runCase("go-test", goCase),
    await runCase("node-test", nodeCase),
  ];
  const passed = results.filter((result) => result.pass).length;
  for (const result of results) {
    console.log(`${result.pass ? "PASS" : "FAIL"} [verify] ${result.id} · ${result.durationMs} ms`);
    for (const check of result.checks) console.log(`   · ${check}`);
    for (const failure of result.failures) console.log(`   - ${failure}`);
  }
  console.log(`\n${passed}/${results.length} verification cases passed`);

  const reportsDir = path.resolve("fixtures", "agent-eval", "reports");
  await fs.mkdir(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(reportsDir, `verify-${stamp}.json`);
  await fs.writeFile(
    reportPath,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        passed,
        total: results.length,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`Report: ${reportPath}`);
  process.exitCode = passed === results.length ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
