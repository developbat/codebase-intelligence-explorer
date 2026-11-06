import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AnalysisResult,
  SymbolRecord,
} from "../../../shared/types";
import type {
  AiBusinessFlow,
  AiBusinessFlowsResult,
  AiChatResult,
  AiContextFile,
  AiProjectSummary,
  AiScopeSummary,
  AiReviewFinding,
  AiReviewResult,
  AiSymbolAnalysis,
  AiUnresolvedAnalysis,
  AiUsage,
  UnresolvedClassification,
} from "../../../shared/ai";
import { aiLanguageInstruction } from "../../../shared/ai";
import { getGitStatus, getFileDiff } from "../git";
import { getDataDir, loadAnalysis } from "../store";
import { isWithin } from "../scanner";
import { chat, type ChatMessage } from "./providers";
import { resolveProvider } from "./settings";

const PROMPT_VERSION = "v1";
const MAX_CONTEXT_CHARS = 16_000;

interface CacheEntry<T> {
  createdAt: string;
  data: T;
}

interface AiCache {
  entries: Record<string, CacheEntry<unknown>>;
}

function cachePath(projectId: string): string {
  return path.join(getDataDir(), "projects", projectId, "ai-cache.json");
}

async function readCache(projectId: string): Promise<AiCache> {
  try {
    const parsed = JSON.parse(await fs.readFile(cachePath(projectId), "utf8")) as AiCache;
    return { entries: parsed.entries ?? {} };
  } catch {
    return { entries: {} };
  }
}

