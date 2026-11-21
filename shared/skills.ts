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

export interface SkillFileResponse {
  path: string;
  bytes: number;
  content: string;
}
