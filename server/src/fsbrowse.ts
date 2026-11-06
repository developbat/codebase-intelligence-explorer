import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FolderEntry, FolderListing, QuickLocation } from "../../shared/types";

function expand(input: string): string {
  if (!input) return os.homedir();
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

export async function quickLocations(): Promise<QuickLocation[]> {
  const candidates: QuickLocation[] = [
    { id: "home", label: "Home", path: os.homedir() },
    { id: "desktop", label: "Desktop", path: path.join(os.homedir(), "Desktop") },
    { id: "documents", label: "Documents", path: path.join(os.homedir(), "Documents") },
    { id: "downloads", label: "Downloads", path: path.join(os.homedir(), "Downloads") },
  ];
  if (process.platform === "darwin") candidates.push({ id: "volumes", label: "Volumes", path: "/Volumes" });
  candidates.push({ id: "root", label: "Root", path: path.parse(os.homedir()).root });

  const available: QuickLocation[] = [];
  const seen = new Set<string>();
  for (const location of candidates) {
    if (seen.has(location.path)) continue;
    if (await isDirectory(location.path)) {
      seen.add(location.path);
      available.push(location);
    }
  }
  return available;
}

export async function listFolders(inputPath: string | undefined): Promise<FolderListing> {
  let requested = expand(inputPath ?? "");
  try {
    requested = await fs.realpath(requested);
  } catch {
    // fall back to home when the requested path does not exist
    requested = os.homedir();
  }

  const stat = await fs.stat(requested);
  if (!stat.isDirectory()) throw new Error("The selected path is not a folder.");

  const dirents = await fs.readdir(requested, { withFileTypes: true });
  const entries: FolderEntry[] = [];

  for (const dirent of dirents) {
    const absolute = path.join(requested, dirent.name);
    let directory = dirent.isDirectory();
    const symlink = dirent.isSymbolicLink();
    if (!directory && symlink) {
      directory = await isDirectory(absolute);
    }
    if (!directory) continue;
    entries.push({
      name: dirent.name,
      path: absolute,
      hidden: dirent.name.startsWith("."),
      symlink,
    });
  }

  entries.sort((a, b) => {
    if (a.hidden !== b.hidden) return a.hidden ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  const parent = path.dirname(requested);
  return {
    path: requested,
    parent: parent === requested ? null : parent,
    entries: entries.slice(0, 1000),
    quickLocations: await quickLocations(),
  };
}
