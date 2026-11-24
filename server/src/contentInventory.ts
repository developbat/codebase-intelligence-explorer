import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { AnalysisResult } from "../../shared/types";
import type {
  BrokenReference,
  ContentAsset,
  ContentInventory,
  ContentReference,
  MarkdownInventory,
} from "../../shared/contentInventory";

const ASSET_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "tiff", "svg", "ico", "pdf",
  "woff", "woff2", "ttf", "otf", "eot", "mp3", "wav", "ogg", "aac", "flac",
  "m4a", "mp4", "webm", "mov",
]);

const REFERENCE_EXTENSIONS = new Set([
  ...ASSET_EXTENSIONS,
  "css", "scss", "sass", "less", "js", "mjs", "cjs", "jsx", "ts", "tsx",
  "html", "htm", "json", "webmanifest",
]);

const SOURCE_EXTENSIONS = new Set([
  "html", "htm", "css", "scss", "sass", "less", "js", "mjs", "cjs", "jsx",
  "ts", "tsx", "vue", "svelte", "php", "md", "mdx",
]);

const IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/coverage/**",
  "**/vendor/**",
  "**/.next/**",
  "**/Pods/**",
  "**/DerivedData/**",
  "**/.cie/**",
  "**/._*",
];

function extension(filePath: string): string {
  return path.extname(filePath).slice(1).toLowerCase();
}

