import dns from "node:dns/promises";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { isWithin } from "./scanner";

const MAX_FETCH_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 16_000;
const FETCH_TIMEOUT_MS = 20_000;
const NOTES_DIR = ".cie/agent/notes";
const MAX_NOTE_CHARS = 120_000;
const MAX_NOTES = 400;

export interface WebFetchResult {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  title?: string;
  bytes: number;
  text: string;
  truncated: boolean;
}

export interface ResearchNoteInfo {
  path: string;
  title: string;
  tags: string[];
  sources: string[];
  bytes: number;
  updatedAt?: string;
}

function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const parts = address.split(".").map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    return false;
  }
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    return (
      normalized === "::1" ||
      normalized === "::" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80") ||
      normalized.startsWith("::ffff:127.") ||
      normalized.startsWith("::ffff:10.") ||
      normalized.startsWith("::ffff:192.168.")
    );
  }
  return false;
}

async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs are allowed.");
  }
  if (url.username || url.password) {
    throw new Error("URLs with embedded credentials are not allowed.");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new Error("Local and internal hosts are not allowed for web fetch.");
  }
  const addresses = net.isIP(host)
    ? [{ address: host }]
    : await dns.lookup(host, { all: true }).catch(() => []);
  if (addresses.length === 0) throw new Error("Could not resolve the URL host.");
  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error("Private, loopback and link-local addresses are not allowed for web fetch.");
  }
  return url;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

export function extractReadableText(html: string): { title?: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
  const cleaned = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|li|h[1-6]|tr|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = decodeEntities(cleaned)
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title: title ? decodeEntities(title) : undefined, text };
}

export async function webFetch(rawUrl: string, maxChars = 12_000): Promise<WebFetchResult> {
  let current = rawUrl.trim();
  let response: Response | null = null;
  for (let redirect = 0; redirect <= 4; redirect += 1) {
    const url = await assertPublicUrl(current);
    response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "User-Agent": "codebase-intelligence-explorer/0.2 research fetch",
        Accept: "text/html,application/xhtml+xml,text/plain,application/json,text/markdown;q=0.9,*/*;q=0.5",
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) break;
      current = new URL(location, url).toString();
      continue;
    }
    break;
  }
  if (!response) throw new Error("Web fetch failed.");
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (
    contentType &&
    !/text\/|application\/(json|xml|xhtml|javascript)/i.test(contentType)
  ) {
    throw new Error(`Unsupported content type: ${contentType.split(";")[0]}`);
  }
  const declared = Number(response.headers.get("content-length")) || 0;
  if (declared > MAX_FETCH_BYTES) throw new Error("Page is larger than the 2 MB fetch limit.");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_FETCH_BYTES) throw new Error("Page is larger than the 2 MB fetch limit.");
  const raw = buffer.toString("utf8");
  const isHtml = /html|xhtml/i.test(contentType) || /<html|<body|<p\b/i.test(raw.slice(0, 2_000));
  const extracted = isHtml
    ? extractReadableText(raw)
    : { title: undefined, text: decodeEntities(raw).trim() };
  const limit = Math.max(1_000, Math.min(MAX_TEXT_CHARS, Math.floor(maxChars)));
  const text = extracted.text.slice(0, limit);
  return {
    url: rawUrl,
    finalUrl: response.url || current,
    status: response.status,
    contentType: contentType.split(";")[0] || "unknown",
    title: extracted.title,
    bytes: buffer.length,
    text,
    truncated: extracted.text.length > text.length,
  };
}

function notesDir(rootPath: string): string {
  return path.join(rootPath, NOTES_DIR);
}

function slugify(value: string): string {
  const map: Record<string, string> = {
    ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u",
    Ç: "c", Ğ: "g", İ: "i", Ö: "o", Ş: "s", Ü: "u",
  };
  return value
    .replace(/[çğıöşüÇĞİÖŞÜ]/g, (char) => map[char] ?? char)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "note";
}

function parseFrontmatter(content: string): {
  title?: string;
  tags: string[];
  sources: string[];
  updatedAt?: string;
  body: string;
} {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(content);
  if (!match) return { tags: [], sources: [], body: content };
  const meta = match[1];
  const body = content.slice(match[0].length);
  const title = /^title:\s*(.+)$/m.exec(meta)?.[1]?.trim();
  const updatedAt = /^updated:\s*(.+)$/m.exec(meta)?.[1]?.trim();
  const list = (key: string): string[] => {
    const line = new RegExp(`^${key}:\\s*\\[(.*)\\]$`, "m").exec(meta)?.[1];
    return line
      ? line
          .split(",")
          .map((item) => item.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean)
      : [];
  };
  return { title, tags: list("tags"), sources: list("sources"), updatedAt, body };
}

