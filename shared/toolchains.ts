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
  /** Installs into the open project's dev dependencies instead of system-wide. */
  local?: boolean;
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
  runtime?: {
    /** True when the app ships its own Node LTS runtime. */
    bundled: boolean;
    /** Directory where app-managed tools are installed. */
    managedToolsDir: string;
    /** App data directory. */
    dataDir: string;
  };
}

export interface ToolchainInstallResult {
  id: string;
  command: string;
  ok: boolean;
  /** True when the tool needs an open project (or manual install) and was not run. */
  skipped?: boolean;
  output: string;
}