function cleanReference(raw: string): string | null {
  const value = raw.trim().replace(/^["']|["']$/g, "");
  if (!value) return null;
  if (/^(?:data:|https?:|mailto:|tel:|javascript:|\/\/)/i.test(value)) return null;
  const withoutHash = value.split("#")[0].split("?")[0].trim();
  if (!withoutHash || withoutHash === "#") return null;
  return withoutHash;
}

function resolveReference(sourceFile: string, reference: string): string | null {
  const clean = cleanReference(reference);
  if (!clean) return null;
  if (!REFERENCE_EXTENSIONS.has(extension(clean))) return null;
  const resolved = clean.startsWith("/")
    ? clean.replace(/^\/+/, "")
    : path.posix.normalize(path.posix.join(path.posix.dirname(sourceFile), clean));
  const normalized = resolved.replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("../") || normalized === "..") return null;
  return normalized;
}

function referencesForLine(filePath: string, line: string): string[] {
  const extensionName = extension(filePath);
  const references: string[] = [];
  if (["html", "htm", "vue", "svelte", "php"].includes(extensionName)) {
    for (const match of line.matchAll(/\b(?:src|href|poster|data-src)\s*=\s*["']([^"']+)["']/gi)) {
      references.push(match[1]);
    }
  }
  if (["css", "scss", "sass", "less"].includes(extensionName)) {
    for (const match of line.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
      references.push(match[1]);
    }
  }
  if (["js", "mjs", "cjs", "jsx", "ts", "tsx", "vue", "svelte"].includes(extensionName)) {
    for (const match of line.matchAll(/(?:from\s+|require\(\s*|import\(\s*)["']([^"']+)["']/g)) {
      references.push(match[1]);
    }
  }
  if (["md", "mdx"].includes(extensionName)) {
    for (const match of line.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
      references.push(match[1]);
    }
  }
  return references;
}

function markdownInventory(
  files: { path: string; content: string }[],
): MarkdownInventory[] {
  const result: MarkdownInventory[] = [];
  for (const file of files) {
    if (!/\.(?:md|mdx)$/i.test(file.path)) continue;
    const headings: MarkdownInventory["headings"] = [];
    let fenced = false;
    const lines = file.content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^\s*(?:```|~~~)/.test(line)) {
        fenced = !fenced;
        continue;
      }
      if (fenced) continue;
      const match = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*$/);
      if (!match) continue;
      headings.push({
        file: file.path,
        line: index + 1,
        level: match[1].length,
        text: match[2].trim(),
      });
    }
    const warnings: string[] = [];
    if (headings.length > 0 && headings[0].level !== 1) {
      warnings.push(`Starts with h${headings[0].level} instead of h1 at line ${headings[0].line}.`);
    }
    for (let index = 1; index < headings.length; index += 1) {
      const previous = headings[index - 1];
      const current = headings[index];
      if (current.level > previous.level + 1) {
        warnings.push(
          `Heading jump h${previous.level} → h${current.level} at line ${current.line}.`,
        );
      }
    }
    const h1Count = headings.filter((heading) => heading.level === 1).length;
    if (h1Count > 1) warnings.push(`Multiple h1 headings (${h1Count}).`);
    result.push({ file: file.path, headings, warnings });
  }
  return result.sort((a, b) => a.file.localeCompare(b.file));
}

export async function auditContentInventory(
  analysis: AnalysisResult,
): Promise<ContentInventory> {
  const assetEntries = await fg("**/*", {
    cwd: analysis.rootPath,
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: false,
    suppressErrors: true,
    ignore: IGNORE,
  });
  const assets = assetEntries
    .filter((file) => ASSET_EXTENSIONS.has(extension(file)))
    .sort((a, b) => a.localeCompare(b));
  const assetMap = new Map<string, ContentAsset>();
  for (const asset of assets) {
    let bytes = 0;
    try {
      // eslint-disable-next-line no-await-in-loop
      bytes = (await fs.stat(path.resolve(analysis.rootPath, asset))).size;
    } catch {
      continue;
    }
    assetMap.set(asset, { path: asset, bytes, referencedBy: [] });
  }

  const sourceFiles = analysis.files
    .map((file) => file.path)
    .filter((file) => SOURCE_EXTENSIONS.has(extension(file)));
  const broken: BrokenReference[] = [];
  const seenBroken = new Set<string>();
  const notes: string[] = [];
  const markdownSources: { path: string; content: string }[] = [];

  for (const file of sourceFiles) {
    let content: string;
    try {
      // eslint-disable-next-line no-await-in-loop
      content = await fs.readFile(path.resolve(analysis.rootPath, file), "utf8");
    } catch {
      continue;
    }
    if (/\.(?:md|mdx)$/i.test(file)) markdownSources.push({ path: file, content });
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      for (const raw of referencesForLine(file, lines[index])) {
        const resolved = resolveReference(file, raw);
        if (!resolved) continue;
        const exists = await fs
          .access(path.resolve(analysis.rootPath, resolved))
          .then(() => true)
          .catch(() => false);
        if (exists) {
          const asset = assetMap.get(resolved);
          if (asset) {
            asset.referencedBy.push({ file, line: index + 1, reference: raw });
          }
        } else {
          const key = `${file}:${index + 1}:${raw}`;
          if (!seenBroken.has(key)) {
            seenBroken.add(key);
            broken.push({ file, line: index + 1, reference: raw, resolved });
          }
        }
      }
    }
  }

  const unreferenced = [...assetMap.values()]
    .filter((asset) => asset.referencedBy.length === 0)
    .sort((a, b) => a.path.localeCompare(b.path));
  const markdown = markdownInventory(markdownSources);
  notes.push("References in dynamic JavaScript strings may not be detected.");
  if (assetMap.size > 0 && sourceFiles.length === 0) {
    notes.push("No source files were indexed; only filesystem assets were inventoried.");
  }

  return {
    assets: [...assetMap.values()].sort((a, b) => a.path.localeCompare(b.path)),
    unreferenced,
    broken,
    markdown,
    summary: {
      assets: assetMap.size,
      unreferenced: unreferenced.length,
      broken: broken.length,
      markdownFiles: markdown.length,
      headingWarnings: markdown.reduce((sum, entry) => sum + entry.warnings.length, 0),
    },
    notes,
  };
}

export function renderContentInventory(inventory: ContentInventory): string {
  const lines = [
    `Assets: ${inventory.summary.assets} · Unreferenced: ${inventory.summary.unreferenced} · Broken references: ${inventory.summary.broken} · Markdown files: ${inventory.summary.markdownFiles} · Heading warnings: ${inventory.summary.headingWarnings}`,
  ];
  if (inventory.broken.length > 0) {
    lines.push("", "Broken references:");
    lines.push(
      ...inventory.broken
        .slice(0, 40)
        .map((item) => `- ${item.file}:${item.line} → ${item.reference}`),
    );
  }
  if (inventory.unreferenced.length > 0) {
    lines.push("", "Unreferenced assets:");
    lines.push(...inventory.unreferenced.slice(0, 40).map((item) => `- ${item.path} (${item.bytes} B)`));
  }
  const markdownWarnings = inventory.markdown.filter((entry) => entry.warnings.length > 0);
  if (markdownWarnings.length > 0) {
    lines.push("", "Markdown heading warnings:");
    for (const entry of markdownWarnings.slice(0, 20)) {
      lines.push(`- ${entry.file}: ${entry.warnings.join(" ")}`);
    }
  }
  if (inventory.notes.length > 0) lines.push("", ...inventory.notes);
  return lines.join("\n");
}
