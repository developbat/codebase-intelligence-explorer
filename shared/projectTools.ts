export interface ProjectTool {
  name: string;
  description: string;
  command: string;
  tags: string[];
  source: "auto" | "manual";
  path?: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  successCount: number;
  failureCount: number;
}

export interface ProjectToolList {
  tools: ProjectTool[];
  directory: string;
  registryPath: string;
}
