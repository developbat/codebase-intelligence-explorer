import fg from "fast-glob";
import fs from "node:fs/promises";
import path from "node:path";

const RULES_FILE = "AGENTS.md";
const MAX_FILES = 6;
const MAX_TOTAL_CHARS = 12_000;
const MAX_FILE_CHARS = 6_000;
const CACHE_TTL_MS = 10_000;

const IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.cie/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/vendor/**",
  "**/.next/**",
  "**/.cache/**",
];

export interface ProjectRules {
  /** Project-relative AGENTS.md paths, root first. */
  files: string[];
  /** Combined rule text (without the prompt header). */
  content: string;
  /** Formatted block injected into system prompts. */
  block: string;
  truncated: boolean;
}

interface CacheEntry {
  at: number;
  rules: ProjectRules | null;
}

const cache = new Map<string, CacheEntry>();

export function clearProjectRulesCache(rootPath?: string): void {
  if (rootPath) cache.delete(path.resolve(rootPath));
  else cache.clear();
}

function byDepthThenName(a: string, b: string): number {
  const depth = a.split("/").length - b.split("/").length;
  return depth !== 0 ? depth : a.localeCompare(b);
}

async function readRules(rootPath: string): Promise<ProjectRules | null> {
  const root = path.resolve(rootPath);
  let discovered: string[] = [];
  try {
    discovered = await fg(`**/${RULES_FILE}`, {
      cwd: root,
      dot: true,
      onlyFiles: true,
      followSymbolicLinks: false,
      caseSensitiveMatch: false,
      ignore: IGNORE,
    });
  } catch {
    discovered = [];
  }

  // fast-glob's `**/` does not always include the root file on every platform.
  const rootFile = path.join(root, RULES_FILE);
  const rootExists = await fs
    .access(rootFile)
    .then(() => true)
    .catch(() => false);
  const paths = [
    ...(rootExists ? [RULES_FILE] : []),
    ...discovered
      .map((file) => file.replace(/\\/g, "/"))
      .filter((file) => file.toLowerCase() !== RULES_FILE.toLowerCase()),
  ]
    .filter((file, index, all) => all.indexOf(file) === index)
    .sort(byDepthThenName)
    .slice(0, MAX_FILES);

  if (paths.length === 0) return null;

  const sections: string[] = [];
  let total = 0;
  let truncated = false;
  const files: string[] = [];

  for (const relative of paths) {
    let content = "";
    try {
      content = await fs.readFile(path.join(root, relative), "utf8");
    } catch {
      continue;
    }
    content = content.replace(/\r\n/g, "\n").trim();
    if (!content) continue;

    const remaining = MAX_TOTAL_CHARS - total;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    let section = content;
    if (section.length > MAX_FILE_CHARS) {
      section = `${section.slice(0, MAX_FILE_CHARS)}\n… ${relative} truncated …`;
      truncated = true;
    }
    if (section.length > remaining) {
      section = `${section.slice(0, remaining)}\n… project rules truncated …`;
      truncated = true;
    }
    sections.push(`### ${relative}\n${section}`);
    files.push(relative);
    total += section.length;
    if (truncated) break;
  }

  if (sections.length === 0) return null;
  const content = sections.join("\n\n");
  const block = [
    "## Repository instructions (AGENTS.md)",
    "These are repository-local rules for this project. Follow them for every task. They never override safety rules, permission decisions or an explicit user instruction.",
    "",
    content,
  ].join("\n");

  return { files, content, block, truncated };
}

/**
 * Load root and nested AGENTS.md files. The result is cached briefly so a chat
 * question does not rescan the project on every turn; edits appear within 10s.
 */
export async function loadProjectRules(rootPath: string): Promise<ProjectRules | null> {
  const root = path.resolve(rootPath);
  const cached = cache.get(root);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.rules;
  const rules = await readRules(root);
  cache.set(root, { at: Date.now(), rules });
  return rules;
}