async function writeCache(projectId: string, cache: AiCache): Promise<void> {
  const entries = Object.entries(cache.entries)
    .sort((a, b) => (a[1].createdAt < b[1].createdAt ? 1 : -1))
    .slice(0, 120);
  const file = cachePath(projectId);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify({ entries: Object.fromEntries(entries) }), {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(temp, file);
}

export function sourceHash(content: string): string {
  return crypto.createHash("sha1").update(content).digest("hex");
}

async function readLines(
  analysis: AnalysisResult,
  filePath: string,
  startLine: number,
  endLine: number,
  maxChars = 6000,
): Promise<string> {
  const absolute = path.resolve(analysis.rootPath, filePath);
  if (!isWithin(analysis.rootPath, absolute)) throw new Error("Access outside the project root was denied.");
  const content = await fs.readFile(absolute, "utf8");
  const lines = content.split("\n");
  const from = Math.max(1, startLine);
  const to = Math.min(lines.length, Math.max(from, endLine));
  let text = lines
    .slice(from - 1, to)
    .map((line, index) => `${from + index}: ${line}`)
    .join("\n");
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n… truncated …`;
  return text;
}

function symbolByGraphId(analysis: AnalysisResult, symbolId: string): SymbolRecord | undefined {
  return analysis.symbols.find((symbol) => symbol.id === symbolId);
}

function nodeLabel(analysis: AnalysisResult, nodeId: string): string {
  const node = analysis.nodes.find((candidate) => candidate.id === nodeId);
  return node?.metadata?.qualifiedName ?? node?.label ?? nodeId;
}

function evidenceOf(analysis: AnalysisResult, filePath: string, startLine?: number, endLine?: number, label?: string): AiContextFile {
  return { path: filePath, startLine, endLine, label };
}

function parseJsonObject(text: string): Record<string, unknown> {
  const withoutFences = text.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const start = withoutFences.indexOf("{");
  const end = withoutFences.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("The model did not return a JSON object.");
  try {
    return JSON.parse(withoutFences.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new Error("The model returned invalid JSON. Try again or switch models.");
  }
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function normalizeEvidence(value: unknown, fallback: AiContextFile[]): AiContextFile[] {
  if (!Array.isArray(value)) return fallback;
  const items: AiContextFile[] = [];
  for (const item of value) {
    const entry = item as Record<string, unknown>;
    const file = String(entry.file ?? entry.path ?? "");
    if (!file) continue;
    items.push({
      path: file,
      startLine: Number(entry.start_line ?? entry.startLine) || undefined,
      endLine: Number(entry.end_line ?? entry.endLine) || undefined,
      label: entry.description ? String(entry.description) : undefined,
    });
  }
  return items.length > 0 ? items : fallback;
}

function cacheKey(parts: (string | undefined)[]): string {
  return `${PROMPT_VERSION}:${parts.filter(Boolean).join(":")}`;
}

function projectBrief(analysis: AnalysisResult): string {
  return [
    `Project: ${analysis.projectName}`,
    `Root: ${analysis.rootPath}`,
    `Frameworks: ${(analysis.frameworks ?? []).join(", ") || "none detected"}`,
    `Files: ${analysis.stats.files}, symbols: ${analysis.stats.symbols}, routes: ${analysis.stats.routes}, database objects: ${analysis.stats.databases}, events: ${analysis.stats.events}`,
    `Languages: ${Object.entries(analysis.languages).map(([language, count]) => `${language} (${count})`).join(", ")}`,
  ].join("\n");
}

export async function analyzeSymbol(
  projectId: string,
  symbolId: string,
  options: { provider?: Parameters<typeof resolveProvider>[0]; model?: string; force?: boolean; language?: string } = {},
): Promise<AiSymbolAnalysis> {
  const analysis = await loadAnalysis(projectId);
  const symbol = symbolByGraphId(analysis, symbolId);
  if (!symbol) throw new Error("Symbol was not found in this analysis.");
  const config = await resolveProvider(options.provider, options.model);
  const file = analysis.files.find((candidate) => candidate.path === symbol.filePath);
  const key = cacheKey([
    "symbol",
    config.id,
    config.model,
    symbol.id,
    symbol.hash ?? file?.hash ?? String(symbol.startLine),
    options.language ?? "en",
  ]);

  const cache = await readCache(projectId);
  if (!options.force) {
    const hit = cache.entries[key] as CacheEntry<AiSymbolAnalysis> | undefined;
    if (hit) return { ...hit.data, cached: true };
  }

  const source = await readLines(analysis, symbol.filePath, symbol.startLine, symbol.endLine);
  const callers = analysis.edges
    .filter((edge) => edge.kind === "CALLS" && edge.target === symbol.id)
    .map((edge) => nodeLabel(analysis, edge.source))
    .slice(0, 20);
  const callees = analysis.edges
    .filter((edge) => edge.kind === "CALLS" && edge.source === symbol.id)
    .map((edge) => nodeLabel(analysis, edge.target))
    .slice(0, 30);

  const context = [
    projectBrief(analysis),
    "",
    `Symbol: ${symbol.qualifiedName} (${symbol.kind})`,
    `File: ${symbol.filePath}:${symbol.startLine}-${symbol.endLine}`,
    `Signature: ${symbol.signature}`,
    `Exported: ${symbol.exported}; async: ${symbol.async}`,
    `Callers: ${callers.join(", ") || "none resolved"}`,
    `Callees: ${callees.join(", ") || "none resolved"}`,
    "",
    "Actual source code:",
    "```",
    source,
    "```",
  ].join("\n");

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are a senior code intelligence analyst. Read the actual implementation before explaining it. Never infer behavior from names alone. Return ONLY valid JSON with this shape: " +
        '{"purpose":"...","businessSteps":["..."],"inputs":["..."],"outputs":["..."],"sideEffects":["..."],"risks":["..."],"uncertainties":["..."]}. ' +
        "Each uncertainty must state what cannot be verified from the provided code. Keep steps concrete and traceable to the code. " +
        aiLanguageInstruction(options.language),
    },
    {
      role: "user",
      content: `${context}\n\nAnalyze this symbol. Use short, specific statements. ` +
        "Include database writes, network calls, events, validation, and error paths you can actually see. " +
        "If a callee implementation is not provided, say that its behavior is unverified.",
    },
  ];

  const response = await chat(config, messages, { maxTokens: 1600, temperature: 0.1 });
  const parsed = parseJsonObject(response);
  const usage: AiUsage = {
    inputChars: context.length,
    estimatedTokens: Math.ceil(context.length / 4),
    contextFiles: [evidenceOf(analysis, symbol.filePath, symbol.startLine, symbol.endLine, symbol.qualifiedName)],
  };
  const result: AiSymbolAnalysis = {
    symbol: symbol.qualifiedName,
    purpose: String(parsed.purpose ?? "No purpose returned."),
    businessSteps: stringArray(parsed.businessSteps ?? parsed.business_steps),
    inputs: stringArray(parsed.inputs),
    outputs: stringArray(parsed.outputs),
    sideEffects: stringArray(parsed.sideEffects ?? parsed.side_effects),
    risks: stringArray(parsed.risks),
    uncertainties: stringArray(parsed.uncertainties),
    evidence: normalizeEvidence(parsed.evidence, usage.contextFiles),
    provider: config.id,
    model: config.model,
    cached: false,
    createdAt: new Date().toISOString(),
    usage,
  };

  cache.entries[key] = { createdAt: result.createdAt, data: result };
  await writeCache(projectId, cache);
  return result;
}

