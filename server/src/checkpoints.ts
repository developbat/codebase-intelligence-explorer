import fs from "node:fs/promises";
import path from "node:path";
import type {
  CheckpointFile,
  ProjectCheckpoint,
  RestoreCheckpointResult,
} from "../../shared/checkpoints";
import { getDataDir } from "./store";
import { isWithin } from "./scanner";
import { isSecretProjectPath } from "./editor";

interface InternalCheckpointFile extends CheckpointFile {
  snapshot?: string;
}

interface InternalCheckpoint extends Omit<ProjectCheckpoint, "files"> {
  files: InternalCheckpointFile[];
}

const MAX_SNAPSHOT_BYTES = 8_000_000;
const KEEP_CHECKPOINTS = 20;

function safeProjectId(projectId: string): string | null {
  return /^[A-Za-z0-9_-]{1,80}$/.test(projectId) ? projectId : null;
}

function checkpointsRoot(projectId: string): string {
  return path.join(getDataDir(), "checkpoints", projectId);
}

function checkpointDir(projectId: string, checkpointId: string): string {
  return path.join(checkpointsRoot(projectId), checkpointId);
}

function manifestPath(projectId: string, checkpointId: string): string {
  return path.join(checkpointDir(projectId, checkpointId), "checkpoint.json");
}

function publicCheckpoint(checkpoint: InternalCheckpoint): ProjectCheckpoint {
  return {
    ...checkpoint,
    files: checkpoint.files.map(({ snapshot: _snapshot, ...file }) => file),
  };
}

async function writeManifest(checkpoint: InternalCheckpoint): Promise<void> {
  const file = manifestPath(checkpoint.projectId, checkpoint.id);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(checkpoint, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(temp, file);
}

async function readManifest(
  projectId: string,
  checkpointId: string,
): Promise<InternalCheckpoint | null> {
  if (!safeProjectId(projectId) || !/^[A-Za-z0-9_-]{1,120}$/.test(checkpointId)) return null;
  try {
    const raw = await fs.readFile(manifestPath(projectId, checkpointId), "utf8");
    return JSON.parse(raw) as InternalCheckpoint;
  } catch {
    return null;
  }
}

async function ensureSafeParent(rootPath: string, absolute: string): Promise<void> {
  if (!isWithin(rootPath, absolute)) throw new Error("Checkpoint path is outside the project.");
  await fs.mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
}

async function pruneCheckpoints(projectId: string, keepId?: string): Promise<void> {
  const root = checkpointsRoot(projectId);
  const entries = await fs.readdir(root).catch(() => [] as string[]);
  const withStats = await Promise.all(
    entries.map(async (name) => {
      const stat = await fs.stat(path.join(root, name)).catch(() => null);
      return { name, mtime: stat?.mtimeMs ?? 0 };
    }),
  );
  const stale = withStats
    .filter((entry) => entry.name !== keepId)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(KEEP_CHECKPOINTS - 1);
  await Promise.all(
    stale.map((entry) =>
      fs.rm(path.join(root, entry.name), { recursive: true, force: true }).catch(() => undefined),
    ),
  );
}

export class CheckpointRecorder {
  constructor(
    private readonly checkpoint: InternalCheckpoint,
    private readonly rootPath: string,
  ) {}

  private async rememberPath(relativePath: string): Promise<void> {
    if (this.checkpoint.files.some((file) => file.path === relativePath)) return;
    const relative = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!relative || relative.startsWith("..") || isSecretProjectPath(relative)) return;
    const absolute = path.resolve(this.rootPath, relative);
    if (!isWithin(this.rootPath, absolute)) return;
    const stat = await fs.lstat(absolute).catch(() => null);
    if (!stat) {
      this.checkpoint.files.push({ path: relative, existed: false, kind: "file" });
      await writeManifest(this.checkpoint);
      return;
    }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      this.checkpoint.files.push({ path: relative, existed: true, kind: "directory" });
      const entries = await fs.readdir(absolute, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isSymbolicLink()) {
          await this.rememberPath(`${relative}/${entry.name}`);
        }
      }
      await writeManifest(this.checkpoint);
      return;
    }
    if (!stat.isFile()) return;

    const snapshotRelative = `files/${this.checkpoint.files.length}-${relative.replace(
      /[\\/]/g,
      "__",
    )}`;
    const snapshotAbsolute = path.join(
      checkpointDir(this.checkpoint.projectId, this.checkpoint.id),
      snapshotRelative,
    );
    const restorable = stat.size <= MAX_SNAPSHOT_BYTES;
    if (restorable) {
      await fs.mkdir(path.dirname(snapshotAbsolute), { recursive: true, mode: 0o700 });
      await fs.copyFile(absolute, snapshotAbsolute);
    }
    this.checkpoint.files.push({
      path: relative,
      existed: true,
      kind: "file",
      bytes: stat.size,
      ...(restorable ? { snapshot: snapshotRelative } : { skipped: true }),
    });
    await writeManifest(this.checkpoint);
  }

  /** Remember the pre-run state of a file or directory before the agent mutates it. */
  async remember(relativePath: string): Promise<void> {
    await this.rememberPath(relativePath);
    this.checkpoint.updatedAt = new Date().toISOString();
    await writeManifest(this.checkpoint).catch(() => undefined);
  }

  async finalize(): Promise<void> {
    this.checkpoint.status = "ready";
    this.checkpoint.updatedAt = new Date().toISOString();
    if (this.checkpoint.files.length === 0) {
      await fs
        .rm(checkpointDir(this.checkpoint.projectId, this.checkpoint.id), {
          recursive: true,
          force: true,
        })
        .catch(() => undefined);
      return;
    }
    await writeManifest(this.checkpoint).catch(() => undefined);
  }
}

