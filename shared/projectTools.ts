export interface ProjectToolInputSchema {
  type?: "object";
  required?: string[];
  properties?: Record<
    string,
    {
      type?: "string" | "number" | "boolean" | "array" | "object";
      description?: string;
      enum?: Array<string | number | boolean>;
    }
  >;
}

export interface ProjectTool {
  name: string;
  description: string;
  whenToUse?: string;
  inputSchema?: ProjectToolInputSchema;
  timeoutMs?: number;
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
