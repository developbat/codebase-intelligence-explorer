import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import MiniSearch from "minisearch";
import type { AnalysisResult, ProjectIndexHit, ProjectIndexStatus } from "../../shared/types";
import { getDataDir } from "./store";

interface IndexDocument {
  id: string;
  kind: "file" | "symbol" | "route" | "project" | "conversation";
  title: string;
  text: string;
  path?: string;
  line?: number;
  symbol?: string;
  snippet?: string;
  answer?: string;
  updatedAt?: string;
}

interface IndexMeta {
  version: 1;
  updatedAt: string;
  fingerprint: string;
  documentCount: number;
  partial: boolean;
}

interface LoadedIndex {
  index: MiniSearch<IndexDocument>;
  meta: IndexMeta;
}

interface BuildState {
  building: boolean;
  processed: number;
  total: number;
  error?: string;
}

interface StoredConversation {
  id: string;
  question: string;
  answer: string;
  provider: string;
  model: string;
  createdAt: string;
}

const MAX_FILE_CHARS = 60_000;
const MAX_CONVERSATIONS = 300;

const indexOptions = {
  fields: ["title", "text", "path", "symbol"],
  storeFields: ["kind", "title", "path", "line", "symbol", "snippet", "answer", "updatedAt"],
  idField: "id",
  searchOptions: {
    boost: { title: 2.4, path: 2.0, symbol: 2.0 },
    fuzzy: 0.2,
    prefix: true,
  },
};

const cache = new Map<string, LoadedIndex>();
const buildStates = new Map<string, BuildState>();

function projectDir(projectId: string): string {
  return path.join(getDataDir(), "projects", projectId);
}

function indexPath(projectId: string): string {
  return path.join(projectDir(projectId), "search-index.json");
}

function metaPath(projectId: string): string {
  return path.join(projectDir(projectId), "search-index-meta.json");
}

function conversationPath(projectId: string): string {
  return path.join(projectDir(projectId), "conversations.json");
}

function fingerprintOf(analysis: AnalysisResult): string {
  return crypto
    .createHash("sha1")
    .update(analysis.files.map((file) => `${file.path}:${file.hash}`).join("|"))
    .update(`|${analysis.symbols.length}|${analysis.nodes.length}`)
    .digest("hex")
    .slice(0, 20);
}

function snippetOf(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 260);
}

function fileDocument(file: AnalysisResult["files"][number], content: string): IndexDocument {
  const clipped = content.slice(0, MAX_FILE_CHARS);
  return {
    id: `file:${file.path}`,
    kind: "file",
    title: file.path,
    text: clipped,
    path: file.path,
    line: 1,
    snippet: snippetOf(clipped),
    updatedAt: new Date().toISOString(),
  };
}

function projectDocument(analysis: AnalysisResult): IndexDocument {
  const frameworks = (analysis.frameworks ?? []).join(", ");
  const tooling = analysis.tooling;
  const text = [
    `Project: ${analysis.projectName}`,
    `Root: ${analysis.rootPath}`,
    `Frameworks: ${frameworks || "none"}`,
    `Languages: ${Object.entries(analysis.languages).map(([name, count]) => `${name} ${count}`).join(", ")}`,
    tooling
      ? `Ecosystems: ${tooling.ecosystems.join(", ")}; package managers: ${tooling.packageManagers.join(", ")}; test: ${tooling.testFramework ?? "none"}; tests: ${tooling.testCommands.join(" | ")}; typecheck: ${tooling.typecheckCommands?.join(" | ") ?? "none"}; build: ${tooling.buildCommands.join(" | ")}`
      : "",
    `Files: ${analysis.stats.files}; symbols: ${analysis.stats.symbols}; routes: ${analysis.stats.routes}`,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    id: `project:${analysis.id}`,
    kind: "project",
    title: analysis.projectName,
    text,
    path: "",
    line: 1,
    snippet: snippetOf(text),
    updatedAt: analysis.createdAt,
  };
}

