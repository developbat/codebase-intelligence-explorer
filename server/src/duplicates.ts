import type { FileRecord } from "../../shared/types";

export interface DuplicateGroup {
  hash: string;
  bytes: number;
  paths: string[];
}

export interface DuplicateReport {
  scanned: number;
  groups: DuplicateGroup[];
  duplicateFiles: number;
  wastedBytes: number;
}

export interface StorageFolder {
  path: string;
  files: number;
  bytes: number;
}

export function findDuplicateFiles(
  files: FileRecord[],
  options: { path?: string; minBytes?: number; maxGroups?: number } = {},
): DuplicateReport {
  const prefix = options.path?.replace(/^\/+/, "").replace(/\/+$/, "");
  const minBytes = Math.max(0, Number(options.minBytes) || 0);
  const maxGroups = Math.max(1, Math.min(100, Number(options.maxGroups) || 30));
  const groups = new Map<string, DuplicateGroup>();
  let scanned = 0;

  for (const file of files) {
    if (!file.hash || file.bytes < minBytes) continue;
    if (prefix && file.path !== prefix && !file.path.startsWith(`${prefix}/`)) continue;
    scanned += 1;
    const key = `${file.bytes}:${file.hash}`;
    const existing = groups.get(key);
    if (existing) {
      existing.paths.push(file.path);
    } else {
      groups.set(key, { hash: file.hash, bytes: file.bytes, paths: [file.path] });
    }
  }

  const result = [...groups.values()]
    .filter((group) => group.paths.length > 1)
    .sort((a, b) => b.bytes * (b.paths.length - 1) - a.bytes * (a.paths.length - 1))
    .slice(0, maxGroups);

  return {
    scanned,
    groups: result,
    duplicateFiles: result.reduce((total, group) => total + group.paths.length - 1, 0),
    wastedBytes: result.reduce(
      (total, group) => total + group.bytes * (group.paths.length - 1),
      0,
    ),
  };
}

export function summarizeStorage(
  files: FileRecord[],
  options: { path?: string; top?: number } = {},
): { scanned: number; totalBytes: number; folders: StorageFolder[] } {
  const prefix = options.path?.replace(/^\/+/, "").replace(/\/+$/, "");
  const top = Math.max(1, Math.min(100, Number(options.top) || 12));
  const folders = new Map<string, StorageFolder>();
  let totalBytes = 0;
  let scanned = 0;

  for (const file of files) {
    if (prefix && file.path !== prefix && !file.path.startsWith(`${prefix}/`)) continue;
    const relative = prefix
      ? file.path.slice(prefix.length).replace(/^\/+/, "")
      : file.path;
    if (!relative) continue;
    const slash = relative.indexOf("/");
    const folder = slash === -1 ? "(root)" : relative.slice(0, slash);
    const key = prefix ? `${prefix}/${folder}` : folder;
    const entry = folders.get(key) ?? { path: key, files: 0, bytes: 0 };
    entry.files += 1;
    entry.bytes += file.bytes;
    folders.set(key, entry);
    totalBytes += file.bytes;
    scanned += 1;
  }

  return {
    scanned,
    totalBytes,
    folders: [...folders.values()].sort((a, b) => b.bytes - a.bytes).slice(0, top),
  };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}
