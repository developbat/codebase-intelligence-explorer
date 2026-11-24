import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { AnalysisResult } from "../../shared/types";
import { isWithin } from "./scanner";

export type EntityKind =
  | "color"
  | "input"
  | "button"
  | "link"
  | "function"
  | "class"
  | "component"
  | "env"
  | "todo"
  | "route"
  | "import"
  | "selector"
  | "asset"
  | "markdown"
  | "document"
  | "file"
  | "text";

export interface EntityItem {
  key: string;
  file: string;
  line: number;
  values: Record<string, string>;
}

export interface EntityHeader {
  key: string;
  label: string;
}

export interface EntityResult {
  kind: EntityKind;
  total: number;
  unique: number;
  items: EntityItem[];
  headers: EntityHeader[];
  markdown: string;
  truncated: boolean;
}

export interface EntityRequest {
  kind: EntityKind;
  scope?: string | string[];
  query?: string;
  limit?: number;
}

export interface WorkBrief {
  mode: "extract" | "change";
  kind: EntityKind;
}

const KIND_ALIASES: { kind: EntityKind; words: RegExp }[] = [
  { kind: "color", words: /\b(?:colors?|renk\w*|palette|palet)\b/i },
  { kind: "input", words: /\b(?:inputs?|form fields?|fields?|text ?inputs?|textareas?|selects?)\b|girdi\w*|form alan\w*|alanlar\w*|input\w*/i },
  { kind: "button", words: /\b(?:buttons?|buton\w*)\b/i },
  { kind: "link", words: /\b(?:links?|anchors?)\b|bağlantı\w*|link\w*/i },
  { kind: "function", words: /\b(?:functions?|methods?)\b|fonksiyon\w*|metot\w*/i },
  { kind: "class", words: /\b(?:classes?|structs?|interfaces?)\b|sınıf\w*/i },
  { kind: "component", words: /\b(?:components?|widgets?)\b|bileşen\w*/i },
  { kind: "env", words: /\b(?:env(?:ironment)?(?: variables?)?|secrets?)\b|ortam değişkeni\w*/i },
  { kind: "todo", words: /\b(?:todos?|fixmes?|hacks?)\b/i },
  { kind: "route", words: /\b(?:routes?|endpoints?|apis?)\b|rota\w*|uç nokta\w*/i },
  { kind: "import", words: /\b(?:imports?|modules?|dependencies)\b|bağımlılık\w*|modül\w*/i },
  { kind: "selector", words: /\b(?:selectors?|css rules?)\b|seçici\w*/i },
  { kind: "asset", words: /\b(?:assets?|images?|media|fonts?|icons?)\b|görsel\w*|resim\w*|ikon\w*|varlık\w*|asset\w*/i },
  {
    kind: "document",
    words:
      /(?:md|markdown|readme|docs?|documentation)\s*(?:files?|dosyalar\w*)|(?:dosyalar\w*|files?)\s*(?:md|markdown)|belge\w*\s*(?:dosya\w*|listesi)/i,
  },
  { kind: "markdown", words: /\b(?:markdown|md|headings?)\b|başlık\w*/i },
  { kind: "file", words: /\b(?:files?|paths?)\b|dosya\w*/i },
];

