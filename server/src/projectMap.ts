import fs from "node:fs/promises";
import path from "node:path";
import type { AnalysisResult } from "../../shared/types";

const SKIP_DIRS = new Set([
  ".cie",
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  "Pods",
  "vendor",
  "DerivedData",
  ".gradle",
]);
const SOURCE_EXT =
  /\.(?:js|mjs|cjs|jsx|ts|tsx|css|scss|sass|less|html?|php|py|go|rs|java|kt|swift|dart|rb|vue|svelte|json|md|sql|sh|bash)$/i;
const CODE_EXT =
  /\.(?:js|mjs|cjs|jsx|ts|tsx|css|scss|sass|less|html?|php|py|go|rs|java|kt|swift|dart|rb|vue|svelte|sql|sh|bash)$/i;
const LOCKFILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json"]);

export interface ProjectMapAudit {
  files: { path: string; symbols: number; loc?: number }[];
  missingFromIndex: string[];
  indexedButMissing: string[];
  symbols: { total: number; kinds: Record<string, number> };
  entries: string[];
  scripts: string[];
  loaded: string[];
  unreferenced: string[];
  keySymbols: { path: string; name: string; kind: string; line: number }[];
}

async function diskSources(rootPath: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    let entries: { name: string; isDirectory(): boolean }[];
    try {
      entries = (await fs.readdir(directory, { withFileTypes: true })) as unknown as {
        name: string;
        isDirectory(): boolean;
      }[];
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= 2_000) return;
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        // eslint-disable-next-line no-await-in-loop
        await walk(path.join(directory, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
        continue;
      }
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (LOCKFILES.has(entry.name)) continue;
      if (SOURCE_EXT.test(relative)) found.push(relative);
    }
  };
  await walk(rootPath, "");
  return found.sort();
}