export async function reviewChanges(
  projectId: string,
  options: {
    provider?: Parameters<typeof resolveProvider>[0];
    model?: string;
    force?: boolean;
    files?: string[];
    base?: string;
    language?: string;
  } = {},
): Promise<AiReviewResult> {
  const analysis = await loadAnalysis(projectId);
  const config = await resolveProvider(options.provider, options.model);
  const status = await getGitStatus(analysis.rootPath, analysis);
  if (!status.available) throw new Error("Git is not available for this project.");
  const allowed = options.files && options.files.length > 0 ? new Set(options.files) : null;
  const candidates = allowed ? status.files.filter((file) => allowed.has(file.path)) : status.files;
  if (candidates.length === 0) throw new Error("There are no changed files to review.");

  const filesToReview = candidates.slice(0, 6);
  const base = options.base || analysis.git?.head || "HEAD";
  const blocks: string[] = [];
  const contextFiles: AiContextFile[] = [];
  for (const file of filesToReview) {
    if (file.status === "deleted") {
      blocks.push(`### ${file.path} (deleted)\nFile was deleted.`);
      contextFiles.push({ path: file.path, label: "deleted" });
      continue;
    }
    try {
      const diff = await getFileDiff(analysis.rootPath, file.path, base);
      const text = diff.diff.slice(0, 8000);
      blocks.push(`### ${file.path} (${file.status})\n\`\`\`diff\n${text}\n\`\`\``);
      contextFiles.push({ path: file.path, label: file.status });
    } catch {
      blocks.push(`### ${file.path} (${file.status})\nDiff could not be read.`);
    }
  }

  const context = [
    projectBrief(analysis),
    "",
    `Git: ${status.branch ?? "unknown branch"} @ ${status.head?.slice(0, 10) ?? "unknown"}`,
    `Changed files: ${status.files.map((file) => `${file.path} (${file.status})`).join(", ")}`,
    "",
    ...blocks,
  ].join("\n");

  const diffHash = crypto.createHash("sha1").update(context).digest("hex");
  const key = cacheKey(["review", config.id, config.model, diffHash, options.language ?? "en"]);
  const cache = await readCache(projectId);
  if (!options.force) {
    const hit = cache.entries[key] as CacheEntry<AiReviewResult> | undefined;
    if (hit) return { ...hit.data, cached: true };
  }

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are a strict senior code reviewer. Review the actual diff and the project context. " +
        "Only report issues you can support with the provided diff. Do not invent runtime behavior. Return ONLY valid JSON: " +
        '{"summary":"...","riskLevel":"critical|high|medium|low","findings":[{"severity":"critical|high|medium|low","file":"path","line":123,"category":"bug|security|performance|maintainability|tests|api-contract","title":"...","description":"...","suggestion":"..."}]}. ' +
        "If there are no material issues, return an empty findings array and say so in the summary. " +
        aiLanguageInstruction(options.language),
    },
    {
      role: "user",
      content: `${context}\n\nReview the pending changes. Focus on correctness, regressions, security, error handling, API contracts, and missing tests. Reference file paths and line numbers from the diff.`,
    },
  ];

  const response = await chat(config, messages, { maxTokens: 2200, temperature: 0.1 });
  const parsed = parseJsonObject(response);
  const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
  const findings: AiReviewFinding[] = rawFindings
    .map((item) => {
      const finding = item as Record<string, unknown>;
      const severity = String(finding.severity ?? "medium").toLowerCase();
      return {
        severity: (["critical", "high", "medium", "low"].includes(severity) ? severity : "medium") as AiReviewFinding["severity"],
        file: String(finding.file ?? ""),
        line: Number(finding.line) || undefined,
        category: String(finding.category ?? "general"),
        title: String(finding.title ?? "Finding"),
        description: String(finding.description ?? ""),
        suggestion: finding.suggestion ? String(finding.suggestion) : undefined,
      };
    })
    .filter(
      (finding) =>
        Boolean(finding.file) &&
        filesToReview.some(
          (file) =>
            file.path === finding.file.replace(/^\.?\//, "") ||
            file.path.endsWith(finding.file.replace(/^\.?\//, "")) ||
            finding.file.endsWith(file.path),
        ),
    );

  const risk = String(parsed.riskLevel ?? parsed.risk_level ?? "medium").toLowerCase();
  const result: AiReviewResult = {
    summary: String(parsed.summary ?? "Review completed."),
    riskLevel: (["critical", "high", "medium", "low"].includes(risk) ? risk : "medium") as AiReviewResult["riskLevel"],
    findings,
    filesReviewed: filesToReview.map((file) => file.path),
    provider: config.id,
    model: config.model,
    cached: false,
    createdAt: new Date().toISOString(),
    usage: { inputChars: context.length, estimatedTokens: Math.ceil(context.length / 4), contextFiles },
  };

  cache.entries[key] = { createdAt: result.createdAt, data: result };
  await writeCache(projectId, cache);
  return result;
}

export async function summarizeScope(
  projectId: string,
  nodeId: string,
  options: { provider?: Parameters<typeof resolveProvider>[0]; model?: string; force?: boolean; language?: string } = {},
): Promise<AiScopeSummary> {
  const analysis = await loadAnalysis(projectId);
  const node = analysis.nodes.find((candidate) => candidate.id === nodeId);
  if (!node || !["file", "folder", "module"].includes(node.kind)) {
    throw new Error("Only files, folders, and packages can be summarized.");
  }
  const config = await resolveProvider(options.provider, options.model);
  const fingerprint = crypto
    .createHash("sha1")
    .update(analysis.files.map((file) => `${file.path}:${file.hash}`).join("|"))
    .digest("hex")
    .slice(0, 16);
  const key = cacheKey(["scope", config.id, config.model, nodeId, fingerprint, options.language ?? "en"]);
  const cache = await readCache(projectId);
  if (!options.force) {
    const hit = cache.entries[key] as CacheEntry<AiScopeSummary> | undefined;
    if (hit) return { ...hit.data, cached: true };
  }

  let files: string[] = [];
  if (node.kind === "file" && node.filePath) {
    files = [node.filePath];
  } else if (node.kind === "folder" && node.filePath) {
    const prefix = `${node.filePath}/`;
    files = analysis.files.filter((file) => file.path.startsWith(prefix)).map((file) => file.path);
  } else if (node.kind === "module") {
    files = analysis.edges
      .filter((edge) => edge.kind === "IMPORTS" && edge.target === node.id)
      .map((edge) => analysis.nodes.find((candidate) => candidate.id === edge.source)?.filePath)
      .filter((file): file is string => Boolean(file));
  }

  const scopeSymbols = analysis.symbols
    .filter((symbol) => files.includes(symbol.filePath))
    .sort(
      (a, b) =>
        (analysis.nodes.find((candidate) => candidate.id === b.id)?.metadata?.callerCount ?? 0) -
        (analysis.nodes.find((candidate) => candidate.id === a.id)?.metadata?.callerCount ?? 0),
    );
  const topSymbols = scopeSymbols.slice(0, 8);
  const relatedRoutes = analysis.nodes.filter(
    (candidate) => candidate.kind === "route" && candidate.filePath && files.includes(candidate.filePath),
  );
  const relatedDatabases = analysis.nodes.filter(
    (candidate) => candidate.kind === "database" && candidate.filePath && files.includes(candidate.filePath),
  );
  const relatedEvents = analysis.nodes.filter(
    (candidate) => candidate.kind === "event",
  );
  const imports = analysis.edges
    .filter(
      (edge) =>
        edge.kind === "IMPORTS" &&
        analysis.nodes.find((candidate) => candidate.id === edge.source)?.filePath &&
        files.includes(analysis.nodes.find((candidate) => candidate.id === edge.source)!.filePath!),
    )
    .map((edge) => analysis.nodes.find((candidate) => candidate.id === edge.target))
    .filter((target): target is NonNullable<typeof target> => Boolean(target));

  const contextFiles: AiContextFile[] = [];
  const contextParts = [
    projectBrief(analysis),
    "",
    `Scope: ${node.metadata?.qualifiedName ?? node.label} (${node.kind})`,
    `Files (${files.length}):\n${files.slice(0, 80).map((file) => `- ${file}`).join("\n")}`,
    "",
    "Symbols:",
    scopeSymbols
      .slice(0, 40)
      .map((symbol) => `- ${symbol.qualifiedName} (${symbol.kind}) ${symbol.filePath}:${symbol.startLine}`)
      .join("\n"),
    "",
    `Routes: ${relatedRoutes.map((route) => route.label).join(", ") || "none"}`,
    `Database objects: ${relatedDatabases.map((database) => database.label).join(", ") || "none"}`,
    `Events: ${relatedEvents.map((event) => event.label).join(", ") || "none"}`,
    `Imports: ${imports.map((target) => target.label).join(", ") || "none"}`,
  ];

  let budget = 10_000;
  for (const symbol of topSymbols) {
    if (budget <= 0) break;
    const source = await readLines(analysis, symbol.filePath, symbol.startLine, symbol.endLine, Math.min(2200, budget));
    contextParts.push("", `### ${symbol.qualifiedName}`, `File: ${symbol.filePath}:${symbol.startLine}`, "```", source, "```");
    budget -= source.length;
    contextFiles.push({ path: symbol.filePath, startLine: symbol.startLine, endLine: symbol.endLine, label: symbol.qualifiedName });
  }

  const context = contextParts.join("\n");
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are a code intelligence analyst summarizing a file, folder, or package. Use only the provided context. " +
        "Return ONLY valid JSON: " +
        '{"summary":"...","responsibilities":["..."],"dependencies":["..."],"risks":["..."],"evidence":[{"file":"path","start_line":1,"end_line":10,"description":"..."}]}. ' +
        "Be concrete. Explain what this scope owns, what it depends on, and which risks are visible. " +
        aiLanguageInstruction(options.language),
    },
    {
      role: "user",
      content: `${context}\n\nSummarize this ${node.kind}.`,
    },
  ];
  const response = await chat(config, messages, { maxTokens: 1600, temperature: 0.15 });
  const parsed = parseJsonObject(response);
  const usage: AiUsage = { inputChars: context.length, estimatedTokens: Math.ceil(context.length / 4), contextFiles };
  const result: AiScopeSummary = {
    scope: node.metadata?.qualifiedName ?? node.label,
    kind: node.kind,
    summary: String(parsed.summary ?? "No summary returned."),
    responsibilities: stringArray(parsed.responsibilities),
    dependencies: stringArray(parsed.dependencies),
    risks: stringArray(parsed.risks),
    evidence: normalizeEvidence(parsed.evidence, contextFiles),
    provider: config.id,
    model: config.model,
    cached: false,
    createdAt: new Date().toISOString(),
    usage,
  };
  cache.entries[key] = { createdAt: result.createdAt, data: result };
  await writeCache(projectId, cache);
  return result;
}

