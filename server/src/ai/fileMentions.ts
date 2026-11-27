import fs from "node:fs/promises";
import path from "node:path";
import { isWithin } from "../scanner";

export interface FileMention {
  path: string;
  content: string;
  truncated: boolean;
}

const MENTION_PATTERN = /(?:^|[\s(])@([A-Za-z0-9_./\\-]+)/g;
const DENIED_SEGMENTS = /(^|\/)(?:node_modules|\.git|\.cie|dist|build|coverage|vendor)(\/|$)/i;
const SECRET_FILE = /(^|\/)(?:\.env(?:\.|$)|[^/]+\.(?:pem|key|p12|pfx)|id_rsa|id_ed25519)$/i;

export function extractFileMentions(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(MENTION_PATTERN)) {
    let value = match[1].replace(/\\/g, "/").replace(/^\.\//, "").replace(/[.,;:!?]+$/, "");
    if (!value || value.includes("..")) continue;
    if (DENIED_SEGMENTS.test(value) || SECRET_FILE.test(value)) continue;
    if (!found.includes(value)) found.push(value);
  }
  return found.slice(0, 6);
}

export async function readFileMentions(
  rootPath: string,
  text: string,
  options: { maxFiles?: number; maxCharsPerFile?: number } = {},
): Promise<FileMention[]> {
  const maxFiles = Math.max(1, Math.min(6, options.maxFiles ?? 4));
  const maxChars = Math.max(500, Math.min(12_000, options.maxCharsPerFile ?? 5_000));
  const realRoot = await fs.realpath(rootPath).catch(() => rootPath);
  const mentions: FileMention[] = [];

  for (const relative of extractFileMentions(text).slice(0, maxFiles)) {
    const absolute = path.resolve(realRoot, relative);
    if (!isWithin(realRoot, absolute)) continue;
    let real = absolute;
    try {
      real = await fs.realpath(absolute);
    } catch {
      continue;
    }
    if (!isWithin(realRoot, real)) continue;
    const stat = await fs.stat(real).catch(() => null);
    if (!stat?.isFile()) continue;
    const raw = await fs.readFile(real, "utf8").catch(() => null);
    if (raw === null) continue;
    const truncated = raw.length > maxChars;
    mentions.push({
      path: relative,
      content: truncated ? `${raw.slice(0, maxChars)}\n… mention truncated …` : raw,
      truncated,
    });
  }
  return mentions;
}

export function formatFileMentions(mentions: FileMention[]): string {
  if (mentions.length === 0) return "";
  return [
    "## Explicitly referenced files (@mentions)",
    "The user pinned these files with @path. Read them first and do not replace their contents without checking the request.",
    "",
    ...mentions.map((mention) => `### ${mention.path}\n\`\`\`\n${mention.content}\n\`\`\``),
  ].join("\n");
}
