import fs from "node:fs/promises";
import path from "node:path";
import type { ProjectTooling } from "../../shared/types";

interface ProjectFile {
  path: string;
}

function testFilesFor(files: ProjectFile[]): string[] {
  return files
    .map((file) => file.path)
    .filter((filePath) => {
      if (/\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i.test(filePath)) return true;
      if (/Test\.php$/i.test(filePath)) return true;
      if (/(^|\/)test_.*\.py$/i.test(filePath) || /_test\.py$/i.test(filePath)) return true;
      if (/(^|\/)(__tests__|tests?|spec)\//i.test(filePath) && /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|php|py|go|rs|java|kt|kts|cs|rb|swift|scala|dart|exs?|c|cc|cpp|cxx|h|hpp|lhs?|ml|mli|t|jl|erl|clj[cs]?|cr|nim|zig|sol|lua|r|fs|fsx|vb|groovy|ps1|bats?)$/i.test(filePath)) return true;
      if (/_test\.go$/i.test(filePath)) return true;
      if (/(^|\/)tests?\/.*\.rs$/i.test(filePath)) return true;
      if (/(Test|Tests|IT)\.(java|kt|kts|cs|scala)$/i.test(filePath)) return true;
      if (/(^|\/)src\/test\//i.test(filePath) && /\.(java|kt|kts|cs|fs|fsx|vb|scala|groovy)$/i.test(filePath)) return true;
      if (/_spec\.rb$/i.test(filePath) || /_test\.rb$/i.test(filePath)) return true;
      if (/(^|\/)t\/.*\.t$/i.test(filePath)) return true;
      if (/(Tests?)\.swift$/i.test(filePath)) return true;
      if (/_test\.exs$/i.test(filePath)) return true;
      if (/_test\.dart$/i.test(filePath) || /(^|\/)test\/.*\.dart$/i.test(filePath)) return true;
      if (/(^|\/)(test|tests)\/.*\.(c|cc|cpp|cxx)$/i.test(filePath)) return true;
      if (/(^|\/)(test|tests)\//i.test(filePath) && /\.(lhs?|ml|mli|t|jl|erl|clj[cs]?|cr|nim|zig|sol|lua|r|fs|fsx|vb|groovy|scala|kt|kts|java|cs|swift|php|py|rb|go|rs|dart|exs?|d|c|cc|cpp|cxx)$/i.test(filePath)) return true;
      if (/(Spec|Test|Tests|IT)\.(hs|lhs|ml|mli|jl|erl|clj[cs]?|cr|nim|zig|sol|lua|fs|fsx|vb|groovy|scala|kt|kts|java|cs|swift|dart)$/i.test(filePath)) return true;
      if (/_test\.(ml|nim|zig|lua|clj[cs]?|jl)$/i.test(filePath)) return true;
      if (/_spec\.(cr|lua)$/i.test(filePath)) return true;
      if (/_SUITE\.erl$/i.test(filePath)) return true;
      if (/\.Tests?\.(ps1|fs|fsx|vb)$/i.test(filePath)) return true;
      if (/\.bats$/i.test(filePath)) return true;
      return false;
    })
    .sort((a, b) => a.localeCompare(b));
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function detectProjectProfile(
  rootPath: string,
  files: ProjectFile[],
  providedFrameworks: string[] = [],
): Promise<ProjectTooling> {
  const entries = await fs.readdir(rootPath, { withFileTypes: true }).catch(() => []);
  const rootFiles = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const testFiles = testFilesFor(files);
  const hasTest = (pattern: RegExp) => testFiles.some((file) => pattern.test(file));
  const pythonTestFiles = testFiles.filter((file) => /\.py$/i.test(file));
  const pythonTestDir =
    pythonTestFiles.length > 0 && pythonTestFiles.every((file) => file.startsWith("tests/"))
      ? "tests"
      : ".";
  let pythonUsesUnittest = false;
  for (const file of pythonTestFiles.slice(0, 8)) {
    const content = await fs.readFile(path.join(rootPath, file), "utf8").catch(() => "");
    if (/^\s*(?:import unittest|from unittest)/m.test(content)) {
      pythonUsesUnittest = true;
      break;
    }
  }

  const exists = (name: string) => rootFiles.has(name);

  const ecosystems: string[] = [];
  const packageManagers: string[] = [];
  const frameworks: string[] = [];
  const manifests: string[] = [];
  const testCommands: string[] = [];
  let nodeRunner = "npm";
  let hasNpmTest = false;
  const buildCommands: string[] = [];
  const typecheckCommands: string[] = [];
  const lintCommands: string[] = [];
  const formatCommands: string[] = [];
  let testFramework: string | undefined;
  let hasTests = testFiles.length > 0;

  const addCommand = (list: string[], command: string) => {
    if (!list.includes(command)) list.push(command);
  };
  const addFramework = (name: string) => {
    if (!frameworks.includes(name)) frameworks.push(name);
  };
  const addEcosystem = (name: string) => {
    if (!ecosystems.includes(name)) ecosystems.push(name);
  };
  const addManager = (name: string) => {
    if (!packageManagers.includes(name)) packageManagers.push(name);
  };
  const addManifest = (name: string) => {
    if (!manifests.includes(name)) manifests.push(name);
  };

  // Node / JavaScript ecosystem
  if (exists("package.json")) {
    addEcosystem("Node.js");
    addFramework("Node.js");
    addManifest("package.json");
    const packageJson = await readJson<{
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }>(path.join(rootPath, "package.json"));
    const scripts = packageJson?.scripts ?? {};
    const dependencies = {
      ...(packageJson?.dependencies ?? {}),
      ...(packageJson?.devDependencies ?? {}),
    };
    const dependencyNames = Object.keys(dependencies);
    if (exists("pnpm-lock.yaml")) addManager("pnpm");
    else if (exists("yarn.lock")) addManager("yarn");
    else if (exists("bun.lockb") || exists("bun.lock")) addManager("bun");
    else addManager("npm");
    const runner =
      packageManagers.includes("pnpm") ? "pnpm"
      : packageManagers.includes("yarn") ? "yarn"
      : packageManagers.includes("bun") ? "bun"
      : "npm";
    nodeRunner = runner;
    if (typeof scripts.build === "string" && scripts.build.trim()) {
      addCommand(buildCommands, `${runner} run build`);
    }
    if (exists("tsconfig.json") && (dependencyNames.includes("typescript") || exists("tsconfig.json"))) {
      addCommand(typecheckCommands, "npx tsc --noEmit");
    }
    hasNpmTest = typeof scripts.test === "string" && scripts.test.trim().length > 0;
    const hasEslint =
      dependencyNames.some((name) => /^eslint$/.test(name)) ||
      [...rootFiles].some((name) => /^\.eslintrc|^eslint\.config\./.test(name));
    if (hasEslint) addCommand(lintCommands, runner === "npm" ? "npx eslint ." : `${runner} exec eslint .`);
    const hasPrettier =
      dependencyNames.some((name) => /^prettier$/.test(name)) ||
      [...rootFiles].some((name) => /^\.prettierrc|^prettier\.config\./.test(name));
    if (hasPrettier) addCommand(formatCommands, runner === "npm" ? "npx prettier --check ." : `${runner} exec prettier --check .`);
  }

  // PHP / Composer
  if (exists("composer.json")) {
    addEcosystem("PHP");
    addFramework("PHP");
    addManifest("composer.json");
    addManager("composer");
    const composer = await readJson<{
      require?: Record<string, string>;
      "require-dev"?: Record<string, string>;
      scripts?: Record<string, string>;
    }>(path.join(rootPath, "composer.json"));
    const dependencies = { ...(composer?.require ?? {}), ...(composer?.["require-dev"] ?? {}) };
    if (dependencies["laravel/framework"]) addFramework("Laravel");
    if (dependencies["squizlabs/php_codesniffer"] || dependencies["friendsofphp/php-cs-fixer"]) {
      addCommand(lintCommands, "vendor/bin/phpcs");
      addCommand(formatCommands, "vendor/bin/php-cs-fixer fix --dry-run --diff");
    }
  }

  // Python
  if (exists("requirements.txt") || exists("pyproject.toml") || exists("Pipfile") || exists("setup.py")) {
    addEcosystem("Python");
    addFramework("Python");
    addManifest(
      exists("pyproject.toml") ? "pyproject.toml" : exists("Pipfile") ? "Pipfile" : exists("setup.py") ? "setup.py" : "requirements.txt",
    );
    if (exists("poetry.lock") || exists("pyproject.toml")) addManager("poetry");
    else if (exists("uv.lock")) addManager("uv");
    else if (exists("Pipfile")) addManager("pipenv");
    else addManager("pip");
    const requirementText = await fs.readFile(path.join(rootPath, "requirements.txt"), "utf8").catch(() => "");
    const pyprojectText = await fs.readFile(path.join(rootPath, "pyproject.toml"), "utf8").catch(() => "");
    const pythonDeps = `${requirementText}\n${pyprojectText}`.toLowerCase();
    if (/\bruff\b/.test(pythonDeps)) addCommand(lintCommands, "ruff check .");
    if (/\bblack\b/.test(pythonDeps)) addCommand(formatCommands, "black --check .");
    if (/\bmypy\b/.test(pythonDeps)) {
      addCommand(typecheckCommands, "mypy .");
      addCommand(lintCommands, "mypy .");
    }
  }

  // Go
  if (exists("go.mod")) {
    addEcosystem("Go");
    addFramework("Go Modules");
    addManifest("go.mod");
    addManager("go");
    addCommand(buildCommands, "go build ./...");
    addCommand(typecheckCommands, "go build ./...");
    addCommand(lintCommands, "go vet ./...");
    addCommand(formatCommands, "gofmt -l .");
    if (hasTest(/_test\.go$/i)) {
      testFramework = "Go test";
      addCommand(testCommands, "go test ./...");
      hasTests = true;
    }
  }

  // Rust
  if (exists("Cargo.toml")) {
    addEcosystem("Rust");
    addFramework("Cargo");
    addManifest("Cargo.toml");
    addManager("cargo");
    addCommand(buildCommands, "cargo build");
    addCommand(typecheckCommands, "cargo check");
    addCommand(lintCommands, "cargo clippy -- -D warnings");
    addCommand(formatCommands, "cargo fmt -- --check");
    const rustFiles = testFiles.filter((file) => file.endsWith(".rs"));
    let inline = rustFiles.length > 0;
    if (!inline) {
      for (const file of files.filter((entry) => entry.path.endsWith(".rs")).slice(0, 120)) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const content = await fs.readFile(path.join(rootPath, file.path), "utf8");
          if (/#\[(?:tokio::)?test\]/.test(content)) {
            inline = true;
            break;
          }
        } catch {
          // ignore unreadable files
        }
      }
    }
    if (inline) {
      testFramework = "Cargo test";
      addCommand(testCommands, "cargo test");
      hasTests = true;
    }
  }

  // Java / Kotlin
  if (exists("pom.xml")) {
    addEcosystem("Java");
    addFramework("Maven");
    addManifest("pom.xml");
    addManager("maven");
    addCommand(buildCommands, "mvn -q -DskipTests package");
    addCommand(typecheckCommands, "mvn -q -DskipTests compile");
    if (hasTest(/\.(java|kt|kts)$/i)) {
      testFramework = "Maven";
      addCommand(testCommands, exists("mvnw") ? "./mvnw test" : "mvn test");
      hasTests = true;
    }
  } else if (exists("build.gradle") || exists("build.gradle.kts")) {
    addEcosystem(exists("build.gradle.kts") ? "Kotlin" : "Java");
    addFramework("Gradle");
    addManifest(exists("build.gradle.kts") ? "build.gradle.kts" : "build.gradle");
    addManager("gradle");
    addCommand(buildCommands, exists("gradlew") ? "./gradlew build -x test" : "gradle build -x test");
    addCommand(typecheckCommands, exists("gradlew") ? "./gradlew classes" : "gradle classes");
    if (hasTest(/\.(java|kt|kts)$/i)) {
      testFramework = "Gradle";
      addCommand(testCommands, exists("gradlew") ? "./gradlew test" : "gradle test");
      hasTests = true;
    }
  }

  // .NET
  if (exists("global.json") || [...rootFiles].some((name) => /\.(sln|csproj|fsproj|vbproj)$/i.test(name))) {
    addEcosystem(".NET");
    addFramework(".NET");
    for (const name of rootFiles) {
      if (/\.(sln|csproj|fsproj|vbproj)$/i.test(name)) addManifest(name);
    }
    addManager("dotnet");
    addCommand(buildCommands, "dotnet build");
    addCommand(typecheckCommands, "dotnet build");
    addCommand(formatCommands, "dotnet format --verify-no-changes");
    if (hasTest(/\.(cs|fs|fsx|vb)$/i)) {
      testFramework = "dotnet test";
      addCommand(testCommands, "dotnet test");
      hasTests = true;
    }
  }

  // Ruby
  if (exists("Gemfile")) {
    addEcosystem("Ruby");
    addFramework("Ruby Bundler");
    addManifest("Gemfile");
    addManager("bundler");
    addCommand(lintCommands, "bundle exec rubocop");
    if (hasTest(/_spec\.rb$/i)) {
      testFramework = "RSpec";
      addCommand(testCommands, "bundle exec rspec");
      hasTests = true;
    } else if (hasTest(/\.rb$/i)) {
      testFramework = "Minitest";
      addCommand(testCommands, exists("Rakefile") ? "bundle exec rake test" : "rake test");
      hasTests = true;
    }
  }

  // Swift
  if (exists("Package.swift")) {
    addEcosystem("Swift");
    addFramework("SwiftPM");
    addManifest("Package.swift");
    addManager("swiftpm");
    addCommand(buildCommands, "swift build");
    addCommand(typecheckCommands, "swift build");
    if (hasTest(/\.swift$/i)) {
      testFramework = "Swift test";
      addCommand(testCommands, "swift test");
      hasTests = true;
    }
  }

  // Elixir
  if (exists("mix.exs")) {
    addEcosystem("Elixir");
    addFramework("Mix");
    addManifest("mix.exs");
    addManager("mix");
    addCommand(buildCommands, "mix compile");
    addCommand(typecheckCommands, "mix compile --warnings-as-errors");
    addCommand(formatCommands, "mix format --check-formatted");
    if (hasTest(/_test\.exs$/i)) {
      testFramework = "ExUnit";
      addCommand(testCommands, "mix test");
      hasTests = true;
    }
  }

  // Scala
  if (exists("build.sbt")) {
    addEcosystem("Scala");
    addFramework("sbt");
    addManifest("build.sbt");
    addManager("sbt");
    addCommand(buildCommands, "sbt compile");
    addCommand(typecheckCommands, "sbt compile");
    if (hasTest(/\.scala$/i)) {
      testFramework = "sbt";
      addCommand(testCommands, "sbt test");
      hasTests = true;
    }
  }

  // Haskell
  if ([...rootFiles].some((name) => /\.cabal$/i.test(name)) || exists("stack.yaml")) {
    const cabal = [...rootFiles].find((name) => /\.cabal$/i.test(name));
    addEcosystem("Haskell");
    addFramework("Haskell");
    if (cabal) addManifest(cabal);
    addManager(exists("stack.yaml") ? "stack" : "cabal");
    addCommand(buildCommands, exists("stack.yaml") ? "stack build" : "cabal build");
    addCommand(typecheckCommands, exists("stack.yaml") ? "stack build" : "cabal build");
    if (hasTest(/\.(hs|lhs)$/i)) {
      testFramework = exists("stack.yaml") ? "Stack test" : "Cabal test";
      addCommand(testCommands, exists("stack.yaml") ? "stack test" : "cabal test");
      hasTests = true;
    }
  }

  // OCaml / Dune
  if (exists("dune-project")) {
    addEcosystem("OCaml");
    addFramework("Dune");
    addManifest("dune-project");
    addManager("opam");
    addCommand(buildCommands, "dune build");
    addCommand(typecheckCommands, "dune build");
    if (hasTest(/\.(ml|mli)$/i)) {
      testFramework = "Dune";
      addCommand(testCommands, "dune test");
      hasTests = true;
    }
  }

  // Perl
  if (exists("Makefile.PL") || exists("cpanfile") || hasTest(/\.t$/i)) {
    addEcosystem("Perl");
    addFramework("Perl");
    addManager("cpan");
    addCommand(buildCommands, "perl Makefile.PL && make");
    testFramework = "prove";
    addCommand(testCommands, testFiles.some((file) => /(^|\/)t\/.*\.t$/i.test(file)) ? "prove -lr t" : "prove -lr .");
    hasTests = true;
  }

  // Julia
  if (exists("Project.toml") && testFiles.some((file) => /\.jl$/i.test(file))) {
    addEcosystem("Julia");
    addFramework("Julia");
    addManifest("Project.toml");
    addManager("pkg");
    addCommand(buildCommands, "julia --project=. -e 'using Pkg; Pkg.instantiate()'");
    testFramework = "Julia Test";
    addCommand(testCommands, "julia --project=. -e 'using Pkg; Pkg.test()'");
    hasTests = true;
  }

  // Erlang / rebar3
  if (exists("rebar.config")) {
    addEcosystem("Erlang");
    addFramework("rebar3");
    addManifest("rebar.config");
    addManager("rebar3");
    addCommand(buildCommands, "rebar3 compile");
    addCommand(typecheckCommands, "rebar3 compile");
    if (testFiles.some((file) => /\.erl$/i.test(file))) {
      testFramework = "EUnit";
      addCommand(testCommands, "rebar3 eunit");
      if (testFiles.some((file) => /_SUITE\.erl$/i.test(file))) addCommand(testCommands, "rebar3 ct");
      hasTests = true;
    }
  }

  // Clojure
  if (exists("deps.edn") || exists("project.clj")) {
    addEcosystem("Clojure");
    addFramework("Clojure");
    addManifest(exists("project.clj") ? "project.clj" : "deps.edn");
    addManager(exists("project.clj") ? "lein" : "clojure");
    addCommand(buildCommands, exists("project.clj") ? "lein compile" : "clojure -M -e '(compile 'clojure.main)'");
    if (testFiles.some((file) => /\.clj[cs]?$/i.test(file))) {
      testFramework = "Clojure test";
      addCommand(testCommands, exists("project.clj") ? "lein test" : "clojure -X:test");
      hasTests = true;
    }
  }

  // Crystal
  if (exists("shard.yml")) {
    addEcosystem("Crystal");
    addFramework("Crystal");
    addManifest("shard.yml");
    addManager("shards");
    addCommand(buildCommands, "crystal build src/*.cr");
    if (testFiles.some((file) => /\.cr$/i.test(file))) {
      testFramework = "Crystal spec";
      addCommand(testCommands, "crystal spec");
      hasTests = true;
    }
  }

  // Nim
  if ([...rootFiles].some((name) => /\.nimble$/i.test(name))) {
    const nimble = [...rootFiles].find((name) => /\.nimble$/i.test(name));
    addEcosystem("Nim");
    addFramework("Nimble");
    if (nimble) addManifest(nimble);
    addManager("nimble");
    addCommand(buildCommands, "nimble build");
    if (testFiles.some((file) => /\.nim$/i.test(file))) {
      testFramework = "Nimble test";
      addCommand(testCommands, "nimble test");
      hasTests = true;
    }
  }

  // Zig
  if (exists("build.zig")) {
    addEcosystem("Zig");
    addFramework("Zig build");
    addManifest("build.zig");
    addManager("zig");
    addCommand(buildCommands, "zig build");
    addCommand(typecheckCommands, "zig build");
    if (testFiles.some((file) => /\.zig$/i.test(file))) {
      testFramework = "Zig test";
      addCommand(testCommands, "zig build test");
      hasTests = true;
    }
  }

  // Solidity
  if (exists("foundry.toml")) {
    addEcosystem("Solidity");
    addFramework("Foundry");
    addManifest("foundry.toml");
    addManager("forge");
    addCommand(buildCommands, "forge build");
    testFramework = "Forge test";
    addCommand(testCommands, "forge test");
    hasTests = true;
  } else if ([...rootFiles].some((name) => /^hardhat\.config\./i.test(name))) {
    addEcosystem("Solidity");
    addFramework("Hardhat");
    addManager("npm");
    testFramework = "Hardhat test";
    addCommand(testCommands, "npx hardhat test");
    hasTests = true;
  }

  // Lua / Busted
  if (exists(".busted") || testFiles.some((file) => /\.lua$/i.test(file))) {
    addEcosystem("Lua");
    addFramework("Lua");
    addManager("luarocks");
    testFramework = "Busted";
    addCommand(testCommands, "busted");
    hasTests = true;
  }

  // R / testthat
  if (exists("DESCRIPTION") || testFiles.some((file) => /\.[rR]$/.test(file))) {
    addEcosystem("R");
    addFramework("R");
    if (exists("DESCRIPTION")) addManifest("DESCRIPTION");
    addManager("R");
    testFramework = "testthat";
    addCommand(testCommands, "Rscript -e 'testthat::test_dir(\"tests/testthat\")'");
    hasTests = true;
  }

  // PowerShell / Pester
  if (testFiles.some((file) => /\.Tests?\.ps1$/i.test(file))) {
    addEcosystem("PowerShell");
    addFramework("Pester");
    addManager("PowerShell");
    testFramework = "Pester";
    addCommand(testCommands, "Invoke-Pester");
    hasTests = true;
  }

  // Bats
  if (testFiles.some((file) => /\.bats$/i.test(file))) {
    addEcosystem("Shell");
    addFramework("Bats");
    testFramework = "Bats";
    addCommand(testCommands, "bats tests");
    hasTests = true;
  }

  // Deno
  if (exists("deno.json") || exists("deno.jsonc")) {
    addEcosystem("Deno");
    addFramework("Deno");
    addManifest(exists("deno.jsonc") ? "deno.jsonc" : "deno.json");
    addManager("deno");
    addCommand(buildCommands, "deno check .");
    addCommand(typecheckCommands, "deno check .");
    if (testFiles.some((file) => /\.(ts|tsx|js|jsx)$/i.test(file))) {
      testFramework = "Deno test";
      addCommand(testCommands, "deno test");
      hasTests = true;
    }
  }

  // Bazel
  if (exists("WORKSPACE") || exists("WORKSPACE.bazel") || exists("MODULE.bazel")) {
    addEcosystem("Bazel");
    addFramework("Bazel");
    addManager("bazel");
    if (testFiles.length > 0) {
      testFramework = "Bazel test";
      addCommand(testCommands, "bazel test //...");
      hasTests = true;
    }
  }

  // Dart / Flutter
  if (exists("pubspec.yaml")) {
    const pubspec = await fs.readFile(path.join(rootPath, "pubspec.yaml"), "utf8").catch(() => "");
    const flutter = /sdk:\s*flutter|flutter:/i.test(pubspec);
    addEcosystem("Dart");
    addFramework(flutter ? "Flutter" : "Dart");
    addManifest("pubspec.yaml");
    addManager("pub");
    addCommand(typecheckCommands, flutter ? "flutter analyze" : "dart analyze");
    addCommand(lintCommands, flutter ? "flutter analyze" : "dart analyze");
    addCommand(formatCommands, flutter ? "dart format --output=none --set-exit-if-changed ." : "dart format --output=none --set-exit-if-changed .");
    if (hasTest(/\.dart$/i)) {
      testFramework = flutter ? "Flutter test" : "Dart test";
      addCommand(testCommands, flutter ? "flutter test" : "dart test");
      hasTests = true;
    }
  }

  // Godot
  if (exists("project.godot")) {
    addEcosystem("Godot");
    addFramework("Godot 4");
    addManifest("project.godot");
    addManager("godot");
    addCommand(buildCommands, "godot --headless --path . --quit");
    addCommand(typecheckCommands, "godot --headless --path . --quit");
  }

  // C / C++ + CMake
  if (exists("CMakeLists.txt")) {
    addEcosystem("C/C++");
    addFramework("CMake");
    addManifest("CMakeLists.txt");
    addManager("cmake");
    addCommand(buildCommands, "cmake --build build");
    addCommand(typecheckCommands, "cmake --build build");
    if (hasTest(/\.(c|cc|cpp|cxx)$/i)) {
      testFramework = "CTest";
      addCommand(testCommands, "ctest --output-on-failure");
      hasTests = true;
    }
  }

  // Existing framework signals (Vitest/Jest/Laravel/PHPUnit/Pytest/Static HTML)
  for (const framework of providedFrameworks) {
    if (["Vitest", "Jest", "Laravel", "PHPUnit", "Pytest", "Static HTML"].includes(framework)) {
      if (!testFramework) {
        if (framework === "Vitest") {
          testFramework = "Vitest";
          addCommand(testCommands, "npx vitest run");
          hasTests = hasTests || testFiles.length > 0;
        } else if (framework === "Jest") {
          testFramework = "Jest";
          addCommand(testCommands, "npm test -- --runInBand");
          hasTests = hasTests || testFiles.length > 0;
        } else if (framework === "Laravel") {
          testFramework = "Laravel";
          addCommand(testCommands, "php artisan test");
          hasTests = true;
        } else if (framework === "PHPUnit") {
          testFramework = "PHPUnit";
          addCommand(testCommands, "vendor/bin/phpunit");
          hasTests = true;
        } else if (framework === "Pytest") {
          testFramework = "Pytest";
          addCommand(testCommands, "pytest -q");
          hasTests = true;
        }
      }
    }
  }
  if (!testFramework && hasTest(/\.php$/i)) {
    testFramework = "PHPUnit";
    addCommand(testCommands, "vendor/bin/phpunit");
    hasTests = true;
  }
  if (!testFramework && hasTest(/\.py$/i)) {
    if (pythonUsesUnittest) {
      testFramework = "unittest";
      addCommand(
        testCommands,
        `python3 -m unittest discover -s ${pythonTestDir} -q`,
      );
    } else {
      testFramework = "Pytest";
      addCommand(testCommands, "pytest -q");
    }
    hasTests = true;
  }
  if (testCommands.length === 0 && exists("Makefile")) {
    const makefile = await fs.readFile(path.join(rootPath, "Makefile"), "utf8").catch(() => "");
    if (/^test\s*:/m.test(makefile)) {
      testFramework = "Make";
      addCommand(testCommands, "make test");
      hasTests = true;
    }
  }
  if (testCommands.length === 0 && hasNpmTest) {
    testFramework = "Node test";
    addCommand(testCommands, `${nodeRunner} test`);
    hasTests = true;
  }

  return {
    ecosystems: ecosystems.sort((a, b) => a.localeCompare(b)),
    packageManagers: [...new Set(packageManagers)],
    frameworks: frameworks.sort((a, b) => a.localeCompare(b)),
    testFramework,
    testCommands,
    buildCommands,
    typecheckCommands,
    lintCommands,
    formatCommands,
    manifests,
    testFileCount: testFiles.length,
    hasTests: hasTests || testFiles.length > 0,
  };
}

export { testFilesFor };
