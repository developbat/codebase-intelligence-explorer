import fg from "fast-glob";
import fs from "node:fs/promises";
import path from "node:path";
import { isWithin } from "./scanner";

const MAX_ICON_BYTES = 2_000_000;

const ICON_CANDIDATES = [
  "public/favicon.ico",
  "public/favicon.png",
  "public/favicon.svg",
  "public/icon.png",
  "public/icon.svg",
  "public/logo.png",
  "public/logo.svg",
  "public/apple-touch-icon.png",
  "app/favicon.ico",
  "app/icon.png",
  "app/icon.svg",
  "src/app/favicon.ico",
  "src/app/icon.png",
  "src/app/icon.svg",
  "web/public/favicon.ico",
  "web/public/favicon.png",
  "web/public/icon.png",
  "web/public/logo.png",
  "static/favicon.ico",
  "static/icon.png",
  "static/logo.png",
  "assets/icon.png",
  "assets/logo.png",
  "resources/icon.png",
  "resources/logo.png",
  "favicon.ico",
  "favicon.png",
  "icon.png",
  "logo.png",
  "logo.svg",
];

const MIME_BY_EXTENSION: Record<string, string> = {
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

const ICON_GLOBS = [
  "**/favicon.{ico,png,svg,webp}",
  "**/{icon,logo,apple-touch-icon}.{png,svg,jpg,jpeg,webp,ico}",
];

const ICON_IGNORES = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/coverage/**",
  "**/vendor/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/.cache/**",
  "**/Pods/**",
  "**/DerivedData/**",
];

export interface ProjectIcon {
  data: Buffer;
  mime: string;
  relativePath: string;
}

function mimeFor(filePath: string): string | null {
  return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? null;
}

async function readIcon(root: string, realRoot: string, relativePath: string): Promise<ProjectIcon | null> {
  try {
    const absolute = path.resolve(root, relativePath);
    if (!isWithin(root, absolute)) return null;
    const realIcon = await fs.realpath(absolute);
    if (!isWithin(realRoot, realIcon)) return null;
    const stat = await fs.stat(realIcon);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_ICON_BYTES) return null;
    const mime = mimeFor(realIcon);
    if (!mime) return null;
    return { data: await fs.readFile(realIcon), mime, relativePath };
  } catch {
    return null;
  }
}

function iconScore(filePath: string): number {
  const name = path.basename(filePath).toLowerCase();
  if (name.startsWith("logo")) return 0;
  if (name.startsWith("icon")) return 1;
  if (name.startsWith("apple-touch-icon")) return 2;
  if (name.startsWith("favicon")) return 3;
  return 4;
}

function depthOf(filePath: string): number {
  return filePath.split("/").length;
}

/**
 * Finds a local project icon without reading arbitrary files. Only common
 * favicon/logo/icon names and image extensions are considered.
 */
export async function findProjectIcon(rootPath: string): Promise<ProjectIcon | null> {
  const root = await fs.realpath(rootPath);
  for (const candidate of ICON_CANDIDATES) {
    if (!mimeFor(candidate)) continue;
    const icon = await readIcon(root, root, candidate);
    if (icon) return icon;
  }

  try {
    const matches = await fg(ICON_GLOBS, {
      cwd: root,
      onlyFiles: true,
      dot: false,
      followSymbolicLinks: false,
      ignore: ICON_IGNORES,
      suppressErrors: true,
    });
    const sorted = matches
      .filter((file) => mimeFor(file))
      .sort((a, b) => iconScore(a) - iconScore(b) || depthOf(a) - depthOf(b) || a.localeCompare(b))
      .slice(0, 12);
    for (const candidate of sorted) {
      const icon = await readIcon(root, root, candidate);
      if (icon) return icon;
    }
  } catch {
    // no icon is a normal result
  }

  return null;
}