function symbolDocuments(analysis: AnalysisResult): IndexDocument[] {
  return analysis.symbols.map((symbol) => ({
    id: `symbol:${symbol.id}`,
    kind: "symbol",
    title: symbol.qualifiedName,
    text: `${symbol.qualifiedName} ${symbol.signature} ${symbol.kind}`,
    path: symbol.filePath,
    line: symbol.startLine,
    symbol: symbol.qualifiedName,
    snippet: snippetOf(`${symbol.qualifiedName} — ${symbol.signature}`),
    updatedAt: analysis.createdAt,
  }));
}

function routeDocuments(analysis: AnalysisResult): IndexDocument[] {
  return analysis.nodes
    .filter((node) => node.kind === "route")
    .map((node) => ({
      id: `route:${node.id}`,
      kind: "route",
      title: node.label,
      text: `${node.label} ${node.metadata?.framework ?? ""} ${node.filePath ?? ""}`,
      path: node.filePath,
      line: node.startLine,
      snippet: snippetOf(`${node.label}${node.metadata?.framework ? ` · ${node.metadata.framework}` : ""}`),
      updatedAt: analysis.createdAt,
    }));
}

function conversationDocument(entry: StoredConversation): IndexDocument {
  return {
    id: `conversation:${entry.id}`,
    kind: "conversation",
    title: entry.question,
    text: `${entry.question}\n${entry.answer}`,
    path: "",
    line: 1,
    snippet: snippetOf(entry.answer),
    answer: entry.answer.slice(0, 2_000),
    updatedAt: entry.createdAt,
  };
}

async function readConversations(projectId: string): Promise<StoredConversation[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(conversationPath(projectId), "utf8")) as {
      entries?: StoredConversation[];
    };
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