export async function auditProjectKnowledge(analysis: AnalysisResult): Promise<ProjectMapAudit> {
  const byFile = new Map<string, number>();
  const kinds: Record<string, number> = {};
  for (const symbol of analysis.symbols) {
    byFile.set(symbol.filePath, (byFile.get(symbol.filePath) ?? 0) + 1);
    kinds[symbol.kind] = (kinds[symbol.kind] ?? 0) + 1;
  }
  const indexed = new Set(analysis.files.map((file) => file.path));
  const disk = await diskSources(analysis.rootPath);
  const missingFromIndex = disk
    .filter((file) => CODE_EXT.test(file) && !/\.d\.[cm]?ts$/i.test(file) && !indexed.has(file))
    .slice(0, 40);
  const indexedButMissing = analysis.files
    .map((file) => file.path)
    .filter((file) => CODE_EXT.test(file) && !disk.includes(file))
    .slice(0, 20);

  const entries = analysis.files
    .map((file) => file.path)
    .filter((file) =>
      /(^|\/)(index\.html?|main\.[jt]sx?|app\.[jt]s|src\/(?:main|index|app)\.[jt]sx?|package\.json)$/i.test(
        file,
      ),
    )
    .slice(0, 12);

  const scripts: string[] = [];
  for (const htmlPath of analysis.files.filter((file) => /\.html?$/i.test(file.path)).slice(0, 4)) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const html = await fs.readFile(path.join(analysis.rootPath, htmlPath.path), "utf8");
      for (const match of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) scripts.push(match[1]);
      for (const match of html.matchAll(/<link[^>]+href=["']([^"']+)["']/gi)) scripts.push(match[1]);
    } catch {
      // ignore unreadable HTML
    }
  }
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(analysis.rootPath, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    for (const name of Object.keys(pkg.scripts ?? {}).slice(0, 12)) scripts.push(`npm run ${name}`);
  } catch {
    // no package.json
  }

  const loaded = [
    ...new Set(
      scripts
        .map((script) =>
          script
            .split("?")[0]
            .split("#")[0]
            .replace(/^\.\//, "")
            .replace(/^\//, ""),
        )
        .filter((script) => !/^https?:/i.test(script)),
    ),
  ];
  const hasHtmlEntry = analysis.files.some((file) => /\.html?$/i.test(file.path));
  const unreferenced = (hasHtmlEntry ? analysis.files : [])
    .map((file) => file.path)
    .filter((file) => /\.(?:js|mjs|cjs|jsx|ts|tsx|css|scss|sass|less)$/i.test(file))
    .filter((file) => !loaded.some((entry) => entry === file || entry.endsWith(`/${file}`) || file.endsWith(`/${entry}`)))
    .filter((file) => !/\.(?:test|spec)\./i.test(file) && !/(?:^|\/)(?:vite|eslint|jest|vitest|playwright)\.config\./i.test(file))
    .filter((file) => !/^(?:node_modules|dist|build|\.cie)\//.test(file))
    .slice(0, 30);

  const keySymbols = analysis.symbols
    .filter((symbol) => symbol.kind === "function" || symbol.kind === "method" || symbol.kind === "class")
    .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine)
    .slice(0, 140)
    .map((symbol) => ({
      path: symbol.filePath,
      name: symbol.name,
      kind: symbol.kind,
      line: symbol.startLine,
    }));

  return {
    files: analysis.files
      .map((file) => ({ path: file.path, symbols: byFile.get(file.path) ?? 0, loc: file.loc }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    missingFromIndex,
    indexedButMissing,
    symbols: { total: analysis.symbols.length, kinds },
    entries,
    scripts: [...new Set(scripts)].slice(0, 20),
    loaded,
    unreferenced,
    keySymbols,
  };
}

export function renderProjectMap(analysis: AnalysisResult, audit: ProjectMapAudit): string {
  const lines: string[] = [
    "# Project map",
    "",
    "Generated by Codebase Intelligence Explorer. Use this map to choose files and symbols before searching. Search exact labels/strings with search_code/find_in_file; search function/class names with find_symbols.",
    "",
    "## Files",
  ];
  for (const file of audit.files) {
    lines.push(`- ${file.path} — ${file.loc ?? "?"} lines, ${file.symbols} symbol(s)`);
  }
  if (audit.loaded.length > 0) {
    lines.push("", "## Loaded entry assets");
    for (const file of audit.loaded) lines.push(`- ${file}`);
  }
  if (audit.unreferenced.length > 0) {
    lines.push(
      "",
      "## Not referenced by HTML",
      "These files are not loaded by the entry HTML. They may be imported by a bundler or dead; verify an import before using them for runtime behavior.",
    );
    for (const file of audit.unreferenced) lines.push(`- ${file}`);
  }
  if (audit.missingFromIndex.length > 0) {
    lines.push("", "## Files on disk but missing from the index");
    for (const file of audit.missingFromIndex) lines.push(`- ${file}`);
  }
  if (audit.indexedButMissing.length > 0) {
    lines.push("", "## Indexed paths that no longer exist");
    for (const file of audit.indexedButMissing) lines.push(`- ${file}`);
  }
  lines.push(
    "",
    "## Symbols",
    `Total: ${audit.symbols.total}`,
    Object.entries(audit.symbols.kinds)
      .map(([kind, count]) => `- ${kind}: ${count}`)
      .join("\n"),
  );
  if (audit.keySymbols.length > 0) {
    lines.push("", "## Key symbols");
    for (const symbol of audit.keySymbols) {
      lines.push(`- ${symbol.path}:${symbol.line} — ${symbol.kind} ${symbol.name}`);
    }
  }
  if (audit.entries.length > 0 || audit.scripts.length > 0) {
    lines.push("", "## Entry points and scripts");
    for (const entry of audit.entries) lines.push(`- entry: ${entry}`);
    for (const script of audit.scripts) lines.push(`- ${script}`);
  }
  lines.push(
    "",
    "## Search hints",
    "- Turkish labels/strings are not symbol names: search them as text in the file that owns the data (e.g. comedy.js item tables).",
    "- Function and class names are indexed: use find_symbols/read_symbol before reading whole files.",
    "- If a file is missing from the index, re-analyze the project before trusting symbol search.",
    "",
    `Analysis: ${analysis.files.length} files · ${analysis.symbols.length} symbols`,
  );
  return `${lines.join("\n")}\n`;
}

export async function ensureProjectMap(analysis: AnalysisResult): Promise<string> {
  const directory = path.join(analysis.rootPath, ".cie", "agent");
  const file = path.join(directory, "PROJECT_MAP.md");
  const generated = await fs
    .stat(file)
    .then((stat) => stat.mtimeMs)
    .catch(() => 0);
  const analysisTime = Date.parse(analysis.createdAt);
  if (generated > 0 && (!Number.isFinite(analysisTime) || generated >= analysisTime)) {
    const current = await fs.readFile(file, "utf8").catch(() => "");
    if (current.includes("## Loaded entry assets")) return current;
  }
  const audit = await auditProjectKnowledge(analysis);
  const content = renderProjectMap(analysis, audit);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(file, content, { mode: 0o600 });
  return content;
}
