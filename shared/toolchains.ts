export interface ToolchainInstallCommand {
  platform: "darwin" | "linux" | "win32";
  command: string;
  label: string;
}

export interface ToolchainTool {
  id: string;
  name: string;
  installed: boolean;
  version?: string;
  installCommands: ToolchainInstallCommand[];
}

export interface ToolchainReport {
  platform: "darwin" | "linux" | "win32";
  tools: ToolchainTool[];
  missing: string[];
}

export interface ToolchainInstallResult {
  id: string;
  command: string;
  ok: boolean;
  output: string;
}