export async function summarizeProject(
  projectId: string,
  options: { provider?: Parameters<typeof resolveProvider>[0]; model?: string; force?: boolean; language?: string } = {},
): Promise<AiProjectSummary> {
  const analysis = await loadAnalysis(projectId);
  const config = await resolveProvider(options.provider, options.model);
  const fingerprint = crypto
    .createHash("sha1")
    .update(analysis.files.map((file) => `${file.path}:${file.hash}`).join("|"))
    .digest("hex")
    .slice(0, 16);
  const key = cacheKey(["summary", config.id, config.model, fingerprint, options.language ?? "en"]);
  const cache = await readCache(projectId);
  if (!options.force) {
    const hit = cache.entries[key] as CacheEntry<AiProjectSummary> | undefined;
    if (hit) return { ...hit.data, cached: true };
  }

  const routes = analysis.nodes.filter((node) => node.kind === "route");
  const databases = analysis.nodes.filter((node) => node.kind === "database");
  const events = analysis.nodes.filter((node) => node.kind === "event");
  const degree = (node: AnalysisResult["nodes"][number]) =>
    (node.metadata?.callerCount ?? 0) + (node.metadata?.callCount ?? 0);
  const functions = analysis.nodes
    .filter((node) => node.kind === "function" || node.kind === "method")
    .sort((a, b) => degree(b) - degree(a));
  const topFunctions = functions.slice(0, 10);
  const entryFiles = new Set(
    analysis.nodes
      .filter(
        (node) =>
          node.kind === "file" &&
          node.filePath &&
          /(^|\/)(index|main|server|app|bootstrap|routes?)\.[^.]+$/i.test(node.filePath),
      )
      .map((node) => node.id),
  );
  const entries = analysis.symbols
    .filter(
      (symbol) =>
        symbol.exported &&
        (entryFiles.has(`file:${symbol.filePath}`) ||
          /(^|\/)(index|main|server|app|bootstrap|routes?)\.[^.]+$/i.test(symbol.filePath)),
    )
    .slice(0, 8);

  const selectedSymbols = [...new Map(
    [...topFunctions, ...entries.map((entry) => analysis.nodes.find((node) => node.id === entry.id)).filter(Boolean)]
      .map((node) => [node!.id, node!] as const),
  ).values()].slice(0, 8);

  const contextFiles: AiContextFile[] = [];
  const contextParts = [projectBrief(analysis), ""];
  let budget = 12_000;

  if (routes.length > 0) {
    contextParts.push(
      `Routes:\n${routes
        .slice(0, 30)
        .map((route) => `- ${route.label} (${route.filePath ?? "unknown"})`)
        .join("\n")}`,
    );
  }
  if (databases.length > 0) {
    contextParts.push(
      `Database objects:\n${databases
        .slice(0, 30)
        .map((database) => `- ${database.label}${database.metadata?.orm ? ` [${database.metadata.orm}]` : ""}`)
        .join("\n")}`,
    );
  }
  if (events.length > 0) {
    contextParts.push(`Events:\n${events.slice(0, 20).map((event) => `- ${event.label}`).join("\n")}`);
  }

  for (const node of selectedSymbols) {
    if (budget <= 0) break;
    const symbol = analysis.symbols.find((candidate) => candidate.id === node.id);
    if (!symbol) continue;
    contextParts.push(`### ${symbol.qualifiedName} (${symbol.kind})`);
    contextParts.push(`File: ${symbol.filePath}:${symbol.startLine}-${symbol.endLine}`);
    contextParts.push(`Signature: ${symbol.signature}`);
    if (budget > 800) {
      const source = await readLines(analysis, symbol.filePath, symbol.startLine, symbol.endLine, Math.min(2400, budget));
      contextParts.push("```", source, "```");
      budget -= source.length;
      contextFiles.push({
        path: symbol.filePath,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        label: symbol.qualifiedName,
      });
    }
  }

  const context = contextParts.join("\n");
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are a software architect explaining an unfamiliar codebase. Use only the provided graph and source context. " +
        "Return ONLY valid JSON: " +
        '{"summary":"...","architecture":"...","keyFlows":["..."],"entryPoints":["..."],"risks":["..."],"evidence":[{"file":"path","start_line":1,"end_line":10,"description":"..."}]}. ' +
        "Write a clear narrative a developer could read in two minutes. Explain the major modules, how requests/data move, and what is uncertain. Do not invent behavior. " +
        aiLanguageInstruction(options.language),
    },
    {
      role: "user",
      content: `${context}\n\nExplain this project's architecture and its most important flows in natural language. ` +
        "Keep evidence paths tied to the provided context.",
    },
  ];

  const response = await chat(config, messages, { maxTokens: 2200, temperature: 0.2 });
  const parsed = parseJsonObject(response);
  const usage: AiUsage = { inputChars: context.length, estimatedTokens: Math.ceil(context.length / 4), contextFiles };
  const result: AiProjectSummary = {
    summary: String(parsed.summary ?? "No summary returned."),
    architecture: String(parsed.architecture ?? ""),
    keyFlows: stringArray(parsed.keyFlows ?? parsed.key_flows),
    entryPoints: stringArray(parsed.entryPoints ?? parsed.entry_points),
    risks: stringArray(parsed.risks),
    evidence: normalizeEvidence(parsed.evidence, contextFiles),
    provider: config.id,
    model: config.model,
    cached: false,
    createdAt: new Date().toISOString(),
    usage,
  };

  cache.entries[key] = { createdAt: result.createdAt, data: result };
  await writeCache(projectId, cache);
  return result;
}

