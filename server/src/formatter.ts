import fs from "node:fs/promises";
import path from "node:path";
import type { AnalysisResult } from "../../shared/types";
import { runProjectCommand, readSourceFile } from "./editor";
import { detectProjectProfile } from "./projectProfile";
import { updateIndexedFile } from "./indexer";

export interface FormatFileResult {
  filePath: string;
  command?: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  content: string;
  formatted: boolean;
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function formatProjectFile(
  projectId: string,
  analysis: AnalysisResult,
  filePath: string,
): Promise<FormatFileResult> {
  const file = await readSourceFile(analysis.rootPath, filePath);
  const name = file.filePath.split("/").pop()?.toLowerCase() ?? "";
  const extension = file.filePath.split(".").pop()?.toLowerCase() ?? "";
  const tooling =
    analysis.tooling ??
    (await detectProjectProfile(
      analysis.rootPath,
      analysis.files.map((entry) => ({ path: entry.path })),
      analysis.frameworks ?? [],
    ));

  const has = (needle: string) =>
    [...tooling.formatCommands, ...tooling.lintCommands].some((command) =>
      command.toLowerCase().includes(needle),
    );
  const exists = (name: string) =>
    fs.access(path.join(analysis.rootPath, name)).then(() => true).catch(() => false);
  const quoted = quoteShell(file.filePath);
  let command: string | undefined;

  if ((await exists("dprint.json")) || (await exists(".dprint.jsonc"))) {
    command = `npx dprint fmt ${quoted}`;
  } else if (extension === "toml" && (await exists("taplo.toml"))) {
    command = `taplo fmt ${quoted}`;
  } else if (extension === "proto" && ((await exists("buf.yaml")) || (await exists("buf.gen.yaml")))) {
    command = `buf format -w ${quoted}`;
  } else if (extension === "ex" || extension === "exs") {
    if (has("mix format") || (await exists("mix.exs"))) command = `mix format ${quoted}`;
  } else if (extension === "scala" && (await exists(".scalafmt.conf"))) {
    command = `scalafmt ${quoted}`;
  } else if (extension === "zig") {
    command = `zig fmt ${quoted}`;
  } else if (extension === "cr") {
    command = `crystal tool format ${quoted}`;
  } else if (extension === "nix") {
    command = `nixfmt ${quoted}`;
  } else if (extension === "tf" || extension === "tfvars") {
    command = `terraform fmt ${quoted}`;
  } else if ((extension === "cmake" || name === "cmakelists.txt") && ((await exists(".cmake-format")) || (await exists(".cmake-format.yaml")) || (await exists("cmake-format.yaml")))) {
    command = `cmake-format -i ${quoted}`;
  } else if ((extension === "ml" || extension === "mli") && (await exists(".ocamlformat"))) {
    command = `ocamlformat -i ${quoted}`;
  } else if (extension === "swift" && (await exists(".swift-format"))) {
    command = `swift-format format -i ${quoted}`;
  } else if (extension === "rb" && has("standardrb")) {
    command = `bundle exec standardrb --fix ${quoted}`;
  } else if (extension === "rb" && has("rubocop")) {
    command = `bundle exec rubocop -a ${quoted}`;
  } else if (extension === "sol" && (await exists("foundry.toml"))) {
    command = `forge fmt ${quoted}`;
  } else if (extension === "lua" && ((await exists(".stylua.toml")) || (await exists("stylua.toml")))) {
    command = `stylua ${quoted}`;
  } else if ((extension === "pl" || extension === "pm") && (await exists(".perltidyrc"))) {
    command = `perltidy -b ${quoted}`;
  } else if ((extension === "hs" || extension === "lhs") && (await exists(".ormolu"))) {
    command = `ormolu --mode inplace ${quoted}`;
  } else if ((extension === "hs" || extension === "lhs") && ((await exists(".fourmolu.yaml")) || (await exists("fourmolu.yaml")))) {
    command = `fourmolu -i ${quoted}`;
  } else if (["go"].includes(extension)) {
    command = `gofmt -w ${quoted}`;
  } else if (["rs"].includes(extension)) {
    command = `rustfmt ${quoted}`;
  } else if (["py"].includes(extension)) {
    if (has("black")) command = `black ${quoted}`;
    else if (has("ruff")) command = `ruff format ${quoted}`;
  } else if (["php"].includes(extension) && has("php-cs-fixer")) {
    command = `vendor/bin/php-cs-fixer fix ${quoted}`;
  } else if (["dart"].includes(extension)) {
    command = `dart format ${quoted}`;
  } else if (["c", "cc", "cpp", "cxx", "h", "hpp"].includes(extension)) {
    const clangFormat = await fs
      .access(path.join(analysis.rootPath, ".clang-format"))
      .then(() => true)
      .catch(() => false);
    if (clangFormat) command = `clang-format -i ${quoted}`;
  } else if (
    ["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "json", "jsonc", "json5", "css", "scss", "sass", "less", "html", "htm", "md", "mdx", "yaml", "yml", "vue", "svelte", "astro", "graphql", "gql"].includes(
      extension,
    ) &&
    has("prettier")
  ) {
    command = `npx prettier --write ${quoted}`;
  }

  if (!command) {
    return {
      filePath: file.filePath,
      command: undefined,
      exitCode: null,
      stdout: "",
      stderr: "No formatter was detected for this file type.",
      content: file.content,
      formatted: false,
    };
  }

  const result = await runProjectCommand(analysis.rootPath, command);
  if (result.exitCode === 0) {
    const formattedContent = await fs.readFile(path.resolve(analysis.rootPath, file.filePath), "utf8");
    await updateIndexedFile(projectId, analysis.rootPath, file.filePath, formattedContent).catch(() => {
      // index update is best-effort
    });
    return {
      filePath: file.filePath,
      command,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      content: formattedContent,
      formatted: formattedContent !== file.content,
    };
  }

  return {
    filePath: file.filePath,
    command,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    content: file.content,
    formatted: false,
  };
}
