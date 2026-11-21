import assert from "node:assert/strict";
import test from "node:test";
import { detectLanguage, isSupportedTextFile } from "./fileLanguage";

test("language detection covers many source and config formats", () => {
  const cases: [string, string][] = [
    ["src/app.ts", "typescript"],
    ["src/view.tsx", "tsx"],
    ["src/app.js", "javascript"],
    ["src/app.jsx", "jsx"],
    ["src/app.py", "python"],
    ["src/app.rb", "ruby"],
    ["src/Main.hs", "haskell"],
    ["src/main.rs", "rust"],
    ["src/main.go", "go"],
    ["src/Main.kt", "kotlin"],
    ["src/App.cs", "csharp"],
    ["src/App.fs", "fsharp"],
    ["src/main.swift", "swift"],
    ["src/app.ex", "elixir"],
    ["src/app.clj", "clojure"],
    ["src/app.ml", "ocaml"],
    ["src/app.erl", "erlang"],
    ["src/app.cr", "crystal"],
    ["src/app.nim", "nim"],
    ["src/app.zig", "zig"],
    ["src/App.sol", "solidity"],
    ["src/app.jl", "julia"],
    ["src/app.pl", "perl"],
    ["src/app.lua", "lua"],
    ["src/app.R", "r"],
    ["src/app.ps1", "powershell"],
    ["src/app.tf", "hcl"],
    ["src/app.nix", "nix"],
    ["Dockerfile", "dockerfile"],
    ["Containerfile", "dockerfile"],
    ["Makefile", "makefile"],
    ["CMakeLists.txt", "cmake"],
    ["Rakefile", "ruby"],
    ["Jenkinsfile", "groovy"],
    ["package.json", "json"],
    ["config.yaml", "yaml"],
    ["pyproject.toml", "toml"],
    ["README.md", "markdown"],
    ["env.example", "text"],
    ["schema.graphql", "graphql"],
    ["service.proto", "protobuf"],
    ["App.csproj", "xml"],
    ["icon.svg", "xml"],
    ["style.scss", "scss"],
    ["index.vue", "vue"],
    ["main.tf", "hcl"],
    ["justfile", "makefile"],
  ];
  for (const [file, expected] of cases) {
    assert.equal(detectLanguage(file), expected, `${file} should be ${expected}`);
  }
  assert.equal(detectLanguage("image.png"), null);
  assert.equal(detectLanguage("archive.zip"), null);
  assert.equal(detectLanguage("binary.exe"), null);
  assert.equal(isSupportedTextFile("src/main.rs"), true);
  assert.equal(isSupportedTextFile("image.png"), false);
});
