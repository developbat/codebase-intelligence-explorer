import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AnalysisResult, CodeSearchResponse, CodeSearchResult, GraphNode } from "../../shared/types";
import { isWithin } from "./scanner";

interface VectorDoc {
  nodeId: string;
  label: string;
  kind: GraphNode["kind"];
  filePath?: string;
  startLine?: number;
  endLine?: number;
  snippet?: string;
  tokens: Map<string, number>;
  norm: number;
}

interface VectorIndex {
  fingerprint: string;
  docs: VectorDoc[];
  idf: Map<string, number>;
  builtAt: number;
}

const indexCache = new Map<string, VectorIndex>();
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "const", "let", "var", "function", "return",
  "import", "export", "class", "interface", "type", "async", "await", "new", "true", "false", "null",
  "undefined", "string", "number", "boolean", "void", "public", "private", "readonly", "extends",
  "implements", "if", "else", "try", "catch", "throw", "bir", "bu", "ile", "için", "olan", "ve",
]);

function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_$]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token))
    .slice(0, 800);
}

function fingerprintOf(analysis: AnalysisResult): string {
  return crypto
    .createHash("sha1")
    .update(analysis.files.map((file) => `${file.path}:${file.hash}`).join("|"))
    .digest("hex")
    .slice(0, 16);
}

function addDoc(
  docs: VectorDoc[],
  doc: Omit<VectorDoc, "tokens" | "norm">,
  text: string,
): void {
  const counts = new Map<string, number>();
  for (const token of tokenize(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
  let sum = 0;
  for (const count of counts.values()) sum += count * count;
  docs.push({
    ...doc,
    tokens: counts,
    norm: Math.sqrt(sum),
    snippet: doc.snippet?.replace(/\s+/g, " ").slice(0, 180),
  });
}

async function buildIndex(analysis: AnalysisResult): Promise<VectorIndex> {
  const fingerprint = fingerprintOf(analysis);
  const cached = indexCache.get(analysis.id);
  if (cached?.fingerprint === fingerprint) return cached;

  const docs: VectorDoc[] = [];
  const nodeById = new Map(analysis.nodes.map((node) => [node.id, node]));
  const contents = new Map<string, string[]>();

  const filesToRead = analysis.files.slice(0, 500);
  await Promise.all(
    filesToRead.map(async (file) => {
      try {
        const absolute = path.resolve(analysis.rootPath, file.path);
        if (!isWithin(analysis.rootPath, absolute)) return;
        const content = await fs.readFile(absolute, "utf8");
        contents.set(file.path, content.split("\n"));
      } catch {
        // unreadable files are skipped
      }
    }),
  );

  for (const symbol of analysis.symbols.slice(0, 3000)) {
    const node = nodeById.get(symbol.id);
    if (!node) continue;
    const lines = contents.get(symbol.filePath);
    const body = lines
      ? lines.slice(symbol.startLine - 1, symbol.endLine).join("\n").slice(0, 4000)
      : "";
    const firstLine = body.split("\n").find((line) => line.trim().length > 0)?.trim();
    addDoc(
      docs,
      {
        nodeId: symbol.id,
        label: symbol.qualifiedName,
        kind: symbol.kind,
        filePath: symbol.filePath,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        snippet: firstLine ?? symbol.signature,
      },
      `${symbol.qualifiedName} ${symbol.name} ${symbol.signature} ${symbol.filePath} ${body}`,
    );
  }

  for (const node of analysis.nodes) {
    if (node.kind === "file") {
      const record = analysis.files.find((file) => file.path === node.filePath);
      addDoc(
        docs,
        {
          nodeId: node.id,
          label: node.label,
          kind: node.kind,
          filePath: node.filePath,
          snippet: record ? record.imports.join(", ").slice(0, 160) : undefined,
        },
        `${node.label} ${node.filePath} ${record?.imports.join(" ") ?? ""}`,
      );
    } else if (node.kind === "route" || node.kind === "database" || node.kind === "event" || node.kind === "module") {
      addDoc(
        docs,
        {
          nodeId: node.id,
          label: node.label,
          kind: node.kind,
          filePath: node.filePath,
          startLine: node.startLine,
          endLine: node.endLine,
          snippet:
            typeof node.metadata?.signature === "string" ? node.metadata.signature : undefined,
        },
        `${node.label} ${node.kind} ${node.filePath ?? ""} ${JSON.stringify(node.metadata ?? {})}`,
      );
    }
  }

  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const token of doc.tokens.keys()) df.set(token, (df.get(token) ?? 0) + 1);
  }
  const idf = new Map<string, number>();
  for (const [token, frequency] of df) idf.set(token, Math.log((docs.length + 1) / (frequency + 0.5)) + 1);

  // Weight vectors by IDF once.
  for (const doc of docs) {
    for (const [token, count] of doc.tokens) doc.tokens.set(token, count * (idf.get(token) ?? 1));
    let sum = 0;
    for (const value of doc.tokens.values()) sum += value * value;
    doc.norm = Math.sqrt(sum);
  }

  const index: VectorIndex = { fingerprint, docs, idf, builtAt: Date.now() };
  indexCache.set(analysis.id, index);
  if (indexCache.size > 6) {
    const oldest = [...indexCache.entries()].sort((a, b) => a[1].builtAt - b[1].builtAt)[0];
    if (oldest) indexCache.delete(oldest[0]);
  }
  return index;
}

export async function searchCode(
  analysis: AnalysisResult,
  query: string,
  limit = 20,
): Promise<CodeSearchResponse> {
  const startedAt = Date.now();
  const index = await buildIndex(analysis);
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return { query, results: [], indexSize: index.docs.length, tookMs: Date.now() - startedAt };
  }

  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  let queryNorm = 0;
  for (const [token, count] of counts) {
    const weighted = count * (index.idf.get(token) ?? 1);
    counts.set(token, weighted);
    queryNorm += weighted * weighted;
  }
  queryNorm = Math.sqrt(queryNorm);
  const needle = query.trim().toLowerCase();

  const scored: { doc: VectorDoc; score: number; exact: number }[] = [];
  for (const doc of index.docs) {
    if (doc.norm === 0) continue;
    let dot = 0;
    for (const [token, weight] of counts) {
      const value = doc.tokens.get(token);
      if (value) dot += weight * value;
    }
    if (dot === 0) continue;
    const exact = doc.label.toLowerCase().includes(needle) ? 1 : 0;
    scored.push({ doc, score: dot / (queryNorm * doc.norm) + exact * 0.25, exact });
  }

  scored.sort((a, b) => b.score - a.score || b.exact - a.exact);
  const results: CodeSearchResult[] = scored.slice(0, Math.max(1, Math.min(50, limit))).map(({ doc, score }) => ({
    nodeId: doc.nodeId,
    label: doc.label,
    kind: doc.kind,
    filePath: doc.filePath,
    startLine: doc.startLine,
    endLine: doc.endLine,
    score: Math.round(score * 1000) / 1000,
    snippet: doc.snippet,
  }));

  return {
    query,
    results,
    indexSize: index.docs.length,
    tookMs: Date.now() - startedAt,
  };
}
