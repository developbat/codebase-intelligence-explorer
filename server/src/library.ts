import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir, loadAnalysis } from "./store";
import { isWithin } from "./scanner";

export type LibraryKind = "image" | "video";

export interface LibraryAsset {
  id: string;
  kind: LibraryKind;
  title: string;
  prompt?: string;
  url: string;
  fileName?: string;
  mime?: string;
  bytes?: number;
  provider?: string;
  model?: string;
  sourceProjectId?: string;
  createdAt: string;
}

interface LibraryIndex {
  version: 1;
  assets: LibraryAsset[];
}

function libraryRoot(): string {
  return path.join(getDataDir(), "library");
}

function indexPath(): string {
  return path.join(libraryRoot(), "index.json");
}

async function readIndex(): Promise<LibraryIndex> {
  try {
    const parsed = JSON.parse(await fs.readFile(indexPath(), "utf8")) as LibraryIndex;
    return {
      version: 1,
      assets: Array.isArray(parsed.assets) ? parsed.assets : [],
    };
  } catch {
    return { version: 1, assets: [] };
  }
}

async function writeIndex(index: LibraryIndex): Promise<void> {
  await fs.mkdir(libraryRoot(), { recursive: true, mode: 0o700 });
  const target = indexPath();
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify({ version: 1, assets: index.assets.slice(-500) }, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(temp, target);
}

export async function listLibrary(kind?: LibraryKind): Promise<LibraryAsset[]> {
  const index = await readIndex();
  return index.assets
    .filter((asset) => !kind || asset.kind === kind)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function addLibraryAsset(input: {
  url: string;
  kind: LibraryKind;
  title?: string;
  prompt?: string;
  fileName?: string;
  mime?: string;
  bytes?: number;
  provider?: string;
  model?: string;
  sourceProjectId?: string;
}): Promise<LibraryAsset> {
  const index = await readIndex();
  const existing = index.assets.find(
    (asset) => asset.url === input.url && asset.kind === input.kind,
  );
  if (existing) return existing;
  const asset: LibraryAsset = {
    id: `lib-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
    kind: input.kind,
    title: (input.title || input.prompt || "Generated asset").trim().slice(0, 160),
    prompt: input.prompt?.trim().slice(0, 2_000),
    url: input.url,
    fileName: input.fileName,
    mime: input.mime,
    bytes: input.bytes,
    provider: input.provider,
    model: input.model,
    sourceProjectId: input.sourceProjectId,
    createdAt: new Date().toISOString(),
  };
  index.assets.push(asset);
  await writeIndex(index);
  return asset;
}

function safeName(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "asset"
  );
}

function extensionFor(asset: LibraryAsset): string {
  if (asset.fileName) {
    const ext = path.extname(asset.fileName);
    if (ext) return ext;
  }
  if (asset.mime === "video/mp4") return ".mp4";
  if (asset.mime === "image/png") return ".png";
  if (asset.mime === "image/webp") return ".webp";
  if (asset.mime === "image/svg+xml") return ".svg";
  if (asset.kind === "video") return ".mp4";
  return ".jpg";
}

async function readAssetBytes(asset: LibraryAsset): Promise<Buffer> {
  if (asset.fileName) {
    const local = path.join(getDataDir(), "generated", path.basename(asset.fileName));
    const data = await fs.readFile(local).catch(() => null);
    if (data) return data;
  }
  if (asset.url.startsWith("/api/studio/media/")) {
    const file = path.basename(asset.url);
    const data = await fs
      .readFile(path.join(getDataDir(), "generated", path.basename(file)))
      .catch(() => null);
    if (data) return data;
  }
  if (/^https?:\/\//i.test(asset.url)) {
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Could not download the library asset (HTTP ${response.status}).`);
    return Buffer.from(await response.arrayBuffer());
  }
  throw new Error("This library asset has no readable file.");
}

export async function copyLibraryAssetToProject(
  assetId: string,
  projectId: string,
  targetPath?: string,
): Promise<{ path: string; bytes: number; asset: LibraryAsset }> {
  const index = await readIndex();
  const asset = index.assets.find((item) => item.id === assetId);
  if (!asset) throw new Error("Library asset not found.");
  const analysis = await loadAnalysis(projectId);
  const bytes = await readAssetBytes(asset);
  const extension = extensionFor(asset);
  const baseName = safeName(asset.title).replace(/\.[a-z0-9]+$/i, "");
  const relative = (
    targetPath?.trim() ||
    `assets/library/${baseName}-${asset.id.slice(-6)}${extension}`
  )
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  if (!relative || relative.split("/").some((part) => part === "..")) {
    throw new Error("Library copy path is outside the project.");
  }
  const target = path.resolve(analysis.rootPath, relative);
  if (!isWithin(analysis.rootPath, target)) {
    throw new Error("Library copy path is outside the project.");
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes);
  return { path: relative, bytes: bytes.length, asset };
}

export async function removeLibraryAsset(id: string): Promise<void> {
  const index = await readIndex();
  index.assets = index.assets.filter((asset) => asset.id !== id);
  await writeIndex(index);
}