const LIST_WORDS = /\b(list|listele|tüm|tum|all|every|hepsi|hangi|which|show|göster|getir|extract|çıkar|say|count)\b/i;
const LOCATION_WORDS = /\b(nerede|where|hangi dosya)\b/i;
const CHANGE_WORDS = /\b(change|değiştir|degistir|update|güncelle|guncelle|replace|retheme|modify|düzenle|duzenle)\b/i;
const NEGATED_CHANGE =
  /\b(?:değiştirme|degistirme|değiştirmeden|degistirmeden|ekleme|eklemeyin|eklemeden|dokunma|without changing|(?:do not|don't|without)\s+(?:add|create|implement|insert|change|modify|update|edit|touch)|no changes?)\b/i;
const ADDITIVE_WORDS = /\b(?:add|create|implement|insert)\b|ekle\w*|ekley\w*|oluştur\w*|olustur\w*/i;

export function resolveEntityKind(text: string): EntityKind | null {
  // Route/endpoint wording is more specific than generic "method" or "function".
  if (/\b(?:routes?|endpoints?|apis?)\b|rota\w*|uç nokta\w*/i.test(text)) return "route";
  for (const entry of KIND_ALIASES) {
    if (entry.words.test(text)) return entry.kind;
  }
  return null;
}

export function resolveWorkBrief(text: string): WorkBrief | null {
  const kind = resolveEntityKind(text);
  if (!kind) return null;
  if (
    LIST_WORDS.test(text) &&
    LOCATION_WORDS.test(text) &&
    !/\b(list|listele|tüm|tum|all|every|hepsi)\b/i.test(text)
  ) {
    return null;
  }
  const changeMatch = text.match(CHANGE_WORDS);
  const addMatch = text.match(ADDITIVE_WORDS);
  const negationMatch = text.match(NEGATED_CHANGE);
  if (
    (changeMatch || addMatch) &&
    (!negationMatch ||
      ((changeMatch?.index ?? Number.MAX_SAFE_INTEGER) <= (negationMatch.index ?? 0) ||
        (addMatch?.index ?? Number.MAX_SAFE_INTEGER) <= (negationMatch.index ?? 0)))
  ) {
    return { mode: "change", kind };
  }
  if (LIST_WORDS.test(text)) return { mode: "extract", kind };
  return null;
}

const ASSET_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "bmp",
  "tiff",
  "svg",
  "ico",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "mp3",
  "wav",
  "ogg",
  "aac",
  "flac",
  "m4a",
  "mp4",
  "webm",
  "mov",
]);

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function scopedFiles(
  analysis: AnalysisResult,
  scope: string | string[] | undefined,
  extensions?: Set<string>,
): string[] {
  const scopes = (Array.isArray(scope) ? scope : scope ? [scope] : [])
    .map((value) => value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, ""))
    .filter(Boolean);
  const files = analysis.files.map((file) => file.path);
  return files.filter((file) => {
    if (/^(?:\.cie|node_modules|dist|build|\.git|Pods|vendor)\//.test(file)) return false;
    const extension = path.extname(file).slice(1).toLowerCase();
    if (extensions && !extensions.has(extension)) return false;
    if (scopes.length === 0) return true;
    return scopes.some((entry) => {
      if (entry.includes("*")) return globToRegExp(entry).test(file);
      return file === entry || file.startsWith(`${entry.replace(/\/$/, "")}/`);
    });
  });
}

async function readText(analysis: AnalysisResult, file: string): Promise<string | null> {
  const absolute = path.resolve(analysis.rootPath, file);
  if (!isWithin(analysis.rootPath, absolute)) return null;
  try {
    const stat = await fs.stat(absolute);
    if (!stat.isFile() || stat.size > 900_000) return null;
    return await fs.readFile(absolute, "utf8");
  } catch {
    return null;
  }
}

function isTestPath(file: string): boolean {
  return (
    /(^|\/)(?:tests?|__tests__|spec)\//i.test(file) ||
    /\.(?:test|spec)\.[^.]+$/i.test(file) ||
    /(^|\/)test_[^/]+$/i.test(file) ||
    /(^|\/)[^/]+_test\.[^.]+$/i.test(file)
  );
}

function cell(value: string | undefined): string {
  return (value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 180);
}

function buildResult(
  kind: EntityKind,
  headers: EntityHeader[],
  items: EntityItem[],
  unique: number,
  truncated: boolean,
): EntityResult {
  const table = [
    `| ${headers.map((header) => header.label).join(" | ")} |`,
    `|${headers.map(() => "---").join("|")}|`,
    ...items.map(
      (item) => `| ${headers.map((header) => cell(item.values[header.key])).join(" | ")} |`,
    ),
  ].join("\n");
  return {
    kind,
    total: items.length,
    unique,
    items,
    headers,
    markdown: `Extraction: ${kind} · ${items.length} item(s)${truncated ? " (truncated)" : ""}\n\n${table}`,
    truncated,
  };
}

function symbolKind(kind: EntityKind): string[] {
  if (kind === "class") return ["class", "struct", "interface"];
  if (kind === "component") return ["function", "class"];
  return ["function", "method"];
}

