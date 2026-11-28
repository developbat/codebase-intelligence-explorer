import { exec, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type {
  ToolchainCategory,
  ToolchainInstallCommand,
  ToolchainInstallResult,
  ToolchainReport,
  ToolchainTool,
} from "../../shared/toolchains";

import { toolchainPath } from "./shellPath";

const execFileAsync = promisify(execFile);

function hasEslintConfig(rootPath?: string): boolean {
  if (!rootPath) return false;
  return [
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
    "eslint.config.ts",
    ".eslintrc",
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc.json",
    ".eslintrc.yml",
    ".eslintrc.yaml",
  ].some((name) => fs.existsSync(path.join(rootPath, name)));
}
const execAsync = promisify(exec);

type Platform = "darwin" | "linux" | "win32";

interface Definition {
  id: string;
  name: string;
  commands: string[];
  args: string[];
  category: ToolchainCategory;
  languages?: string[];
  required?: boolean;
  autoInstall?: boolean;
  managed?: boolean;
  local?: boolean;
  packageName?: string;
  note?: string;
  install: Partial<Record<Platform, string>>;
}

export interface EnvironmentContext {
  rootPath?: string;
  languages?: string[];
  files?: string[];
}

const install = (
  darwin: string | undefined,
  linux: string | undefined,
  win32: string | undefined,
  label: string,
): ToolchainInstallCommand[] =>
  (["darwin", "linux", "win32"] as Platform[])
    .map((platform) => {
      const command = platform === "darwin" ? darwin : platform === "linux" ? linux : win32;
      return command ? { platform, command, label } : null;
    })
    .filter((value): value is ToolchainInstallCommand => Boolean(value));

const platformCommand = (
  darwin: string | undefined,
  linux: string | undefined,
  win32: string | undefined,
) => ({ darwin, linux, win32 });

const DEFINITIONS: Definition[] = [
  {
    id: "node",
    name: "Node.js",
    commands: ["node"],
    args: ["--version"],
    category: "runtime",
    required: true,
    managed: true,
    autoInstall: false,
    note: "Required by the editor runtime. Detected and repaired through the OS package manager.",
    install: platformCommand("brew install node", "sudo apt-get install -y nodejs npm", "choco install nodejs -y"),
  },
  {
    id: "npm",
    name: "npm",
    commands: ["npm"],
    args: ["--version"],
    category: "package-manager",
    required: true,
    managed: true,
    autoInstall: false,
    install: platformCommand("brew install node", "sudo apt-get install -y nodejs npm", "choco install nodejs -y"),
  },
  {
    id: "pnpm",
    name: "pnpm",
    commands: ["pnpm"],
    args: ["--version"],
    category: "package-manager",
    managed: true,
    autoInstall: false,
    install: platformCommand("npm install -g pnpm", "npm install -g pnpm", "npm install -g pnpm"),
  },
  {
    id: "yarn",
    name: "Yarn",
    commands: ["yarn"],
    args: ["--version"],
    category: "package-manager",
    managed: true,
    autoInstall: false,
    install: platformCommand("npm install -g yarn", "npm install -g yarn", "npm install -g yarn"),
  },
  {
    id: "git",
    name: "Git",
    commands: ["git"],
    args: ["--version"],
    category: "version-control",
    required: true,
    managed: true,
    autoInstall: false,
    note: "Required for diffs, blame and Git tools. The OS package manager owns the binary.",
    install: platformCommand("brew install git", "sudo apt-get install -y git", "choco install git -y"),
  },
  {
    id: "python3",
    name: "Python 3",
    commands: ["python3", "python"],
    args: ["--version"],
    category: "runtime",
    languages: ["python"],
    managed: true,
    autoInstall: false,
    install: platformCommand(
      "brew install python",
      "sudo apt-get install -y python3 python3-pip",
      "choco install python -y",
    ),
  },
  {
    id: "php",
    name: "PHP",
    commands: ["php"],
    args: ["--version"],
    category: "runtime",
    languages: ["php"],
    managed: true,
    autoInstall: false,
    install: platformCommand("brew install php", "sudo apt-get install -y php-cli", "choco install php -y"),
  },
  {
    id: "composer",
    name: "Composer",
    commands: ["composer"],
    args: ["--version"],
    category: "package-manager",
    languages: ["php"],
    managed: true,
    autoInstall: false,
    install: platformCommand(
      "brew install composer",
      "sudo apt-get install -y composer",
      "choco install composer -y",
    ),
  },
  {
    id: "go",
    name: "Go",
    commands: ["go"],
    args: ["version"],
    category: "runtime",
    languages: ["go"],
    managed: true,
    autoInstall: false,
    install: platformCommand("brew install go", "sudo snap install go --classic", "choco install golang -y"),
  },
  {
    id: "rustc",
    name: "Rust",
    commands: ["rustc"],
    args: ["--version"],
    category: "runtime",
    languages: ["rust"],
    managed: true,
    autoInstall: false,
    install: platformCommand("brew install rust", "sudo snap install rustup --classic", "choco install rustup.install -y"),
  },
  {
    id: "cargo",
    name: "Cargo",
    commands: ["cargo"],
    args: ["--version"],
    category: "package-manager",
    languages: ["rust"],
    managed: true,
    autoInstall: false,
    install: platformCommand("brew install rust", "sudo snap install rustup --classic", "choco install rustup.install -y"),
  },
  {
    id: "typescript-language-server",
    name: "TypeScript Language Server",
    commands: ["typescript-language-server"],
    packageName: "typescript-language-server",
    args: ["--version"],
    category: "lsp",
    languages: ["typescript", "javascript"],
    managed: true,
    autoInstall: true,
    local: true,
    note: "Installed as a project-local dev dependency; the editor starts it over stdio.",
    install: platformCommand(
      "npm install -D typescript-language-server typescript",
      "npm install -D typescript-language-server typescript",
      "npm install -D typescript-language-server typescript",
    ),
  },
  {
    id: "pyright",
    name: "Pyright",
    commands: ["pyright-langserver", "pyright"],
    packageName: "pyright",
    args: ["--version"],
    category: "lsp",
    languages: ["python"],
    managed: true,
    autoInstall: true,
    note: "Python language server. Install when Python support is enabled.",
    install: platformCommand("npm install -g pyright", "npm install -g pyright", "npm install -g pyright"),
  },
  {
    id: "rust-analyzer",
    name: "rust-analyzer",
    commands: ["rust-analyzer"],
    args: ["--version"],
    category: "lsp",
    languages: ["rust"],
    managed: true,
    autoInstall: true,
    note: "Rust language server, installed through rustup.",
    install: platformCommand(
      "rustup component add rust-analyzer",
      "rustup component add rust-analyzer",
      "rustup component add rust-analyzer",
    ),
  },
  {
    id: "gopls",
    name: "gopls",
    commands: ["gopls"],
    args: ["version"],
    category: "lsp",
    languages: ["go"],
    managed: true,
    autoInstall: true,
    note: "Go language server.",
    install: platformCommand(
      "go install golang.org/x/tools/gopls@latest",
      "go install golang.org/x/tools/gopls@latest",
      "go install golang.org/x/tools/gopls@latest",
    ),
  },
  {
    id: "intelephense",
    name: "Intelephense",
    commands: ["intelephense"],
    packageName: "intelephense",
    args: ["--version"],
    category: "lsp",
    languages: ["php"],
    managed: true,
    autoInstall: true,
    note: "PHP language server.",
    install: platformCommand("npm install -g intelephense", "npm install -g intelephense", "npm install -g intelephense"),
  },
  {
    id: "eslint",
    name: "ESLint",
    commands: ["eslint"],
    packageName: "eslint",
    args: ["--version"],
    category: "linter",
    languages: ["typescript", "javascript"],
    managed: true,
    autoInstall: true,
    local: true,
    note: "Project dependency; install only when the project uses ESLint.",
    install: platformCommand("npm install -D eslint", "npm install -D eslint", "npm install -D eslint"),
  },
  {
    id: "prettier",
    name: "Prettier",
    commands: ["prettier"],
    packageName: "prettier",
    args: ["--version"],
    category: "formatter",
    languages: ["typescript", "javascript", "css", "html", "json", "markdown"],
    managed: true,
    autoInstall: true,
    local: true,
    note: "Project dependency; install only when the project uses Prettier.",
    install: platformCommand("npm install -D prettier", "npm install -D prettier", "npm install -D prettier"),
  },
  {
    id: "docker",
    name: "Docker",
    commands: ["docker"],
    args: ["--version"],
    category: "container",
    managed: false,
    autoInstall: false,
    note: "External dependency; detected only.",
    install: {},
  },
  {
    id: "pdftotext",
    name: "Poppler PDF tools",
    commands: ["pdftotext"],
    args: ["-v"],
    category: "document",
    managed: true,
    autoInstall: false,
    install: platformCommand("brew install poppler", "sudo apt-get install -y poppler-utils", "choco install poppler -y"),
  },
  {
    id: "tesseract",
    name: "Tesseract OCR",
    commands: ["tesseract"],
    args: ["--version"],
    category: "document",
    managed: true,
    autoInstall: false,
    install: platformCommand("brew install tesseract", "sudo apt-get install -y tesseract-ocr", "choco install tesseract -y"),
  },
  {
    id: "ffmpeg",
    name: "FFmpeg",
    commands: ["ffmpeg"],
    args: ["-version"],
    category: "media",
    managed: true,
    autoInstall: false,
    install: platformCommand("brew install ffmpeg", "sudo apt-get install -y ffmpeg", "choco install ffmpeg -y"),
  },
  {
    id: "ffprobe",
    name: "FFprobe",
    commands: ["ffprobe"],
    args: ["-version"],
    category: "media",
    managed: true,
    autoInstall: false,
    install: platformCommand("brew install ffmpeg", "sudo apt-get install -y ffmpeg", "choco install ffmpeg -y"),
  },
  {
    id: "xcrun",
    name: "Xcode simctl",
    commands: ["xcrun"],
    args: ["--find", "simctl"],
    category: "mobile",
    managed: false,
    autoInstall: false,
    install: {},
  },
  {
    id: "adb",
    name: "Android adb",
    commands: ["adb"],
    args: ["version"],
    category: "mobile",
    managed: false,
    autoInstall: false,
    install: {},
  },
  {
    id: "emulator",
    name: "Android emulator",
    commands: ["emulator"],
    args: ["-version"],
    category: "mobile",
    managed: false,
    autoInstall: false,
    install: {},
  },
  {
    id: "pod",
    name: "CocoaPods",
    commands: ["pod"],
    args: ["--version"],
    category: "mobile",
    managed: true,
    autoInstall: false,
    install: platformCommand("sudo gem install cocoapods", "sudo gem install cocoapods", ""),
  },
  {
    id: "flutter",
    name: "Flutter",
    commands: ["flutter"],
    args: ["--version"],
    category: "mobile",
    managed: true,
    autoInstall: false,
    install: platformCommand("brew install --cask flutter", "sudo snap install flutter --classic", "choco install flutter -y"),
  },
  {
    id: "dart",
    name: "Dart",
    commands: ["dart"],
    args: ["--version"],
    category: "runtime",
    languages: ["dart"],
    managed: true,
    autoInstall: false,
    install: platformCommand("brew install dart", "sudo snap install dart --classic", "choco install dart-sdk -y"),
  },
  {
    id: "godot",
    name: "Godot 4",
    commands: ["godot", "godot4"],
    args: ["--version"],
    category: "game",
    managed: true,
    autoInstall: false,
    install: platformCommand("brew install --cask godot", "sudo snap install godot", "choco install godot -y"),
  },
];

function platform(): Platform {
  return process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";
}

function packageVersion(packageJsonPath: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

function packageCandidates(definition: Definition, projectRoot?: string): { path: string; label: string }[] {
  if (!definition.packageName) return [];
  const packageName = definition.packageName;
  const candidates: { path: string; label: string }[] = [];
  if (definition.local && projectRoot) {
    candidates.push({
      path: path.join(projectRoot, "node_modules", packageName, "package.json"),
      label: `${packageName} (project)`,
    });
  }
  candidates.push({
    path: path.join(process.cwd(), "node_modules", packageName, "package.json"),
    label: `${packageName} (app)`,
  });
  // npm's default global layout: <prefix>/bin/node -> <prefix>/lib/node_modules/<pkg>
  const nodeDir = path.dirname(process.execPath);
  candidates.push({
    path: path.resolve(nodeDir, "..", "lib", "node_modules", packageName, "package.json"),
    label: `${packageName} (global)`,
  });
  candidates.push({
    path: path.resolve(nodeDir, "..", "node_modules", packageName, "package.json"),
    label: `${packageName} (global)`,
  });
  if (process.env.npm_config_prefix) {
    candidates.push({
      path: path.join(process.env.npm_config_prefix, "lib", "node_modules", packageName, "package.json"),
      label: `${packageName} (global)`,
    });
  }
  if (process.env.NPM_CONFIG_PREFIX) {
    candidates.push({
      path: path.join(process.env.NPM_CONFIG_PREFIX, "lib", "node_modules", packageName, "package.json"),
      label: `${packageName} (global)`,
    });
  }
  return candidates;
}

function commandCandidates(definition: Definition, projectRoot?: string): string[] {
  const candidates: string[] = [];
  if (definition.local && projectRoot) {
    for (const command of definition.commands) {
      candidates.push(path.resolve(projectRoot, "node_modules", ".bin", command));
    }
  }
  for (const command of definition.commands) {
    const appLocal = path.resolve(process.cwd(), "node_modules", ".bin", command);
    if (fs.existsSync(appLocal)) candidates.push(appLocal);
    candidates.push(command);
  }
  return [...new Set(candidates)];
}

const WINGET_IDS: Record<string, string> = {
  node: "OpenJS.NodeJS.LTS",
  npm: "OpenJS.NodeJS.LTS",
  git: "Git.Git",
  python3: "Python.Python.3.13",
  go: "GoLang.Go",
  rustc: "Rustlang.Rustup",
  cargo: "Rustlang.Rustup",
  ffmpeg: "Gyan.FFmpeg",
};

const commandAvailability = new Map<string, boolean>();

async function hasCommand(command: string): Promise<boolean> {
  const cached = commandAvailability.get(command);
  if (cached !== undefined) return cached;
  try {
    await execFileAsync(process.platform === "win32" ? "where" : "which", [command], {
      timeout: 3_000,
      maxBuffer: 256 * 1024,
      env: { ...process.env, PATH: toolchainPath() },
    });
    commandAvailability.set(command, true);
    return true;
  } catch {
    commandAvailability.set(command, false);
    return false;
  }
}

function windowsInstallHint(): string {
  return process.platform === "win32"
    ? "Windows: install with winget or Chocolatey, or run the command in an elevated terminal."
    : "";
}

async function checkDefinition(
  definition: Definition,
  projectRoot?: string,
): Promise<ToolchainTool> {
  for (const candidate of packageCandidates(definition, projectRoot)) {
    if (!fs.existsSync(candidate.path)) continue;
    const version = packageVersion(candidate.path);
    return {
      id: definition.id,
      name: definition.name,
      installed: true,
      version: version ? `${version} · ${candidate.label}` : candidate.label,
      installCommands: install(
        definition.install.darwin,
        definition.install.linux,
        definition.install.win32,
        definition.name,
      ),
      category: definition.category,
      languages: definition.languages,
      required: definition.required,
      autoInstall: definition.autoInstall,
      managed: definition.managed,
      local: definition.local,
      note: definition.note,
    };
  }
  for (const command of commandCandidates(definition, projectRoot)) {
    try {
      const result = await execFileAsync(command, definition.args, {
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
        cwd: projectRoot,
        env: { ...process.env, PATH: toolchainPath() },
      });
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
      return {
        id: definition.id,
        name: definition.name,
        installed: true,
        version: output.split("\n")[0]?.slice(0, 180),
        installCommands: install(
          definition.install.darwin,
          definition.install.linux,
          definition.install.win32,
          definition.name,
        ),
        category: definition.category,
        languages: definition.languages,
        required: definition.required,
        autoInstall: definition.autoInstall,
        managed: definition.managed,
        local: definition.local,
        note: definition.note,
      };
    } catch {
      // try the next command/candidate
    }
  }
  return {
    id: definition.id,
    name: definition.name,
    installed: false,
    installCommands: install(
      definition.install.darwin,
      definition.install.linux,
      definition.install.win32,
      definition.name,
    ),
    category: definition.category,
    languages: definition.languages,
    required: definition.required,
    autoInstall: definition.autoInstall,
    managed: definition.managed,
    local: definition.local,
    note: definition.note,
  };
}

export function normalizeLanguages(languages: string[] | undefined): string[] {
  const result = new Set<string>();
  for (const raw of languages ?? []) {
    const language = raw.toLowerCase();
    if (["javascript", "typescript", "jsx", "tsx", "node"].includes(language)) {
      result.add("typescript");
      result.add("javascript");
    } else if (["python", "py"].includes(language)) {
      result.add("python");
    } else if (language === "rust") {
      result.add("rust");
    } else if (language === "go" || language === "golang") {
      result.add("go");
    } else if (language === "php") {
      result.add("php");
    } else if (["html", "css", "json", "markdown"].includes(language)) {
      result.add(language);
    }
  }
  return [...result].sort();
}

export function recommendedToolIds(languages: string[], files: string[] = []): string[] {
  const ids = new Set<string>(["node", "npm", "git"]);
  const normalized = normalizeLanguages(languages);
  if (normalized.includes("typescript") || normalized.includes("javascript")) {
    ids.add("typescript-language-server");
    if (
      files.some((file) =>
        /(^|\/)(?:\.eslintrc|eslint\.config\.|eslint\.config$)/i.test(file),
      )
    ) {
      ids.add("eslint");
    }
    if (
      files.some((file) =>
        /(^|\/)(?:\.prettierrc|prettier\.config\.|prettier\.config$)/i.test(file),
      )
    ) {
      ids.add("prettier");
    }
  }
  if (normalized.includes("python")) ids.add("pyright");
  if (normalized.includes("rust")) ids.add("rust-analyzer");
  if (normalized.includes("go")) ids.add("gopls");
  if (normalized.includes("php")) ids.add("intelephense");
  if (files.some((file) => /(^|\/)dockerfile$/i.test(file) || /\.dockerfile$/i.test(file))) {
    ids.add("docker");
  }
  return [...ids];
}

const CACHE_MS = 45_000;
const cached = new Map<string, { report: ToolchainReport; at: number }>();

export async function checkToolchains(
  force = false,
  context: EnvironmentContext = {},
): Promise<ToolchainReport> {
  const languages = normalizeLanguages(context.languages);
  const cacheKey = `${context.rootPath ?? "global"}::${languages.join(",")}::${context.files?.length ?? 0}`;
  const hit = cached.get(cacheKey);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.report;

  const recommended = new Set(recommendedToolIds(languages, context.files));
  const tools = await Promise.all(
    DEFINITIONS.map(async (definition) => {
      const tool = await checkDefinition(definition, context.rootPath);
      return { ...tool, recommended: recommended.has(definition.id) };
    }),
  );
  const missing = tools.filter((tool) => !tool.installed).map((tool) => tool.id);
  const recommendedMissing = tools
    .filter((tool) => tool.recommended && !tool.installed)
    .map((tool) => tool.id);
  const report: ToolchainReport = {
    platform: platform(),
    tools,
    missing,
    languages,
    recommended: [...recommended],
    recommendedMissing,
    projectRoot: context.rootPath,
  };
  cached.set(cacheKey, { report, at: Date.now() });
  return report;
}

async function resolveInstallCommand(
  definition: Definition,
  platformName: Platform,
  projectRoot: string | undefined,
  command: string,
): Promise<{ command?: string; error?: string }> {
  // Project-local tools (eslint, prettier, TypeScript server) need a workspace;
  // otherwise npm would write into the app bundle and fail.
  if (definition.local === true && !projectRoot) {
    return {
      error: `${definition.name} installs into a project's dev dependencies. Open a project first, or run manually: ${command}`,
    };
  }
  if (command.startsWith("brew ")) {
    if (await hasCommand("brew")) return { command };
    if (definition.packageName && (await hasCommand("npm"))) {
      return { command: `npm install -g ${definition.packageName}` };
    }
    return {
      error: `Homebrew (brew) was not found. Install it from https://brew.sh, or run manually: ${command}`,
    };
  }
  if (command.startsWith("npm ")) {
    if (await hasCommand("npm")) return { command };
    return {
      error: `npm was not found. Install Node.js first, then run: ${command}`,
    };
  }
  if (command.startsWith("sudo ")) {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return { command: command.replace(/^sudo\s+/, "") };
    }
    const passwordless = await execFileAsync("sudo", ["-n", "true"], {
      timeout: 3_000,
      env: { ...process.env, PATH: toolchainPath() },
    })
      .then(() => true)
      .catch(() => false);
    if (!passwordless) {
      return {
        error: `Administrator permission is required. Run this in a terminal: ${command}`,
      };
    }
    return { command: command.replace(/^sudo\s+/, "sudo -n ") };
  }
  const executable = command.split(/\s+/)[0];
  if (executable && !(await hasCommand(executable))) {
    return {
      error: `"${executable}" was not found. Install it first, then run: ${command}`,
    };
  }
  return { command };
}

export async function installToolchain(
  id: string,
  projectRoot?: string,
): Promise<ToolchainInstallResult> {
  const definition = DEFINITIONS.find((item) => item.id === id);
  if (!definition) throw new Error("Unknown toolchain.");
  const report = await checkToolchains(true, { rootPath: projectRoot });
  const tool = report.tools.find((item) => item.id === id);
  if (!tool) throw new Error("Unknown toolchain.");
  if (tool.installed) {
    const note =
      id === "eslint" && projectRoot && !hasEslintConfig(projectRoot)
        ? " No eslint.config.js / .eslintrc file was found; add a config before using the lint command."
        : "";
    return { id, command: "", ok: true, output: `${tool.name} is already installed.${note}` };
  }
  const installCommand = tool.installCommands.find(
    (item) => item.platform === report.platform,
  )?.command;
  if (!installCommand) {
    throw new Error(`No automatic install command is available for ${tool.name} on ${report.platform}.`);
  }
  let command = installCommand;
  if (report.platform === "win32") {
    if ((await hasCommand("choco")) === false && command.startsWith("choco ")) {
      const wingetId = WINGET_IDS[id];
      if (wingetId && (await hasCommand("winget"))) {
        command = `winget install --id ${wingetId} -e --silent --accept-package-agreements --accept-source-agreements`;
      } else {
        return {
          id,
          command,
          ok: false,
          output: `${tool.name} needs Chocolatey, but choco was not found.${windowsInstallHint()}`,
        };
      }
    }
  }
  const resolved = await resolveInstallCommand(
    definition,
    report.platform,
    projectRoot,
    command,
  );
  if (resolved.error) {
    return { id, command, ok: false, output: resolved.error };
  }
  command = resolved.command ?? command;
  let output = "";
  try {
    const result = await execAsync(command, {
      timeout: 15 * 60_000,
      maxBuffer: 8 * 1024 * 1024,
      shell: process.platform === "win32" ? process.env.COMSPEC || "cmd.exe" : "/bin/bash",
      cwd: projectRoot,
      windowsHide: true,
      env: { ...process.env, PATH: toolchainPath() },
    });
    output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().slice(-8_000);
  } catch (error) {
    // The install may have added a binary; do not keep a stale "missing" cache.
    commandAvailability.clear();
    return {
      id,
      command,
      ok: false,
      output: `${error instanceof Error ? error.message : "Toolchain install failed."}${windowsInstallHint()}`.slice(-8_000),
    };
  }
  commandAvailability.clear();
  const after = await checkToolchains(true, { rootPath: projectRoot });
  const installedTool = after.tools.find((item) => item.id === id);
  if (!installedTool?.installed) {
    return {
      id,
      command,
      ok: false,
      output: `${output}\n\n${tool.name} is still not detected after the install command. Check the npm prefix/global path or run the command manually.`.trim(),
    };
  }
  const eslintNote =
    id === "eslint" && projectRoot && !hasEslintConfig(projectRoot)
      ? "ESLint is installed, but no eslint.config.js / .eslintrc file was found. Add a config (or run `npx eslint --init`) before using the lint command."
      : "";
  return {
    id,
    command,
    ok: true,
    output: `${output}${output ? "\n\n" : ""}${tool.name} ${installedTool.version ?? "installed"}.${eslintNote ? `\n\n${eslintNote}` : ""}`.trim(),
  };
}

export async function installRecommended(
  context: EnvironmentContext = {},
): Promise<{ results: ToolchainInstallResult[]; report: ToolchainReport }> {
  const report = await checkToolchains(true, context);
  const platformName = report.platform;
  const categoryRank = (tool: ToolchainTool): number =>
    tool.category === "runtime" || tool.category === "package-manager"
      ? 0
      : tool.category === "version-control"
        ? 1
        : tool.category === "lsp"
          ? 2
          : 3;
  const targets = report.tools
    .filter(
      (tool) =>
        tool.recommended &&
        !tool.installed &&
        (tool.autoInstall === true || tool.required === true) &&
        tool.installCommands.some((command) => command.platform === platformName),
    )
    .sort((left, right) => categoryRank(left) - categoryRank(right));
  const results: ToolchainInstallResult[] = [];
  for (const tool of targets) {
    if (tool.local === true && !context.rootPath) {
      results.push({
        id: tool.id,
        command: "",
        ok: false,
        skipped: true,
        output: `${tool.name} installs into a project's dev dependencies. Open a project first, or install it from the tool's Install button inside a project.`,
      });
      continue;
    }
    // Sequential installs keep package-manager state deterministic.
    // eslint-disable-next-line no-await-in-loop
    results.push(await installToolchain(tool.id, context.rootPath));
  }
  return { results, report: await checkToolchains(true, context) };
}