export async function beginCheckpoint(
  projectId: string,
  rootPath: string,
  runId: string,
  goal: string,
): Promise<CheckpointRecorder | null> {
  if (!safeProjectId(projectId)) return null;
  const id = `cp_${runId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 110)}`;
  const now = new Date().toISOString();
  const checkpoint: InternalCheckpoint = {
    id,
    projectId,
    runId,
    goal: goal.trim().slice(0, 600),
    createdAt: now,
    updatedAt: now,
    status: "open",
    files: [],
  };
  await fs.mkdir(checkpointDir(projectId, id), { recursive: true, mode: 0o700 });
  await writeManifest(checkpoint);
  await pruneCheckpoints(projectId, id);
  return new CheckpointRecorder(checkpoint, rootPath);
}

export async function listCheckpoints(projectId: string): Promise<ProjectCheckpoint[]> {
  if (!safeProjectId(projectId)) return [];
  const root = checkpointsRoot(projectId);
  const entries = await fs.readdir(root).catch(() => [] as string[]);
  const checkpoints = await Promise.all(
    entries.map((id) => readManifest(projectId, id)),
  );
  return checkpoints
    .filter(
      (checkpoint): checkpoint is InternalCheckpoint =>
        Boolean(checkpoint && checkpoint.files.length > 0),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, KEEP_CHECKPOINTS)
    .map(publicCheckpoint);
}

export async function restoreCheckpoint(
  projectId: string,
  rootPath: string,
  checkpointId: string,
): Promise<RestoreCheckpointResult> {
  const checkpoint = await readManifest(projectId, checkpointId);
  if (!checkpoint) throw new Error("Checkpoint not found.");
  if (checkpoint.files.length === 0) throw new Error("This checkpoint has no files to restore.");

  let restored = 0;
  let deleted = 0;
  const failed: { path: string; error: string }[] = [];

  const restoreEntry = async (entry: InternalCheckpointFile): Promise<void> => {
    const relative = entry.path.replace(/\\/g, "/").replace(/^\/+/, "");
    if (isSecretProjectPath(relative)) {
      failed.push({ path: entry.path, error: "Secret project paths are never restored." });
      return;
    }
    const absolute = path.resolve(rootPath, relative);
    if (!isWithin(rootPath, absolute)) {
      failed.push({ path: entry.path, error: "Path is outside the project." });
      return;
    }

    if (!entry.existed) {
      try {
        const stat = await fs.lstat(absolute).catch(() => null);
        if (stat) await fs.rm(absolute, { recursive: true, force: true });
        deleted += 1;
      } catch (error) {
        failed.push({
          path: entry.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (entry.kind === "directory") {
      try {
        await fs.mkdir(absolute, { recursive: true, mode: 0o700 });
        restored += 1;
      } catch (error) {
        failed.push({
          path: entry.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (!entry.snapshot) {
      failed.push({
        path: entry.path,
        error: entry.skipped
          ? "Original file was too large to snapshot."
          : "Checkpoint snapshot is missing.",
      });
      return;
    }
    try {
      const snapshot = path.join(
        checkpointDir(projectId, checkpointId),
        entry.snapshot,
      );
      await ensureSafeParent(rootPath, absolute);
      await fs.copyFile(snapshot, absolute);
      restored += 1;
    } catch (error) {
      failed.push({
        path: entry.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // Restore existing paths first, then remove paths that did not exist before.
  for (const entry of checkpoint.files.filter((file) => file.existed)) {
    await restoreEntry(entry);
  }
  for (const entry of checkpoint.files.filter((file) => !file.existed)) {
    await restoreEntry(entry);
  }

  checkpoint.status = "restored";
  checkpoint.updatedAt = new Date().toISOString();
  await writeManifest(checkpoint).catch(() => undefined);
  return {
    checkpoint: publicCheckpoint(checkpoint),
    restored,
    deleted,
    failed,
  };
}
