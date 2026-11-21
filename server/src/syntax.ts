import { spawnSync } from "node:child_process";
import type { AnalysisResult, SyntaxCheckResult } from "../../shared/types";
import { readSourceFile, runProjectCommand } from "./editor";

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function hasBinary(binary: string): boolean {
  const result = spawnSync(process.platform === "win32" ? "where" : "which", [binary], {
    stdio: "ignore",
    timeout: 5_000,
  });
  return result.status === 0;
}

function unsupported(filePath: string, message: string): SyntaxCheckResult {
  return {
    filePath,
    supported: false,
    ok: true,
    exitCode: null,
    output: message,
  };
}

export async function checkFileSyntax(
  analysis: AnalysisResult,
  filePath: string,
): Promise<SyntaxCheckResult> {
  const file = await readSourceFile(analysis.rootPath, filePath);
  const name = file.filePath.split("/").pop()?.toLowerCase() ?? "";
  const extension = name.includes(".") ? name.split(".").pop() ?? "" : "";
  const quoted = quoteShell(file.filePath);

  if (name === "dockerfile" || name.startsWith("dockerfile.")) {
    if (!hasBinary("hadolint")) {
      return unsupported(file.filePath, "hadolint is not installed, so Dockerfiles cannot be syntax-checked locally.");
    }
    const command = `hadolint ${quoted}`;
    const result = await runProjectCommand(analysis.rootPath, command, undefined, { timeoutMs: 60_000 });
    return {
      filePath: file.filePath,
      supported: true,
      command,
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      output: `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim(),
    };
  }

  let binary: string | undefined;
  let command: string | undefined;

  if (["js", "mjs", "cjs"].includes(extension)) {
    binary = "node";
    command = `node --check ${quoted}`;
  } else if (["ts", "tsx", "mts", "cts", "jsx"].includes(extension)) {
    return unsupported(
      file.filePath,
      "TypeScript and JSX syntax is checked by the project typecheck/build command.",
    );
  } else if (extension === "py") {
    binary = "python3";
    command = `python3 -c 'import sys; compile(open(sys.argv[1]).read(), sys.argv[1], "exec")' ${quoted}`;
  } else if (extension === "php") {
    binary = "php";
    command = `php -l ${quoted}`;
  } else if (extension === "rb") {
    binary = "ruby";
    command = `ruby -c ${quoted}`;
  } else if (["sh", "bash", "zsh", "ksh"].includes(extension)) {
    binary = "bash";
    command = `bash -n ${quoted}`;
  } else if (["json", "jsonc", "json5", "jsonl", "ndjson", "avsc"].includes(extension)) {
    binary = "node";
    command = `node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' ${quoted}`;
  } else if (extension === "go") {
    binary = "gofmt";
    command = `gofmt -e -l ${quoted}`;
  } else if (extension === "rs") {
    binary = "rustfmt";
    command = `rustfmt --check ${quoted}`;
  } else if (extension === "c") {
    binary = "cc";
    command = `cc -fsyntax-only ${quoted}`;
  } else if (["cpp", "cc", "cxx", "hpp", "hxx", "hh"].includes(extension)) {
    binary = "c++";
    command = `c++ -fsyntax-only ${quoted}`;
  } else if (extension === "h") {
    binary = "cc";
    command = `cc -fsyntax-only ${quoted}`;
  } else if (extension === "m") {
    binary = "clang";
    command = `clang -fsyntax-only -x objective-c ${quoted}`;
  } else if (extension === "mm") {
    binary = "clang";
    command = `clang -fsyntax-only -x objective-c++ ${quoted}`;
  } else if (extension === "lua") {
    binary = "luac";
    command = `luac -p ${quoted}`;
  } else if (["pl", "pm", "t"].includes(extension)) {
    binary = "perl";
    command = `perl -c ${quoted}`;
  } else if (["ps1", "psm1", "psd1"].includes(extension)) {
    binary = "pwsh";
    command = `pwsh -NoProfile -Command '[void][scriptblock]::Create((Get-Content -Raw -LiteralPath $args[0]))' ${quoted}`;
  } else if (extension === "zig") {
    binary = "zig";
    command = `zig ast-check ${quoted}`;
  } else if (extension === "sol") {
    binary = "solc";
    command = `solc --parse-only ${quoted}`;
  } else if (["xml", "svg", "plist", "xsd", "xsl", "xslt", "csproj", "vbproj", "fsproj"].includes(extension)) {
    binary = "xmllint";
    command = `xmllint --noout ${quoted}`;
  } else if (["yaml", "yml"].includes(extension)) {
    binary = "ruby";
    command = `ruby -ryaml -e 'YAML.load_file(ARGV[0])' ${quoted}`;
  } else if (extension === "toml") {
    binary = "python3";
    command = `python3 -c 'import sys, tomllib; tomllib.load(open(sys.argv[1], "rb"))' ${quoted}`;
  } else if (["r"].includes(extension)) {
    binary = "Rscript";
    command = `Rscript -e 'invisible(parse(file=commandArgs(TRUE)[1]))' ${quoted}`;
  } else if (extension === "nix") {
    binary = "nix-instantiate";
    command = `nix-instantiate --parse ${quoted}`;
  } else if (["ex", "exs"].includes(extension)) {
    binary = "elixir";
    command = `elixir -e 'Code.string_to_quoted!(File.read!(System.argv() |> hd))' ${quoted}`;
  }

  if (!command || !binary) {
    return unsupported(
      file.filePath,
      `No per-file syntax checker is available for .${extension || "file"} files. Use the project typecheck or build check.`,
    );
  }

  if (!hasBinary(binary)) {
    return unsupported(
      file.filePath,
      `${binary} is not installed, so this file cannot be syntax-checked locally. Install it or use the project build/typecheck check.`,
    );
  }

  const result = await runProjectCommand(analysis.rootPath, command, undefined, {
    timeoutMs: 60_000,
  });
  return {
    filePath: file.filePath,
    supported: true,
    command,
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    output: `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim(),
  };
}