const UNRESOLVED_CLASSES: UnresolvedClassification[] = [
  "builtin",
  "external-package",
  "dynamic-dispatch",
  "callback",
  "string-based",
  "missed-local",
  "unknown",
];

export async function discoverBusinessFlows(
  projectId: string,
  options: { provider?: Parameters<typeof resolveProvider>[0]; model?: string; force?: boolean; language?: string } = {},
): Promise<AiBusinessFlowsResult> {
  const analysis = await loadAnalysis(projectId);
  const config = await resolveProvider(options.provider, options.model);
  const fingerprint = crypto
    .createHash("sha1")
    .update(analysis.files.map((file) => `${file.path}:${file.hash}`).join("|"))
    .digest("hex")
    .slice(0, 16);
  const key = cacheKey(["flows", config.id, config.model, fingerprint, options.language ?? "en"]);
  const cache = await readCache(projectId);
  if (!options.force) {
    const hit = cache.entries[key] as CacheEntry<AiBusinessFlowsResult> | undefined;
    if (hit) return { ...hit.data, cached: true };
  }

  const nodeById = new Map(analysis.nodes.map((node) => [node.id, node]));
  const routes = analysis.nodes.filter((node) => node.kind === "route");
  const routesToUse = routes.length > 0
    ? routes.slice(0, 12)
    : analysis.nodes
        .filter((node) => node.kind === "function" || node.kind === "method")
        .sort(
          (a, b) =>
            (b.metadata?.callerCount ?? 0) + (b.metadata?.callCount ?? 0) -
            ((a.metadata?.callerCount ?? 0) + (a.metadata?.callCount ?? 0)),
        )
        .slice(0, 6);

  const chains: string[] = [];
  const contextFiles: AiContextFile[] = [];
  const chainNodes = new Set<string>();

  for (const route of routesToUse) {
    const steps: string[] = [];
    const queue: { id: string; depth: number }[] = [{ id: route.id, depth: 0 }];
    const seen = new Set<string>();
    while (queue.length > 0 && chainNodes.size < 80) {
      const current = queue.shift()!;
      if (seen.has(current.id) || current.depth > 3) continue;
      seen.add(current.id);
      const node = nodeById.get(current.id);
      if (!node) continue;
      chainNodes.add(node.id);
      steps.push(
        `${"  ".repeat(current.depth)}- ${node.label} [${node.kind}]${node.filePath ? ` (${node.filePath}:${node.startLine ?? 1})` : ""}`,
      );
      if (current.depth < 3) {
        for (const edge of analysis.edges) {
          if (edge.source !== node.id) continue;
          if (edge.kind === "ROUTES_TO" || edge.kind === "CALLS" || edge.kind === "READS_FROM" || edge.kind === "WRITES_TO" || edge.kind === "PUBLISHES" || edge.kind === "SUBSCRIBES_TO") {
            queue.push({ id: edge.target, depth: current.depth + 1 });
          }
        }
      }
    }
    chains.push(`### ${route.label}\n${steps.join("\n")}`);
  }

  // Include source of the first few unique handler symbols to ground the narrative.
  let budget = 11_000;
  const includedFiles = new Set<string>();
  for (const id of chainNodes) {
    if (budget <= 0) break;
    const symbol = analysis.symbols.find((candidate) => candidate.id === id);
    if (!symbol || includedFiles.has(symbol.filePath)) continue;
    includedFiles.add(symbol.filePath);
    const source = await readLines(analysis, symbol.filePath, symbol.startLine, symbol.endLine, Math.min(2200, budget));
    chains.push(`\nSource: ${symbol.qualifiedName}\n\`\`\`\n${source}\n\`\`\``);
    budget -= source.length;
    contextFiles.push({ path: symbol.filePath, startLine: symbol.startLine, endLine: symbol.endLine, label: symbol.qualifiedName });
  }

  const context = [projectBrief(analysis), "", ...chains].join("\n");
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are a business-flow analyst. Turn the provided route/call/database/event chains into end-to-end business flows. " +
        "Return ONLY valid JSON: " +
        '{"flows":[{"name":"...","description":"...","confidence":"high|medium|low","steps":[{"label":"...","description":"...","file":"path","startLine":1,"endLine":2,"kind":"route|function|database|event"}],"entities":["..."],"risks":["..."]}]}. ' +
        "Do not invent steps that the graph does not support. Prefer 2-5 concrete flows. If a chain is incomplete, say so in the description. " +
        aiLanguageInstruction(options.language),
    },
    {
      role: "user",
      content: `${context}\n\nIdentify the main business flows and their steps.`,
    },
  ];

  const response = await chat(config, messages, { maxTokens: 2400, temperature: 0.2 });
  const parsed = parseJsonObject(response);
  const rawFlows = Array.isArray(parsed.flows) ? parsed.flows : [];
  const flows: AiBusinessFlow[] = rawFlows.map((item) => {
    const flow = item as Record<string, unknown>;
    const rawSteps = Array.isArray(flow.steps) ? flow.steps : [];
    return {
      name: String(flow.name ?? "Untitled flow"),
      description: String(flow.description ?? ""),
      confidence: (["high", "medium", "low"].includes(String(flow.confidence)) ? String(flow.confidence) : "medium") as AiBusinessFlow["confidence"],
      steps: rawSteps.map((step) => {
        const entry = step as Record<string, unknown>;
        return {
          label: String(entry.label ?? entry.name ?? "Step"),
          description: entry.description ? String(entry.description) : undefined,
          file: entry.file ? String(entry.file) : undefined,
          startLine: Number(entry.startLine ?? entry.start_line) || undefined,
          endLine: Number(entry.endLine ?? entry.end_line) || undefined,
          kind: entry.kind ? String(entry.kind) : undefined,
        };
      }),
      entities: stringArray(flow.entities),
      risks: stringArray(flow.risks),
    };
  });

  const result: AiBusinessFlowsResult = {
    flows,
    provider: config.id,
    model: config.model,
    cached: false,
    createdAt: new Date().toISOString(),
    usage: { inputChars: context.length, estimatedTokens: Math.ceil(context.length / 4), contextFiles },
  };
  cache.entries[key] = { createdAt: result.createdAt, data: result };
  await writeCache(projectId, cache);
  return result;
}

