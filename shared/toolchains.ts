export interface ToolchainInstallCommand {
  platform: "darwin" | "linux" | "win32";
  command: string;
  label: string;
}

export type ToolchainCategory =
  | "runtime"
  | "package-manager"
  | "version-control"
  | "lsp"
  | "linter"
  | "formatter"
  | "container"
  | "document"
  | "media"
  | "mobile"
  | "game"
  | "other";

export interface ToolchainTool {
  id: string;
  name: string;
  installed: boolean;
  version?: string;
  installCommands: ToolchainInstallCommand[];
  category: ToolchainCategory;
  languages?: string[];
  /** Required for the editor itself, not only for a language. */
  required?: boolean;
  /** Recommended by the current project's languages/files. */
  recommended?: boolean;
  /** Safe to install from the "Install recommended" action. */
  autoInstall?: boolean;
  /** The app can manage this tool locally instead of a system-wide install. */
  managed?: boolean;
  note?: string;
}

export interface ToolchainReport {
  platform: "darwin" | "linux" | "win32";
  tools: ToolchainTool[];
  missing: string[];
  languages: string[];
  recommended: string[];
  recommendedMissing: string[];
  projectRoot?: string;
}

export interface ToolchainInstallResult {
  id: string;
  command: string;
  ok: boolean;
  output: string;
}