function notePath(rootPath: string, relativePath: string): string {
  const requested = relativePath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!requested) throw new Error("A note path is required.");
  const withExtension = requested.endsWith(".md") ? requested : `${requested}.md`;
  const absolute = withExtension.startsWith(`${NOTES_DIR}/`)
    ? path.resolve(rootPath, withExtension)
    : path.resolve(rootPath, NOTES_DIR, withExtension);
  if (!isWithin(notesDir(rootPath), absolute)) throw new Error("Note path is outside the notes folder.");
  return absolute;
}

export async function saveResearchNote(
  rootPath: string,
  input: {
    title: string;
    content: string;
    tags?: string[];
    sources?: string[];
    name?: string;
    append?: boolean;
  },
): Promise<{ path: string; title: string; bytes: number }> {
  const title = input.title.trim().slice(0, 200);
  const content = input.content.trim();
  if (!title) throw new Error("A note title is required.");
  if (!content) throw new Error("Note content is required.");
  if (content.length > MAX_NOTE_CHARS) throw new Error("Note is too large (120k character limit).");
  const fileName = `${slugify(input.name || title)}.md`;
  const absolute = notePath(rootPath, fileName);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const entries = await fs.readdir(notesDir(rootPath)).catch(() => [] as string[]);
  if (!entries.includes(fileName) && entries.filter((entry) => entry.endsWith(".md")).length >= MAX_NOTES) {
    throw new Error(`Notes limit reached (${MAX_NOTES}).`);
  }
  let tags = (input.tags ?? []).map((tag) => tag.trim().slice(0, 40)).filter(Boolean).slice(0, 12);
  let sources = (input.sources ?? []).map((source) => source.trim().slice(0, 500)).filter(Boolean).slice(0, 12);
  const now = new Date().toISOString();
  let body = content;
  if (input.append) {
    const existing = await fs.readFile(absolute, "utf8").catch(() => "");
    if (existing) {
      const parsed = parseFrontmatter(existing);
      if (tags.length === 0) tags = parsed.tags;
      if (sources.length === 0) sources = parsed.sources;
      body = `${parsed.body.trim()}\n\n---\n\n${content}`;
    }
  }
  const document = `---\ntitle: ${title}\ntags: [${tags.join(", ")}]\nsources: [${sources.join(", ")}]\nupdated: ${now}\n---\n\n${body}\n`;
  await fs.writeFile(absolute, document, "utf8");
  return {
    path: path.relative(rootPath, absolute),
    title,
    bytes: Buffer.byteLength(document, "utf8"),
  };
}

export async function listResearchNotes(rootPath: string): Promise<ResearchNoteInfo[]> {
  const dir = notesDir(rootPath);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const notes: ResearchNoteInfo[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const absolute = path.join(dir, entry.name);
    const [content, stat] = await Promise.all([
      fs.readFile(absolute, "utf8").catch(() => ""),
      fs.stat(absolute).catch(() => null),
    ]);
    const parsed = parseFrontmatter(content);
    notes.push({
      path: path.relative(rootPath, absolute),
      title: parsed.title ?? entry.name.replace(/\.md$/, ""),
      tags: parsed.tags,
      sources: parsed.sources,
      bytes: stat?.size ?? Buffer.byteLength(content, "utf8"),
      updatedAt: parsed.updatedAt ?? stat?.mtime.toISOString(),
    });
  }
  return notes.sort((a, b) => (a.updatedAt ?? "").localeCompare(b.updatedAt ?? "")).reverse();
}

export async function readResearchNote(
  rootPath: string,
  relativePath: string,
): Promise<{ path: string; title: string; tags: string[]; sources: string[]; content: string }> {
  const absolute = notePath(rootPath, relativePath);
  const content = await fs.readFile(absolute, "utf8").catch(() => {
    throw new Error("Note not found.");
  });
  if (Buffer.byteLength(content, "utf8") > 500_000) throw new Error("Note is too large to read.");
  const parsed = parseFrontmatter(content);
  return {
    path: path.relative(rootPath, absolute),
    title: parsed.title ?? path.basename(relativePath, ".md"),
    tags: parsed.tags,
    sources: parsed.sources,
    content,
  };
}

export async function searchResearchNotes(
  rootPath: string,
  query: string,
  limit = 10,
): Promise<{ path: string; title: string; snippet: string; score: number }[]> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const tokens = needle.split(/\s+/).filter((token) => token.length > 1);
  const results: { path: string; title: string; snippet: string; score: number }[] = [];
  for (const note of await listResearchNotes(rootPath)) {
    const absolute = path.resolve(rootPath, note.path);
    const content = await fs.readFile(absolute, "utf8").catch(() => "");
    const haystack = `${note.title}\n${content}`.toLowerCase();
    let score = haystack.includes(needle) ? 6 : 0;
    for (const token of tokens) if (haystack.includes(token)) score += 1;
    if (score === 0) continue;
    const index = haystack.indexOf(tokens[0] ?? needle);
    const snippet = content.slice(Math.max(0, index - 80), Math.max(0, index - 80) + 260).replace(/\s+/g, " ");
    results.push({ path: note.path, title: note.title, snippet: snippet.trim(), score });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(30, limit)));
}