export async function investigateUnresolved(
  projectId: string,
  nodeId: string,
  options: { provider?: Parameters<typeof resolveProvider>[0]; model?: string; force?: boolean; language?: string } = {},
): Promise<AiUnresolvedAnalysis> {
  const analysis = await loadAnalysis(projectId);
  const node = analysis.nodes.find((candidate) => candidate.id === nodeId);
  if (!node || !node.metadata?.unresolved) throw new Error("This node is not an unresolved target.");
  const config = await resolveProvider(options.provider, options.model);

  const incoming = analysis.edges.filter((edge) => edge.target === nodeId && edge.evidence);
  const callSites: { filePath: string; startLine?: number; endLine?: number; description?: string; caller: string }[] = [];
  for (const edge of incoming) {
    const source = analysis.nodes.find((candidate) => candidate.id === edge.source);
    for (const evidence of edge.evidence ?? []) {
      if (callSites.some((site) => site.filePath === evidence.filePath && site.startLine === evidence.startLine)) continue;
      callSites.push({
        filePath: evidence.filePath,
        startLine: evidence.startLine,
        endLine: evidence.endLine,
        description: evidence.description,
        caller: source?.metadata?.qualifiedName ?? source?.label ?? edge.source,
      });
    }
  }
  if (callSites.length === 0) throw new Error("No call sites were recorded for this target.");

  const snippets: string[] = [];
  const contextFiles: AiContextFile[] = [];
  for (const site of callSites.slice(0, 8)) {
    const line = site.startLine ?? 1;
    const from = Math.max(1, line - 10);
    const to = Math.max(from, line + 10);
    const snippet = await readLines(analysis, site.filePath, from, to, 1800);
    snippets.push(`### ${site.filePath}:${line} (caller: ${site.caller})\n\`\`\`\n${snippet}\n\`\`\``);
    contextFiles.push({ path: site.filePath, startLine: line, endLine: line, label: site.caller });
  }

  const siteHash = crypto
    .createHash("sha1")
    .update(snippets.join("|"))
    .digest("hex")
    .slice(0, 16);
  const key = cacheKey(["unresolved", node.label, config.id, config.model, siteHash, options.language ?? "en"]);
  const cache = await readCache(projectId);
  if (!options.force) {
    const hit = cache.entries[key] as CacheEntry<AiUnresolvedAnalysis> | undefined;
    if (hit) return { ...hit.data, cached: true };
  }

  const context = [projectBrief(analysis), "", ...snippets].join("\n");
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are diagnosing a static-analysis gap. Classify why a call target could not be resolved. " +
        "Return ONLY valid JSON: " +
        '{"classification":"builtin|external-package|dynamic-dispatch|callback|string-based|missed-local|unknown","confidence":"high|medium|low","explanation":"...","recommendation":"..."}. ' +
        "base your answer on the actual source snippets, not the symbol name alone. A builtin is a JS/TS global such as Set, Map, Promise. An external-package is an imported npm/browser API. " +
        "missed-local means the target probably is a local function the analyzer failed to link. Explain how to improve the analyzer or the code so this becomes resolvable. " +
        aiLanguageInstruction(options.language),
    },
    {
      role: "user",
      content: `${context}\n\nUnresolved target: ${node.label}\nExplain why this target is unresolved and how it should be handled.`,
    },
  ];

  const response = await chat(config, messages, { maxTokens: 900, temperature: 0.1 });
  const parsed = parseJsonObject(response);
  const classification = String(parsed.classification ?? "unknown") as UnresolvedClassification;
  const confidence = String(parsed.confidence ?? "low").toLowerCase();
  const result: AiUnresolvedAnalysis = {
    target: node.label,
    classification: UNRESOLVED_CLASSES.includes(classification) ? classification : "unknown",
    confidence: (["high", "medium", "low"].includes(confidence) ? confidence : "low") as AiUnresolvedAnalysis["confidence"],
    explanation: String(parsed.explanation ?? "No explanation returned."),
    recommendation: String(parsed.recommendation ?? "Inspect the call sites manually."),
    callSites: contextFiles,
    provider: config.id,
    model: config.model,
    cached: false,
    createdAt: new Date().toISOString(),
    usage: { inputChars: context.length, estimatedTokens: Math.ceil(context.length / 4), contextFiles },
  };

  cache.entries[key] = { createdAt: result.createdAt, data: result };
  await writeCache(projectId, cache);
  return result;
}

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "what", "how", "does", "where", "which", "when",
  "why", "are", "is", "in", "on", "of", "to", "a", "an", "code", "works", "work", "explain", "show",
  "give", "me", "about", "please", "bir", "bu", "nasıl", "nedir", "hangi", "için", "ile", "olan",
]);