async function extractSymbols(
  analysis: AnalysisResult,
  kind: EntityKind,
  scope: string | string[] | undefined,
  limit: number,
): Promise<EntityResult> {
  const scopes = new Set(scopedFiles(analysis, scope));
  const kinds = symbolKind(kind);
  const items = analysis.symbols
    .filter((symbol) => kinds.includes(symbol.kind))
    .filter((symbol) => scopes.has(symbol.filePath))
    .filter(
      (symbol) =>
        kind !== "component" ||
        (/\.(?:tsx|jsx|vue|svelte)$/i.test(symbol.filePath) && /^[A-Z]/.test(symbol.name)),
    )
    .slice(0, limit)
    .map((symbol) => ({
      key: `${symbol.filePath}:${symbol.startLine}:${symbol.name}`,
      file: symbol.filePath,
      line: symbol.startLine,
      values: {
        file: symbol.filePath,
        line: String(symbol.startLine),
        name: symbol.name,
        kind: symbol.kind,
      },
    }));
  const headers: EntityHeader[] = [
    { key: "file", label: "Dosya" },
    { key: "line", label: "Satır" },
    { key: "name", label: "Ad" },
    { key: "kind", label: "Tür" },
  ];
  return buildResult(kind, headers, items, items.length, items.length >= limit);
}

async function extractColor(
  analysis: AnalysisResult,
  scope: string | string[] | undefined,
  limit: number,
): Promise<EntityResult> {
  const files = scopedFiles(
    analysis,
    scope,
    new Set([
      "css",
      "scss",
      "sass",
      "less",
      "html",
      "htm",
      "xml",
      "svg",
      "js",
      "mjs",
      "cjs",
      "jsx",
      "ts",
      "tsx",
      "vue",
      "svelte",
      "php",
      "py",
      "json",
      "yml",
      "yaml",
      "toml",
      "kt",
      "java",
      "swift",
      "dart",
    ]),
  );
  const items: EntityItem[] = [];
  let truncated = false;
  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop
    const content = await readText(analysis, file);
    if (!content) continue;
    const stylesheet = /\.(?:css|scss|sass|less)$/i.test(file);
    const lines = content.split("\n");
    let selector = "";
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (stylesheet && line.includes("{")) selector = line.split("{")[0].trim();
      const property = stylesheet ? line.split(":")[0].trim() : "inline";
      for (const match of line.matchAll(
        /#[0-9a-fA-F]{3,8}\b|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^)]*\)/g,
      )) {
        if (items.length >= limit) {
          truncated = true;
          break;
        }
        items.push({
          key: match[0].toLowerCase(),
          file,
          line: index + 1,
          values: {
            file,
            line: String(index + 1),
            selector,
            property,
            color: match[0],
          },
        });
      }
      if (truncated) break;
    }
    if (truncated) break;
  }
  const unique = new Set(items.map((item) => item.values.color.toLowerCase())).size;
  const headers: EntityHeader[] = [
    { key: "file", label: "Dosya" },
    { key: "line", label: "Satır" },
    { key: "selector", label: "Seçici" },
    { key: "property", label: "Özellik" },
    { key: "color", label: "Renk" },
  ];
  const result = buildResult("color", headers, items, unique, truncated);
  const uniqueCodes = [...new Set(items.map((item) => item.values.color))];
  result.markdown += `\n\nUnique codes (${uniqueCodes.length}):\n${uniqueCodes.join("\n")}`;
  return result;
}

