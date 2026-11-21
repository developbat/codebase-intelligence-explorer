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
  AiCodeEditResult,
  AiContextFile,
  AiProjectSummary,
  AiScopeSummary,
  AiReviewFinding,
  AiReviewResult,
  AiSymbolAnalysis,
  AiTaskFileChange,
  AiTaskResult,
  AiTestGenerationResult,
  AiUnresolvedAnalysis,
  AiUsage,
  AiAgentResult,
  AiAgentStep,
  AiAgentAction,
  AiAgentEvent,
  AiAgentLogEntry,
  AiAgentPermissionRequest,
  AiAgentPlan,
  AiPermissionDecision,
  AiPermissionKind,
  AiTokenUsage,
  UnresolvedClassification,
} from "../../../shared/ai";
import { aiLanguageInstruction } from "../../../shared/ai";
import { getGitBlame, getGitStatus, getFileDiff } from "../git";
import { getDataDir, loadAnalysis } from "../store";
import { isWithin } from "../scanner";
import { formatProjectFile } from "../formatter";
import { detectProjectProfile } from "../projectProfile";
import { queryCsvFile, querySqliteFile } from "../dataQuery";
import { runBrowserCheck } from "../browserCheck";
import type { BrowserCheckStep } from "../../../shared/browserCheck";
import {
  findProjectTool,
  listProjectTools,
  recordProjectToolRun,
} from "../projectTools";
import {
  deleteProjectPath,
  readSourceFile,
  renameProjectPath,
  runProjectCommand,
  writeSourceFile,
} from "../editor";
import { chat, type ChatMessage } from "./providers";
import { resolveProvider } from "./settings";
import { recordUsage } from "./usage";
import { recordModelOutcome } from "./modelStats";
import { pickAlternateAgentModel } from "./agents";
import { getPrompt, renderPrompt } from "./prompts";
import { loadEnabledSkills, renderSkillsForPrompt } from "../skills";
import { requestPermission } from "./permissions";
import {
  recordConversation,
  removeIndexedPath,
  renameIndexedPath,
  searchConversations,
  searchProjectIndex,
} from "../indexer";

const PROMPT_VERSION = "v3";
const MAX_CONTEXT_CHARS = 16_000;

async function chatTracked(
  projectId: string,
  config: Awaited<ReturnType<typeof resolveProvider>>,
  messages: ChatMessage[],
  options: Parameters<typeof chat>[2],
  kind: string,
): Promise<{ text: string; tokenUsage?: AiTokenUsage }> {
  let tokenUsage: AiTokenUsage | undefined;
  const text = await chat(config, messages, {
    ...options,
    onUsage: (usage) => {
      tokenUsage = usage;
    },
  });
  if (!tokenUsage) {
    const inputChars = messages.reduce((total, message) => total + message.content.length, 0);
    const inputTokens = Math.ceil(inputChars / 4);
    const outputTokens = Math.ceil(text.length / 4);
    tokenUsage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
  }
  await recordUsage({
    projectId,
    provider: config.id,
    model: config.model,
    kind,
    inputTokens: tokenUsage.inputTokens,
    outputTokens: tokenUsage.outputTokens,
    totalTokens: tokenUsage.totalTokens,
  });
  return { text, tokenUsage };
}

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

function fileTypeCounts(analysis: AnalysisResult): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of analysis.files) {
    const extension = file.path.split(".").pop()?.toLowerCase() ?? "other";
    counts[extension] = (counts[extension] ?? 0) + 1;
  }
  return counts;
}

function projectBrief(analysis: AnalysisResult): string {
  const counts = fileTypeCounts(analysis);
  const routeNodes = analysis.nodes.filter((node) => node.kind === "route");
  const htmlFiles = analysis.files.filter((file) => /\.html?$/i.test(file.path));
  const jsFiles = analysis.files.filter((file) => /\.(?:js|mjs|cjs|jsx|ts|tsx)$/i.test(file.path));
  const cssFiles = analysis.files.filter((file) => /\.(?:css|scss|sass|less)$/i.test(file.path));
  const phpFiles = analysis.files.filter((file) => /\.php$/i.test(file.path));
  const pyFiles = analysis.files.filter((file) => /\.py$/i.test(file.path));
  return [
    `Project: ${analysis.projectName}`,
    `Root: ${analysis.rootPath}`,
    `Frameworks: ${(analysis.frameworks ?? []).join(", ") || "none detected"}`,
    `Ecosystems: ${analysis.tooling?.ecosystems.join(", ") || "none detected"}`,
    `Package managers: ${analysis.tooling?.packageManagers.join(", ") || "none detected"}`,
    `Test framework: ${analysis.tooling?.testFramework ?? "none detected"}`,
    `Test commands: ${analysis.tooling?.testCommands.join(" | ") || "none"}`,
    `Typecheck commands: ${analysis.tooling?.typecheckCommands?.join(" | ") || "none"}`,
    `Build commands: ${analysis.tooling?.buildCommands.join(" | ") || "none"}`,
    `Lint/format commands: ${[...(analysis.tooling?.lintCommands ?? []), ...(analysis.tooling?.formatCommands ?? [])].join(" | ") || "none"}`,
    `Files: ${analysis.stats.files}, symbols: ${analysis.stats.symbols}, routes: ${analysis.stats.routes}, database objects: ${analysis.stats.databases}, events: ${analysis.stats.events}`,
    `Inventory: HTML ${htmlFiles.length}, JavaScript/TypeScript ${jsFiles.length}, CSS ${cssFiles.length}, PHP ${phpFiles.length}, Python ${pyFiles.length}`,
    `File extensions: ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([extension, count]) => `${extension} (${count})`).join(", ")}`,
    `Route nodes: ${routeNodes.length}${routeNodes.some((node) => node.metadata?.framework === "Static HTML") ? " (static HTML pages included)" : ""}`,
    `Languages: ${Object.entries(analysis.languages).map(([language, count]) => `${language} (${count})`).join(", ")}`,
    `Client assets: ${jsFiles.slice(0, 24).map((file) => file.path).join(", ") || "none"}`,
    `Stylesheets: ${cssFiles.slice(0, 24).map((file) => file.path).join(", ") || "none"}`,
    `HTML pages sample: ${htmlFiles.slice(0, 24).map((file) => file.path).join(", ") || "none"}`,
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
  const symbolPrompt = await getPrompt("symbol.analyze", projectId);
  const key = cacheKey([
    "symbol",
    config.id,
    config.model,
    symbol.id,
    symbol.hash ?? file?.hash ?? String(symbol.startLine),
    options.language ?? "en",
    `prompt-v${symbolPrompt.version}`,
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
      content: renderPrompt(symbolPrompt.system, {
        language: aiLanguageInstruction(options.language ?? "en"),
      }),
    },
    {
      role: "user",
      content: `${context}\n\nAnalyze this symbol. Use short, specific statements. ` +
        "Include database writes, network calls, events, validation, and error paths you can actually see. " +
        "If a callee implementation is not provided, say that its behavior is unverified.",
    },
  ];

  const completion = await chatTracked(projectId, config, messages, { maxTokens: 1600, temperature: 0.1 }, "symbol");
  const response = completion.text;
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
    tokenUsage: completion.tokenUsage,
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
  const reviewPrompt = await getPrompt("review.diff", projectId);
  const key = cacheKey([
    "review",
    config.id,
    config.model,
    diffHash,
    options.language ?? "en",
    `prompt-v${reviewPrompt.version}`,
  ]);
  const cache = await readCache(projectId);
  if (!options.force) {
    const hit = cache.entries[key] as CacheEntry<AiReviewResult> | undefined;
    if (hit) return { ...hit.data, cached: true };
  }

  const reviewPromptContent = renderPrompt(reviewPrompt.system, {
    language: aiLanguageInstruction(options.language ?? "en"),
  });
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: reviewPromptContent,
    },
    {
      role: "user",
      content: `${context}\n\nReview the pending changes. Focus on correctness, regressions, security, error handling, API contracts, and missing tests. Reference file paths and line numbers from the diff.`,
    },
  ];

  const completion = await chatTracked(projectId, config, messages, { maxTokens: 2200, temperature: 0.1 }, "review");
  const response = completion.text;
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
    tokenUsage: completion.tokenUsage,
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
  const scopePrompt = await getPrompt("scope.summary", projectId);
  const key = cacheKey([
    "scope",
    config.id,
    config.model,
    nodeId,
    fingerprint,
    options.language ?? "en",
    `prompt-v${scopePrompt.version}`,
  ]);
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
      content: renderPrompt(scopePrompt.system, {
        language: aiLanguageInstruction(options.language ?? "en"),
      }),
    },
    {
      role: "user",
      content: `${context}\n\nSummarize this ${node.kind}.`,
    },
  ];
  const completion = await chatTracked(projectId, config, messages, { maxTokens: 1600, temperature: 0.15 }, "scope");
  const response = completion.text;
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
  const summaryPrompt = await getPrompt("project.summary", projectId);
  const key = cacheKey([
    "summary",
    config.id,
    config.model,
    fingerprint,
    options.language ?? "en",
    `prompt-v${summaryPrompt.version}`,
  ]);
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
  let budget = 20_000;

  if (routes.length > 0) {
    contextParts.push(
      `Complete route inventory (${routes.length}):\n${routes
        .slice(0, 300)
        .map((route) => `- ${route.label}${route.metadata?.framework ? ` [${route.metadata.framework}]` : ""}`)
        .join("\n")}`,
    );
  }
  const htmlFiles = analysis.files.filter((file) => /\.html?$/i.test(file.path));
  const jsFiles = analysis.files.filter((file) => /\.(?:js|mjs|cjs|jsx|ts|tsx)$/i.test(file.path));
  const cssFiles = analysis.files.filter((file) => /\.(?:css|scss|sass|less)$/i.test(file.path));
  if (htmlFiles.length > 0 || jsFiles.length > 0 || cssFiles.length > 0) {
    contextParts.push(
      [
        "Client asset inventory:",
        `HTML pages (${htmlFiles.length}): ${htmlFiles.slice(0, 80).map((file) => file.path).join(", ")}`,
        `JavaScript/TypeScript files (${jsFiles.length}): ${jsFiles.slice(0, 80).map((file) => file.path).join(", ")}`,
        `CSS files (${cssFiles.length}): ${cssFiles.slice(0, 80).map((file) => file.path).join(", ")}`,
      ].join("\n"),
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
  const summaryPromptContent = renderPrompt(summaryPrompt.system, {
    language: aiLanguageInstruction(options.language ?? "en"),
  });
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: summaryPromptContent,
    },
    {
      role: "user",
      content: `${context}\n\nExplain this project's architecture and its most important flows in natural language. ` +
        "Keep evidence paths tied to the provided context.",
    },
  ];

  const completion = await chatTracked(projectId, config, messages, { maxTokens: 3500, temperature: 0.2, timeoutMs: 120_000 }, "summary");
  const response = completion.text;
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
    tokenUsage: completion.tokenUsage,
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
  const flowsPrompt = await getPrompt("flows.business", projectId);
  const key = cacheKey([
    "flows",
    config.id,
    config.model,
    fingerprint,
    options.language ?? "en",
    `prompt-v${flowsPrompt.version}`,
  ]);
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
      content: renderPrompt(flowsPrompt.system, {
        language: aiLanguageInstruction(options.language ?? "en"),
      }),
    },
    {
      role: "user",
      content: `${context}\n\nIdentify the main business flows and their steps.`,
    },
  ];

  const completion = await chatTracked(projectId, config, messages, { maxTokens: 2400, temperature: 0.2 }, "flows");
  const response = completion.text;
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
    tokenUsage: completion.tokenUsage,
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
  const unresolvedPrompt = await getPrompt("unresolved.investigate", projectId);
  const key = cacheKey([
    "unresolved",
    node.label,
    config.id,
    config.model,
    siteHash,
    options.language ?? "en",
    `prompt-v${unresolvedPrompt.version}`,
  ]);
  const cache = await readCache(projectId);
  if (!options.force) {
    const hit = cache.entries[key] as CacheEntry<AiUnresolvedAnalysis> | undefined;
    if (hit) return { ...hit.data, cached: true };
  }

  const context = [projectBrief(analysis), "", ...snippets].join("\n");
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: renderPrompt(unresolvedPrompt.system, {
        language: aiLanguageInstruction(options.language ?? "en"),
      }),
    },
    {
      role: "user",
      content: `${context}\n\nUnresolved target: ${node.label}\nExplain why this target is unresolved and how it should be handled.`,
    },
  ];

  const completion = await chatTracked(projectId, config, messages, { maxTokens: 900, temperature: 0.1 }, "unresolved");
  const response = completion.text;
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
    tokenUsage: completion.tokenUsage,
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

export async function generateTests(
  projectId: string,
  sourceFile: string,
  framework: string | undefined,
  instruction: string,
  options: { provider?: Parameters<typeof resolveProvider>[0]; model?: string } = {},
): Promise<AiTestGenerationResult> {
  const analysis = await loadAnalysis(projectId);
  const relative = sourceFile.replace(/^\/+/, "");
  const absolute = path.resolve(analysis.rootPath, relative);
  if (!isWithin(analysis.rootPath, absolute)) throw new Error("Access outside the project root was denied.");
  const [realRoot, realFile] = await Promise.all([
    fs.realpath(analysis.rootPath),
    fs.realpath(absolute).catch(() => absolute),
  ]);
  if (!isWithin(realRoot, realFile)) throw new Error("Access outside the project root was denied.");
  const source = await fs.readFile(realFile, "utf8");
  if (source.length > 24_000) {
    throw new Error("This source file is too large for AI test generation.");
  }

  const config = await resolveProvider(options.provider, options.model);
  const context = [
    `Project: ${analysis.projectName}`,
    `Source file: ${relative}`,
    `Test framework: ${framework || "infer from project conventions"}`,
    `Instruction: ${instruction.trim() || "Generate focused tests for the main behavior."}`,
    "",
    "Source code:",
    "```",
    source,
    "```",
  ].join("\n");

  const testsPrompt = await getPrompt("tests.generate", projectId);
  const testsPromptContent = renderPrompt(testsPrompt.system, {
    language: aiLanguageInstruction("en"),
  });
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: testsPromptContent,
    },
    {
      role: "user",
      content: context,
    },
  ];

  const completion = await chatTracked(projectId, config, messages, {
    maxTokens: 6000,
    temperature: 0.1,
    timeoutMs: 90_000,
  }, "tests");
  const response = completion.text;
  const parsed = parseJsonObject(response);
  const testFilePath = typeof parsed.testFilePath === "string" ? parsed.testFilePath.replace(/^\/+/, "") : "";
  const content = typeof parsed.content === "string" ? parsed.content : "";
  if (!testFilePath || !content.trim()) throw new Error("The model did not return a test file.");
  const target = path.resolve(analysis.rootPath, testFilePath);
  if (!isWithin(analysis.rootPath, target)) throw new Error("The generated test path is outside the project.");
  const exists = await fs.access(target).then(() => true).catch(() => false);
  if (exists) throw new Error("The generated test path already exists. Generate again or choose another instruction.");

  return {
    sourceFile: relative,
    testFilePath,
    framework,
    content,
    explanation: String(parsed.explanation ?? "Generated by the selected model."),
    provider: config.id,
    model: config.model,
    createdAt: new Date().toISOString(),
    usage: {
      inputChars: context.length,
      estimatedTokens: Math.ceil(context.length / 4),
      contextFiles: [{ path: relative, label: "Source under test" }],
    },
    tokenUsage: completion.tokenUsage,
  };
}