function keywords(question: string): string[] {
  return [...new Set(
    question
      .toLowerCase()
      .split(/[^a-z0-9_$ğüşıöç]+/i)
      .filter((token) => token.length > 2 && !STOP_WORDS.has(token)),
  )].slice(0, 12);
}

export async function askProject(
  projectId: string,
  question: string,
  options: { provider?: Parameters<typeof resolveProvider>[0]; model?: string; history?: ChatMessage[]; language?: string } = {},
): Promise<AiChatResult> {
  const analysis = await loadAnalysis(projectId);
  const config = await resolveProvider(options.provider, options.model);
  const tokens = keywords(question);

  let scored = analysis.nodes
    .filter((node) => !["project", "folder", "module"].includes(node.kind))
    .map((node) => {
      const haystack = `${node.label} ${node.metadata?.qualifiedName ?? ""} ${node.filePath ?? ""}`.toLowerCase();
      let score = 0;
      for (const token of tokens) if (haystack.includes(token)) score += 3;
      if (node.kind === "route" || node.kind === "database" || node.kind === "event") score += 1;
      score += Math.min(2, ((node.metadata?.callerCount ?? 0) + (node.metadata?.callCount ?? 0)) / 20);
      return { node, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 14);

  if (scored.length === 0) {
    scored = analysis.nodes
      .filter((node) => node.kind === "function" || node.kind === "method" || node.kind === "route")
      .sort(
        (a, b) =>
          (b.metadata?.callerCount ?? 0) +
          (b.metadata?.callCount ?? 0) -
          ((a.metadata?.callerCount ?? 0) + (a.metadata?.callCount ?? 0)),
      )
      .slice(0, 10)
      .map((node) => ({ node, score: 0 }));
  }

  const contextParts: string[] = [projectBrief(analysis), ""];
  const contextFiles: AiContextFile[] = [];
  let budget = MAX_CONTEXT_CHARS;

  for (const { node } of scored) {
    if (budget <= 0) break;
    contextParts.push(`### ${node.metadata?.qualifiedName ?? node.label} (${node.kind})`);
    if (node.filePath) {
      contextParts.push(`File: ${node.filePath}${node.startLine ? `:${node.startLine}-${node.endLine ?? node.startLine}` : ""}`);
    }
    const symbol = node.kind === "function" || node.kind === "method" || node.kind === "class"
      ? analysis.symbols.find((candidate) => candidate.id === node.id)
      : undefined;
    if (symbol) {
      contextParts.push(`Signature: ${symbol.signature}`);
      const source = await readLines(analysis, symbol.filePath, symbol.startLine, symbol.endLine, Math.min(4500, budget));
      contextParts.push("```", source, "```");
      budget -= source.length;
      contextFiles.push({ path: symbol.filePath, startLine: symbol.startLine, endLine: symbol.endLine, label: symbol.qualifiedName });
    } else {
      const metadata = node.metadata ?? {};
      contextParts.push(`Metadata: ${JSON.stringify(metadata).slice(0, 500)}`);
      if (node.filePath) contextFiles.push({ path: node.filePath, startLine: node.startLine, endLine: node.endLine, label: node.label });
    }
    contextParts.push("");
  }

  const context = contextParts.join("\n");
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are Codebase Intelligence Explorer, a codebase Q&A assistant. Answer only from the provided project graph and source excerpts. " +
        "Cite file paths and line ranges for every important claim. If the context is insufficient, say exactly what is missing. " +
        "Do not invent call relationships. Distinguish static facts from inference. Use concise Markdown. " +
        aiLanguageInstruction(options.language),
    },
    ...(options.history ?? []).slice(-6),
    {
      role: "user",
      content: `Project context:\n${context}\n\nQuestion: ${question}`,
    },
  ];

  const answer = await chat(config, messages, { maxTokens: 1800, temperature: 0.15 });
  return {
    answer,
    evidence: contextFiles,
    provider: config.id,
    model: config.model,
    createdAt: new Date().toISOString(),
    usage: { inputChars: context.length, estimatedTokens: Math.ceil(context.length / 4), contextFiles },
  };
}