async function extractMarkup(
  analysis: AnalysisResult,
  kind: "input" | "button" | "link",
  scope: string | string[] | undefined,
  limit: number,
): Promise<EntityResult> {
  const files = scopedFiles(
    analysis,
    scope,
    new Set(["html", "htm", "js", "mjs", "cjs", "ts", "jsx", "tsx", "vue", "svelte"]),
  );
  const items: EntityItem[] = [];
  let truncated = false;
  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop
    const content = await readText(analysis, file);
    if (!content) continue;
    const patterns =
      kind === "input"
        ? [
            /<(?:input|textarea|select)\b[^>]*>/gi,
            /<TextInput\b[^>]*>/gi,
            /<Switch\b[^>]*>/gi,
          ]
        : kind === "button"
          ? [
              /<button\b[^>]*>[\s\S]*?<\/button>/gi,
              /<(?:Pressable|TouchableOpacity|TouchableHighlight|TouchableWithoutFeedback)\b[^>]*>/gi,
              /<Button\b[^>]*>/g,
            ]
          : [
              /<a\b[^>]*href\s*=\s*["'][^"']+["'][^>]*>/gi,
              /<Link\b[^>]*>/g,
            ];
    for (const pattern of patterns) {
      for (const match of content.matchAll(pattern)) {
        if (items.length >= limit) {
          truncated = true;
          break;
        }
        const tag = match[0];
        const before = content.slice(0, match.index ?? 0);
        const line = before.split("\n").length;
        const attr = (name: string) =>
          tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1] ?? "";
        const text =
          kind === "button"
            ? tag
                .replace(/<[^>]+>/g, " ")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 80)
            : "";
        const name = attr("id") || attr("name") || attr("aria-label") || attr("placeholder");
        const keyBase = name || tag.slice(0, 60);
        items.push({
          key: `${file}:${line}:${keyBase}`,
          file,
          line,
          values:
            kind === "input"
              ? {
                  file,
                  line: String(line),
                  name,
                  type: attr("type") || tag.match(/^<(\w+)/)?.[1] || "",
                  placeholder: attr("placeholder"),
                }
              : kind === "button"
                ? { file, line: String(line), name, text }
                : { file, line: String(line), href: attr("href"), text: text || name },
        });
        if (truncated) break;
      }
      if (truncated) break;
    }

    const dynamicPattern =
      kind === "input"
        ? /createElement\(\s*["'](?:input|textarea|select)["']/g
        : kind === "button"
          ? /createElement\(\s*["']button["']/g
          : /createElement\(\s*["']a["']/g;
    for (const match of content.matchAll(dynamicPattern)) {
      if (items.length >= limit) {
        truncated = true;
        break;
      }
      const line = content.slice(0, match.index ?? 0).split("\n").length;
      if (items.some((item) => item.file === file && item.line === line)) continue;
      const lines = content.split("\n");
      const snippet = lines.slice(line - 1, line + 24).join("\n");
      const property = (name: string) =>
        snippet.match(new RegExp(`\\.${name}\\s*=\\s*["']([^"']*)["']`))?.[1] ?? "";
      const setAttribute = (name: string) =>
        snippet.match(
          new RegExp(`setAttribute\\(\\s*["']${name}["']\\s*,\\s*["']([^"']*)["']`, "i"),
        )?.[1] ?? "";
      const id = property("id") || setAttribute("id");
      const className = property("className") || setAttribute("class");
      const ariaLabel = setAttribute("aria-label") || property("ariaLabel");
      const placeholder = property("placeholder") || setAttribute("placeholder");
      const textContent = property("textContent") || property("innerText");
      const href = property("href") || setAttribute("href");
      const name = id || ariaLabel || placeholder || className;
      const keyBase = name || `${kind}-${line}`;
      items.push({
        key: `${file}:${line}:${keyBase}`,
        file,
        line,
        values:
          kind === "input"
            ? {
                file,
                line: String(line),
                name,
                type: property("type") || setAttribute("type") || "text",
                placeholder,
              }
            : kind === "button"
              ? {
                  file,
                  line: String(line),
                  name,
                  text: textContent.replace(/<[^>]+>/g, " ").trim().slice(0, 80),
                }
              : { file, line: String(line), href, text: textContent || name },
      });
    }
    if (truncated) break;
  }
  const headers: EntityHeader[] =
    kind === "input"
      ? [
          { key: "file", label: "Dosya" },
          { key: "line", label: "Satır" },
          { key: "name", label: "Ad" },
          { key: "type", label: "Tür" },
        ]
      : kind === "button"
        ? [
            { key: "file", label: "Dosya" },
            { key: "line", label: "Satır" },
            { key: "name", label: "Ad" },
            { key: "text", label: "Metin" },
          ]
        : [
            { key: "file", label: "Dosya" },
            { key: "line", label: "Satır" },
            { key: "href", label: "Href" },
            { key: "text", label: "Metin" },
          ];
  return buildResult(kind, headers, items, items.length, truncated);
}

async function extractPatterned(
  analysis: AnalysisResult,
  kind: "env" | "todo" | "route" | "import",
  scope: string | string[] | undefined,
  limit: number,
): Promise<EntityResult> {
  const extensions = new Set([
    "js","mjs","cjs","jsx","ts","tsx","py","go","php","rb","rs","java","kt","swift","dart","vue","svelte","sh","bash"
  ]);
  const files = scopedFiles(analysis, scope, extensions);
  const items: EntityItem[] = [];
  let truncated = false;
  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop
    const content = await readText(analysis, file);
    if (!content) continue;
    if (kind === "route" && isTestPath(file)) continue;
    const lines = content.split("\n");
    let inGoImport = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const matches: string[] = [];
      if (kind === "env") {
        for (const match of line.matchAll(
          /(?:process\.env\.|process\.env\[|os\.environ\[|os\.environ\.get\(|os\.(?:getenv|Getenv|LookupEnv)\(|getenv\(|env\(|ENV\[)[\s"']*([A-Z][A-Z0-9_]{2,})/g,
        )) matches.push(match[1]);
      } else if (kind === "todo") {
        if (/\b(?:TODO|FIXME|HACK|XXX)\b/i.test(line)) matches.push(line.trim());
      } else if (kind === "route") {
        const patterns = [
          /\$?(?:router|app|routes?)\s*->\s*(get|post|put|patch|delete)\(\s*["']([^"']*)["']/i,
          /(?:Route|Router)::(get|post|put|patch|delete)\(\s*["']([^"']*)["']/i,
          /@(?:app|router|bp)\.(get|post|put|patch|delete)\(\s*["']([^"']*)["']/i,
          /\.(get|post|put|patch|delete)\(\s*["'](\/[^"']*)["']/i,
          /(?:HandleFunc|Handle)\(\s*["']([^"']+)["']/i,
        ];
        for (const pattern of patterns) {
          const match = line.match(pattern);
          if (!match) continue;
          if (match.length > 2 && match[1] && match[2] !== undefined) {
            matches.push(`${match[1].toUpperCase()} ${match[2] || "/"}`);
          } else if (match[1]?.startsWith("/")) {
            matches.push(match[1]);
          }
        }
        const decorator = line.match(
          /@(?:app|router|bp)\.(get|post|put|patch|delete)\(\s*$/i,
        );
        if (decorator) {
          for (let look = index + 1; look < Math.min(index + 4, lines.length); look += 1) {
            const next = lines[look];
            const quoted = next.match(/^\s*["']([^"']*)["']/);
            if (quoted) {
              matches.push(`${decorator[1].toUpperCase()} ${quoted[1] || "/"}`);
              break;
            }
            if (next.includes(")")) break;
          }
        }
        if (line.includes("include_router(")) {
          const inlinePrefix = line.match(/prefix\s*=\s*["']([^"']+)["']/);
          if (inlinePrefix) {
            matches.push(`PREFIX ${inlinePrefix[1]}`);
          } else {
            for (let look = index + 1; look < Math.min(index + 8, lines.length); look += 1) {
              const next = lines[look];
              const prefix = next.match(/prefix\s*=\s*["']([^"']+)["']/);
              if (prefix) {
                matches.push(`PREFIX ${prefix[1]}`);
                break;
              }
              if (next.includes(")")) break;
            }
          }
        }
      } else if (kind === "import") {
        const trimmed = line.trim();
        if (/^import\s*\(\s*$/.test(trimmed)) {
          inGoImport = true;
          continue;
        }
        if (inGoImport) {
          if (/^\)/.test(trimmed)) {
            inGoImport = false;
            continue;
          }
          const goMatch = trimmed.match(/^(?:\w+\s+)?"([^"]+)"$/);
          if (goMatch) matches.push(goMatch[1]);
          continue;
        }
        const candidates = [
          ...line.matchAll(
            /(?:^|\s)import(?:\s+[\w*{},\s]+?\s+from)?\s*["']([^"']+)["']/g,
          ),
          ...line.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g),
          ...line.matchAll(/^\s*from\s+([\w.]+)\s+import\s+/g),
          ...line.matchAll(/^\s*import\s+([\w.]+)(?:\s+as\s+\w+)?\s*$/g),
          ...line.matchAll(/^\s*use\s+([\w\\]+)(?:\s+as\s+\w+)?\s*;/g),
          ...line.matchAll(/^\s*use\s+([\w:]+)(?:::\{[^}]*\})?\s*;/g),
          ...line.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)\s*;?$/g),
          ...line.matchAll(/^\s*import\s+["']([^"']+)["']\s*;?$/g),
        ];
        for (const match of candidates) {
          if (match[1]) matches.push(match[1]);
        }
      }
      for (const value of [...new Set(matches)]) {
        if (items.length >= limit) {
          truncated = true;
          break;
        }
        const routeSpace = value.indexOf(" ");
        const routeMethod = kind === "route" && routeSpace > 0 ? value.slice(0, routeSpace) : "";
        const routePath = kind === "route" && routeSpace > 0 ? value.slice(routeSpace + 1) : value;
        items.push({
          key: kind === "env" ? value : `${file}:${index + 1}:${value}`,
          file,
          line: index + 1,
          values:
            kind === "env"
              ? { file, line: String(index + 1), name: value }
              : kind === "route"
                ? {
                    file,
                    line: String(index + 1),
                    method: routeMethod,
                    path: routePath,
                  }
                : { file, line: String(index + 1), value },
        });
      }
      if (truncated) break;
    }
    if (truncated) break;
  }
  const headers: EntityHeader[] =
    kind === "env"
      ? [
          { key: "file", label: "Dosya" },
          { key: "line", label: "Satır" },
          { key: "name", label: "Değişken" },
        ]
      : kind === "route"
        ? [
            { key: "file", label: "Dosya" },
            { key: "line", label: "Satır" },
            { key: "method", label: "Metot" },
            { key: "path", label: "Yol" },
          ]
        : [
            { key: "file", label: "Dosya" },
            { key: "line", label: "Satır" },
            { key: "value", label: "Değer" },
          ];
  const unique = new Set(items.map((item) => item.key)).size;
  return buildResult(kind, headers, items, unique, truncated);
}

const DOCUMENT_EXTENSIONS = new Set(["md", "mdx", "rst", "adoc"]);

const FS_IGNORE = [
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

async function listFilesystemFiles(
  analysis: AnalysisResult,
  scope: string | string[] | undefined,
  extensions: Set<string>,
): Promise<string[]> {
  const scopes = (Array.isArray(scope) ? scope : scope ? [scope] : [])
    .map((value) => value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, ""))
    .filter(Boolean);
  const patterns = scopes.length
    ? scopes.map((entry) =>
        entry.includes("*") || path.extname(entry) ? entry : `${entry.replace(/\/$/, "")}/**/*`,
      )
    : ["**/*"];
  const entries = await fg(patterns, {
    cwd: analysis.rootPath,
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: false,
    suppressErrors: true,
    ignore: FS_IGNORE,
  });
  return entries
    .filter((file) => extensions.has(path.extname(file).slice(1).toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
}

async function extractAssets(
  analysis: AnalysisResult,
  scope: string | string[] | undefined,
  limit: number,
): Promise<EntityResult> {
  const files = await listFilesystemFiles(analysis, scope, ASSET_EXTENSIONS);
  const items: EntityItem[] = [];
  for (const file of files.slice(0, limit)) {
    const absolute = path.resolve(analysis.rootPath, file);
    if (!isWithin(analysis.rootPath, absolute)) continue;
    let bytes = 0;
    try {
      // eslint-disable-next-line no-await-in-loop
      const stat = await fs.stat(absolute);
      if (!stat.isFile()) continue;
      bytes = stat.size;
    } catch {
      continue;
    }
    items.push({
      key: file,
      file,
      line: 1,
      values: {
        file,
        bytes: String(bytes),
        extension: path.extname(file).slice(1).toLowerCase(),
      },
    });
  }
  const headers: EntityHeader[] = [
    { key: "file", label: "Dosya" },
    { key: "bytes", label: "Boyut" },
    { key: "extension", label: "Tür" },
  ];
  return buildResult("asset", headers, items, items.length, files.length > limit);
}

async function extractDocuments(
  analysis: AnalysisResult,
  scope: string | string[] | undefined,
  limit: number,
): Promise<EntityResult> {
  const files = await listFilesystemFiles(analysis, scope, DOCUMENT_EXTENSIONS);
  const items: EntityItem[] = [];
  for (const file of files.slice(0, limit)) {
    const absolute = path.resolve(analysis.rootPath, file);
    if (!isWithin(analysis.rootPath, absolute)) continue;
    let bytes = 0;
    let loc = 0;
    try {
      // eslint-disable-next-line no-await-in-loop
      const stat = await fs.stat(absolute);
      if (!stat.isFile()) continue;
      bytes = stat.size;
      if (bytes <= 900_000) {
        // eslint-disable-next-line no-await-in-loop
        const content = await fs.readFile(absolute, "utf8");
        loc = content.length === 0 ? 0 : content.split("\n").length;
      }
    } catch {
      continue;
    }
    items.push({
      key: file,
      file,
      line: 1,
      values: {
        file,
        bytes: String(bytes),
        loc: String(loc),
        extension: path.extname(file).slice(1).toLowerCase(),
      },
    });
  }
  const headers: EntityHeader[] = [
    { key: "file", label: "Dosya" },
    { key: "bytes", label: "Boyut" },
    { key: "loc", label: "Satır" },
  ];
  return buildResult("document", headers, items, items.length, files.length > limit);
}

async function extractMarkdown(
  analysis: AnalysisResult,
  scope: string | string[] | undefined,
  limit: number,
): Promise<EntityResult> {
  const files = scopedFiles(analysis, scope, new Set(["md", "mdx"]));
  const items: EntityItem[] = [];
  let truncated = false;
  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop
    const content = await readText(analysis, file);
    if (!content) continue;
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)/);
      if (heading) {
        if (items.length >= limit) {
          truncated = true;
          break;
        }
        items.push({
          key: `${file}:${index + 1}:heading:${heading[2].trim()}`,
          file,
          line: index + 1,
          values: {
            file,
            line: String(index + 1),
            type: "heading",
            text: `${heading[1]} ${heading[2].trim()}`,
          },
        });
      }
      for (const match of line.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
        if (items.length >= limit) {
          truncated = true;
          break;
        }
        items.push({
          key: `${file}:${index + 1}:link:${match[1]}`,
          file,
          line: index + 1,
          values: {
            file,
            line: String(index + 1),
            type: "link",
            text: match[1],
          },
        });
      }
      if (truncated) break;
    }
    if (truncated) break;
  }
  const headers: EntityHeader[] = [
    { key: "file", label: "Dosya" },
    { key: "line", label: "Satır" },
    { key: "type", label: "Tür" },
    { key: "text", label: "Metin" },
  ];
  return buildResult("markdown", headers, items, items.length, truncated);
}

async function extractFiles(analysis: AnalysisResult, scope: string | string[] | undefined, limit: number): Promise<EntityResult> {
  const files = scopedFiles(analysis, scope);
  const items = analysis.files
    .filter((file) => files.includes(file.path))
    .slice(0, limit)
    .map((file) => ({
      key: file.path,
      file: file.path,
      line: 1,
      values: {
        file: file.path,
        bytes: String(file.bytes),
        loc: String(file.loc),
      },
    }));
  const headers: EntityHeader[] = [
    { key: "file", label: "Dosya" },
    { key: "bytes", label: "Boyut" },
    { key: "loc", label: "Satır" },
  ];
  return buildResult("file", headers, items, items.length, items.length >= limit);
}

async function extractSelector(
  analysis: AnalysisResult,
  scope: string | string[] | undefined,
  limit: number,
): Promise<EntityResult> {
  const files = scopedFiles(
    analysis,
    scope,
    new Set([
      "css",
      "scss",
      "sass",
      "less",
      "html",
      "htm",
      "js",
      "mjs",
      "cjs",
      "jsx",
      "ts",
      "tsx",
      "vue",
      "svelte",
    ]),
  );
  const items: EntityItem[] = [];
  let truncated = false;
  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop
    const content = await readText(analysis, file);
    if (!content) continue;
    const extension = path.extname(file).slice(1).toLowerCase();
    const stylesheet = ["css", "scss", "sass", "less"].includes(extension);
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const found: string[] = [];
      if (stylesheet) {
        const compact = line.replace(/\/\*.*?\*\//g, "").trim();
        if (compact.includes("{")) {
          const selector = compact.split("{")[0].trim();
          if (
            selector &&
            !selector.startsWith("@") &&
            !/^\d+(?:\.\d+)?%$/.test(selector) &&
            !/[;{}]/.test(selector)
          ) {
            for (const part of selector.split(",")) {
              const value = part.trim();
              if (value) found.push(value);
            }
          }
        }
      }
      for (const match of line.matchAll(
        /(?:querySelectorAll|querySelector|closest)\(\s*["'`]([^"'`]+)["'`]/g,
      )) {
        found.push(match[1]);
      }
      for (const match of line.matchAll(/getElementById\(\s*["'`]([^"'`]+)["'`]/g)) {
        found.push(`#${match[1]}`);
      }
      for (const match of line.matchAll(
        /getElementsByClassName\(\s*["'`]([^"'`]+)["'`]/g,
      )) {
        found.push(
          ...match[1]
            .split(/\s+/)
            .filter(Boolean)
            .map((name) => `.${name}`),
        );
      }
      for (const value of [...new Set(found)]) {
        if (items.length >= limit) {
          truncated = true;
          break;
        }
        items.push({
          key: `${file}:${index + 1}:${value}`,
          file,
          line: index + 1,
          values: {
            file,
            line: String(index + 1),
            type: stylesheet ? "css" : "dom",
            selector: value,
          },
        });
      }
      if (truncated) break;
    }
    if (truncated) break;
  }
  const headers: EntityHeader[] = [
    { key: "file", label: "Dosya" },
    { key: "line", label: "Satır" },
    { key: "type", label: "Tür" },
    { key: "selector", label: "Seçici" },
  ];
  return buildResult("selector", headers, items, items.length, truncated);
}

async function extractText(
  analysis: AnalysisResult,
  scope: string | string[] | undefined,
  query: string | undefined,
  limit: number,
): Promise<EntityResult> {
  const needle = (query ?? "").trim();
  if (!needle) throw new Error("A query is required for text extraction.");
  const files = scopedFiles(analysis, scope);
  const items: EntityItem[] = [];
  let truncated = false;
  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop
    const content = await readText(analysis, file);
    if (!content) continue;
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].toLowerCase().includes(needle.toLowerCase())) continue;
      if (items.length >= limit) {
        truncated = true;
        break;
      }
      items.push({
        key: `${file}:${index + 1}`,
        file,
        line: index + 1,
        values: { file, line: String(index + 1), text: lines[index].trim() },
      });
    }
    if (truncated) break;
  }
  const headers: EntityHeader[] = [
    { key: "file", label: "Dosya" },
    { key: "line", label: "Satır" },
    { key: "text", label: "Metin" },
  ];
  return buildResult("text", headers, items, items.length, truncated);
}

export interface MappedReplacement {
  from: string;
  to: string;
  count: number;
}

export interface MappedContentResult {
  content: string;
  count: number;
  replacements: MappedReplacement[];
}

export function applyMappingsToContent(
  content: string,
  kind: "color" | "text",
  mapping: Array<readonly [string, string]>,
): MappedContentResult {
  const entries = [...mapping]
    .filter(([from, to]) => from.length > 0 && to.length > 0)
    .sort((a, b) => b[0].length - a[0].length);
  if (entries.length === 0) {
    return { content, count: 0, replacements: [] };
  }
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const targets = new Map<string, string>();
  for (const [from, to] of entries) {
    targets.set(kind === "color" ? from.toLowerCase() : from, to);
  }
  const alternatives = entries
    .map(([from]) =>
      kind === "color" && /^#[0-9a-f]{3,8}$/i.test(from)
        ? `${escape(from)}(?![0-9a-fA-F])`
        : escape(from),
    )
    .join("|");
  const pattern = new RegExp(`(?:${alternatives})`, kind === "color" ? "gi" : "g");
  const counts = new Map<string, number>();
  const next = content.replace(pattern, (match) => {
    const key = kind === "color" ? match.toLowerCase() : match;
    const replacement = targets.get(key);
    if (replacement === undefined) return match;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return replacement;
  });
  const replacements: MappedReplacement[] = [];
  let count = 0;
  for (const [from, to] of entries) {
    const found = counts.get(kind === "color" ? from.toLowerCase() : from) ?? 0;
    if (found === 0) continue;
    replacements.push({ from, to, count: found });
    count += found;
  }
  return { content: next, count, replacements };
}

export async function extractEntities(
  analysis: AnalysisResult,
  request: EntityRequest,
): Promise<EntityResult> {
  const limit = Math.max(1, Math.min(2_000, Number(request.limit) || 500));
  switch (request.kind) {
    case "color":
      return extractColor(analysis, request.scope, limit);
    case "input":
    case "button":
    case "link":
      return extractMarkup(analysis, request.kind, request.scope, limit);
    case "function":
    case "class":
    case "component":
      return extractSymbols(analysis, request.kind, request.scope, limit);
    case "env":
    case "todo":
    case "route":
    case "import":
      return extractPatterned(analysis, request.kind, request.scope, limit);
    case "asset":
      return extractAssets(analysis, request.scope, limit);
    case "document":
      return extractDocuments(analysis, request.scope, limit);
    case "selector":
      return extractSelector(analysis, request.scope, limit);
    case "markdown":
      return extractMarkdown(analysis, request.scope, limit);
    case "file":
      return extractFiles(analysis, request.scope, limit);
    case "text":
      return extractText(analysis, request.scope, request.query, limit);
    default:
      throw new Error(`Unsupported extraction kind: ${String(request.kind)}`);
  }
}