function stripCodeFence(value: string): string {
  const fenced = value.trim().match(/^```[A-Za-z0-9_+.-]*\n([\s\S]*?)\n```$/);
  return fenced ? fenced[1] : value;
}

export function applyTextEdits(
  original: string,
  rawEdits: unknown,
): string {
  if (!Array.isArray(rawEdits)) return original;
  let updated = original;
  for (const raw of rawEdits) {
    const edit = raw as Record<string, unknown>;
    const find = typeof edit.find === "string" ? edit.find : "";
    const replace = typeof edit.replace === "string" ? edit.replace : "";
    if (!find || find === replace) continue;
    const occurrences = updated.split(find).length - 1;
    if (occurrences === 1) {
      updated = updated.replace(find, replace);
      continue;
    }
    // Models sometimes include indentation differences. Try a trimmed-line
    // match before rejecting the patch.
    const trimmedFind = find.trim();
    if (trimmedFind) {
      const trimmedOccurrences = updated.split(trimmedFind).length - 1;
      if (trimmedOccurrences === 1) {
        updated = updated.replace(trimmedFind, replace.trim());
        continue;
      }
    }
    throw new Error(
      occurrences === 0
        ? "The model returned an edit whose source snippet was not found. Try again with a more specific instruction."
        : "The model returned an ambiguous edit. Try again with a more specific instruction.",
    );
  }
  return updated;
}

function taskContextFiles(analysis: AnalysisResult, instruction: string, activeFile?: string): string[] {
  const tokens = [...new Set(instruction.toLowerCase().match(/[a-z0-9çğıöşü_]{3,}/g) ?? [])];
  const ranked = analysis.files
    .map((file) => {
      const haystack = `${file.path} ${analysis.symbols
        .filter((symbol) => symbol.filePath === file.path)
        .map((symbol) => symbol.qualifiedName)
        .join(" ")}`.toLowerCase();
      let score = 0;
      for (const token of tokens) if (haystack.includes(token)) score += 2;
      if (activeFile && file.path === activeFile) score += 20;
      return { path: file.path, score };
    })
    .sort((a, b) => b.score - a.score);
  return [...new Set([activeFile, ...ranked.filter((item) => item.score > 0).map((item) => item.path)]
    .filter((value): value is string => Boolean(value)))].slice(0, 5);
}

export async function runCodingTask(
  projectId: string,
  instruction: string,
  options: {
    activeFile?: string;
    provider?: Parameters<typeof resolveProvider>[0];
    model?: string;
  } = {},
): Promise<AiTaskResult> {
  const analysis = await loadAnalysis(projectId);
  if (!instruction.trim()) throw new Error("A coding instruction is required.");
  const config = await resolveProvider(options.provider, options.model);
  const contextFiles = taskContextFiles(analysis, instruction, options.activeFile);
  const contextParts: string[] = [projectBrief(analysis), "", "Project file list (partial):"];
  contextParts.push(analysis.files.slice(0, 120).map((file) => file.path).join("\n"));
  const evidence: AiContextFile[] = [];

  for (const filePath of contextFiles) {
    const absolute = path.resolve(analysis.rootPath, filePath);
    if (!isWithin(analysis.rootPath, absolute)) continue;
    try {
      const content = await fs.readFile(absolute, "utf8");
      contextParts.push("", `### ${filePath}`, "```", content.slice(0, 7000), "```");
      evidence.push({ path: filePath, label: "Task context" });
    } catch {
      // ignore unreadable context files
    }
  }

  const taskPrompt = await getPrompt("task.multi_file", projectId);
  const taskPromptContent = renderPrompt(taskPrompt.system, {
    language: aiLanguageInstruction("en"),
  });
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: taskPromptContent,
    },
    {
      role: "user",
      content: `${contextParts.join("\n")}\n\nTask: ${instruction.trim()}`,
    },
  ];

  const completion = await chatTracked(projectId, config, messages, {
    maxTokens: 8000,
    temperature: 0.1,
    timeoutMs: 120_000,
  }, "task");
  const response = completion.text;
  const parsed = parseJsonObject(response);
  const rawChanges = Array.isArray(parsed.changes) ? parsed.changes : [];
  if (rawChanges.length === 0) throw new Error("The model did not return any file changes.");
  const changes: AiTaskFileChange[] = [];
  const seen = new Set<string>();
  let totalChars = 0;

  for (const raw of rawChanges.slice(0, 6)) {
    const item = raw as Record<string, unknown>;
    const relative = String(item.path ?? "").replace(/^\/+/, "");
    if (!relative || seen.has(relative)) continue;
    const target = path.resolve(analysis.rootPath, relative);
    if (!isWithin(analysis.rootPath, target)) continue;
    let content = typeof item.content === "string" ? stripCodeFence(item.content) : "";
    if (!content.trim()) continue;
    if (content.length > 120_000) throw new Error(`Generated content for ${relative} is too large.`);
    totalChars += content.length;
    if (totalChars > 240_000) throw new Error("The proposed task is too large. Narrow the instruction.");
    const exists = await fs.access(target).then(() => true).catch(() => false);
    const originalContent = exists ? await fs.readFile(target, "utf8").catch(() => undefined) : undefined;
    changes.push({
      path: relative,
      action: exists ? "modify" : "create",
      content,
      originalContent,
      explanation: item.explanation ? String(item.explanation) : undefined,
    });
    seen.add(relative);
  }

  if (changes.length === 0) throw new Error("The model did not return valid file changes.");
  return {
    instruction: instruction.trim(),
    summary: String(parsed.summary ?? parsed.explanation ?? "Proposed code changes."),
    changes,
    provider: config.id,
    model: config.model,
    createdAt: new Date().toISOString(),
    usage: {
      inputChars: contextParts.join("\n").length,
      estimatedTokens: Math.ceil(contextParts.join("\n").length / 4),
      contextFiles: evidence,
    },
    tokenUsage: completion.tokenUsage,
  };
}

export async function editSourceFile(
  projectId: string,
  filePath: string,
  instruction: string,
  options: { provider?: Parameters<typeof resolveProvider>[0]; model?: string; language?: string } = {},
): Promise<AiCodeEditResult> {
  const analysis = await loadAnalysis(projectId);
  const relative = filePath.replace(/^\/+/, "");
  const absolute = path.resolve(analysis.rootPath, relative);
  if (!isWithin(analysis.rootPath, absolute)) throw new Error("Access outside the project root was denied.");
  const [realRoot, realFile] = await Promise.all([
    fs.realpath(analysis.rootPath),
    fs.realpath(absolute).catch(() => absolute),
  ]);
  if (!isWithin(realRoot, realFile)) throw new Error("Access outside the project root was denied.");
  const content = await fs.readFile(realFile, "utf8");
  if (content.length > 120_000) {
    throw new Error(
      "This file is too large for an AI edit (120 KB limit). Select a smaller file or edit it manually.",
    );
  }
  if (!instruction.trim()) throw new Error("An edit instruction is required.");

  const patchMode = content.length > 24_000;
  const config = await resolveProvider(options.provider, options.model);
  const context = [
    `File: ${relative}`,
    `Project: ${analysis.projectName}`,
    `Instruction: ${instruction.trim()}`,
    "",
    "Current file content:",
    "```",
    content,
    "```",
  ].join("\n");

  const editPrompt = await getPrompt(patchMode ? "edit.file_patch" : "edit.file", projectId);
  const editPromptContent = renderPrompt(editPrompt.system, {
    language: aiLanguageInstruction(options.language ?? "en"),
  });
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: editPromptContent,
    },
    {
      role: "user",
      content: context,
    },
  ];

  const completion = await chatTracked(projectId, config, messages, {
    maxTokens: patchMode ? 3000 : 6000,
    temperature: 0.1,
    timeoutMs: 90_000,
  }, "edit");
  const response = completion.text;

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = parseJsonObject(response);
  } catch {
    if (patchMode) {
      throw new Error("The model returned an invalid patch. Try again or use a smaller file.");
    }
    const fenced = response.match(/```[A-Za-z0-9_+.-]*\n([\s\S]*?)\n```/);
    const fallback = stripCodeFence(fenced ? fenced[1] : response);
    if (!fallback.trim()) throw new Error("The model did not return updated file content.");
    return {
      filePath: relative,
      instruction: instruction.trim(),
      originalContent: content,
      newContent: fallback,
      explanation: "The model returned source code directly; the JSON wrapper was missing.",
      provider: config.id,
      model: config.model,
      createdAt: new Date().toISOString(),
      usage: {
        inputChars: context.length,
        estimatedTokens: Math.ceil(context.length / 4),
        contextFiles: [{ path: relative, label: "Source file" }],
      },
      tokenUsage: completion.tokenUsage,
    };
  }

  let newContent = "";
  if (patchMode) {
    if (Array.isArray(parsed.edits)) {
      newContent = applyTextEdits(content, parsed.edits);
    } else if (typeof parsed.content === "string") {
      newContent = stripCodeFence(parsed.content);
    }
  } else {
    const candidate =
      parsed.content ?? parsed.newContent ?? parsed.fileContent ?? parsed.code;
    if (typeof candidate === "string") newContent = stripCodeFence(candidate);
    if (!newContent.trim() && Array.isArray(parsed.edits)) {
      newContent = applyTextEdits(content, parsed.edits);
    }
  }
  if (!newContent.trim()) {
    throw new Error(
      patchMode
        ? "The model did not return a valid edit patch. Try a more specific instruction."
        : "The model did not return updated file content.",
    );
  }
  return {
    filePath: relative,
    instruction: instruction.trim(),
    originalContent: content,
    newContent,
    explanation: String(parsed.explanation ?? "Updated by the selected model."),
    provider: config.id,
    model: config.model,
    createdAt: new Date().toISOString(),
    usage: {
      inputChars: context.length,
      estimatedTokens: Math.ceil(context.length / 4),
      contextFiles: [{ path: relative, label: "Source file" }],
    },
    tokenUsage: completion.tokenUsage,
  };
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
  const indexHits = [
    ...(await searchConversations(analysis.id, question, 3)),
    ...(await searchProjectIndex(analysis.id, question, 8, analysis.rootPath)),
  ];
  if (indexHits.length > 0) {
    contextParts.push(
      `Index hits (best local matches):\n${indexHits
        .map((hit) => {
          if (hit.kind === "conversation") {
            return `- conversation · ${hit.title}${hit.answer ? ` — previous answer: ${hit.answer.slice(0, 600)}` : ""}`;
          }
          return `- ${hit.kind} · ${hit.title}${hit.path ? ` — ${hit.path}${hit.line ? `:${hit.line}` : ""}` : ""}${
            hit.snippet ? ` — ${hit.snippet.slice(0, 220)}` : ""
          }`;
        })
        .join("\n")}`,
    );
  }
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
  const chatPrompt = await getPrompt("chat.answer", projectId);
  const skillsPrompt = await loadEnabledSkills(analysis.rootPath, projectId)
    .then(renderSkillsForPrompt)
    .catch(() => "");
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        renderPrompt(chatPrompt.system, {
          language: aiLanguageInstruction(options.language ?? "en"),
        }) + (skillsPrompt ? `\n\n${skillsPrompt}` : ""),
    },
    ...(options.history ?? []).slice(-6),
    {
      role: "user",
      content: `Project context:\n${context}\n\nQuestion: ${question}`,
    },
  ];

  const completion = await chatTracked(projectId, config, messages, { maxTokens: 1800, temperature: 0.15 }, "chat");
  await recordConversation(projectId, question, completion.text, config.id, config.model).catch(() => {
    // conversation indexing is best-effort
  });
  return {
    answer: completion.text,
    evidence: contextFiles,
    provider: config.id,
    model: config.model,
    createdAt: new Date().toISOString(),
    usage: { inputChars: context.length, estimatedTokens: Math.ceil(context.length / 4), contextFiles },
    tokenUsage: completion.tokenUsage,
  };
}

/* ------------------------------------------------------------------ */
/* Agent mode: read, search, write and run commands in a controlled loop */
/* ------------------------------------------------------------------ */

const AGENT_MAX_STEPS = 16;
const AGENT_MAX_ACTIONS = 40;
const AGENT_MAX_VERIFY_ATTEMPTS = 3;
const ACTION_INTENT =
  /\b(ekle|oluştur|oluşturur|düzelt|güncelle|değiştir|taşı|sil|create|add|implement|fix|update|change|refactor|move|delete|build)\b/i;
const QUESTION_INTENT =
  /\b(nasıl|neden|niçin|nedir|ne|mi|mı|mu|mü|how|why|what|where|which|explain|açıkla|anlat)\b/i;

const READ_ONLY_ACTIONS = new Set([
  "list_files",
  "search_code",
  "read_file",
  "find_in_file",
  "list_items",
  "count_matches",
  "json_query",
  "find_symbols",
  "sqlite_query",
  "csv_query",
  "git_blame",
  "list_project_tools",
  "browser_check",
]);
const AGENT_MAX_WRITES = 10;
const AGENT_MAX_COMMANDS = 5;
const AGENT_READ_CHARS = 18_000;
const AGENT_OBSERVATION_CHARS = 3_000;

const AGENT_BLOCKED_COMMANDS: RegExp[] = [
  /\bsudo\b/,
  /\bdoas\b/,
  /\bmkfs(?:\.|\b)/,
  /\bdiskutil\s+erase/i,
  /\bdd\s+if=/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bgit\s+push\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\b[^\n]*-[a-z]*f/i,
  /\bnpm\s+publish\b/,
  /\byarn\s+publish\b/,
  /\bpnpm\s+publish\b/,
  /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+\/(?:\s|$)/i,
  /\bchmod\s+-R\s+777\s+\/(?:\s|$)/i,
  /\bcurl\b[^\n|]*\|\s*(?:sh|bash|zsh)\b/,
  /\bwget\b[^\n|]*\|\s*(?:sh|bash|zsh)\b/,
];

export function isSecretAgentPath(relative: string): boolean {
  const normalized = relative.replace(/\\/g, "/");
  if (/(^|\/)\.git\//.test(normalized)) return true;
  if (/(^|\/)\.env(?:\.|$)/.test(normalized)) return true;
  return /\.(?:pem|key|p12|pfx|crt|cer)$/i.test(normalized);
}

export function isBlockedAgentCommand(command: string): boolean {
  return AGENT_BLOCKED_COMMANDS.some((pattern) => pattern.test(command));
}

function agentActionTarget(args: Record<string, unknown>): string | undefined {
  const value = args.path ?? args.query ?? args.command ?? args.newPath;
  return typeof value === "string" ? value : undefined;
}

function stableActionKey(args: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(args).sort()) sorted[key] = args[key];
  return JSON.stringify(sorted);
}

