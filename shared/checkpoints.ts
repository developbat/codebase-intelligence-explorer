export interface CheckpointFile {
  path: string;
  existed: boolean;
  kind: "file" | "directory";
  bytes?: number;
  /** True when the original was too large to snapshot; restore will report it. */
  skipped?: boolean;
}

export interface ProjectCheckpoint {
  id: string;
  projectId: string;
  runId: string;
  goal: string;
  createdAt: string;
  updatedAt: string;
  status: "open" | "ready" | "restored";
  files: CheckpointFile[];
}

export interface RestoreCheckpointResult {
  checkpoint: ProjectCheckpoint;
  restored: number;
  deleted: number;
  failed: { path: string; error: string }[];
}
