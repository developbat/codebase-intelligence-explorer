import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ToolchainInstallCommand,
  ToolchainInstallResult,
  ToolchainReport,
  ToolchainTool,
} from "../../shared/toolchains";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

type Platform = "darwin" | "linux" | "win32";

interface Definition {
  id: string;
  name: string;
  commands: string[];
  args: string[];
  install: Partial<Record<Platform, string>>;
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

const DEFINITIONS: Definition[] = [
  { id: "node", name: "Node.js", commands: ["node"], args: ["--version"], install: {} },
  { id: "npm", name: "npm", commands: ["npm"], args: ["--version"], install: {} },
  { id: "git", name: "Git", commands: ["git"], args: ["--version"], install: {} },
  { id: "python3", name: "Python 3", commands: ["python3"], args: ["--version"], install: {} },
  { id: "php", name: "PHP", commands: ["php"], args: ["--version"], install: {} },
  { id: "composer", name: "Composer", commands: ["composer"], args: ["--version"], install: {} },
  {
    id: "go",
    name: "Go",
    commands: ["go"],
    args: ["version"],
    install: {
      darwin: "brew install go",
      linux: "sudo snap install go --classic",
      win32: "choco install golang -y",
    },
  },
  {
    id: "rustc",
    name: "Rust",
    commands: ["rustc"],
    args: ["--version"],
    install: {
      darwin: "brew install rust",
      linux: "sudo snap install rustup --classic",
      win32: "choco install rustup.install -y",
    },
  },
  {
    id: "cargo",
    name: "Cargo",
    commands: ["cargo"],
    args: ["--version"],
    install: {
      darwin: "brew install rust",
      linux: "sudo snap install rustup --classic",
      win32: "choco install rustup.install -y",
    },
  },
  {
    id: "ffmpeg",
    name: "FFmpeg",
    commands: ["ffmpeg"],
    args: ["-version"],
    install: {
      darwin: "brew install ffmpeg",
      linux: "sudo apt-get install -y ffmpeg",
      win32: "choco install ffmpeg -y",
    },
  },
  {
    id: "ffprobe",
    name: "FFprobe",
    commands: ["ffprobe"],
    args: ["-version"],
    install: {
      darwin: "brew install ffmpeg",
      linux: "sudo apt-get install -y ffmpeg",
      win32: "choco install ffmpeg -y",
    },
  },
  { id: "xcrun", name: "Xcode simctl", commands: ["xcrun"], args: ["--find", "simctl"], install: {} },
  { id: "adb", name: "Android adb", commands: ["adb"], args: ["version"], install: {} },
  { id: "emulator", name: "Android emulator", commands: ["emulator"], args: ["-version"], install: {} },
  { id: "pod", name: "CocoaPods", commands: ["pod"], args: ["--version"], install: {} },
  {
    id: "flutter",
    name: "Flutter",
    commands: ["flutter"],
    args: ["--version"],
    install: {
      darwin: "brew install --cask flutter",
      linux: "sudo snap install flutter --classic",
      win32: "choco install flutter -y",
    },
  },
  {
    id: "dart",
    name: "Dart",
    commands: ["dart"],
    args: ["--version"],
    install: {
      darwin: "brew install dart",
      linux: "sudo snap install dart --classic",
      win32: "choco install dart-sdk -y",
    },
  },
  {
    id: "godot",
    name: "Godot 4",
    commands: ["godot", "godot4"],
    args: ["--version"],
    install: {
      darwin: "brew install --cask godot",
      linux: "sudo snap install godot",
      win32: "choco install godot -y",
    },
  },
];

function platform(): Platform {
  return process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";
}

async function checkDefinition(definition: Definition): Promise<ToolchainTool> {
  for (const command of definition.commands) {
    try {
      const result = await execFileAsync(command, definition.args, {
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
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
      };
    } catch {
      // try next command/candidate
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
  };
}

let cachedReport: { report: ToolchainReport; at: number } | null = null;
const CACHE_MS = 45_000;

export async function checkToolchains(force = false): Promise<ToolchainReport> {
  if (!force && cachedReport && Date.now() - cachedReport.at < CACHE_MS) {
    return cachedReport.report;
  }
  const tools = await Promise.all(DEFINITIONS.map((definition) => checkDefinition(definition)));
  const report: ToolchainReport = {
    platform: platform(),
    tools,
    missing: tools.filter((tool) => !tool.installed).map((tool) => tool.id),
  };
  cachedReport = { report, at: Date.now() };
  return report;
}

export async function installToolchain(id: string): Promise<ToolchainInstallResult> {
  const report = await checkToolchains();
  const tool = report.tools.find((item) => item.id === id);
  if (!tool) throw new Error("Unknown toolchain.");
  if (tool.installed) {
    return { id, command: "", ok: true, output: `${tool.name} is already installed.` };
  }
  const command = tool.installCommands.find((item) => item.platform === report.platform)?.command;
  if (!command) throw new Error(`No automatic install command is available for ${tool.name} on ${report.platform}.`);
  try {
    const result = await execAsync(command, {
      timeout: 10 * 60_000,
      maxBuffer: 5 * 1024 * 1024,
      shell: "/bin/bash",
    });
    return {
      id,
      command,
      ok: true,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().slice(-8_000),
    };
  } catch (error) {
    return {
      id,
      command,
      ok: false,
      output: (error instanceof Error ? error.message : "Toolchain install failed.").slice(-8_000),
    };
  }
}
