export type SkillScope = "project" | "global" | "external";

export interface SkillFile {
  path: string;
  bytes: number;
  kind: "markdown" | "script" | "reference" | "asset" | "other";
}

export interface SkillRecord {
  key: string;
  name: string;
  description: string;
  scope: SkillScope;
  source: string;
  sourceLabel: string;
  directory: string;
  enabled: boolean;
  hasScripts: boolean;
  hasReferences: boolean;
  allowedTools?: string;
  files: SkillFile[];
  bytes: number;
  updatedAt: string;
  warning?: string;
}

export interface SkillDetail extends SkillRecord {
  content: string;
  body: string;
}

export interface SkillSourceInfo {
  id: string;
  label: string;
  scope: SkillScope;
  directory: string;
  exists: boolean;
  skillCount: number;
}

export interface SkillListResponse {
  skills: SkillRecord[];
  sources: SkillSourceInfo[];
  enabledCount: number;
  limits: {
    maxPromptSkills: number;
    maxCharsPerSkill: number;
    maxTotalChars: number;
  };
}

export interface SkillScriptRunResult {
  command: string;
  output: string;
  exitCode: number | null;
  durationMs: number;
}

export interface SkillFileResponse {
  path: string;
  bytes: number;
  content: string;
}

export type SkillInstallScope = "project" | "global";

export interface SkillCandidate {
  id: string;
  name: string;
  description: string;
  relativePath: string;
  body: string;
  files: SkillFile[];
  bytes: number;
  hasScripts: boolean;
  hasReferences: boolean;
  allowedTools?: string;
}

export interface SkillSourcePreview {
  source: string;
  repository?: string;
  ref: string;
  hash?: string;
  candidates: SkillCandidate[];
  warnings: string[];
}

export interface SkillInstallRequest {
  source: string;
  ref?: string;
  skills: string[];
  scope: SkillInstallScope;
  enable?: boolean;
}

export interface InstalledSkillInfo {
  key: string;
  name: string;
  directory: string;
  scope: SkillInstallScope;
  source: string;
  ref: string;
  hash: string;
  commitSha?: string;
  enabled: boolean;
}

export interface SkillInstallResult {
  installed: InstalledSkillInfo[];
  skipped: string[];
  registryPath: string;
  warnings: string[];
}

export interface SkillCatalogItem {
  id: string;
  name: string;
  source: string;
  skillId: string;
  installs: number;
  url: string;
}

export interface SkillCatalogResponse {
  query: string;
  skills: SkillCatalogItem[];
}