export function preferredVerificationCommand(
  tooling:
    | { typecheckCommands?: string[]; buildCommands?: string[] }
    | undefined,
): string | undefined {
  return tooling?.typecheckCommands?.[0] ?? tooling?.buildCommands?.[0];
}

export function reportsRemainingWork(summary: string): boolean {
  const remaining =
    /\b(not (?:done|implemented|completed)|remaining work|remains? (?:undone|to be done))\b|yapılmadı|tamamlanmadı|eksik kaldı|\bkalan\s*[:(]|\bnext step\b|sonraki adım/i.test(
      summary,
    );
  const none =
    /\bkalan\s*(?:yok|değil)\b|nothing (?:remaining|left)|no remaining work/i.test(summary);
  return remaining && !none;
}

export function isFastEditTask(instruction: string, askMode: boolean): boolean {
  const trimmed = instruction.trim();
  return (
    !askMode &&
    trimmed.length <= 260 &&
    ACTION_INTENT.test(trimmed) &&
    !QUESTION_INTENT.test(trimmed) &&
    !trimmed.endsWith("?")
  );
}

export function readRangeCovered(
  ranges: { start: number; end: number; wholeFile: boolean }[],
  start: number,
  wholeFile: boolean,
  end: number,
): boolean {
  return ranges.some(
    (entry) => entry.start <= start && (wholeFile ? entry.wholeFile : entry.end >= end),
  );
}

function normalizeAgentPath(rootPath: string, input: unknown): string {
  let value = typeof input === "string" ? input.trim() : "";
  if (!value) return "";
  if (!path.isAbsolute(value)) {
    value = value.replace(/^\.\//, "").replace(/^\/+/, "");
    return value === "." ? "" : value;
  }
  const absolute = path.resolve(value);
  if (!isWithin(rootPath, absolute)) throw new Error("That path is outside the project root.");
  const relative = path.relative(rootPath, absolute);
  return relative === "" ? "" : relative.split(path.sep).join("/");
}

interface ParsedToolAction {
  action: string;
  args: Record<string, unknown>;
}

function attributeValue(attributes: string, name: string): string | undefined {
  const quoted = attributes.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1];
  if (quoted !== undefined) return quoted;
  return attributes.match(new RegExp(`${name}\\s*=\\s*([^\\s>]+)`, "i"))?.[1];
}

/** Parse DeepSeek/native DSML tool-call blocks (often emitted instead of JSON). */
export function parseDsmlActions(text: string): ParsedToolAction[] {
  const actions: ParsedToolAction[] = [];
  const invokePattern = /<[^>]*DSML[^>]*\binvoke\b([^>]*)>([\s\S]*?)<\/[^>]*DSML[^>]*\binvoke\s*>/gi;
  let invoke: RegExpExecArray | null;
  while ((invoke = invokePattern.exec(text))) {
    const name = attributeValue(invoke[1], "name")?.trim();
    if (!name) continue;
    const args: Record<string, unknown> = {};
    const body = invoke[2];
    const parameterPattern = /<[^>]*DSML[^>]*\bparameter\b([^>]*)>([\s\S]*?)<\/[^>]*DSML[^>]*\bparameter\s*>/gi;
    let parameter: RegExpExecArray | null;
    while ((parameter = parameterPattern.exec(body))) {
      const parameterName = attributeValue(parameter[1], "name")?.trim();
      if (!parameterName) continue;
      const rawValue = parameter[2].trim();
      const isString = /string\s*=\s*["']true["']/i.test(parameter[1]);
      let value: unknown = rawValue;
      if (!isString) {
        try {
          value = JSON.parse(rawValue);
        } catch {
          value = rawValue;
        }
      }
      if (parameterName === "args" && value && typeof value === "object" && !Array.isArray(value)) {
        Object.assign(args, value);
      } else {
        args[parameterName] = value;
      }
    }
    if (Object.keys(args).length === 0) {
      try {
        const parsed = parseJsonObject(body);
        Object.assign(args, parsed.args ?? parsed.arguments ?? parsed);
      } catch {
        // keep empty args; the action will explain the missing arguments
      }
    }
    actions.push({ action: name, args });
    if (actions.length >= 20) break;
  }
  return actions;
}

export function isToolCallLeak(text: string): boolean {
  return /DSML|<\|?\|?tool_call|<\/?tool_call|\binvoke\s+name\s*=|\bparameter\s+name\s*=|"tool_calls"\s*:/i.test(
    text,
  );
}

export function stripToolCallMarkup(text: string): string {
  let cleaned = text;
  cleaned = cleaned.replace(/<[^>]*DSML[^>]*\bcalls\s*>[\s\S]*?<\/[^>]*DSML[^>]*\bcalls\s*>/gi, "");
  cleaned = cleaned.replace(/<[^>]*DSML[^>]*\binvoke\b[\s\S]*?<\/[^>]*DSML[^>]*\binvoke\s*>/gi, "");
  cleaned = cleaned.replace(/<\/?[^>]*DSML[^>]*>/gi, "");
  cleaned = cleaned.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "");
  cleaned = cleaned.replace(/<function[^>]*>[\s\S]*?<\/function>/gi, "");
  return cleaned.trim();
}

function extractJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          objects.push(text.slice(start, index + 1));
          start = -1;
        }
      }
    }
  }
  return objects;
}

function actionFromRecord(record: Record<string, unknown>): ParsedToolAction | null {
  const action = String(record.action ?? record.tool ?? record.tool_name ?? record.name ?? "").trim();
  if (!action) return null;
  let rawArgs = record.args ?? record.arguments ?? record.parameters ?? record.input;
  if (typeof rawArgs === "string") {
    try {
      rawArgs = JSON.parse(rawArgs) as unknown;
    } catch {
      return null;
    }
  }
  const args =
    rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};
  return { action, args };
}

export function parseMultipleJsonActions(text: string): ParsedToolAction[] {
  const actions: ParsedToolAction[] = [];
  for (const object of extractJsonObjects(text)) {
    try {
      const parsed = JSON.parse(object) as Record<string, unknown>;
      if (Array.isArray(parsed.actions)) {
        for (const item of parsed.actions) {
          if (item && typeof item === "object" && !Array.isArray(item)) {
            const action = actionFromRecord(item as Record<string, unknown>);
            if (action) actions.push(action);
          }
        }
        continue;
      }
      const action = actionFromRecord(parsed);
      if (action) actions.push(action);
    } catch {
      // ignore malformed fragments
    }
  }
  return actions;
}

export function parseAgentReply(text: string): Record<string, unknown> {
  if (/DSML/i.test(text)) {
    const actions = parseDsmlActions(text);
    if (actions.length > 0) {
      return {
        action: actions[0].action,
        args: actions[0].args,
        __actionCount: actions.length,
        __actions: actions,
      };
    }
  }

  if (/<tool_call/i.test(text)) {
    const block = text.match(/<tool_call>([\s\S]*?)<\/tool_call>/i)?.[1];
    if (block) {
      const name =
        block.match(/<tool_name>\s*([A-Za-z_][A-Za-z0-9_]*)\s*<\/tool_name>/i)?.[1] ??
        block.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:<|$)/)?.[1];
      if (name) {
        const args: Record<string, unknown> = {};
        const pairPattern =
          /<arg_key>\s*([\s\S]*?)\s*<\/arg_key>\s*<arg_value>\s*([\s\S]*?)\s*<\/arg_value>/gi;
        let match: RegExpExecArray | null;
        while ((match = pairPattern.exec(block))) {
          const key = match[1].trim();
          const rawValue = match[2].trim();
          try {
            args[key] = JSON.parse(rawValue);
          } catch {
            args[key] = rawValue;
          }
        }
        return { action: name, args, __actionCount: 1 };
      }
    }
  }

  try {
    const single = parseJsonObject(text);
    for (const key of ["args", "arguments", "parameters", "input"]) {
      if (typeof single[key] === "string") {
        try {
          single[key] = JSON.parse(single[key] as string) as unknown;
        } catch {
          // keep the original string
        }
      }
    }
    if (Array.isArray(single.actions)) {
      const actions = parseMultipleJsonActions(text);
      if (actions.length > 0) {
        return {
          action: actions[0].action,
          args: actions[0].args,
          __actionCount: actions.length,
          __actions: actions,
        };
      }
    }
    return single;
  } catch {
    // fall through to multiple JSON objects and the remaining dialect
  }

  const multiple = parseMultipleJsonActions(text);
  if (multiple.length > 0) {
    return {
      action: multiple[0].action,
      args: multiple[0].args,
      __actionCount: multiple.length,
      __actions: multiple,
    };
  }

  const functionBlock = text.match(
    /<function(?:_call)?[^>]*name=["']?([A-Za-z_][A-Za-z0-9_]*)["']?[^>]*>([\s\S]*?)<\/function(?:_call)?>/i,
  );
  if (functionBlock) {
    const args: Record<string, unknown> = {};
    try {
      const parsed = parseJsonObject(functionBlock[2]);
      Object.assign(args, parsed.args ?? parsed.arguments ?? parsed);
    } catch {
      // keep empty args
    }
    return { action: functionBlock[1], args };
  }

  throw new Error("The model did not return a JSON or tool-call object.");
}

