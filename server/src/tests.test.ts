import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AnalysisResult } from "../../shared/types";
import { discoverTests, runTests } from "./tests";

test("test discovery and runner parse pass/fail summaries and failures", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-tests-"));
  try {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(
      path.join(root, "test-output.sh"),
      "printf 'Tests  2 failed | 3 passed (5)\\n'\nprintf 'FAIL  src/math.test.ts > adds numbers\\n'\nprintf '  AssertionError: expected 4 to be 3\\n'\n",
    );

    const analysis = {
      rootPath: root,
      files: [{ path: "src/math.test.ts" }],
      frameworks: ["Vitest"],
      languages: { typescript: 1 },
    } as unknown as AnalysisResult;

    const discovery = await discoverTests(analysis);
    assert.equal(discovery.framework, "Vitest");
    assert.equal(discovery.testFileCount, 1);
    assert.ok(discovery.commands.includes("npx vitest run"));

    const result = await runTests(analysis, "sh test-output.sh");
    assert.equal(result.summary.passed, 3);
    assert.equal(result.summary.failed, 2);
    assert.equal(result.summary.total, 5);
    assert.equal(result.parsed, true);
    assert.equal(result.failures[0]?.file, "src/math.test.ts");
    assert.ok(result.failures[0]?.name.includes("adds numbers"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("test discovery detects Go, Cargo, Maven, Gradle, dotnet, Ruby and Swift projects", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-detect-"));
  try {
    const scenarios: { manifest: string; manifestContent: string; file: string; framework: string; command: string }[] = [
      { manifest: "go.mod", manifestContent: "module example.com/app\n", file: "pkg/math_test.go", framework: "Go test", command: "go test ./..." },
      { manifest: "Cargo.toml", manifestContent: "[package]\nname=\"app\"\n", file: "tests/integration.rs", framework: "Cargo test", command: "cargo test" },
      { manifest: "pom.xml", manifestContent: "<project/>\n", file: "src/test/java/AppTest.java", framework: "Maven", command: "mvn test" },
      { manifest: "build.gradle", manifestContent: "plugins {}\n", file: "src/test/java/AppTest.java", framework: "Gradle", command: "gradle test" },
      { manifest: "App.csproj", manifestContent: "<Project/>\n", file: "Tests/AppTests.cs", framework: "dotnet test", command: "dotnet test" },
      { manifest: "Gemfile", manifestContent: "source 'https://rubygems.org'\n", file: "spec/app_spec.rb", framework: "RSpec", command: "bundle exec rspec" },
      { manifest: "Package.swift", manifestContent: "// swift-tools-version:5.9\n", file: "Tests/AppTests.swift", framework: "Swift test", command: "swift test" },
    ];
    for (const scenario of scenarios) {
      await fs.rm(path.join(root, "go.mod"), { force: true });
      await fs.rm(path.join(root, "Cargo.toml"), { force: true });
      await fs.rm(path.join(root, "pom.xml"), { force: true });
      await fs.rm(path.join(root, "build.gradle"), { force: true });
      await fs.rm(path.join(root, "App.csproj"), { force: true });
      await fs.rm(path.join(root, "Gemfile"), { force: true });
      await fs.rm(path.join(root, "Package.swift"), { force: true });
      await fs.rm(path.join(root, "pkg"), { recursive: true, force: true });
      await fs.rm(path.join(root, "tests"), { recursive: true, force: true });
      await fs.rm(path.join(root, "src"), { recursive: true, force: true });
      await fs.rm(path.join(root, "Tests"), { recursive: true, force: true });
      await fs.rm(path.join(root, "spec"), { recursive: true, force: true });

      await fs.writeFile(path.join(root, scenario.manifest), scenario.manifestContent);
      await fs.mkdir(path.dirname(path.join(root, scenario.file)), { recursive: true });
      await fs.writeFile(path.join(root, scenario.file), "");
      if (scenario.framework === "RSpec") await fs.writeFile(path.join(root, "Rakefile"), "");

      const analysis = {
        rootPath: root,
        files: [{ path: scenario.file }],
        frameworks: [],
        languages: { other: 1 },
      } as unknown as AnalysisResult;

      const discovery = await discoverTests(analysis);
      assert.equal(discovery.framework, scenario.framework, scenario.framework);
      assert.ok(discovery.commands.includes(scenario.command), `${scenario.framework}: ${discovery.commands.join(" | ")}`);
      assert.equal(discovery.hasTests, true);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Go, Cargo, dotnet, Maven, RSpec and Dart outputs are parsed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-parsers-"));
  try {
    const run = async (name: string, script: string, trigger: string, files: string[]) => {
      await fs.writeFile(path.join(root, `${name}.sh`), script);
      const analysis = {
        rootPath: root,
        files: files.map((file) => ({ path: file })),
        frameworks: [],
        languages: { other: 1 },
      } as unknown as AnalysisResult;
      return runTests(analysis, `sh ${name}.sh # ${trigger}`);
    };

    const go = await run(
      "go",
      "printf -- '--- PASS: TestAdd (0.00s)\\n--- FAIL: TestSub (0.01s)\\n    math_test.go:12: got 3\\nFAIL\\n'",
      "go test",
      ["pkg/math_test.go"],
    );
    assert.equal(go.summary.passed, 1);
    assert.equal(go.summary.failed, 1);
    assert.equal(go.failures[0]?.file, "math_test.go");

    const cargo = await run(
      "cargo",
      "printf 'test result: ok. 3 passed; 1 failed; 0 ignored\\ntest sub ... FAILED\\n'",
      "cargo test",
      ["tests/integration.rs"],
    );
    assert.equal(cargo.summary.passed, 3);
    assert.equal(cargo.summary.failed, 1);
    assert.equal(cargo.summary.total, 4);

    const dotnet = await run(
      "dotnet",
      "printf 'Failed!  - Failed:     1, Passed:     2, Skipped:     0, Total:     3\\nFailed Sub.Tests.Add [12 ms]\\n'",
      "dotnet test",
      ["Tests/AppTests.cs"],
    );
    assert.equal(dotnet.summary.passed, 2);
    assert.equal(dotnet.summary.failed, 1);
    assert.equal(dotnet.summary.total, 3);

    const maven = await run(
      "maven",
      "printf 'Tests run: 4, Failures: 1, Errors: 0, Skipped: 0\\n'",
      "mvn test",
      ["src/test/java/AppTest.java"],
    );
    assert.equal(maven.summary.passed, 3);
    assert.equal(maven.summary.failed, 1);

    const rspec = await run(
      "rspec",
      "printf '2 examples, 1 failure\\nrspec ./spec/app_spec.rb:5 # App fails\\n'",
      "rspec",
      ["spec/app_spec.rb"],
    );
    assert.equal(rspec.summary.total, 2);
    assert.equal(rspec.summary.failed, 1);
    assert.equal(rspec.failures[0]?.file, "spec/app_spec.rb");

    const dart = await run(
      "dart",
      "printf '+3 -1: Some tests failed.\\n'",
      "dart test",
      ["test/app_test.dart"],
    );
    assert.equal(dart.summary.passed, 3);
    assert.equal(dart.summary.failed, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("test discovery covers Haskell, OCaml, Perl, Julia, Erlang, Clojure, Crystal, Nim, Zig, Solidity, Lua, R, PowerShell, Bats, Deno, Bazel and F#", async () => {
  const scenarios: {
    files: string[];
    manifests?: Record<string, string>;
    framework: string;
    command: string;
  }[] = [
    { files: ["test/Spec.hs"], manifests: { "app.cabal": "name: app\n" }, framework: "Cabal test", command: "cabal test" },
    { files: ["test/test_app.ml"], manifests: { "dune-project": "(lang dune 3.0)\n" }, framework: "Dune", command: "dune test" },
    { files: ["t/basic.t"], manifests: { cpanfile: "requires 'Test::More';\n" }, framework: "prove", command: "prove -lr t" },
    { files: ["test/runtests.jl"], manifests: { "Project.toml": "[deps]\n" }, framework: "Julia Test", command: "julia --project=. -e 'using Pkg; Pkg.test()'" },
    { files: ["test/app_tests.erl"], manifests: { "rebar.config": "{erl_opts, []}.\n" }, framework: "EUnit", command: "rebar3 eunit" },
    { files: ["test/app_test.clj"], manifests: { "deps.edn": "{}\n" }, framework: "Clojure test", command: "clojure -X:test" },
    { files: ["spec/app_spec.cr"], manifests: { "shard.yml": "name: app\n" }, framework: "Crystal spec", command: "crystal spec" },
    { files: ["tests/app_test.nim"], manifests: { "app.nimble": "version = \"0.1.0\"\n" }, framework: "Nimble test", command: "nimble test" },
    { files: ["test/app_test.zig"], manifests: { "build.zig": "// build\n" }, framework: "Zig test", command: "zig build test" },
    { files: ["test/App.t.sol"], manifests: { "foundry.toml": "[profile.default]\n" }, framework: "Forge test", command: "forge test" },
    { files: ["spec/app_spec.lua"], manifests: { ".busted": "return {}\n" }, framework: "Busted", command: "busted" },
    { files: ["tests/testthat/test-app.R"], manifests: { DESCRIPTION: "Package: app\n" }, framework: "testthat", command: "Rscript -e 'testthat::test_dir(\"tests/testthat\")'" },
    { files: ["tests/App.Tests.ps1"], framework: "Pester", command: "Invoke-Pester" },
    { files: ["tests/app.bats"], framework: "Bats", command: "bats tests" },
    { files: ["test/app_test.ts"], manifests: { "deno.json": "{}\n" }, framework: "Deno test", command: "deno test" },
    { files: ["test/app_test.ts"], manifests: { "MODULE.bazel": "" }, framework: "Bazel test", command: "bazel test //..." },
    { files: ["Tests/AppTests.fs"], manifests: { "App.fsproj": "<Project/>\n" }, framework: "dotnet test", command: "dotnet test" },
    { files: ["src/app.js"], manifests: { Makefile: ".PHONY: test\ntest:\n\t@echo ok\n" }, framework: "Make", command: "make test" },
  ];

  for (const scenario of scenarios) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-detect2-"));
    try {
      for (const [name, content] of Object.entries(scenario.manifests ?? {})) {
        await fs.writeFile(path.join(root, name), content);
      }
      for (const file of scenario.files) {
        await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await fs.writeFile(path.join(root, file), "");
      }
      const analysis = {
        rootPath: root,
        files: scenario.files.map((file) => ({ path: file })),
        frameworks: [],
        languages: {},
      } as unknown as AnalysisResult;
      const discovery = await discoverTests(analysis);
      assert.equal(discovery.framework, scenario.framework, scenario.files.join(", "));
      assert.ok(discovery.commands.includes(scenario.command), `${scenario.framework} should include ${scenario.command}`);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});