async function saveConversations(projectId: string, entries: StoredConversation[]): Promise<void> {
  const file = conversationPath(projectId);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify({ version: 1, entries: entries.slice(-MAX_CONVERSATIONS) }), {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(temp, file);
}

async function loadIndex(projectId: string): Promise<LoadedIndex | null> {
  const cached = cache.get(projectId);
  if (cached) return cached;
  try {
    const raw = await fs.readFile(indexPath(projectId), "utf8");
    const meta = JSON.parse(await fs.readFile(metaPath(projectId), "utf8")) as IndexMeta;
    const index = MiniSearch.loadJSON<IndexDocument>(raw, indexOptions);
    const loaded = { index, meta };
    cache.set(projectId, loaded);
    return loaded;
  } catch {
    return null;
  }
}

async function saveIndex(projectId: string, index: MiniSearch<IndexDocument>, meta: IndexMeta): Promise<void> {
  await fs.mkdir(projectDir(projectId), { recursive: true, mode: 0o700 });
  const target = indexPath(projectId);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(index.toJSON()), { encoding: "utf8", mode: 0o600 });
  await fs.rename(temp, target);
  const metaTarget = metaPath(projectId);
  const metaTemp = `${metaTarget}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(metaTemp, JSON.stringify(meta), { encoding: "utf8", mode: 0o600 });
  await fs.rename(metaTemp, metaTarget);
  cache.set(projectId, { index, meta });
}

export async function getProjectIndexStatus(
  projectId: string,
  analysis?: AnalysisResult,
): Promise<ProjectIndexStatus> {
  const state = buildStates.get(projectId);
  const loaded = await loadIndex(projectId);
  const currentFingerprint = analysis ? fingerprintOf(analysis) : undefined;
  return {
    ready: Boolean(loaded),
    building: state?.building ?? false,
    processed: state?.processed ?? 0,
    total: state?.total ?? 0,
    documents: loaded?.index.documentCount ?? 0,
    updatedAt: loaded?.meta.updatedAt,
    stale: Boolean(
      loaded && currentFingerprint && loaded.meta.fingerprint !== currentFingerprint,
    ),
    partial: loaded?.meta.partial ?? false,
    error: state?.error,
  };
}

export async function buildProjectIndex(
  projectId: string,
  analysis: AnalysisResult,
): Promise<ProjectIndexStatus> {
  const state: BuildState = {
    building: true,
    processed: 0,
    total: analysis.files.length,
    error: undefined,
  };
  buildStates.set(projectId, state);
  try {
    const index = new MiniSearch<IndexDocument>(indexOptions);
    index.add(projectDocument(analysis));
    for (const symbol of symbolDocuments(analysis)) index.add(symbol);
    for (const route of routeDocuments(analysis)) index.add(route);
    const conversations = await readConversations(projectId);
    for (const conversation of conversations) index.add(conversationDocument(conversation));

    const indexedPaths = new Set(analysis.files.map((file) => file.path));
    const rootEntries = await fs.readdir(analysis.rootPath).catch(() => [] as string[]);
    const manifestNames = new Set([
      "package.json",
      "composer.json",
      "pyproject.toml",
      "requirements.txt",
      "go.mod",
      "Cargo.toml",
      "pom.xml",
      "build.gradle",
      "build.gradle.kts",
      "Gemfile",
      "Package.swift",
      "mix.exs",
      "build.sbt",
      "pubspec.yaml",
      "CMakeLists.txt",
      "tsconfig.json",
    ]);
    const documentNames = rootEntries.filter(
      (name) =>
        manifestNames.has(name) ||
        /^(README|CHANGELOG|LICENSE|CONTRIBUTING)/i.test(name),
    );
    for (const name of documentNames) {
      if (indexedPaths.has(name)) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        const content = await fs.readFile(path.join(analysis.rootPath, name), "utf8");
        index.add(
          fileDocument(
            {
              id: "",
              path: name,
              language: "other",
              bytes: Buffer.byteLength(content),
              loc: content.split("\n").length,
              hash: "",
              imports: [],
            },
            content,
          ),
        );
      } catch {
        // unreadable document
      }
    }

    const queue = [...analysis.files];
    const workers = Array.from({ length: 8 }, async () => {
      for (;;) {
        const file = queue.shift();
        if (!file) return;
        try {
          // eslint-disable-next-line no-await-in-loop
          const content = await fs.readFile(path.join(analysis.rootPath, file.path), "utf8");
          index.add(fileDocument(file, content));
        } catch {
          // unreadable or binary file; skip
        }
        state.processed += 1;
      }
    });
    await Promise.all(workers);

    const meta: IndexMeta = {
      version: 1,
      updatedAt: new Date().toISOString(),
      fingerprint: fingerprintOf(analysis),
      documentCount: index.documentCount,
      partial: false,
    };
    await saveIndex(projectId, index, meta);
    state.building = false;
    return getProjectIndexStatus(projectId, analysis);
  } catch (error) {
    state.building = false;
    state.error = error instanceof Error ? error.message : "Index build failed.";
    throw error;
  }
}

export function startProjectIndexBuild(projectId: string, analysis: AnalysisResult): ProjectIndexStatus {
  const existing = buildStates.get(projectId);
  if (existing?.building) {
    return {
      ready: Boolean(cache.get(projectId)),
      building: true,
      processed: existing.processed,
      total: existing.total,
      documents: cache.get(projectId)?.index.documentCount ?? 0,
      stale: false,
      partial: false,
    };
  }
  void buildProjectIndex(projectId, analysis).catch(() => {
    // status exposes the error
  });
  return {
    ready: Boolean(cache.get(projectId)),
    building: true,
    processed: 0,
    total: analysis.files.length,
    documents: cache.get(projectId)?.index.documentCount ?? 0,
    stale: false,
    partial: false,
  };
}

export async function searchProjectIndex(
  projectId: string,
  query: string,
  limit = 20,
  rootPath?: string,
): Promise<ProjectIndexHit[]> {
  const needle = query.trim();
  if (!needle) return [];
  const loaded = await loadIndex(projectId);
  if (!loaded) return [];
  const results = loaded.index.search(needle).slice(0, Math.max(1, Math.min(50, limit)));
  const hits: ProjectIndexHit[] = results.map((result) => ({
    id: String(result.id),
    kind: String(result.kind ?? "file"),
    title: String(result.title ?? ""),
    path: result.path ? String(result.path) : undefined,
    line: typeof result.line === "number" ? result.line : undefined,
    snippet: result.snippet ? String(result.snippet) : undefined,
    answer: result.answer ? String(result.answer) : undefined,
    score: result.score,
  }));

  if (rootPath) {
    const lowerNeedle = needle.toLowerCase();
    const tokens = lowerNeedle.split(/\s+/).filter((token) => token.length > 1);
    await Promise.all(
      hits.map(async (hit) => {
        if (hit.kind !== "file" || !hit.path) return;
        try {
          const content = await fs.readFile(path.join(rootPath, hit.path), "utf8");
          const lines = content.split("\n");
          const index = lines.findIndex(
            (line) =>
              line.toLowerCase().includes(lowerNeedle) ||
              (tokens.length > 0 && tokens.every((token) => line.toLowerCase().includes(token))),
          );
          if (index >= 0) {
            hit.line = index + 1;
            const line = lines[index];
            const position = line.toLowerCase().indexOf(lowerNeedle);
            const start = Math.max(0, position - 80);
            hit.snippet = line.slice(start, start + 260).trim();
          }
        } catch {
          // unreadable file; keep the stored snippet
        }
      }),
    );
  }

  return hits;
}

export async function updateIndexedFile(
  projectId: string,
  rootPath: string,
  relativePath: string,
  content?: string,
): Promise<void> {
  const loaded = await loadIndex(projectId);
  if (!loaded) return;
  let text = content;
  if (text === undefined) {
    try {
      text = await fs.readFile(path.join(rootPath, relativePath), "utf8");
    } catch {
      return;
    }
  }
  loaded.index.discard(`file:${relativePath}`);
  loaded.index.add(
    fileDocument(
      {
        id: "",
        path: relativePath,
        language: "other",
        bytes: Buffer.byteLength(text),
        loc: text.split("\n").length,
        hash: "",
        imports: [],
      },
      text,
    ),
  );
  const meta: IndexMeta = {
    ...loaded.meta,
    updatedAt: new Date().toISOString(),
    documentCount: loaded.index.documentCount,
    partial: true,
  };
  await saveIndex(projectId, loaded.index, meta);
}

export async function removeIndexedPath(projectId: string, relativePath: string): Promise<void> {
  const loaded = await loadIndex(projectId);
  if (!loaded) return;
  loaded.index.discard(`file:${relativePath}`);
  const meta: IndexMeta = {
    ...loaded.meta,
    updatedAt: new Date().toISOString(),
    documentCount: loaded.index.documentCount,
    partial: true,
  };
  await saveIndex(projectId, loaded.index, meta);
}

export async function renameIndexedPath(
  projectId: string,
  rootPath: string,
  from: string,
  to: string,
): Promise<void> {
  await removeIndexedPath(projectId, from);
  await updateIndexedFile(projectId, rootPath, to);
}

export async function recordConversation(
  projectId: string,
  question: string,
  answer: string,
  provider: string,
  model: string,
): Promise<void> {
  if (!question.trim() || !answer.trim()) return;
  const conversations = await readConversations(projectId);
  if (
    conversations.some(
      (entry) => entry.question === question.trim() && entry.answer === answer.trim(),
    )
  ) {
    return;
  }
  const entry: StoredConversation = {
    id: crypto.createHash("sha1").update(`${question}\n${answer}`).digest("hex").slice(0, 16),
    question: question.trim(),
    answer: answer.trim(),
    provider,
    model,
    createdAt: new Date().toISOString(),
  };
  conversations.push(entry);
  await saveConversations(projectId, conversations);
}

export async function importConversations(
  projectId: string,
  pairs: { question: string; answer: string }[],
  provider = "imported",
  model = "imported",
): Promise<number> {
  let imported = 0;
  for (const pair of pairs.slice(0, 80)) {
    if (!pair.question.trim() || !pair.answer.trim()) continue;
    await recordConversation(projectId, pair.question, pair.answer, provider, model);
    imported += 1;
  }
  return imported;
}

export async function searchConversations(
  projectId: string,
  query: string,
  limit = 5,
): Promise<ProjectIndexHit[]> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const tokens = needle.split(/\s+/).filter((token) => token.length > 1);
  const conversations = await readConversations(projectId);
  return conversations
    .map((entry) => {
      const haystack = `${entry.question} ${entry.answer}`.toLowerCase();
      let score = haystack.includes(needle) ? 4 : 0;
      for (const token of tokens) if (haystack.includes(token)) score += 1;
      return { entry, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ entry, score }) => ({
      id: `conversation:${entry.id}`,
      kind: "conversation",
      title: entry.question,
      answer: entry.answer.slice(0, 2_000),
      snippet: snippetOf(entry.answer),
      score,
    }));
}
