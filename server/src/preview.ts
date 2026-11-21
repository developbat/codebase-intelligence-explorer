import fs from "node:fs/promises";
import path from "node:path";
import { isWithin } from "./scanner";

const MAX_PREVIEW_BYTES = 8_000_000;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".cjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
};

export interface PreviewFile {
  data: Buffer | string;
  mime: string;
  filePath: string;
}

export async function readPreviewFile(
  rootPath: string,
  projectId: string,
  requestedPath: string,
): Promise<PreviewFile> {
  let relative = requestedPath.replace(/^\/+/, "");
  if (!relative || relative.endsWith("/")) relative += "index.html";
  const absolute = path.resolve(rootPath, relative);
  if (!isWithin(rootPath, absolute)) throw new Error("Preview path is outside the project root.");
  const realRoot = await fs.realpath(rootPath);
  const realFile = await fs.realpath(absolute);
  if (!isWithin(realRoot, realFile)) throw new Error("Preview path is outside the project root.");
  const stat = await fs.stat(realFile);
  if (!stat.isFile()) throw new Error("Preview path is not a file.");
  if (stat.size > MAX_PREVIEW_BYTES) throw new Error("Preview file is too large.");
  const extension = path.extname(realFile).toLowerCase();
  const mime = MIME[extension] ?? "application/octet-stream";
  const buffer = await fs.readFile(realFile);
  const previewBase = `/api/projects/${projectId}/preview/`;
  const fileDirectory = path.posix.dirname(relative);
  const relativeBase = fileDirectory === "." ? previewBase : `${previewBase}${fileDirectory}/`;

  if (extension === ".html" || extension === ".htm") {
    let html = buffer.toString("utf8");
    html = html.replace(/(href|src|poster)=(["'])\/(?!\/)/gi, `$1=$2${previewBase}`);
    html = html.replace(
      /<head([^>]*)>/i,
      `<head$1><base href="${relativeBase}">`,
    );
    return { data: html, mime, filePath: relative };
  }

  if (extension === ".css") {
    const css = buffer.toString("utf8").replace(
      /url\((["']?)\/(?!\/)/gi,
      `url($1${previewBase}`,
    );
    return { data: css, mime, filePath: relative };
  }

  return { data: buffer, mime, filePath: relative };
}