export async function agentSeedContext(
  analysis: AnalysisResult,
  instruction: string,
  activeFile?: string,
): Promise<string> {
  const tokens = [...new Set(instruction.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [])];
  const git = await getGitStatus(analysis.rootPath, analysis).catch(() => null);
  const changedFiles = new Set((git?.files ?? []).map((file) => file.path));
  const indexed = await searchProjectIndex(analysis.id, instruction, 6, analysis.rootPath);
  const priorConversations = await searchConversations(analysis.id, instruction, 2);
  const indexLines = [...priorConversations, ...indexed].map((hit) => {
    if (hit.kind === "conversation") {
      return `conversation · ${hit.title}${hit.answer ? ` — previous answer: ${hit.answer.slice(0, 240)}` : ""}`;
    }
    return `${hit.kind} · ${hit.title}${hit.path ? ` — ${hit.path}${hit.line ? `:${hit.line}` : ""}` : ""}${
      hit.snippet ? ` — ${hit.snippet.slice(0, 120)}` : ""
    }`;
  });
  const symbolHits = new Map<string, number>();
  for (const symbol of analysis.symbols) {
    const haystack = symbol.qualifiedName.toLowerCase();
    for (const token of tokens) {
      if (haystack.includes(token)) symbolHits.set(symbol.filePath, (symbolHits.get(symbol.filePath) ?? 0) + 2);
    }
  }
  const listIntent = /\b(list|listele|liste|çıkart|cikart|names?|adları|adlari|enumerate|show all)\b/i.test(
    instruction,
  );
  let listHint = "";
  if (listIntent) {
    const suffixes = ["larin", "lerin", "lar", "ler", "lari", "leri", "sini", "ini", "nin", "in", "si", "su", "da", "de"];
    const stems = new Set<string>();
    for (const token of instruction.toLowerCase().match(/[a-z0-9çğıöşü]{4,}/g) ?? []) {
      stems.add(token);
      for (const suffix of suffixes) {
        if (token.endsWith(suffix) && token.length - suffix.length >= 4) {
          stems.add(token.slice(0, token.length - suffix.length));
        }
      }
      if (token.length > 5) stems.add(token.slice(0, 5));
    }
    const scored = new Map<string, number>();
    for (const file of analysis.files) {
      const lowerPath = file.path.toLowerCase();
      let score = 0;
      for (const stem of stems) {
        if (lowerPath.includes(stem)) score += 3;
      }
      if (/\.(html?|json)$/i.test(lowerPath)) score += 2;
      if (/(index|list|catalog|agents?|editors?)/i.test(lowerPath)) score += 2;
      if (/(^|\/)scripts\//i.test(lowerPath)) score -= 2;
      if (score > 0) scored.set(file.path, score);
    }
    for (const hit of indexed) {
      if (hit.path) scored.set(hit.path, (scored.get(hit.path) ?? 0) + Math.max(1, Math.round(hit.score)));
    }
    const candidates = [...scored.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([filePath]) => filePath);
    let bestItems: ReturnType<typeof extractListItems> = [];
    let bestPath = "";
    for (const candidate of candidates) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const content = await fs.readFile(path.resolve(analysis.rootPath, candidate), "utf8");
        const items = extractListItems(content, candidate, 120);
        if (items.length > bestItems.length) {
          bestItems = items;
          bestPath = candidate;
        }
        if (items.length >= 20) break;
      } catch {
        // try the next candidate
      }
    }
    if (bestItems.length >= 2) {
      listHint = `List request hint — ${bestItems.length} items found in ${bestPath}:\n${bestItems
        .map((item, index) => `${index + 1}. ${item.name}`)
        .join("\n")}`;
    }
  }

  const ranked = analysis.files
    .map((file) => {
      const lowerPath = file.path.toLowerCase();
      let score = 0;
      for (const token of tokens) if (lowerPath.includes(token)) score += 3;
      score += symbolHits.get(file.path) ?? 0;
      if (activeFile && file.path === activeFile) score += 20;
      if (changedFiles.has(file.path)) score += 8;
      return { path: file.path, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((item) => item.path);

  const relevantSymbols = analysis.symbols
    .filter(
      (symbol) =>
        tokens.some((token) => symbol.qualifiedName.toLowerCase().includes(token)) ||
        (activeFile !== undefined && symbol.filePath === activeFile),
    )
    .slice(0, 10)
    .map((symbol) => `${symbol.kind} ${symbol.qualifiedName} — ${symbol.filePath}:${symbol.startLine}`);

  const routes = analysis.nodes
    .filter((node) => node.kind === "route")
    .slice(0, 8)
    .map((node) => `${node.label}${node.filePath ? ` — ${node.filePath}` : ""}`);

  const editIntent = ACTION_INTENT.test(instruction) && !listIntent;
  let editMap = "";
  if (editIntent) {
    const stems = new Set(tokens);
    for (const token of tokens) {
      if (token.endsWith("s") && token.length > 4) stems.add(token.slice(0, -1));
      if (token.endsWith("es") && token.length > 5) stems.add(token.slice(0, -2));
      for (const suffix of ["ları", "leri", "lar", "ler", "sı", "si", "su", "sü", "ı", "i", "u", "ü"]) {
        if (token.endsWith(suffix) && token.length - suffix.length >= 3) {
          stems.add(token.slice(0, token.length - suffix.length));
        }
      }
    }
    const genericDomainTerms = new Set([
      "servi",
      "service",
      "services",
      "controller",
      "controllers",
      "route",
      "routes",
      "repository",
      "repositories",
      "repo",
      "api",
      "get",
      "list",
      "create",
      "add",
      "fix",
      "update",
      "change",
      "project",
      "proje",
      "file",
      "files",
      "dosya",
      "kod",
      "code",
      "test",
      "tests",
      "index",
      "package",
      "readme",
      "src",
      "lib",
      "utils",
      "config",
      "types",
      "type",
      "main",
      "model",
      "models",
      "view",
      "views",
    ]);
    const basenameOf = (filePath: string) =>
      filePath.split("/").pop()?.split(".")[0]?.toLowerCase() ?? "";
    const domainStems = [...stems]
      .filter((stem) => stem.length >= 3 && !genericDomainTerms.has(stem))
      .sort((a, b) => a.length - b.length);
    const domain =
      domainStems.find((stem) =>
        analysis.files.some(
          (file) =>
            /(^|\/)repositories?\//i.test(file.path) &&
            basenameOf(file.path).includes(stem),
        ),
      ) ??
      domainStems.find(
        (stem) =>
          analysis.files.some((file) => basenameOf(file.path).includes(stem)) ||
          analysis.symbols.some((symbol) =>
            symbol.qualifiedName.toLowerCase().includes(stem),
          ),
      ) ??
      domainStems[0] ??
      ranked
        .map((filePath) => basenameOf(filePath))
        .find(
          (name) =>
            name.length >= 3 &&
            !genericDomainTerms.has(name) &&
            analysis.files.some(
              (file) =>
                /(^|\/)(repositories?|services?|controllers?|routes?)\//i.test(file.path) &&
                file.path.toLowerCase().includes(name),
            ),
        );
    const findRankedFile = (pattern: RegExp) =>
      ranked.find((filePath) => pattern.test(filePath)) ??
      analysis.files.find((file) => pattern.test(file.path))?.path;
    const domainFile = (pattern: RegExp) =>
      domain
        ? analysis.files.find(
            (file) => pattern.test(file.path) && file.path.toLowerCase().includes(domain),
          )?.path
        : undefined;
    const domainRepository = domainFile(/(^|\/)repositories?\//i);
    const repositoryPattern = findRankedFile(/(^|\/)repositories?\//i);
    const repository = domainRepository ?? repositoryPattern;
    const servicePattern = findRankedFile(/(^|\/)services?\//i);
    const controllerPattern = findRankedFile(/(^|\/)controllers?\//i);
    const routeFile = findRankedFile(/(^|\/)routes?\//i);
    const serviceExtension = servicePattern ? path.extname(servicePattern) || ".ts" : ".ts";
    const controllerExtension = controllerPattern
      ? path.extname(controllerPattern) || ".ts"
      : ".ts";
    const suggestedService =
      domain && servicePattern
        ? path.posix.join(
            path.posix.dirname(servicePattern),
            `${domain}.service${serviceExtension}`,
          )
        : "";
    const suggestedController =
      domain && controllerPattern
        ? path.posix.join(
            path.posix.dirname(controllerPattern),
            `${domain}.controller${controllerExtension}`,
          )
        : "";
    const bootstrap =
      analysis.files.find((file) =>
        /(^|\/)src\/index\.(ts|tsx|js|jsx)$/i.test(file.path),
      )?.path ?? findRankedFile(/(^|\/)index\.(ts|tsx|js|jsx)$/i);
    const domainSymbols = domain
      ? analysis.symbols
          .filter(
            (symbol) =>
              symbol.qualifiedName.toLowerCase().includes(domain) ||
              symbol.filePath.toLowerCase().includes(domain),
          )
          .slice(0, 8)
          .map(
            (symbol) =>
              `${symbol.kind} ${symbol.qualifiedName} — ${symbol.filePath}:${symbol.startLine}`,
          )
      : [];
    const lines = [
      domain ? `Domain: ${domain}` : "",
      domainRepository
        ? `Existing repository: ${domainRepository}`
        : repositoryPattern
          ? `Repository pattern: ${repositoryPattern}`
          : "",
      servicePattern ? `Service pattern: ${servicePattern}` : "",
      suggestedService ? `Suggested service: ${suggestedService}` : "",
      controllerPattern ? `Controller pattern: ${controllerPattern}` : "",
      suggestedController ? `Suggested controller: ${suggestedController}` : "",
      routeFile ? `Route registry / container: ${routeFile}` : "",
      bootstrap ? `Bootstrap / call site: ${bootstrap}` : "",
      domainSymbols.length ? `Domain symbols:\n${domainSymbols.join("\n")}` : "",
    ].filter(Boolean);
    if (lines.length > 0) {
      editMap = `Edit map (index-derived; verify against the actual files, then start here):\n${lines.join("\n")}\nRead only these files plus the exact file you will edit.`;
    }
  }

  const projectTools = await listProjectTools(analysis.rootPath).catch(() => null);
  const toolLines =
    projectTools && projectTools.tools.length > 0
      ? `Saved project tools (run with run_project_tool; do not recreate them):\n${projectTools.tools
          .slice(0, 20)
          .map(
            (tool) =>
              `- ${tool.name}: ${tool.command}${tool.description ? ` — ${tool.description}` : ""}`,
          )
          .join("\n")}`
      : "";

  return [
    listHint,
    toolLines,
    indexLines.length > 0 ? `Index hits (best local matches):\n${indexLines.join("\n")}` : "",
    editMap,
    `Relevant files (ranked by the instruction and current focus):\n${ranked.length ? ranked.join("\n") : "(none matched; use list_files and search_code)"}`,
    relevantSymbols.length ? `Relevant symbols:\n${relevantSymbols.join("\n")}` : "",
    routes.length ? `Routes (sample):\n${routes.join("\n")}` : "",
    changedFiles.size ? `Uncommitted Git changes:\n${[...changedFiles].slice(0, 20).join("\n")}` : "",
    git?.available ? `Git: ${git.branch ?? "unknown branch"} · ${git.files.length} changed file(s)` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

interface ExtractedListItem {
  name: string;
  line?: number;
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractListItems(content: string, filePath: string, limit: number): ExtractedListItem[] {
  const items: ExtractedListItem[] = [];
  const seen = new Set<string>();
  const lineOf = (position: number) => content.slice(0, Math.max(0, position)).split("\n").length;
  const add = (raw: string, position: number) => {
    const name = decodeHtmlText(raw);
    if (!name || name.length < 2 || name.length > 140) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ name, line: lineOf(position) });
  };

  if (/\.json$/i.test(filePath) || /^\s*[\[{]/.test(content)) {
    try {
      const data = JSON.parse(content) as unknown;
      const walk = (node: unknown) => {
        if (items.length >= limit) return;
        if (Array.isArray(node)) {
          for (const entry of node) walk(entry);
          return;
        }
        if (node && typeof node === "object") {
          const record = node as Record<string, unknown>;
          const label = record.name ?? record.title ?? record.label;
          if (typeof label === "string" && label.trim()) {
            add(label, content.indexOf(label));
          }
          for (const value of Object.values(record)) walk(value);
        }
      };
      walk(data);
      if (items.length > 0) return items.slice(0, limit);
    } catch {
      // fall through to HTML extraction
    }
  }

  const articleWithIdPattern =
    /<article\b[^>]*\bid="[^"]+"[^>]*>[\s\S]*?<h[23]\b[^>]*>\s*(?:<a\b[^>]*>)?([^<]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = articleWithIdPattern.exec(content)) && items.length < limit) {
    add(match[1], match.index + Math.max(0, match[0].lastIndexOf(match[1])));
  }

  if (items.length === 0) {
    const articlePattern = /<article\b[^>]*>[\s\S]*?<h[23]\b[^>]*>\s*(?:<a\b[^>]*>)?([^<]+)/gi;
    while ((match = articlePattern.exec(content)) && items.length < limit) {
      add(match[1], match.index + Math.max(0, match[0].lastIndexOf(match[1])));
    }
  }

  if (items.length === 0) {
    const linkPattern = /<a\b[^>]*data-[a-z0-9-]*link[^>]*>([^<]+)/gi;
    while ((match = linkPattern.exec(content)) && items.length < limit) {
      add(match[1], match.index + Math.max(0, match[0].lastIndexOf(match[1])));
    }
  }

  if (items.length === 0) {
    const headingPattern = /<h[23]\b[^>]*>\s*(?:<a\b[^>]*>)?([^<]+)/gi;
    while ((match = headingPattern.exec(content)) && items.length < limit) {
      add(match[1], match.index + Math.max(0, match[0].lastIndexOf(match[1])));
    }
  }

  return items.slice(0, limit);
}

const AGENT_IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  "output",
  "coverage",
  "vendor",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  "Pods",
  "DerivedData",
]);

export async function listDiskFiles(
  rootPath: string,
  prefix: string,
  limit: number,
): Promise<{ path: string; bytes: number }[]> {
  const results: { path: string; bytes: number }[] = [];
  const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, "");
  const walk = async (relativeDir: string): Promise<void> => {
    if (results.length >= limit) return;
    const absoluteDir = path.resolve(rootPath, relativeDir);
    let entries;
    try {
      entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= limit) return;
      if (entry.isSymbolicLink()) continue;
      if (entry.name.startsWith("._")) continue;
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (AGENT_IGNORED_DIRS.has(entry.name)) continue;
        if (normalizedPrefix && relative !== normalizedPrefix && !normalizedPrefix.startsWith(`${relative}/`)) {
          continue;
        }
        await walk(relative);
        continue;
      }
      if (!entry.isFile()) continue;
      if (normalizedPrefix && relative !== normalizedPrefix && !relative.startsWith(`${normalizedPrefix}/`)) {
        continue;
      }
      try {
        const stat = await fs.stat(path.resolve(rootPath, relative));
        results.push({ path: relative, bytes: stat.size });
      } catch {
        // file disappeared during the scan
      }
    }
  };
  await walk("");
  return results;
}

async function agentSearch(
  analysis: AnalysisResult,
  query: string,
  limit: number,
): Promise<{ results: { path: string; line: number; text: string }[]; source: "index" | "disk" }> {
  const needle = query.trim().toLowerCase();
  if (!needle) return { results: [], source: "index" };
  const indexed = await searchProjectIndex(analysis.id, query, limit, analysis.rootPath);
  const indexedHits = indexed
    .filter((hit) => hit.kind !== "conversation" && hit.path)
    .map((hit) => ({
      path: hit.path!,
      line: hit.line ?? 1,
      text: `${hit.kind}: ${hit.snippet || hit.title}`,
    }));
  const validIndexedHits: typeof indexedHits = [];
  for (const hit of indexedHits) {
    try {
      const result = await fs.stat(path.resolve(analysis.rootPath, hit.path));
      if (result.isFile()) validIndexedHits.push(hit);
    } catch {
      // stale index path; fall through to disk search
    }
  }
  if (validIndexedHits.length > 0) return { results: validIndexedHits, source: "index" };
  const tokens = needle.split(/\s+/).filter((token) => token.length > 1);
  const results: { path: string; line: number; text: string }[] = [];
  const candidates = await listDiskFiles(analysis.rootPath, "", 500);
  for (const file of candidates) {
    if (results.length >= limit) break;
    if (file.bytes > 600_000) continue;
    if (isSecretAgentPath(file.path)) continue;
    const absolute = path.resolve(analysis.rootPath, file.path);
    if (!isWithin(analysis.rootPath, absolute)) continue;
    let content: string;
    try {
      // eslint-disable-next-line no-await-in-loop
      content = await fs.readFile(absolute, "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const lower = lines[index].toLowerCase();
      if (!lower.includes(needle) && !tokens.every((token) => lower.includes(token))) continue;
      results.push({ path: file.path, line: index + 1, text: lines[index].trim().slice(0, 220) });
      if (results.length >= limit) break;
    }
  }
  return { results, source: "disk" };
}

export function agentToolCatalog(
  readOnly: boolean,
  writeApproved: boolean,
  commandsApproved: boolean,
): string {
  const tools = [
    '{"action":"list_files","args":{"path":"src","limit":80}}',
    '{"action":"search_code","args":{"query":"login handler","limit":15}}',
    '{"action":"read_file","args":{"path":"src/app.ts","startLine":1,"endLine":200}}',
    '{"action":"find_in_file","args":{"path":"src/app.ts","query":"login","contextLines":2,"limit":10}}',
    '{"action":"list_items","args":{"path":"data/items.html","limit":100}}',
    '{"action":"count_matches","args":{"path":"src","query":"TODO","limit":20}}',
    '{"action":"json_query","args":{"path":"package.json","pointer":"scripts"}}',
    '{"action":"find_symbols","args":{"query":"UserService","kind":"class","limit":20}}',
    '{"action":"sqlite_query","args":{"path":"data/app.db","query":"SELECT name FROM sqlite_schema"}}',
    '{"action":"csv_query","args":{"path":"data/users.csv","columns":["name","email"],"limit":10}}',
    '{"action":"git_blame","args":{"path":"src/app.ts","startLine":10,"endLine":25}}',
    '{"action":"browser_check","args":{"path":"index.html","steps":[{"action":"fill","selector":"#task-input","value":"Test"},{"action":"click","selector":"#add-task"},{"action":"expectText","selector":"#task-list","text":"Test"}]}}',
    '{"action":"list_project_tools","args":{}}',
  ];
  if (!readOnly) {
    const approval = writeApproved ? "" : "  // requires user approval";
    tools.push(`{"action":"write_file","args":{"path":"src/new-file.ts","content":"complete final file content"}}${approval}`);
    tools.push(`{"action":"replace_in_file","args":{"path":"src/app.ts","find":"exact existing snippet","replace":"replacement snippet"}}${approval}`);
    tools.push(`{"action":"rename_path","args":{"path":"src/old.ts","newPath":"src/new.ts"}}  // always requires confirmation`);
    tools.push(`{"action":"delete_file","args":{"path":"src/obsolete.ts"}}  // always requires confirmation`);
    tools.push(`{"action":"format_file","args":{"path":"src/app.ts"}}${approval}`);
    const commandApproval = commandsApproved ? "" : "  // requires user approval";
    tools.push(`{"action":"run_command","args":{"command":"npm test","cwd":"."}}${commandApproval}`);
    tools.push(`{"action":"run_project_tool","args":{"name":"ui-check"}}${commandApproval}  // runs a saved project tool/script`);
    tools.push('{"action":"delegate_research","args":{"goal":"specific read-only question to investigate"}}  // returns a compact summary only');
  }
  tools.push('{"action":"finish","args":{"summary":"what changed and how it was verified"}}');
  return tools.map((tool) => `- ${tool}`).join("\n");
}

function clampObservation(text: string, limit = AGENT_OBSERVATION_CHARS): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… observation truncated …`;
}

function numberedContent(content: string, startLine: number): string {
  return content
    .split("\n")
    .map((line, index) => `${String(startLine + index).padStart(5, " ")} │ ${line}`)
    .join("\n");
}

export function buildReadOnlyFallbackPlan(plan: AiAgentPlan): AiAgentPlan {
  return {
    ...plan,
    intent: "explain",
    needsWrite: false,
    needsCommand: false,
    verification: undefined,
    risk: "low",
    summary:
      "Permission was denied. Continue with read-only inspection and explain the blocked action.",
    steps: [
      { label: "Continue with read-only inspection" },
      { label: "Report the denied action and the exact permission needed" },
      { label: "Finish with a clear summary" },
    ],
  };
}

export function buildAgentPlan(
  analysis: AnalysisResult,
  instruction: string,
  options: {
    activeFile?: string;
    askMode?: boolean;
    verificationCommand?: string;
  } = {},
): AiAgentPlan {
  const trimmed = instruction.trim();
  const question =
    options.askMode === true ||
    QUESTION_INTENT.test(trimmed) ||
    trimmed.endsWith("?");
  const editIntent = !question && ACTION_INTENT.test(trimmed);
  const runIntent =
    !question &&
    /\b(run|çalıştır|test et|build|derle|typecheck|lint|doğrula|verify)\b/i.test(trimmed) &&
    !editIntent;
  const scaffoldIntent =
    !question &&
    /\b(scaffold|sıfırdan|from scratch|new project|yeni proje|proje oluştur)\b/i.test(trimmed);

  const tokens = [...new Set(trimmed.toLowerCase().match(/[a-z0-9çğıöşü_]{3,}/g) ?? [])];
  const stems = new Set(tokens);
  for (const token of tokens) {
    if (token.endsWith("s") && token.length > 4) stems.add(token.slice(0, -1));
    if (token.endsWith("si") && token.length > 5) stems.add(token.slice(0, -2));
    if (token.endsWith("i") && token.length > 4) stems.add(token.slice(0, -1));
  }
  const scope = analysis.files
    .map((file) => {
      const lower = file.path.toLowerCase();
      let score = 0;
      for (const stem of stems) {
        if (lower.includes(stem)) score += 3;
      }
      if (options.activeFile && file.path === options.activeFile) score += 12;
      return { path: file.path, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((item) => item.path);

  const fallbackScope =
    scope.length > 0
      ? scope
      : editIntent || scaffoldIntent
        ? analysis.files
            .filter((file) => /(repositories?|services?|controllers?|routes?)\//i.test(file.path))
            .slice(0, 4)
            .map((file) => file.path)
        : [];

  const intent: AiAgentPlan["intent"] = question
    ? /\b(açıkla|anlat|explain|summary|özet)\b/i.test(trimmed)
      ? "explain"
      : "question"
    : scaffoldIntent
      ? "scaffold"
      : editIntent
        ? fallbackScope.length > 3
          ? "multi_file"
          : "edit"
        : runIntent
          ? "run"
          : "question";

  const needsWrite = !question && (editIntent || scaffoldIntent);
  const needsCommand =
    !question &&
    /\b(test|build|typecheck|lint|run|çalıştır|derle|doğrula|verify)\b/i.test(trimmed);
  const verification = needsWrite ? options.verificationCommand : undefined;
  const risk: AiAgentPlan["risk"] =
    /\b(delete|sil|remove|drop|reset --hard|force|rm\s)/i.test(trimmed)
      ? "high"
      : needsWrite || needsCommand
        ? "medium"
        : "low";

  const steps: AiAgentPlan["steps"] =
    intent === "question" || intent === "explain"
      ? [
          { label: "Inspect the most relevant files from the index" },
          { label: "Search and read evidence as needed" },
          { label: "Answer with file and line citations" },
        ]
      : intent === "run"
        ? [
            { label: "Inspect scripts, manifests and configuration" },
            { label: "Run the requested command with permission" },
            { label: "Report output and next steps" },
          ]
        : intent === "scaffold"
          ? [
              { label: "Create the project skeleton" },
              { label: "Wire dependencies and configuration" },
              { label: "Verify the build" },
            ]
          : [
              { label: "Inspect the edit map and likely files" },
              { label: "Apply scoped edits" },
              verification
                ? { label: "Run typecheck/build", detail: verification }
                : { label: "Review the changes" },
              { label: "Report changes and verification" },
            ];

  const summary =
    intent === "question" || intent === "explain"
      ? `Answer from ${fallbackScope.length} likely files and the project index.`
      : intent === "run"
        ? "Inspect the project, run the requested command with permission, and report the output."
        : intent === "scaffold"
          ? "Create the project skeleton, wire dependencies, and verify the build."
          : `Inspect ${fallbackScope.length} likely files, apply scoped edits, and verify the result.`;

  return {
    intent,
    summary,
    needsWrite,
    needsCommand,
    risk,
    scope: fallbackScope,
    verification,
    steps,
  };
}

export function queryProjectSymbols(
  analysis: AnalysisResult,
  query: string,
  kind?: string,
  limit = 20,
): SymbolRecord[] {
  const needle = query.trim().toLowerCase();
  const kindFilter = kind?.trim().toLowerCase();
  return analysis.symbols
    .filter((symbol) => {
      if (kindFilter && symbol.kind !== kindFilter) return false;
      if (!needle) return true;
      return (
        symbol.name.toLowerCase().includes(needle) ||
        symbol.qualifiedName.toLowerCase().includes(needle) ||
        symbol.filePath.toLowerCase().includes(needle)
      );
    })
    .slice(0, Math.max(1, Math.min(50, limit)));
}

export async function runAgentTask(
  projectId: string,
  instruction: string,
  options: {
    activeFile?: string;
    provider?: Parameters<typeof resolveProvider>[0];
    model?: string;
    allowWrite?: boolean;
    allowCommands?: boolean;
    language?: string;
    maxSteps?: number;
    mode?: "ask" | "coding" | "auto";
    history?: { role: "user" | "assistant"; content: string }[];
    interactive?: boolean;
    forceFast?: boolean;
  } = {},
  emit: (event: AiAgentEvent) => void = () => {},
  signal?: AbortSignal,
): Promise<AiAgentResult> {
  const analysis = await loadAnalysis(projectId);
  if (!instruction.trim()) throw new Error("An agent instruction is required.");
  const config = await resolveProvider(options.provider, options.model);
  const askMode = options.mode === "ask";
  const autoMode = options.mode === "auto";
  let writeApproved = !askMode && options.allowWrite === true;
  let commandsApproved = !askMode && options.allowCommands === true;
  const interactive = !askMode && options.interactive !== false;
  const runId = `run_${crypto.randomUUID()}`;
  const fastTask = options.forceFast === true || isFastEditTask(instruction, askMode);
  // maxSteps limits model turns, not individual tool actions from a multi-call reply.
  const maxSteps = Math.max(
    2,
    Math.min(24, options.maxSteps ?? (askMode ? 10 : fastTask ? 14 : AGENT_MAX_STEPS)),
  );
  const createdAt = new Date().toISOString();
  const evidence: AiContextFile[] = [];
  const steps: AiAgentStep[] = [];
  const changedFiles: string[] = [];
  const ranCommands: string[] = [];
  const logs: AiAgentLogEntry[] = [];
  let logCounter = 0;
  let currentStepIndex = 0;
  let currentStepTrace: AiAgentLogEntry[] | null = null;
  const log = (
    level: AiAgentLogEntry["level"],
    label: string,
    detail?: string,
  ): void => {
    const entry: AiAgentLogEntry = {
      id: `log-${Date.now()}-${++logCounter}`,
      at: new Date().toISOString(),
      level,
      label,
      detail,
      step: currentStepIndex || undefined,
    };
    logs.push(entry);
    if (currentStepTrace) currentStepTrace.push(entry);
    emit({ type: "log", entry });
  };
  const recordStep = (step: AiAgentStep) => {
    if (currentStepTrace && currentStepTrace.length > 0) step.trace = currentStepTrace;
    steps.push(step);
    emit({ type: "step", step });
  };
  let inputChars = 0;
  const denialCounts = new Map<string, number>();
  let activePlan: AiAgentPlan | null = null;
  let fallbackPlanEmitted = false;

  const requirePermission = async (
    kind: AiPermissionKind,
    tool: string,
    target: string | undefined,
    detail: string | undefined,
    options: { preview?: string; destructive?: boolean } = {},
  ): Promise<boolean> => {
    if (askMode) return false;
    const destructive = options.destructive === true;
    if (!destructive) {
      if (kind === "write" && writeApproved) return true;
      if (kind === "command" && commandsApproved) return true;
    }
    if (!interactive) return false;
    const denialKey = `${kind}:${destructive ? "destructive" : "normal"}`;
    if ((denialCounts.get(denialKey) ?? 0) >= 2) {
      log("warn", "Permission unavailable", `${kind} requests were denied twice in this run.`);
      return false;
    }
    log(
      "warn",
      destructive ? "Destructive action needs confirmation" : "Permission requested",
      `${tool}${target ? ` · ${target}` : ""}`,
    );
    const decision: AiPermissionDecision = await requestPermission(
      {
        runId,
        projectId,
        kind,
        tool,
        target,
        detail,
        preview: options.preview ? options.preview.slice(0, 900) : undefined,
        destructive,
        canAlways: !destructive,
      },
      {
        signal,
        onRequest: (request: AiAgentPermissionRequest) => emit({ type: "permission", request }),
      },
    );
    if (signal?.aborted || decision === "deny") {
      denialCounts.set(denialKey, (denialCounts.get(denialKey) ?? 0) + 1);
      log("warn", "Permission denied", `${tool}${target ? ` · ${target}` : ""}`);
      if (!signal?.aborted && decision === "deny" && activePlan && !fallbackPlanEmitted) {
        fallbackPlanEmitted = true;
        activePlan = buildReadOnlyFallbackPlan(activePlan);
        emit({ type: "plan", plan: activePlan });
        log("warn", "Fallback plan selected", "read-only after permission denial");
      }
      return false;
    }
    if (decision === "always" && !destructive) {
      if (kind === "write") writeApproved = true;
      if (kind === "command") commandsApproved = true;
      log("success", "Permission granted for the rest of this run", kind === "write" ? "file writes" : "commands");
    } else {
      log("success", "Permission granted once", tool);
    }
    return true;
  };

  const verificationTooling =
    analysis.tooling ??
    (await detectProjectProfile(
      analysis.rootPath,
      analysis.files.map((file) => ({ path: file.path })),
      analysis.frameworks ?? [],
    ));
  const verificationCommand = preferredVerificationCommand(verificationTooling);
  let lastVerification: {
    signature: string;
    ran: boolean;
    ok: boolean;
    command?: string;
    output: string;
    cached: boolean;
  } | null = null;
  let verificationAttempts = 0;
  const getLastVerification = () => lastVerification;

  const changeSignature = async (): Promise<string> => {
    const hash = crypto.createHash("sha1");
    for (const filePath of [...changedFiles].sort()) {
      hash.update(filePath);
      const content = await readSourceFile(analysis.rootPath, filePath)
        .then((file) => file.content)
        .catch(() => "");
      hash.update(content);
    }
    return hash.digest("hex").slice(0, 16);
  };

  const verifyChanges = async (): Promise<{
    signature: string;
    ran: boolean;
    ok: boolean;
    command?: string;
    output: string;
    cached: boolean;
  }> => {
    if (askMode || changedFiles.length === 0) {
      return { signature: "", ran: false, ok: false, output: "", cached: false };
    }
    if (!verificationCommand) {
      log("warn", "No verification command", "No typecheck/build command was detected for this project.");
      return {
        signature: "none",
        ran: false,
        ok: false,
        output: "No typecheck/build command was detected for this project.",
        cached: false,
      };
    }
    if (verificationAttempts >= AGENT_MAX_VERIFY_ATTEMPTS) {
      return (
        lastVerification ?? {
          signature: "limit",
          ran: false,
          ok: false,
          command: verificationCommand,
          output: "Verification attempt limit reached.",
          cached: true,
        }
      );
    }
    const signature = await changeSignature();
    if (lastVerification && lastVerification.signature === signature) {
      return { ...lastVerification, cached: true };
    }
    const allowed = await requirePermission(
      "command",
      "verify_changes",
      verificationCommand,
      "Verify the changed files with the project typecheck/build command.",
      { preview: verificationCommand },
    );
    if (!allowed) {
      const denied = {
        signature,
        ran: false,
        ok: false,
        command: verificationCommand,
        output: "Verification was skipped because the user denied the command.",
        cached: false,
      };
      lastVerification = denied;
      log("warn", "Verification skipped", "The user denied the verification command.");
      return denied;
    }
    verificationAttempts += 1;
    log("info", "Verifying changes", verificationCommand);
    const result = await runProjectCommand(analysis.rootPath, verificationCommand, undefined, {
      timeoutMs: 120_000,
      signal,
    });
    const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}${
      result.timedOut ? "\nVerification command timed out." : ""
    }`.trim();
    const verification = {
      signature,
      ran: true,
      ok: result.exitCode === 0,
      command: verificationCommand,
      output,
      cached: false,
    };
    lastVerification = verification;
    if (verification.ok) {
      log("success", "Verification passed", verificationCommand);
    } else {
      log("error", "Verification failed", `${verificationCommand} · exit ${result.exitCode ?? "—"}`);
    }
    return verification;
  };

  const plan = buildAgentPlan(analysis, instruction, {
    activeFile: options.activeFile,
    askMode,
    verificationCommand,
  });
  activePlan = plan;
  const seed = await agentSeedContext(analysis, instruction, options.activeFile);
  const context = [
    projectBrief(analysis),
    "",
    `Working file (optional): ${options.activeFile ?? "none"}`,
    askMode
      ? "Permissions: read-only; file writes and commands are unavailable."
      : `Permissions: write=${writeApproved ? "pre-approved" : "ask the user before writing"}; commands=${
          commandsApproved ? "pre-approved" : "ask the user before running commands"
        }; delete and rename always need confirmation.`,
    seed,
    options.history && options.history.length > 0
      ? `Conversation so far:\n${options.history
          .slice(-6)
          .map((message) => `${message.role}: ${message.content}`)
          .join("\n\n")}`
      : "",
    `Project files (sample):\n${analysis.files.slice(0, 15).map((file) => file.path).join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n");

  const promptId = askMode ? "agent.ask" : autoMode ? "agent.auto" : "agent.coding";
  const prompt = await getPrompt(promptId, projectId);
  const languageInstruction = aiLanguageInstruction(options.language ?? "en");
  const fastSuffix = fastTask
    ? "\n\nFast task profile: this is a small, focused change. Start from the index edit map, read at most 5 files, make the edits, and finish. Complete every edit-map item (service, controller, route registration, container/DI wiring, bootstrap call site) before finishing. Do not read unrelated modules or repeat reads."
    : "";
  const enabledSkills = await loadEnabledSkills(analysis.rootPath, projectId).catch(() => []);
  const skillsPrompt = renderSkillsForPrompt(enabledSkills);
  if (enabledSkills.length > 0) {
    log(
      "info",
      "Skills loaded",
      `${enabledSkills.length} enabled · ${enabledSkills.map((skill) => skill.record.name).join(", ")}`,
    );
  }
  const systemContent =
    renderPrompt(prompt.system, {
      tools: agentToolCatalog(askMode, writeApproved, commandsApproved),
      language: languageInstruction,
    }) +
    (skillsPrompt ? `\n\n${skillsPrompt}` : "") +
    fastSuffix;
  log(
    "info",
    "Prompt selected",
    `${prompt.id} v${prompt.version}${prompt.source !== "default" ? ` · ${prompt.source}` : ""}`,
  );
  if (fastTask) {
    log("info", "Fast task profile selected", "small edit · focused reads · automatic verification");
  }
  const system: ChatMessage = {
    role: "system",
    content: systemContent,
  };

  emit({ type: "start", provider: config.id, model: config.model });
  emit({ type: "plan", plan });
  log(
    "info",
    "Plan ready",
    `${plan.intent} · ${plan.scope.length} files · risk ${plan.risk}`,
  );

  const transcript: ChatMessage[] = [
    system,
    {
      role: "user",
      content: `${context}\n\nTask: ${instruction.trim()}`,
    },
  ];

  let summary = "";
  let stoppedReason: AiAgentResult["stoppedReason"] = "max_steps";
  let errorMessage: string | undefined;
  let consecutiveFailures = 0;
  let protocolFailures = 0;
  let emptyResponseCount = 0;
  const tokenTotal: AiTokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const queuedActions: ParsedToolAction[] = [];
  const readCoverage = new Map<string, { start: number; end: number; wholeFile: boolean; step: number }[]>();
  const readOnlyCache = new Map<string, { step: number; ok: boolean }>();
  const findCounts = new Map<string, number>();
  const invalidateReadCaches = () => {
    readCoverage.clear();
    readOnlyCache.clear();
    findCounts.clear();
  };
  let modelTurns = 0;
  let remainingWorkRejected = false;

  for (let index = 1; ; index += 1) {
    if (signal?.aborted) {
      stoppedReason = "aborted";
      summary = "Stopped by the user.";
      break;
    }
    // A native multi-call reply is one model turn; queued actions do not
    // consume another turn or another model request.
    if (queuedActions.length === 0) {
      if (modelTurns >= maxSteps) break;
      modelTurns += 1;
    }
    const started = Date.now();
    currentStepIndex = index;
    currentStepTrace = [];
    let reply = "";
    let stepUsage: AiTokenUsage | undefined;
    let parsed: Record<string, unknown>;
    if (queuedActions.length > 0) {
      const next = queuedActions.shift()!;
      parsed = { action: next.action, args: next.args, __actionCount: 0 };
      log(
        "info",
        "Queued tool call",
        `${next.action}${agentActionTarget(next.args) ? ` · ${agentActionTarget(next.args)}` : ""}`,
      );
    } else {
    log("model", "Model is thinking…", "Planning the next tool call");
    try {
      inputChars += transcript.reduce((total, message) => total + message.content.length, 0);
      let receivedChars = 0;
      let lastStreamLog = 0;
      const completion = await chatTracked(
        projectId,
        config,
        transcript,
        {
          maxTokens: 6000,
          temperature: 0.1,
          timeoutMs: 120_000,
          signal,
          onToken: (chunk) => {
            receivedChars += chunk.length;
            if (receivedChars - lastStreamLog >= 400) {
              lastStreamLog = receivedChars;
              log("model", "Receiving response…", `${receivedChars} chars`);
            }
          },
        },
        "agent",
      );
      reply = completion.text;
      stepUsage = completion.tokenUsage;
      if (stepUsage) {
        tokenTotal.inputTokens += stepUsage.inputTokens;
        tokenTotal.outputTokens += stepUsage.outputTokens;
        tokenTotal.totalTokens += stepUsage.totalTokens;
      }
    } catch (requestError) {
      log("error", "Model request failed", requestError instanceof Error ? requestError.message : undefined);
      if (signal?.aborted) {
        stoppedReason = "aborted";
        summary = "Stopped by the user.";
        break;
      }
      consecutiveFailures += 1;
      const message = requestError instanceof Error ? requestError.message : "The model request failed.";
      const isEmpty = /empty response/i.test(message);
      const unavailable =
        /error 410\b|end of life|no longer available|model .* not found|does not exist|model_not_found/i.test(
          message,
        );
      if (unavailable) {
        log("error", "Model is unavailable", "Switch to another provider or model.");
      }
      if (isEmpty) {
        emptyResponseCount += 1;
        log("error", `Empty response (${emptyResponseCount}/2)`, message);
      }
      const observation = `Model request failed: ${message}. Retry with a tool call or finish.`;
      recordStep({
        index,
        action: "invalid",
        args: {},
        observation,
        ok: false,
        durationMs: Date.now() - started,
      });
      transcript.push({ role: "user", content: `Observation (step ${index}) [request-error]: ${observation}` });
      if (unavailable) {
        errorMessage = `${message} The selected model is unavailable; switch to another model.`;
        stoppedReason = "error";
        break;
      }
      if (emptyResponseCount >= 2) {
        errorMessage = `${message} Stopped after 2 empty responses instead of looping.`;
        stoppedReason = "error";
        log("error", "Stopping repeated empty responses", "The provider returned no content twice.");
        break;
      }
      if (consecutiveFailures >= 2) {
        errorMessage = message;
        stoppedReason = "error";
        break;
      }
      continue;
    }
    consecutiveFailures = 0;
    log("info", "Plan received", `${reply.length} characters`);

    const cleanReply = stripToolCallMarkup(reply);
    transcript.push({
      role: "assistant",
      content: cleanReply || "[provider-native tool call omitted; use the JSON action protocol]",
    });

    try {
      parsed = parseAgentReply(reply);
    } catch {
      log("error", "Response was not valid tool JSON", reply.replace(/\s+/g, " ").slice(0, 180));
      const looksLikeToolText =
        isToolCallLeak(reply) || /"action"\s*:|"function"\s*:|"tool_calls"\s*:/i.test(reply);
      if ((askMode || autoMode) && !looksLikeToolText && steps.some((step) => step.ok) && reply.trim().length > 30) {
        const answer = reply.trim();
        summary = answer;
        recordStep({
          index,
          action: "finish",
          args: { summary: answer },
          observation: answer,
          ok: true,
          durationMs: Date.now() - started,
          tokenUsage: stepUsage,
        });
        stoppedReason = "finished";
        break;
      }
      const observation = `Invalid response. Reply with one JSON object using action and args. Your reply started with: ${reply.replace(/\s+/g, " ").slice(0, 180)}`;
      recordStep({
        index,
        action: "invalid",
        args: {},
        observation,
        ok: false,
        durationMs: Date.now() - started,
        tokenUsage: stepUsage,
      });
      transcript.push({ role: "user", content: `Observation (step ${index}) [invalid]: ${observation}` });
      continue;
    }
    const parsedActions = Array.isArray(parsed.__actions)
      ? (parsed.__actions as ParsedToolAction[])
      : [];
    if (parsedActions.length > 1) {
      queuedActions.push(...parsedActions.slice(1));
    }
    }

    const actionCount = Number(parsed.__actionCount ?? 1);
    if (actionCount > 1) {
      log(
        "warn",
        "Multiple tool calls in one reply",
        `${actionCount} calls · queued and executed in order`,
      );
    }
    const rawAction = String(parsed.action ?? parsed.tool ?? parsed.tool_name ?? parsed.name ?? "").trim();
    let rawArgs = parsed.args ?? parsed.arguments ?? parsed.parameters ?? parsed.input;
    if (typeof rawArgs === "string") {
      try {
        rawArgs = JSON.parse(rawArgs) as unknown;
      } catch {
        // keep non-JSON strings as empty args
      }
    }
    const args =
      rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {};
    const directAnswer =
      !rawAction && typeof (parsed.answer ?? parsed.summary ?? parsed.message) === "string"
        ? String(parsed.answer ?? parsed.summary ?? parsed.message).trim()
        : "";
    if (directAnswer) {
      recordStep({
        index,
        action: "finish",
        args: { summary: directAnswer },
        observation: directAnswer,
        ok: true,
        durationMs: Date.now() - started,
        tokenUsage: stepUsage,
      });
      summary = directAnswer;
      stoppedReason = "finished";
      break;
    }

    const validActions: AiAgentAction[] = [
      "list_files",
      "search_code",
      "read_file",
      "find_in_file",
      "list_items",
      "count_matches",
      "json_query",
      "find_symbols",
      "sqlite_query",
      "csv_query",
      "git_blame",
      "browser_check",
      "list_project_tools",
      "run_project_tool",
      "delegate_research",
      "write_file",
      "replace_in_file",
      "rename_path",
      "delete_file",
      "format_file",
      "run_command",
      "finish",
    ];
    const action = validActions.includes(rawAction as AiAgentAction)
      ? (rawAction as AiAgentAction)
      : "invalid";

    const step: AiAgentStep = {
      index,
      action,
      args,
      observation: "",
      ok: false,
      durationMs: 0,
    };
    if (action !== "finish" && action !== "invalid") {
      const toolLabel: Record<string, string> = {
        list_files: "Scanning file tree…",
        search_code: "Searching the project…",
        read_file: "Reading file…",
        find_in_file: "Searching inside file…",
        list_items: "Extracting list items…",
        count_matches: "Counting matches…",
        json_query: "Inspecting JSON…",
        find_symbols: "Searching symbols…",
        sqlite_query: "Querying SQLite…",
        csv_query: "Querying CSV…",
        git_blame: "Reading git blame…",
        browser_check: "Inspecting the preview in a browser…",
        list_project_tools: "Listing saved project tools…",
        run_project_tool: "Running saved project tool…",
        delegate_research: "Delegating read-only research…",
        write_file: "Writing file…",
        replace_in_file: "Editing file…",
        rename_path: "Moving path…",
        delete_file: "Deleting file…",
        format_file: "Formatting file…",
        run_command: "Running command…",
      };
      log("tool", toolLabel[action] ?? `Running ${action}…`, agentActionTarget(args));
    }

    if (action === "finish") {
      let rawSummary = String(args.summary ?? parsed.summary ?? parsed.final ?? "").trim();
      if (isToolCallLeak(rawSummary)) {
        const observation =
          "The finish summary contained tool-call or XML markup. Reply with a plain Markdown answer in args.summary. Never output DSML, tool_call, function or provider control tags.";
        log("error", "Finish summary leaked tool markup", rawSummary.replace(/\s+/g, " ").slice(0, 160));
        recordStep({
          index,
          action: "invalid",
          args: {},
          observation,
          ok: false,
          durationMs: Date.now() - started,
          tokenUsage: stepUsage,
        });
        transcript.push({ role: "user", content: `Observation (step ${index}) [invalid]: ${observation}` });
        continue;
      }

      if (
        !askMode &&
        modelTurns < maxSteps &&
        !remainingWorkRejected &&
        reportsRemainingWork(rawSummary)
      ) {
        remainingWorkRejected = true;
        const observation =
          "You reported remaining work. Complete it now, including route registration, container/DI wiring and bootstrap call sites from the edit map, or explain why each remaining item is not required. Do not finish with pending work while turns remain.";
        log("warn", "Finish rejected: remaining work", rawSummary.replace(/\s+/g, " ").slice(0, 160));
        recordStep({
          index,
          action: "invalid",
          args: {},
          observation,
          ok: false,
          durationMs: Date.now() - started,
          tokenUsage: stepUsage,
        });
        transcript.push({ role: "user", content: `Observation (step ${index}) [invalid]: ${observation}` });
        continue;
      }

      if (!askMode && changedFiles.length > 0) {
        const verification = await verifyChanges();
        if (verification.ran && !verification.ok && !verification.cached) {
          const observation = `Verification failed. Fix the reported errors before finishing again.\nCommand: ${verification.command}\n${verification.output.slice(0, 4_000)}`;
          log("error", "Verification failed", verification.command);
          recordStep({
            index,
            action: "run_command",
            args: { command: verification.command ?? "", cwd: "." },
            observation,
            ok: false,
            durationMs: Date.now() - started,
            tokenUsage: stepUsage,
          });
          transcript.push({ role: "user", content: `Observation (step ${index}) [verify ok=false]:\n${observation}` });
          continue;
        }
        if (verification.ran && verification.ok && !/verification/i.test(rawSummary)) {
          rawSummary = `${rawSummary}\n\n**Typecheck:** \`${verification.command}\` passed.`.trim();
        } else if (verification.ran && !verification.ok) {
          rawSummary = `${rawSummary}\n\n**Typecheck failed:** \`${verification.command}\`\n\`\`\`\n${verification.output.slice(0, 3_000)}\n\`\`\``.trim();
        } else if (verification.output) {
          rawSummary = `${rawSummary}\n\n**Verification:** ${verification.output}`.trim();
        }
      }

      summary = rawSummary || "The agent finished without a summary.";
      step.observation = summary;
      step.ok = true;
      step.durationMs = Date.now() - started;
      step.tokenUsage = stepUsage;
      log("success", "Answer is ready", summary.slice(0, 140));
      recordStep(step);
      stoppedReason = "finished";
      break;
    }

    let observation = "";
    let ok = false;
    let actionCacheKeyValue = "";
    let cachedAction: { step: number; ok: boolean } | undefined;
    try {
      if (action === "invalid") {
        throw new Error(
          `Unknown action "${rawAction || "(missing)"}". Reply with one JSON object using action and args. Your reply started with: ${reply.replace(/\s+/g, " ").slice(0, 180)}`,
        );
      }
      actionCacheKeyValue = READ_ONLY_ACTIONS.has(action)
        ? `${action}:${stableActionKey(args)}`
        : "";
      cachedAction = actionCacheKeyValue ? readOnlyCache.get(actionCacheKeyValue) : undefined;
      if (cachedAction) {
        observation = `Already executed in step ${cachedAction.step} with the same arguments. Reuse that observation; do not repeat this call.`;
        ok = cachedAction.ok;
        log("info", "Skipped duplicate tool call", `${action} · step ${cachedAction.step}`);
      } else if (action === "list_files") {
        const rawPrefix = normalizeAgentPath(analysis.rootPath, args.path);
        const prefix = rawPrefix.replace(/\/$/, "");
        const limit = Math.max(1, Math.min(200, Number(args.limit ?? 80) || 80));
        const matches = await listDiskFiles(analysis.rootPath, prefix, limit);
        const analysisByPath = new Map(analysis.files.map((file) => [file.path, file]));
        const lines = matches.map((file) => {
          const known = analysisByPath.get(file.path);
          return `${file.path} (${file.bytes} B${known ? `, ${known.loc} lines` : ""})`;
        });
        observation = lines.length > 0 ? lines.join("\n") : `No project files under "${prefix || "."}".`;
        log("info", `${lines.length} files listed from disk`, prefix || ".");
        ok = true;
      } else if (action === "search_code") {
        const query = String(args.query ?? "").trim();
        if (!query) throw new Error("A search query is required.");
        const limit = Math.max(1, Math.min(30, Number(args.limit ?? 12) || 12));
        const found = await agentSearch(analysis, query, limit);
        observation =
          found.results.length > 0
            ? found.results.map((result) => `${result.path}:${result.line}: ${result.text}`).join("\n")
            : `No matches for "${query}".`;
        for (const result of found.results) {
          evidence.push({ path: result.path, label: "Search result", startLine: result.line });
        }
        log(
          "info",
          found.source === "index" ? "Index search completed" : "Disk scan completed",
          `${found.results.length} matches · ${query}`,
        );
        ok = true;
      } else if (action === "git_blame") {
        const filePath = normalizeAgentPath(analysis.rootPath, args.path);
        if (!filePath) throw new Error("A file path is required.");
        if (isSecretAgentPath(filePath)) throw new Error("Reading environment, key or Git internals files is denied.");
        const startLine = Math.max(1, Number(args.startLine ?? 1) || 1);
        const endLine = Math.max(startLine, Number(args.endLine ?? startLine + 39) || startLine + 39);
        const blame = await getGitBlame(analysis.rootPath, filePath, startLine, endLine);
        observation = `Git blame: ${filePath}:${startLine}-${endLine}\n${clampObservation(blame, 2_800)}`;
        evidence.push({ path: filePath, label: "Git blame", startLine, endLine });
        log("info", "Git blame read", `${filePath}:${startLine}-${endLine}`);
        ok = true;
      } else if (action === "sqlite_query") {
        const filePath = normalizeAgentPath(analysis.rootPath, args.path);
        if (!filePath) throw new Error("A database path is required.");
        if (isSecretAgentPath(filePath)) throw new Error("Reading environment, key or Git internals files is denied.");
        observation = await querySqliteFile(
          analysis.rootPath,
          filePath,
          String(args.query ?? ""),
        );
        evidence.push({ path: filePath, label: "SQLite query" });
        log("info", "SQLite query executed", filePath);
        ok = true;
      } else if (action === "csv_query") {
        const filePath = normalizeAgentPath(analysis.rootPath, args.path);
        if (!filePath) throw new Error("A CSV path is required.");
        if (isSecretAgentPath(filePath)) throw new Error("Reading environment, key or Git internals files is denied.");
        observation = await queryCsvFile(analysis.rootPath, filePath, args);
        evidence.push({ path: filePath, label: "CSV query" });
        log("info", "CSV query executed", filePath);
        ok = true;
      } else if (action === "find_symbols") {
        const query = String(args.query ?? "").trim();
        const kind = String(args.kind ?? "").trim() || undefined;
        const limit = Math.max(1, Math.min(50, Number(args.limit ?? 20) || 20));
        const matches = queryProjectSymbols(analysis, query, kind, limit);
        observation =
          matches.length > 0
            ? matches
                .map(
                  (symbol) =>
                    `${symbol.kind} ${symbol.qualifiedName} — ${symbol.filePath}:${symbol.startLine}`,
                )
                .join("\n")
            : `No symbols matched "${query}"${kind ? ` (kind: ${kind})` : ""}.`;
        for (const match of matches) {
          evidence.push({
            path: match.filePath,
            label: match.qualifiedName,
            startLine: match.startLine,
          });
        }
        log("info", `${matches.length} symbols matched`, query || "*");
        ok = true;
      } else if (action === "read_file") {
        const filePath = normalizeAgentPath(analysis.rootPath, args.path);
        if (!filePath) throw new Error("A file path is required.");
        if (isSecretAgentPath(filePath)) throw new Error("Reading environment, key or Git internals files is denied.");
        const requestedStart = Math.max(1, Number(args.startLine ?? 1) || 1);
        const requestedWhole = args.endLine === undefined;
        const requestedEnd = requestedWhole
          ? Number.POSITIVE_INFINITY
          : Math.max(requestedStart, Number(args.endLine) || requestedStart);
        const ranges = readCoverage.get(filePath) ?? [];
        const coveredEntry = ranges.find(
          (entry) =>
            entry.start <= requestedStart &&
            (requestedWhole ? entry.wholeFile : entry.end >= requestedEnd),
        );
        const covered = readRangeCovered(ranges, requestedStart, requestedWhole, requestedEnd);
        if (covered && coveredEntry) {
          observation = `Already read ${filePath}${
            requestedWhole ? " (whole file)" : `:${requestedStart}-${requestedEnd}`
          } in step ${coveredEntry.step}. Reuse that observation; do not read it again.`;
          log("info", "Read skipped (already in context)", `${filePath} · step ${coveredEntry.step}`);
          ok = true;
        } else {
          const file = await readSourceFile(analysis.rootPath, filePath);
          const lines = file.content.split("\n");
          const startLine = requestedStart;
          const endLine = Math.max(
            startLine,
            Math.min(
              lines.length,
              requestedWhole ? startLine + 260 : requestedEnd,
            ),
          );
          const window = lines.slice(startLine - 1, endLine).join("\n");
          const clipped = window.length > AGENT_READ_CHARS ? `${window.slice(0, AGENT_READ_CHARS)}\n… file window truncated …` : window;
          observation = `File: ${file.filePath} (${lines.length} lines, showing ${startLine}-${Math.min(endLine, lines.length)})\n${numberedContent(clipped, startLine)}`;
          evidence.push({ path: file.filePath, label: "Read by agent", startLine });
          ranges.push({ start: startLine, end: endLine, wholeFile: endLine >= lines.length, step: index });
          readCoverage.set(filePath, ranges);
          log("info", `${lines.length} lines read`, `${file.filePath} (${startLine}-${Math.min(endLine, lines.length)})`);
          ok = true;
        }
      } else if (action === "find_in_file") {
        const filePath = normalizeAgentPath(analysis.rootPath, args.path);
        const query = String(args.query ?? "").trim();
        if (!filePath) throw new Error("A file path is required.");
        if (!query) throw new Error("A search query is required.");
        if (isSecretAgentPath(filePath)) throw new Error("Reading environment, key or Git internals files is denied.");
        const fullRead = (readCoverage.get(filePath) ?? []).find((entry) => entry.wholeFile);
        const previousFindCount = findCounts.get(filePath) ?? 0;
        if (fullRead) {
          observation = `File ${filePath} was already read fully in step ${fullRead.step}. Use that earlier observation instead of searching it again.`;
          log("info", "Find skipped (file already in context)", filePath);
          ok = true;
        } else if (previousFindCount >= 3) {
          observation = `You already searched ${filePath} ${previousFindCount} times. Read the relevant range once, or make the edit using the evidence you have. Do not search this file again.`;
          log("warn", "Repeated file search skipped", `${filePath} · ${previousFindCount} searches`);
          ok = true;
        } else {
          findCounts.set(filePath, previousFindCount + 1);
          const file = await readSourceFile(analysis.rootPath, filePath);
          const lines = file.content.split("\n");
          const needle = query.toLowerCase();
          const limit = Math.max(1, Math.min(40, Number(args.limit ?? 10) || 10));
          const contextLines = Math.max(0, Math.min(5, Number(args.contextLines ?? 1) || 0));
          const hits: string[] = [];
          for (let index = 0; index < lines.length && hits.length < limit; index += 1) {
            if (!lines[index].toLowerCase().includes(needle)) continue;
            const start = Math.max(0, index - contextLines);
            const end = Math.min(lines.length, index + contextLines + 1);
            const snippet = lines
              .slice(start, end)
              .map((line, offset) => `${String(start + offset + 1).padStart(5, " ")} │ ${line.trim()}`)
              .join("\n");
            hits.push(snippet);
          }
          observation =
            hits.length > 0
              ? `Matches for "${query}" in ${file.filePath} (${lines.length} lines):\n${hits.join("\n---\n")}`
              : `No matches for "${query}" in ${file.filePath}.`;
          evidence.push({ path: file.filePath, label: "Search in file" });
          log("info", `${hits.length} matches in file`, query);
          ok = true;
        }
      } else if (action === "list_items") {
        const filePath = normalizeAgentPath(analysis.rootPath, args.path);
        if (!filePath) throw new Error("A file path is required.");
        if (isSecretAgentPath(filePath)) throw new Error("Reading environment, key or Git internals files is denied.");
        const file = await readSourceFile(analysis.rootPath, filePath);
        const limit = Math.max(1, Math.min(120, Number(args.limit ?? 100) || 100));
        const items = extractListItems(file.content, filePath, limit);
        observation =
          items.length > 0
            ? `Items (${items.length}):\n${items
                .map((item, index) => `${index + 1}. ${item.name}${item.line ? ` — line ${item.line}` : ""}`)
                .join("\n")}`
            : `No list items were extracted from ${filePath}. Try read_file or find_in_file.`;
        evidence.push({ path: filePath, label: "List items" });
        log("info", `${items.length} items extracted`, filePath);
        ok = true;
      } else if (action === "count_matches") {
        const query = String(args.query ?? "").trim();
        if (!query) throw new Error("A search query is required.");
        const target = normalizeAgentPath(analysis.rootPath, args.path);
        if (target && isSecretAgentPath(target)) throw new Error("Reading environment, key or Git internals files is denied.");
        const limit = Math.max(1, Math.min(50, Number(args.limit ?? 20) || 20));
        const needle = query.toLowerCase();
        const counts: { path: string; count: number }[] = [];
        let total = 0;
        let scanned = 0;
        const candidates = target
          ? analysis.files.some((file) => file.path === target)
            ? [target]
            : target
          : analysis.files.map((file) => file.path);
        const filesToScan: string[] = typeof candidates === "string" ? [candidates] : candidates;
        for (const filePath of filesToScan.slice(0, 500)) {
          if (isSecretAgentPath(filePath)) continue;
          const absolute = path.resolve(analysis.rootPath, filePath);
          if (!isWithin(analysis.rootPath, absolute)) continue;
          let content: string;
          try {
            // eslint-disable-next-line no-await-in-loop
            const stat = await fs.stat(absolute);
            if (!stat.isFile() || stat.size > 900_000) continue;
            // eslint-disable-next-line no-await-in-loop
            content = await fs.readFile(absolute, "utf8");
          } catch {
            continue;
          }
          scanned += 1;
          const count = content.toLowerCase().split(needle).length - 1;
          if (count > 0) {
            counts.push({ path: filePath, count });
            total += count;
          }
        }
        const top = counts.sort((a, b) => b.count - a.count).slice(0, limit);
        observation =
          `Count of "${query}"${target ? ` under ${target}` : " in the project"}: ${total}\n` +
          (top.length > 0
            ? top.map((entry) => `${entry.path}: ${entry.count}`).join("\n")
            : "(no matches). Try a different query, find_in_file, or inspect the file.");
        for (const entry of top.slice(0, 10)) evidence.push({ path: entry.path, label: "Counted matches" });
        log("info", `${scanned} files scanned · ${total} matches`, query);
        ok = true;
      } else if (action === "json_query") {
        const filePath = normalizeAgentPath(analysis.rootPath, args.path);
        if (!filePath) throw new Error("A file path is required.");
        if (isSecretAgentPath(filePath)) throw new Error("Reading environment, key or Git internals files is denied.");
        const file = await readSourceFile(analysis.rootPath, filePath);
        let data: unknown;
        try {
          data = JSON.parse(file.content.replace(/^\uFEFF/, ""));
        } catch {
          throw new Error(`${filePath} is not valid JSON.`);
        }
        const pointer = String(args.pointer ?? "").trim();
        let current: unknown = data;
        const parts = pointer ? pointer.split(".").filter(Boolean) : [];
        for (const part of parts) {
          if (current && typeof current === "object" && part in (current as Record<string, unknown>)) {
            current = (current as Record<string, unknown>)[part];
          } else if (Array.isArray(current) && /^\d+$/.test(part)) {
            current = current[Number(part)];
          } else {
            throw new Error(`JSON pointer "${pointer}" was not found in ${filePath}.`);
          }
        }
        const describe = (value: unknown): string => {
          if (Array.isArray(value)) {
            return `array (length ${value.length})\nsample: ${JSON.stringify(value.slice(0, 3)).slice(0, 700)}`;
          }
          if (value && typeof value === "object") {
            const entries = Object.entries(value as Record<string, unknown>).slice(0, 30);
            const summary = entries
              .map(([key, entry]) => {
                if (Array.isArray(entry)) return `${key}: array (${entry.length})`;
                if (entry && typeof entry === "object") return `${key}: object`;
                return `${key}: ${JSON.stringify(entry)?.slice(0, 80)}`;
              })
              .join("\n");
            return `object with ${Object.keys(value as Record<string, unknown>).length} keys\n${summary}`;
          }
          return `value: ${JSON.stringify(value)}`;
        };
        observation = `JSON ${filePath}${pointer ? ` at "${pointer}"` : ""}\n${describe(current)}`;
        evidence.push({ path: filePath, label: "JSON query" });
        log("info", "JSON parsed", pointer || "root");
        ok = true;
      } else if (action === "rename_path") {
        const fromPath = normalizeAgentPath(analysis.rootPath, args.path);
        const toPath = normalizeAgentPath(analysis.rootPath, args.newPath);
        if (!fromPath || !toPath) throw new Error("Both path and newPath are required.");
        if (isSecretAgentPath(fromPath) || isSecretAgentPath(toPath)) {
          throw new Error("Renaming environment, key or Git internals files is denied.");
        }
        const renameAllowed = await requirePermission(
          "write",
          "rename_path",
          `${fromPath} → ${toPath}`,
          "Move or rename a project path.",
          { destructive: true },
        );
        if (!renameAllowed) throw new Error("The user denied permission to rename this path.");
        const renamed = await renameProjectPath(analysis.rootPath, fromPath, toPath);
        await renameIndexedPath(projectId, analysis.rootPath, renamed.from, renamed.to).catch(() => {
          // index update is best-effort
        });
        changedFiles.push(renamed.to);
        evidence.push({ path: renamed.to, label: "Renamed by agent" });
        invalidateReadCaches();
        observation = `Renamed ${renamed.from} → ${renamed.to}.`;
        log("success", "Path moved", `${renamed.from} → ${renamed.to}`);
        ok = true;
      } else if (action === "delete_file") {
        const targetPath = normalizeAgentPath(analysis.rootPath, args.path);
        if (!targetPath) throw new Error("A path is required.");
        if (isSecretAgentPath(targetPath)) {
          throw new Error("Deleting environment, key or Git internals files is denied.");
        }
        const deleteAllowed = await requirePermission(
          "write",
          "delete_file",
          targetPath,
          "Delete a file or empty directory. This cannot be undone.",
          { destructive: true },
        );
        if (!deleteAllowed) throw new Error("The user denied permission to delete this path.");
        const deleted = await deleteProjectPath(analysis.rootPath, targetPath);
        await removeIndexedPath(projectId, deleted.path).catch(() => {
          // index update is best-effort
        });
        invalidateReadCaches();
        observation = `Deleted ${deleted.path}${deleted.kind === "directory" ? " (empty directory)" : ""}.`;
        log("success", "Path deleted", deleted.path);
        ok = true;
      } else if (action === "list_project_tools") {
        const projectTools = await listProjectTools(analysis.rootPath);
        observation =
          projectTools.tools.length > 0
            ? `Saved project tools (${projectTools.tools.length}):\n${projectTools.tools
                .map(
                  (tool) =>
                    `- ${tool.name}: ${tool.command}${tool.description ? ` — ${tool.description}` : ""}`,
                )
                .join("\n")}`
            : "No saved project tools. Create a reusable script under .cie/agent/tools/ and it will be auto-registered.";
        log("info", "Project tools listed", `${projectTools.tools.length} tools`);
        ok = true;
      } else if (action === "browser_check") {
        const browserPath = typeof args.path === "string" ? args.path : "index.html";
        const rawSteps = Array.isArray(args.steps) ? args.steps : [];
        const result = await runBrowserCheck(analysis.id, analysis.rootPath, {
          path: browserPath,
          steps: rawSteps as BrowserCheckStep[],
          mobile: args.mobile === true,
          screenshot: args.screenshot === true,
        });
        observation = [
          result.summary,
          ...result.steps.map(
            (step) =>
              `${step.ok ? "PASS" : "FAIL"} #${step.index} ${step.action}: ${step.detail}`,
          ),
          result.consoleErrors.length > 0
            ? `Console errors:\n${result.consoleErrors.slice(0, 12).join("\n")}`
            : "",
          result.pageErrors.length > 0
            ? `Page errors:\n${result.pageErrors.slice(0, 8).join("\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n");
        if (result.screenshotPath) {
          evidence.push({ path: result.screenshotPath, label: "Browser check screenshot" });
        }
        log(
          result.ok ? "success" : "error",
          result.ok ? "Browser check passed" : "Browser check found problems",
          `${browserPath} · ${result.steps.length} steps`,
        );
        ok = result.ok;
      } else if (action === "run_project_tool") {
        const name = String(args.name ?? "").trim();
        if (!name) throw new Error("A project tool name is required.");
        const tool = await findProjectTool(analysis.rootPath, name);
        if (!tool) throw new Error(`Project tool "${name}" was not found.`);
        const allowed = await requirePermission(
          "command",
          "run_project_tool",
          tool.command,
          `Run saved project tool "${tool.name}".`,
          { preview: tool.command },
        );
        if (!allowed) {
          observation = `Permission denied for project tool "${tool.name}".`;
          ok = false;
        } else {
          log("info", "Running project tool", `${tool.name} · ${tool.command}`);
          const result = await runProjectCommand(analysis.rootPath, tool.command, undefined, {
            timeoutMs: 120_000,
            signal,
          });
          const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
          observation = `Project tool "${tool.name}" · exit ${result.exitCode ?? "—"}\n${output || "(no output)"}`;
          ok = result.exitCode === 0;
          await recordProjectToolRun(analysis.rootPath, tool.name, ok).catch(() => undefined);
          log(
            ok ? "success" : "error",
            ok ? "Project tool passed" : "Project tool failed",
            tool.name,
          );
        }
      } else if (action === "delegate_research") {
        const goal = String(args.goal ?? "").trim();
        if (!goal) throw new Error("A research goal is required.");
        const alternate = await pickAlternateAgentModel({
          provider: config.id,
          model: config.model,
        }).catch(() => null);
        const delegated = await runAgentTask(
          analysis.id,
          `Read-only research subagent. Investigate and report a compact answer with file:line evidence. Do not modify files or run commands.\n\n${goal}`,
          {
            mode: "ask",
            maxSteps: 6,
            allowWrite: false,
            allowCommands: false,
            interactive: false,
            language: options.language,
            provider: alternate?.provider,
            model: alternate?.model,
          },
          () => undefined,
          signal,
        );
        observation = [
          `Research subagent · ${delegated.stoppedReason} · ${delegated.provider}/${delegated.model}`,
          delegated.summary,
          delegated.usage?.contextFiles?.length
            ? `Evidence: ${delegated.usage.contextFiles
                .map((file) => `${file.path}${file.startLine ? `:${file.startLine}` : ""}`)
                .join(", ")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n");
        ok = delegated.stoppedReason === "finished";
        if (delegated.tokenUsage) {
          tokenTotal.inputTokens += delegated.tokenUsage.inputTokens;
          tokenTotal.outputTokens += delegated.tokenUsage.outputTokens;
          tokenTotal.totalTokens += delegated.tokenUsage.totalTokens;
        }
        log("info", "Research subagent completed", goal.slice(0, 160));
      } else if (action === "write_file") {
        if (changedFiles.length >= AGENT_MAX_WRITES) throw new Error(`Write limit reached (${AGENT_MAX_WRITES} files).`);
        const filePath = normalizeAgentPath(analysis.rootPath, args.path);
        const content = typeof args.content === "string" ? args.content : "";
        if (!filePath) throw new Error("A file path is required.");
        if (!content && !(args.content === "")) throw new Error("The content field must be a string.");
        if (isSecretAgentPath(filePath)) throw new Error("Writing environment, key or Git internals files is denied.");
        const writeAllowed = await requirePermission(
          "write",
          "write_file",
          filePath,
          `${content.split("\n").length} lines · ${Buffer.byteLength(content, "utf8")} bytes`,
          { preview: content },
        );
        if (!writeAllowed) throw new Error("The user denied permission to write this file.");
        const written = await writeSourceFile(projectId, analysis.rootPath, filePath, content);
        changedFiles.push(written.filePath);
        evidence.push({ path: written.filePath, label: "Written by agent" });
        invalidateReadCaches();
        observation = `Wrote ${written.bytes} bytes to ${written.filePath}${written.backupPath ? " (backup created)" : ""}.`;
        log("success", "File written", `${written.bytes} bytes${written.backupPath ? " · backup created" : ""}`);
        ok = true;
      } else if (action === "replace_in_file") {
        const filePath = normalizeAgentPath(analysis.rootPath, args.path);
        const find = typeof args.find === "string" ? args.find : "";
        const replace = typeof args.replace === "string" ? args.replace : "";
        if (!filePath) throw new Error("A file path is required.");
        if (!find) throw new Error("The find field is required.");
        if (isSecretAgentPath(filePath)) throw new Error("Editing environment, key or Git internals files is denied.");
        const file = await readSourceFile(analysis.rootPath, filePath);
        const occurrences = file.content.split(find).length - 1;
        if (occurrences === 0) throw new Error("The find snippet was not found in the file.");
        if (occurrences > 1) throw new Error(`The find snippet occurs ${occurrences} times; make it unique.`);
        const replaceAllowed = await requirePermission(
          "write",
          "replace_in_file",
          filePath,
          `Replace 1 snippet · ${find.length} → ${replace.length} chars`,
          { preview: `- ${find.slice(0, 420)}\n+ ${replace.slice(0, 420)}` },
        );
        if (!replaceAllowed) throw new Error("The user denied permission to edit this file.");
        const nextContent = file.content.replace(find, replace);
        const written = await writeSourceFile(projectId, analysis.rootPath, filePath, nextContent);
        if (!changedFiles.includes(written.filePath)) changedFiles.push(written.filePath);
        evidence.push({ path: written.filePath, label: "Edited by agent" });
        invalidateReadCaches();
        observation = `Replaced one snippet in ${written.filePath} (${written.bytes} bytes).`;
        log("success", "File edited", written.filePath);
        ok = true;
      } else if (action === "format_file") {
        const filePath = normalizeAgentPath(analysis.rootPath, args.path);
        if (!filePath) throw new Error("A file path is required.");
        if (isSecretAgentPath(filePath)) throw new Error("Formatting environment, key or Git internals files is denied.");
        const formatAllowed = await requirePermission(
          "write",
          "format_file",
          filePath,
          "Run the project formatter and write the formatted file.",
        );
        if (!formatAllowed) throw new Error("The user denied permission to format this file.");
        const formatted = await formatProjectFile(projectId, analysis, filePath);
        if (formatted.exitCode !== 0 || !formatted.command) {
          throw new Error(formatted.stderr || "No formatter was detected for this file type.");
        }
        if (formatted.formatted) changedFiles.push(formatted.filePath);
        evidence.push({ path: formatted.filePath, label: "Formatted by agent" });
        invalidateReadCaches();
        observation = `${formatted.command}\n${formatted.formatted ? "File formatted." : "File was already formatted."}`;
        log("success", "File formatted", formatted.filePath);
        ok = true;
      } else if (action === "run_command") {
        if (ranCommands.length >= AGENT_MAX_COMMANDS) throw new Error(`Command limit reached (${AGENT_MAX_COMMANDS}).`);
        const command = String(args.command ?? "").trim();
        if (!command) throw new Error("A command is required.");
        if (isBlockedAgentCommand(command)) {
          throw new Error("That command is blocked by the agent safety policy.");
        }
        const cwdInput = normalizeAgentPath(analysis.rootPath, args.cwd);
        const cwd = cwdInput || undefined;
        const commandAllowed = await requirePermission(
          "command",
          "run_command",
          command,
          `Working directory: ${cwd ?? "."}`,
          { preview: command },
        );
        if (!commandAllowed) throw new Error("The user denied permission to run this command.");
        const result = await runProjectCommand(analysis.rootPath, command, cwd, { signal });
        ranCommands.push(command);
        log(result.exitCode === 0 ? "success" : "error", "Command finished", `exit ${result.exitCode ?? "—"} · ${result.durationMs} ms`);
        const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
        observation = clampObservation(
          `Command: ${command}\nCWD: ${result.cwd}\nExit: ${result.exitCode ?? "—"}\nDuration: ${result.durationMs} ms\n${output || "(no output)"}`,
        );
        if (verificationCommand && command === verificationCommand) {
          const signature = await changeSignature();
          lastVerification = {
            signature,
            ran: true,
            ok: result.exitCode === 0,
            command,
            output,
            cached: false,
          };
        }
        ok = result.exitCode === 0;
      }
      if (actionCacheKeyValue && !cachedAction && ok) {
        readOnlyCache.set(actionCacheKeyValue, { step: index, ok });
      }
    } catch (toolError) {
      observation = toolError instanceof Error ? toolError.message : "The tool call failed.";
      ok = false;
    }

    if (actionCount > 1) {
      observation = `${observation}\n\n(Your reply contained ${actionCount} tool calls; all were executed in order. One JSON action per turn is still preferred.)`;
    }
    step.observation = clampObservation(
      observation,
      step.action === "read_file" || step.action === "find_in_file"
        ? 3_200
        : step.action === "run_command"
          ? 2_500
          : 1_500,
    );
    step.ok = ok;
    step.durationMs = Date.now() - started;
    step.tokenUsage = stepUsage;
    log(ok ? "success" : "error", ok ? "Tool completed" : "Tool failed", action);
    recordStep(step);
    if (step.action === "invalid") {
      protocolFailures += 1;
      if (protocolFailures >= 2) {
        stoppedReason = "error";
        summary =
          "The model repeatedly returned an invalid tool protocol. Switch model or retry; the task was stopped early to avoid burning tokens.";
        errorMessage = summary;
        log("error", "Stopping invalid tool protocol", "2 consecutive invalid replies");
        break;
      }
    } else {
      protocolFailures = 0;
    }
    log("info", "Evaluating results…", "Deciding the next step");
    transcript.push({
      role: "user",
      content: `Observation (step ${index}) [${action} ok=${ok}]:\n${step.observation}${
        modelTurns >= maxSteps - 1
          ? "\n\nThis is your last allowed model turn. You MUST call finish with a summary now."
          : ""
      }`,
    });

    if (steps.length >= AGENT_MAX_ACTIONS) break;
  }

  if (stoppedReason === "max_steps" && steps.length > 0) {
    currentStepTrace = null;
    if (!askMode && changedFiles.length > 0) {
      const verification = await verifyChanges();
      if (verification.ran && !verification.ok) {
        recordStep({
          index: steps.length + 1,
          action: "run_command",
          args: { command: verification.command ?? "", cwd: "." },
          observation: `Verification failed.\nCommand: ${verification.command}\n${verification.output.slice(0, 4_000)}`,
          ok: false,
          durationMs: 0,
        });
      }
    }
    log("model", "Final answer is being prepared…", "Evaluating collected evidence");
    const digest = steps
      .slice(-24)
      .map((step) => `[${step.index}] ${step.action} (${step.ok ? "ok" : "fail"})\n${step.observation.slice(0, 1400)}`)
      .join("\n\n")
      .slice(0, 24_000);
    try {
      const finalPrompt = await getPrompt(
        askMode || autoMode ? "agent.final" : "agent.final_coding",
        projectId,
      );
      const finalPromptContent = renderPrompt(finalPrompt.system, {
        language: aiLanguageInstruction(options.language ?? "en"),
      });
      log(
        "info",
        "Prompt selected",
        `${finalPrompt.id} v${finalPrompt.version}${finalPrompt.source !== "default" ? ` · ${finalPrompt.source}` : ""}`,
      );
      const finalCompletion = await chatTracked(
        projectId,
        config,
        [
          {
            role: "system",
            content: finalPromptContent,
          },
          {
            role: "user",
            content: `Task: ${instruction.trim()}\n\nTool observations:\n${digest}`,
          },
        ],
        { maxTokens: 2500, temperature: 0.1, timeoutMs: 90_000, signal },
        "agent-final",
      );
      if (finalCompletion.tokenUsage) {
        tokenTotal.inputTokens += finalCompletion.tokenUsage.inputTokens;
        tokenTotal.outputTokens += finalCompletion.tokenUsage.outputTokens;
        tokenTotal.totalTokens += finalCompletion.tokenUsage.totalTokens;
      }
      if (finalCompletion.text.trim()) {
        summary = finalCompletion.text.trim();
        stoppedReason = "finished";
      }
      const finalVerification = getLastVerification();
      if (finalVerification?.ran && finalVerification.ok && !/verification/i.test(summary)) {
        summary = `${summary}\n\n**Typecheck:** \`${finalVerification.command}\` passed.`.trim();
      }
      if (finalVerification?.ran && !finalVerification.ok) {
        summary = `${summary}\n\n**Typecheck failed:** \`${finalVerification.command}\`\n\`\`\`\n${finalVerification.output.slice(0, 3_000)}\n\`\`\``.trim();
      }
    } catch {
      // keep the step-limit summary
    }
  }

  if (stoppedReason === "aborted") {
    summary = summary || "Stopped by the user.";
  } else if (stoppedReason !== "finished" && stoppedReason !== "error") {
    stoppedReason = "max_steps";
    summary =
      "The agent reached the step limit before finishing. Review the steps and run a follow-up instruction to continue.";
  }
  if (stoppedReason === "error") {
    const worked =
      changedFiles.length > 0 || ranCommands.length > 0
        ? ` Work completed before the failure: ${changedFiles.length} file(s) changed, ${ranCommands.length} command(s) run.`
        : "";
    const lastSuccess = [...steps].reverse().find((step) => step.ok);
    const lastEvidence = lastSuccess
      ? ` Last successful tool: ${lastSuccess.action} — ${lastSuccess.observation.slice(0, 260)}`
      : "";
    summary = `${errorMessage ?? "The agent stopped because a request failed."}${worked}${lastEvidence}`;
  }

  if (isToolCallLeak(summary)) {
    const cleaned = stripToolCallMarkup(summary);
    summary =
      cleaned ||
      "The agent could not produce a clean final answer because the model returned provider tool-call markup. Check the tool steps and retry or switch models.";
  }

  if (stoppedReason === "finished" && summary.trim()) {
    await recordConversation(projectId, instruction, summary, config.id, config.model).catch(() => {
      // conversation indexing is best-effort
    });
  }

  const invalidProtocolSteps = steps.filter((step) => step.action === "invalid").length;
  await recordModelOutcome(config.id, config.model, {
    success: stoppedReason === "finished" && invalidProtocolSteps < 2,
    protocolFailure:
      invalidProtocolSteps >= 2 ||
      /invalid tool protocol|provider-native tool call omitted/i.test(summary || errorMessage || ""),
    emptyFailure: /empty response/i.test(summary || errorMessage || ""),
  }).catch(() => {
    // health tracking must never break an agent run
  });

  return {
    instruction: instruction.trim(),
    summary,
    steps,
    changedFiles: [...new Set(changedFiles)],
    ranCommands: [...new Set(ranCommands)],
    stoppedReason,
    error: errorMessage,
    provider: config.id,
    model: config.model,
    createdAt,
    plan: activePlan ?? plan,
    usage: {
      inputChars,
      estimatedTokens: Math.ceil(inputChars / 4),
      contextFiles: evidence.slice(0, 30),
    },
    tokenUsage: tokenTotal,
    logs,
  };
}
