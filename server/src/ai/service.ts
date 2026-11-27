import crypto from "node:crypto";
import { diffLines } from "diff";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AnalysisResult,
  ChangeReport,
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
  AiWorkspaceMode,
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
import { getDataDir, loadAnalysis, saveAnalysis } from "../store";
import { analyzeProject } from "../analyzer";
import { isWithin } from "../scanner";
import { formatProjectFile } from "../formatter";
import { pythonEnvironmentHint } from "./pythonHints";
import { withCommandLock } from "./commandLock";
import { detectProjectProfile } from "../projectProfile";
import { checkFileSyntax } from "../syntax";
import { lspCompletion, lspDiagnostics, lspHover } from "../lsp";
import { queryCsvFile, querySqliteFile } from "../dataQuery";
import { runBrowserCheck } from "../browserCheck";
import {
  isDevServerCommand,
  listBackgroundProcesses,
  startBackgroundProcess,
  stopBackgroundProcess,
  waitForBackgroundUrl,
} from "../processes";
import {
  normalizeBrowserSteps,
  type BrowserCheckStep,
} from "../../../shared/browserCheck";
import {
  createProjectTool,
  findProjectTool,
  listProjectTools,
  recordProjectToolRun,
  validateProjectToolInput,
} from "../projectTools";
import {
  listResearchNotes,
  readResearchNote,
  saveResearchNote,
  httpRequest,
  searchResearchNotes,
  webFetch,
} from "../webResearch";
import { compressVideo } from "../mediaTools";
import {
  convertDocument,
  documentStats,
  readDocument,
  searchDocument,
  transformImage,
} from "../documentTools";
import {
  gitCommit,
  gitCreateBranch,
  gitInfo,
  gitPush,
  gitSetRemote,
} from "../gitAgent";
import {
  bootMobileDevice,
  captureMobileScreenshot,
  installMobileApp,
  launchMobileApp,
  listMobileDevices,
  openMobileUrl,
  readMobileLogs,
  runMobileCheck,
} from "../mobileDevices";
import { createPlaceholderAsset } from "../placeholderAssets";
import { checkToolchains, installToolchain } from "../toolchains";
import { runGameCheck } from "../gameCheck";
import { createGraphic } from "../graphics";
import { checkGraphic } from "../graphicCheck";
import {
  deleteProjectPath,
  readSourceFile,
  renameProjectPath,
  restoreLatestEditorBackup,
  runProjectCommand,
  writeSourceFile,
} from "../editor";
import { chat, type ChatMessage } from "./providers";
import { chatComplete } from "./complete";
import { resolveProvider } from "./settings";
import { recordUsage } from "./usage";
import { recordModelOutcome } from "./modelStats";
import { estimateUsageCost } from "./pricing";
import { readLatestProjectPlan, savePlan } from "../plans";
import type {
  AgentToolGroup,
  IntentAnalysis,
  IntentHistory,
} from "../../../shared/intent";
import { AGENT_TOOL_GROUPS } from "../../../shared/intent";
import { pickAlternateAgentModel } from "./agents";
import { getPrompt, renderPrompt } from "./prompts";
import { listSkills, loadSkillForRun, loadSkillsForPrompt, renderSkillsForPrompt, runSkillScript, setSkillEnabled } from "../skills";
import {
  renderAgentToolCatalog,
  suggestToolsForInstruction,
  toolGroupsFor,
  validateToolArgs,
  type ProjectToolHint,
} from "./toolRegistry";
import { runRegisteredTool } from "./tools/registry";
import type { AgentToolContext } from "./tools/types";
import { appendLesson } from "../tasks";
import { addProjectConstraints, compactProjectBrainBrief, ensureProjectBrain } from "../projectBrain";
import { buildChangeReport } from "../changes";
import { auditClaims } from "./claims";
import { auditContentInventory, renderContentInventory } from "../contentInventory";
import { createArchive, createDocument, type DocumentFormat } from "../documentWriter";
import {
  actionPlanInstruction,
  isSiteInspection,
  resolveActionPlan,
  type ActionPlan,
} from "./actions";
import type { ExtractionTable } from "../../../shared/extraction";
import {
  applyMappingsToContent,
  extractEntities,
  invalidateExtractionCache,
  resolveWorkBrief,
  type EntityKind,
  type EntityResult,
} from "../extractors";
import {
  createSkill,
  installSkills,
  previewSkillSource,
  removeInstalledSkill,
} from "../skillInstall";
import { requestPermission } from "./permissions";
import {
  recordConversation,
  removeIndexedPath,
  startProjectIndexBuild,
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
): Promise<{ text: string; tokenUsage?: AiTokenUsage; finishReason?: string }> {
  let tokenUsage: AiTokenUsage | undefined;
  let finishReason: string | undefined;
  const text = await chat(config, messages, {
    ...options,
    onUsage: (usage) => {
      tokenUsage = usage;
    },
    onFinishReason: (reason) => {
      finishReason = reason;
      options?.onFinishReason?.(reason);
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
  return { text, tokenUsage, finishReason };
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

const MAX_AI_CACHE_ENTRIES = 120;
const MAX_AI_CACHE_CHARS = 2_000_000;

async function writeCache(projectId: string, cache: AiCache): Promise<void> {
  const sorted = Object.entries(cache.entries)
    .sort((a, b) => (a[1].createdAt < b[1].createdAt ? 1 : -1))
    .slice(0, MAX_AI_CACHE_ENTRIES);
  const entries: [string, CacheEntry<unknown>][] = [];
  let chars = 0;
  for (const entry of sorted) {
    let size = 0;
    try {
      size = JSON.stringify(entry[1]).length;
    } catch {
      continue;
    }
    if (size > MAX_AI_CACHE_CHARS / 4) continue;
    if (chars + size > MAX_AI_CACHE_CHARS) break;
    entries.push(entry);
    chars += size;
  }
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

function mappedPreview(before: string, after: string): string {
  const changes = diffLines(before, after).filter((part) => part.added || part.removed);
  return changes
    .slice(0, 8)
    .map((part) =>
      `${part.added ? "+" : "-"} ${part.value
        .split("\n")
        .filter(Boolean)
        .slice(0, 3)
        .join(" / ")
        .slice(0, 220)}`,
    )
    .join("\n");
}

/** A compact reviewable diff for the permission dialog (not a patch file). */
export function permissionDiffPreview(before: string | null, after: string): string {
  if ((before ?? "") === after) return "No changes.";
  if (before === null) {
    const lines = after.split("\n").slice(0, 80);
    return ["+ (new file)", ...lines.map((line) => `+${line}`)].join("\n");
  }
  const lines: string[] = [];
  const push = (line: string) => {
    if (lines.length < 100) lines.push(line);
  };
  for (const part of diffLines(before, after)) {
    const prefix = part.added ? "+" : part.removed ? "-" : " ";
    const value = part.value.endsWith("\n") ? part.value.slice(0, -1) : part.value;
    const chunk = value.split("\n");
    if (!part.added && !part.removed && chunk.length > 8) {
      push(` ${chunk[0]}`);
      push(` ${chunk[1]}`);
      push(`… ${chunk.length - 4} unchanged lines …`);
      push(` ${chunk[chunk.length - 2]}`);
      push(` ${chunk[chunk.length - 1]}`);
    } else {
      for (const line of chunk.slice(0, 80)) push(`${prefix}${line}`);
    }
    if (lines.length >= 100) {
      push("… diff truncated …");
      break;
    }
  }
  return lines.join("\n");
}

function extractionTableOf(result: EntityResult): ExtractionTable {
  return {
    kind: result.kind,
    headers: result.headers,
    items: result.items,
    total: result.total,
    unique: result.unique,
    truncated: result.truncated,
  };
}

function evidenceOf(analysis: AnalysisResult, filePath: string, startLine?: number, endLine?: number, label?: string): AiContextFile {
  return { path: filePath, startLine, endLine, label };
}

function escapeControlCharactersInStrings(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (const character of text) {
    if (inString) {
      if (escaped) {
        result += character;
        escaped = false;
        continue;
      }
      if (character === "\\") {
        result += character;
        escaped = true;
        continue;
      }
      if (character === '"') {
        result += character;
        inString = false;
        continue;
      }
      if (character === "\n") {
        result += "\\n";
        continue;
      }
      if (character === "\r") {
        result += "\\r";
        continue;
      }
      if (character === "\t") {
        result += "\\t";
        continue;
      }
      result += character;
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }
    result += character;
  }
  return result;
}

function jsonCandidates(text: string): string[] {
  const clean = text
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[“”]/g, '"')
    .trim();
  const candidates: string[] = [];
  for (let start = clean.indexOf("{"); start >= 0; start = clean.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < clean.length; index += 1) {
      const character = clean[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          candidates.push(clean.slice(start, index + 1));
          break;
        }
      }
    }
  }
  return candidates;
}

function parseJsonObject(text: string): Record<string, unknown> {
  const candidates = jsonCandidates(text);
  if (candidates.length === 0) {
    throw new Error("The model did not return a JSON object.");
  }
  for (const candidate of candidates) {
    for (const variant of [
      candidate,
      candidate.replace(/,\s*([}\]])/g, "$1"),
      escapeControlCharactersInStrings(candidate).replace(/,\s*([}\]])/g, "$1"),
    ]) {
      try {
        return JSON.parse(variant) as Record<string, unknown>;
      } catch {
        // Try the next repair/candidate.
      }
    }
  }
  throw new Error("The model returned invalid JSON. Try again or switch models.");
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

function compactProjectBrief(analysis: AnalysisResult): string {
  const stylesheets = analysis.files
    .filter((file) => /\.(?:css|scss|sass|less)$/i.test(file.path))
    .slice(0, 8)
    .map((file) => file.path);
  return [
    `Project: ${analysis.projectName} · ${(analysis.frameworks ?? []).join(", ") || "no framework"}`,
    `Languages: ${Object.entries(analysis.languages)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([language, count]) => `${language}(${count})`)
      .join(", ") || "unknown"}`,
    `Files: ${analysis.stats.files} · symbols: ${analysis.stats.symbols}`,
    `Test: ${analysis.tooling?.testCommands.join(" | ") || "none"} · typecheck: ${
      analysis.tooling?.typecheckCommands?.join(" | ") || "none"
    } · build: ${analysis.tooling?.buildCommands.join(" | ") || "none"}`,
    stylesheets.length > 0 ? `Stylesheets: ${stylesheets.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
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

async function chatCompleteTracked(
  projectId: string,
  config: Awaited<ReturnType<typeof resolveProvider>>,
  messages: ChatMessage[],
  options: Parameters<typeof chat>[2],
  kind: string,
): Promise<{ text: string; tokenUsage: AiTokenUsage; truncated: boolean }> {
  const result = await chatComplete(config, messages, options);
  await recordUsage({
    projectId,
    provider: config.id,
    model: config.model,
    kind,
    inputTokens: result.tokenUsage.inputTokens,
    outputTokens: result.tokenUsage.outputTokens,
    totalTokens: result.tokenUsage.totalTokens,
  });
  return result;
}

export async function askProject(
  projectId: string,
  question: string,
  options: {
    provider?: Parameters<typeof resolveProvider>[0];
    model?: string;
    history?: ChatMessage[];
    language?: string;
    intent?: IntentAnalysis;
    workState?: string;
  } = {},
): Promise<AiChatResult> {
  const analysis = await loadAnalysis(projectId);
  const config = await resolveProvider(options.provider, options.model);
  const tokens = keywords(`${options.intent?.normalizedRequest ?? ""} ${question}`);
  if (options.intent?.constraints?.length) {
    await addProjectConstraints(analysis, options.intent.constraints, "chat", question).catch(() => null);
  }
  const brain = await ensureProjectBrain(analysis).catch(() => null);
  const nodeLimit = brain ? 8 : 14;

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
    .slice(0, nodeLimit);

  if (scored.length === 0) {
    scored = analysis.nodes
      .filter((node) => node.kind === "function" || node.kind === "method" || node.kind === "route")
      .sort(
        (a, b) =>
          (b.metadata?.callerCount ?? 0) +
          (b.metadata?.callCount ?? 0) -
          ((a.metadata?.callerCount ?? 0) + (a.metadata?.callCount ?? 0)),
      )
      .slice(0, brain ? 8 : 10)
      .map((node) => ({ node, score: 0 }));
  }

  const brainBrief = brain ? compactProjectBrainBrief(brain) : "";
  const contextParts: string[] = [
    brainBrief || projectBrief(analysis),
    options.workState ?? "",
    options.intent?.normalizedRequest ? `Interpreted request: ${options.intent.normalizedRequest}` : "",
    options.intent?.behaviors?.length
      ? `Requested behaviors: ${options.intent.behaviors
          .map((behavior) => `${behavior.action} ${behavior.target}`)
          .join("; ")}`
      : "",
    "",
  ];
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
  let budget = brain ? 10_000 : MAX_CONTEXT_CHARS;

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
      const source = await readLines(analysis, symbol.filePath, symbol.startLine, symbol.endLine, Math.min(brain ? 3_000 : 4_500, budget));
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
  const chatSkills = await loadSkillsForPrompt(analysis.rootPath, projectId, question).catch(() => ({
    skills: [],
    mentions: [],
    index: "",
  }));
  const skillsPrompt = renderSkillsForPrompt(chatSkills.skills);
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

  const completion = await chatCompleteTracked(projectId, config, messages, { maxTokens: 1800, temperature: 0.15 }, "chat");
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

/**
 * Lightweight path for greetings, thanks and general knowledge. It deliberately
 * sends no tool catalog, project brief or file list, so "hi" does not become a
 * coding task.
 */
export async function answerGeneralChat(
  projectId: string,
  instruction: string,
  options: {
    provider?: Parameters<typeof resolveProvider>[0];
    model?: string;
    language?: string;
    history?: { role: "user" | "assistant"; content: string }[];
    intent?: IntentAnalysis;
    workState?: string;
    promptId?: string;
    skillSlugs?: string[];
    onToken?: (chunk: string) => void;
  } = {},
): Promise<AiAgentResult> {
  const config = await resolveProvider(options.provider, options.model);
  const language = options.language ?? "en";
  const inlineSystem = [
    "You are B.A.D IDE's embedded assistant: a research and code-understanding assistant inside a local IDE.",
    "You have project-scoped persistent memory in this workspace: project brain, task history and saved scenarios. You do not have global personal memory or memory across projects; say that precisely instead of claiming no memory at all.",
    "Use the supplied project context when it is present. Do not claim you need to inspect the project if the context already answers the question; if it is insufficient, name the exact file, symbol or range that is missing.",
    "Chat is read-only. Code Studio performs file edits and commands. If the user asks for a code change, say it belongs in Code Studio and offer a narrower task; do not claim the chat edited files.",
    "Do not claim web browsing, tools or live data unless a tool actually ran in this request.",
  ].join("\n");
  const promptSystem = options.promptId
    ? renderPrompt((await getPrompt(options.promptId, projectId)).system, {
        language: aiLanguageInstruction(language),
      })
    : `${inlineSystem}\n${aiLanguageInstruction(language)}`;
  let skillText = "";
  if (options.skillSlugs && options.skillSlugs.length > 0) {
    const analysis = await loadAnalysis(projectId).catch(() => null);
    if (analysis) {
      const skillLoad = await loadSkillsForPrompt(analysis.rootPath, projectId, instruction, {
        requested: options.skillSlugs,
      }).catch(() => null);
      if (skillLoad) {
        skillText = renderSkillsForPrompt(skillLoad.skills).slice(0, 5_000);
      }
    }
  }
  const systemContent = [
    promptSystem,
    "Chat mode: never output tool calls, JSON actions, XML, DSML or function calls. Answer in Markdown from the supplied context; if it is insufficient, say exactly which file, symbol or range is missing.",
    "Return only the final user-facing answer. Do not include your chain of thought, planning notes, or phrases like 'The user asks', 'I have', 'I must' or 'Let me'. If you need to reason, do it silently.",
    options.intent?.normalizedRequest
      ? `Interpreted request (canonical): ${options.intent.normalizedRequest}`
      : "",
    options.intent?.behaviors?.length
      ? `Requested behaviors: ${options.intent.behaviors
          .map((behavior) => `${behavior.action} ${behavior.target}${behavior.details ? ` (${behavior.details})` : ""}`)
          .join("; ")}`
      : "",
    options.intent?.constraints?.length
      ? `Constraints: ${options.intent.constraints.join("; ")}`
      : "",
    skillText ? `Relevant skill guidance:\n${skillText}` : "",
    options.workState ?? "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const messages: ChatMessage[] = [
    { role: "system", content: systemContent },
    ...selectHistory(options.history, "recent"),
    { role: "user", content: instruction.trim() },
  ];
  const streamFirst = options.promptId === "chat.answer" ? undefined : options.onToken;
  const stripReasoningTail = (value: string): string => {
    const markers = [
      /\n\s*(?:The user wants me|I need to continue|I'll continue|I should continue|Actually,? careful|I must say|Let me continue|We need to continue)\b/i,
    ];
    let cut = value.length;
    for (const marker of markers) {
      const index = value.search(marker);
      if (index > 0) cut = Math.min(cut, index);
    }
    return value.slice(0, cut).trim();
  };
  const maxTokens = options.promptId === "chat.answer" ? 2_200 : 900;
  let completion = await chatCompleteTracked(
    projectId,
    config,
    messages,
    { maxTokens, temperature: 0.4, onToken: streamFirst },
    "chat",
  );
  const looksLikeToolCall = (value: string): boolean => {
    const text = value.trim();
    if (!text) return false;
    return (
      /^\s*\{[\s\S]{0,400}"(?:action|tool|args|name)"\s*:/i.test(text) ||
      /<tool_call>|<\/?function|DSML/i.test(text)
    );
  };
  const looksLikeReasoning = (value: string): boolean => {
    const head = value.trim().slice(0, 280);
    return (
      /^(?:the user|i (?:have|need|must|should|will|can't|cannot|am going)|let me|we (?:need|should)|first,? i|looking at|i'm going to)\b/i.test(
        head,
      ) ||
      /^(?:kullanıcı|önce|şimdi|elimde|ben)\b/i.test(head) &&
        /\b(?:yapmalıyım|söylemeliyim|bakmalıyım|i need|i must|i should)\b/i.test(head)
    );
  };
  let answerText = stripReasoningTail(completion.text.trim());
  if (looksLikeToolCall(answerText) || looksLikeReasoning(answerText)) {
    const retry = await chatCompleteTracked(
      projectId,
      config,
      [
        {
          role: "system",
          content: `${systemContent}\n\nIMPORTANT: Your previous reply was internal reasoning or a tool call, not a user-facing answer. Chat cannot run tools. Return ONLY the final Markdown answer. Do not restate the request or say 'The user asks', 'I have', 'I must' or 'Let me'. If the supplied context is insufficient, name the missing file, symbol or range.`,
        },
        ...selectHistory(options.history, "recent"),
        { role: "user", content: instruction.trim() },
      ],
      { maxTokens: 1_200, temperature: 0.2 },
      "chat",
    );
    completion = {
      ...retry,
      tokenUsage: {
        inputTokens: completion.tokenUsage.inputTokens + retry.tokenUsage.inputTokens,
        outputTokens: completion.tokenUsage.outputTokens + retry.tokenUsage.outputTokens,
        totalTokens: completion.tokenUsage.totalTokens + retry.tokenUsage.totalTokens,
      },
    };
    answerText = stripReasoningTail(retry.text.trim());
    if (looksLikeToolCall(answerText) || looksLikeReasoning(answerText)) {
      answerText = /^tr/i.test(language)
        ? "Bu soruyu yanıtlamak için sağlanan bağlam yetersiz. Lütfen dosya/sembol belirt; Code Studio ile inceleyebiliriz."
        : "The supplied context is insufficient for this question. Name the file or symbol, or ask Code Studio to inspect it.";
    }
  }
  const costUsd = await estimateUsageCost(config.id, config.model, completion.tokenUsage).catch(
    () => undefined,
  );
  const inputChars = messages.reduce((total, message) => total + message.content.length, 0);
  return {
    instruction,
    summary: answerText,
    steps: [],
    changedFiles: [],
    ranCommands: [],
    stoppedReason: "finished",
    provider: config.id,
    model: config.model,
    createdAt: new Date().toISOString(),
    usage: {
      inputChars,
      estimatedTokens: Math.ceil(inputChars / 4),
      contextFiles: [],
    },
    tokenUsage: completion.tokenUsage,
    costUsd,
  };
}

/* ------------------------------------------------------------------ */
/* Agent mode: read, search, write and run commands in a controlled loop */
/* ------------------------------------------------------------------ */

const AGENT_MAX_VERIFY_ATTEMPTS = 3;
const ACTION_INTENT =
  /\b(ekle|ekley|eklen|ekleme|oluştur|olustur|düzelt|duzelt|güncelle|guncelle|değiştir|degistir|taşı|tasi|sil|yap|yapal|ayarla|renklendir|boya|çevir|cevir|create|add|implement|fix|update|change|refactor|move|delete|build)\w*/i;
const QUESTION_INTENT =
  /\b(nasıl|neden|niçin|nedir|ne|mi|mı|mu|mü|how|why|what|where|which|explain|açıkla|anlat)\b/i;

/**
 * Boilerplate safety lines ("do not ask which project", "never do later
 * tasks") must not decide the action plan. Drop only negated sentences so a
 * positive edit sentence in the same paragraph still classifies correctly.
 */
function withoutNegativeInstructions(text: string): string {
  const kept = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0 && !/\b(do not|don't|never)\b/i.test(sentence));
  return kept.length > 0 ? kept.join(" ") : text.trim();
}

const READ_ONLY_ACTIONS = new Set([
  "list_files",
  "search_code",
  "read_file",
  "read_symbol",
  "find_in_file",
  "diagnostics",
  "lsp_hover",
  "lsp_completion",
  "list_items",
  "count_matches",
  "list_colors",
  "extract_entities",
  "audit_content",
  "json_query",
  "find_symbols",
  "sqlite_query",
  "csv_query",
  "git_blame",
  "list_project_tools",
  "browser_check",
  "game_check",
  "graphic_check",
  "web_fetch",
  "read_document",
  "search_document",
  "search_conversations",
  "list_notes",
  "read_note",
  "search_notes",
  "git_info",
  "list_skills",
  "search_skills",
  "load_skill",
  "preview_skill_source",
  "list_mobile_devices",
]);
const AGENT_MAX_WRITES = 60;
// Runaway guard, not a step budget: a write task that has spent this many
// tokens without changing a file is stuck, and a read-only task that has spent
// this much without finishing is not making useful progress.
const NO_PROGRESS_TOKEN_LIMIT = 300_000;
const READ_ONLY_TOKEN_LIMIT = 500_000;
const WORKING_TOKEN_LIMIT = 900_000;
const AGENT_MAX_COMMANDS = 8;
const AGENT_READ_CHARS = 18_000;
const NARROW_EDIT_MAX_READ_LINES = 160;
// A 500-800 line source file is small enough to read once. Chunking it into
// 160-line slices makes the model reconstruct it across turns and burn budget.
const FULL_READ_MAX_LINES = 800;
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
  // Killing or daemonizing a dev server makes the preview stale and makes the
  // agent verify a different process than the app manages.
  /\b(?:p?kill|killall)\b/,
  /\bnohup\b/,
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
    | {
        typecheckCommands?: string[];
        buildCommands?: string[];
        testCommands?: string[];
        lintCommands?: string[];
      }
    | undefined,
): string | undefined {
  return preferredVerificationCommands(tooling)[0];
}

export function preferredVerificationCommands(
  tooling:
    | {
        typecheckCommands?: string[];
        buildCommands?: string[];
        testCommands?: string[];
        lintCommands?: string[];
      }
    | undefined,
): string[] {
  const commands = [
    ...(tooling?.typecheckCommands ?? []),
    ...(tooling?.testCommands ?? []),
    ...(tooling?.lintCommands ?? []),
  ]
    .map((command) => command.trim())
    .filter(Boolean);
  const unique = [...new Set(commands)];
  const fallback = (tooling?.buildCommands ?? []).map((command) => command.trim()).filter(Boolean);
  return (unique.length > 0 ? unique : fallback).slice(0, 3);
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function nearestGoModule(root: string, file: string): Promise<string | null> {
  let directory = path.dirname(path.resolve(root, file));
  const resolvedRoot = path.resolve(root);
  while (directory.startsWith(resolvedRoot)) {
    if (await fs.access(path.join(directory, "go.mod")).then(() => true).catch(() => false)) {
      return path.relative(resolvedRoot, directory) || ".";
    }
    if (directory === resolvedRoot) break;
    directory = path.dirname(directory);
  }
  return null;
}

export async function verificationCommandsForChanges(
  rootPath: string,
  changedFiles: readonly string[],
  baseCommands: readonly string[],
): Promise<string[]> {
  const commands = [...baseCommands];
  const goFiles = changedFiles.filter((file) => /\.go$/i.test(file));
  if (goFiles.length === 0) return commands;
  const hasRootModule = await fs
    .access(path.join(rootPath, "go.mod"))
    .then(() => true)
    .catch(() => false);
  if (hasRootModule) return commands;
  const modules = new Set<string>();
  for (const file of goFiles) {
    // eslint-disable-next-line no-await-in-loop
    const module = await nearestGoModule(rootPath, file);
    if (module) modules.add(module);
  }
  if (modules.size === 0) return commands;
  const alreadyRunsGoTests = commands.some((command) => /\bgo test\b/.test(command));
  if (alreadyRunsGoTests) return commands;
  for (const module of [...modules].slice(0, 3)) {
    commands.push(
      module === "."
        ? "go test ./..."
        : `(cd ${shellSingleQuote(module)} && go test ./...)`,
    );
  }
  return commands;
}

export function reportsIncompleteWiring(summary: string, removalContext = false): boolean {
  const noMissing =
    /(?:eksik|missing|hatalı|kırık|broken)[^\n.]{0,80}(?:yok|değil|bulunmuyor|none\b|no\b)/i.test(
      summary,
    );
  if (
    removalContext &&
    /(?:kaldırıldı|silindi|removed|deleted|absent|null|yok)/i.test(summary)
  ) {
    return false;
  }
  // A removal task often says "no new form/input/markup is needed" or "the
  // removed list leaves no control to add". That is a complete removal, not
  // missing wiring.
  const notNeeded =
    /(?:html|markup|template|form|input|kontrol|alan)[^\n]{0,140}(?:gerekmiyor|gerek yok|eklenmesi gerekmiyor|not needed|no new\b|nothing to add)/i.test(
      summary,
    );
  const positive =
    /(?:html|markup|template|form)[^\n]{0,100}(?:yok|tanımlı değil|yer almıyor|missing|not present|does not exist)|(?:eklenmesi|eklenmeli)[^\n]{0,100}gerekiyor|kabul kriteri[^\n]{0,100}tam karşılan|bu adım[^\n]{0,80}yer almıyor/i.test(
      summary,
    );
  return positive && !noMissing && !notNeeded;
}

export function looksLikePlanningText(summary: string): boolean {
  const text = summary.trim();
  if (!text) return false;
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const delivered =
    lines.length >= 4 &&
    /(?:^|\n)\s*(?:[-*]|\d+\.|\|)/.test(text);
  if (delivered) return false;
  return /(?:need to|have to|i need to)\s+(?:read|check|inspect|search|open|scan|verify)|i(?:'ll| will)\s+(?:read|check|inspect|search|open|scan|start|look)|let me\s+(?:read|check|inspect|search|open|scan|start|look)|let's\s+(?:read|check|inspect|search|open|scan|start|look)|start (?:by|with)\s+(?:reading|checking|inspecting|searching)|first,?\s+(?:read|check|inspect|search)|read (?:the )?file (?:fully|completely|in chunks)|check (?:the )?file size|dosyayı\s+(?:tamamen|baştan|tümüyle)?\s*oku|önce\s+.{0,40}(?:oku|kontrol et|incele)|okuyayım|kontrol edeyim|inceleyeyim|başlayalım/i.test(
    text,
  );
}

export function reportsRemainingWork(summary: string): boolean {
  const remaining =
    /\b(not (?:done|implemented|completed|verified)|remaining work|remains? (?:undone|to be done))\b|(?:[iİ]ş|görev|kısım|adım|özellik|madde)\s+(?:yapılmadı|tamamlanmadı)|eksik kaldı|\bkalan\s*[:(]|\bnext step\b|sonraki adım|doğrulanmadı|doğrulanamadı|kanıtlanamadı|kanıtlanmadı|test edilmedi|çalıştırılmadı|calistirilmadi|kabul edilmedi|tamamlanamadı/i.test(
      summary,
    );
  const none =
    /\bkalan\s*(?:yok|değil)\b|nothing (?:remaining|left)|no remaining work/i.test(summary);
  const noSourceChange =
    /(?:proje dosyalarında|kaynak dosyalarda|source files?|code files?).{0,50}(?:değişiklik yapılmadı|değiştirilmedi|unchanged|not changed)/i.test(
      summary,
    );
  return remaining && !none && !noSourceChange;
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

function pathFromArgs(args: Record<string, unknown>): unknown {
  return (
    args.path ??
    args.file ??
    args.filePath ??
    args.file_path ??
    args.target ??
    args.filename ??
    fallbackPathFromArgs(args)
  );
}

function firstStringArg(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string") return value;
  }
  return "";
}

function findFromArgs(args: Record<string, unknown>): string {
  return firstStringArg(args, ["find", "search", "old", "oldText", "old_string", "oldString", "target", "from"]);
}

function replaceFromArgs(args: Record<string, unknown>): string {
  return firstStringArg(args, ["replace", "replacement", "new", "newText", "new_string", "newString", "to", "with"]);
}

function contentFromArgs(args: Record<string, unknown>): string {
  for (const key of ["content", "text", "code", "body", "value", "source"]) {
    const value = args[key];
    if (typeof value === "string") return value;
  }
  return "";
}

function looksLikePathValue(value: string): boolean {
  const text = value.trim();
  if (!text || text.length > 240 || text.includes("\n")) return false;
  return /^(?:\.\/)?[\w@./ -]+\.[A-Za-z0-9]{1,12}$/.test(text) || /^[\w@./-]+\/[\w@./-]+$/.test(text);
}

function fallbackPathFromArgs(args: Record<string, unknown>): string {
  for (const value of Object.values(args)) {
    if (typeof value === "string" && looksLikePathValue(value)) return value;
  }
  return "";
}

const TOOL_ARG_TEMPLATES: Record<string, string> = {
  write_file: '{"action":"write_file","args":{"path":"relative/file.ext","content":"..."}}',
  append_text: '{"action":"append_text","args":{"path":"relative/file.ext","content":"..."}}',
  replace_in_file:
    '{"action":"replace_in_file","args":{"path":"relative/file.ext","find":"exact text","replace":"new text"}}',
  replace_many:
    '{"action":"replace_many","args":{"path":"relative/file.ext","edits":[{"find":"...","replace":"..."}]}}',
  read_file: '{"action":"read_file","args":{"path":"relative/file.ext"}}',
  find_in_file: '{"action":"find_in_file","args":{"path":"relative/file.ext","query":"text"}}',
  delete_file: '{"action":"delete_file","args":{"path":"relative/file.ext"}}',
  rename_path: '{"action":"rename_path","args":{"path":"old/path","to":"new/path"}}',
  browser_check:
    '{"action":"browser_check","args":{"path":"index.html","steps":[{"action":"click","selector":"#play"},{"action":"pressKeys","keys":["3","0","*","1","Enter"]},{"action":"expectText","selector":"#score","text":"1"}]}}',
  game_check:
    '{"action":"game_check","args":{"path":"index.html","steps":[{"action":"expectVisible","selector":"canvas"},{"action":"eval","value":"window.score ?? 0"}]}}',
};

export const VERIFICATION_ACTIONS = new Set([
  "browser_check",
  "run_test_scenario",
  "game_check",
  "graphic_check",
  "mobile_check",
  "diagnostics",
]);

export function isSyntheticCheckPath(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized.startsWith(".cie/") || normalized.includes("/.cie/") || normalized.startsWith("tmp/");
}

const CHECK_ASSERTION_ACTIONS = new Set([
  "expectText",
  "expectValue",
  "expectCount",
  "expectStable",
]);

export function countCheckAssertions(steps: { action: string }[] | undefined): number {
  return (steps ?? []).filter((step) => CHECK_ASSERTION_ACTIONS.has(step.action)).length;
}

function toolArgHint(action: string): string {
  const template = TOOL_ARG_TEMPLATES[action];
  return template
    ? ` Correct call shape: ${template} (the file path key is "path"; "file", "filePath", "filename" and "target" are also accepted).`
    : "";
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

export function stripCommentaryTags(text: string): string {
  return text
    .replace(/<commentary\b[^>]*>[\s\S]*?<\/commentary\s*>/gi, " ")
    .replace(/<analysis\b[^>]*>[\s\S]*?<\/analysis\s*>/gi, " ")
    .replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking\s*>/gi, " ")
    .replace(/<\/?commentary\b[^>]*>/gi, " ")
    .replace(/<\/?analysis\b[^>]*>/gi, " ")
    .replace(/<\/?thinking\b[^>]*>/gi, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

async function auditNoChangeAcceptance(
  projectId: string,
  config: Awaited<ReturnType<typeof resolveProvider>>,
  instruction: string,
  summary: string,
  steps: AiAgentStep[],
): Promise<{ ok: boolean; missing: string[] } | null> {
  const evidence = steps
    .slice(-24)
    .map(
      (step) =>
        `#${step.index} ${step.action} ${step.ok ? "ok" : "fail"}${step.args ? ` args=${JSON.stringify(step.args).slice(0, 500)}` : ""}\n${(step.observation ?? "").slice(0, 700)}`,
    )
    .join("\n\n");
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are a strict acceptance reviewer for a coding agent. Return only JSON: {\"ok\":boolean,\"missing\":string[]}. A no-change claim is valid only when the evidence explicitly proves every acceptance clause. Input gating does not prove a visual highlight. A merged/single bar requires proof that duplicate target/score displays were actually removed. Cite concrete file:line or runtime evidence, not intent. Judge only the explicit acceptance clauses; do not add new requirements such as git status, console-error checks or hidden-view visibility unless the acceptance asks for them. If the run changed no files, the step list itself is the evidence; do not require a git status/diff. A browser_check eval that sets up the object, repeats collection, reads the resolved cell with isWall/reachability and asserts the result is valid evidence.",
    },
    {
      role: "user",
      content: [
        "Task and acceptance:",
        instruction.slice(0, 6_000),
        "",
        "Agent summary:",
        summary.slice(0, 4_000),
        "",
        "Tool evidence:",
        evidence || "(none)",
        "",
        "If any acceptance clause is unproven, return ok=false and list the missing clauses. Be strict but do not ask for unrelated refactors.",
      ].join("\n"),
    },
  ];
  try {
    const completion = await chat(config, messages, {
      maxTokens: 700,
      temperature: 0,
      timeoutMs: 60_000,
    });
    const match = completion.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as { ok?: unknown; missing?: unknown };
    if (typeof parsed.ok !== "boolean") return null;
    const missing = Array.isArray(parsed.missing)
      ? parsed.missing.filter((item): item is string => typeof item === "string").slice(0, 8)
      : [];
    return { ok: parsed.ok, missing };
  } catch {
    return null;
  }
}

async function suggestToolRepair(
  config: Awaited<ReturnType<typeof resolveProvider>>,
  action: string,
  args: Record<string, unknown>,
  error: string,
): Promise<string | null> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You repair one failed coding-agent tool call. Return only a JSON object with action and args. Do not explain, do not add markdown.",
    },
    {
      role: "user",
      content: [
        `Failed action: ${action}`,
        `Failed args: ${JSON.stringify(args).slice(0, 2_000)}`,
        `Error: ${error.slice(0, 1_200)}`,
        "Return the corrected call. Use the canonical keys: path, find, replace, content, query, selector, value, keys.",
      ].join("\n"),
    },
  ];
  try {
    const completion = await chat(config, messages, {
      maxTokens: 500,
      temperature: 0,
      timeoutMs: 30_000,
    });
    const match = completion.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as { action?: unknown; args?: unknown };
    if (typeof parsed.action !== "string" || !parsed.action.trim()) return null;
    const repairedArgs =
      parsed.args && typeof parsed.args === "object" && !Array.isArray(parsed.args)
        ? parsed.args
        : {};
    return JSON.stringify({ action: parsed.action.trim(), args: repairedArgs });
  } catch {
    return null;
  }
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
    const multipleActions = parseMultipleJsonActions(text);
    if (multipleActions.length > 1) {
      return {
        action: multipleActions[0].action,
        args: multipleActions[0].args,
        __actionCount: multipleActions.length,
        __actions: multipleActions,
      };
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

export function impactContext(
  analysis: AnalysisResult,
  symbolIds: Set<string>,
  limit = 16,
): string[] {
  if (symbolIds.size === 0) return [];
  const nodes = new Map(analysis.nodes.map((node) => [node.id, node]));
  const describe = (id: string): string => {
    const node = nodes.get(id);
    if (!node) return id;
    const label = node.metadata?.qualifiedName ?? node.label ?? id;
    const location = node.filePath
      ? `${node.filePath}${node.startLine ? `:${node.startLine}` : ""}`
      : "";
    return location ? `${label} (${location})` : label;
  };
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const edge of analysis.edges) {
    if (edge.kind !== "CALLS") continue;
    if (symbolIds.has(edge.target)) {
      const line = `caller ${describe(edge.source)} → ${describe(edge.target)}`;
      if (!seen.has(line)) {
        seen.add(line);
        lines.push(line);
      }
    }
    if (symbolIds.has(edge.source)) {
      const line = `${describe(edge.source)} → callee ${describe(edge.target)}`;
      if (!seen.has(line)) {
        seen.add(line);
        lines.push(line);
      }
    }
    if (lines.length >= limit) break;
  }
  return lines;
}

export async function agentSeedContext(
  analysis: AnalysisResult,
  instruction: string,
  activeFile?: string,
  suppliedProjectTools?: { tools: ProjectToolHint[] } | null,
): Promise<string> {
  const tokens = [...new Set(instruction.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [])];
  const attachmentPaths = [...instruction.matchAll(/(?:Ek dosya|Attached file|Ekli dosya):\s*([^\s]+)/gi)]
    .map((match) => match[1])
    .slice(0, 3);
  const attachmentContext: string[] = [];
  for (const attachmentPath of attachmentPaths) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const document = await readDocument(analysis.rootPath, attachmentPath, {
        maxChars: 80_000,
        ocr: false,
      });
      const stats = document.stats ?? documentStats(document.text);
      attachmentContext.push(
        [
          `Attached document: ${document.path} · ${document.kind} · ${document.bytes} bytes`,
          `Structure: ${stats.lines} lines · ${stats.words} words · ${stats.headings} headings · ${stats.links} links · ${stats.checkedBoxes} checked / ${stats.uncheckedBoxes} unchecked checkboxes`,
          document.text.slice(0, 2_000),
        ].join("\n"),
      );
    } catch {
      attachmentContext.push(`Attached document could not be read: ${attachmentPath}`);
    }
  }
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
  const impact = impactContext(
    analysis,
    new Set(
      analysis.symbols
        .filter(
          (symbol) =>
            tokens.some((token) => symbol.qualifiedName.toLowerCase().includes(token)) ||
            (activeFile !== undefined && symbol.filePath === activeFile),
        )
        .slice(0, 12)
        .map((symbol) => symbol.id),
    ),
  );

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

  const projectTools =
    suppliedProjectTools ?? (await listProjectTools(analysis.rootPath).catch(() => null));
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
    attachmentContext.length > 0 ? `Attached document context:\n${attachmentContext.join("\n\n")}` : "",
    listHint,
    toolLines,
    indexLines.length > 0 ? `Index hits (best local matches):\n${indexLines.join("\n")}` : "",
    editMap,
    `Relevant files (ranked by the instruction and current focus):\n${ranked.length ? ranked.join("\n") : "(none matched; use list_files and search_code)"}`,
    relevantSymbols.length ? `Relevant symbols:\n${relevantSymbols.join("\n")}` : "",
    impact.length ? `Impact / reverse dependencies (callers and callees):\n${impact.join("\n")}` : "",
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
  ".cie",
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

export async function agentSearch(
  analysis: AnalysisResult,
  query: string,
  limit: number,
): Promise<{ results: { path: string; line: number; text: string }[]; source: "index" | "disk" }> {
  const needle = query.trim().toLowerCase();
  if (!needle) return { results: [], source: "index" };
  const indexed = await searchProjectIndex(analysis.id, query, limit, analysis.rootPath);
  const indexedHits = indexed
    .filter(
      (hit) =>
        hit.kind !== "conversation" &&
        hit.path &&
        !/^(?:\.cie|node_modules|dist|build|\.git)\//.test(hit.path),
    )
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
    if (/^(?:\.cie|node_modules|dist|build|\.git)\//.test(file.path)) continue;
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


export async function auditUnreferencedAssets(
  analysis: AnalysisResult,
  changedFiles: string[],
): Promise<string[]> {
  const htmlFiles = analysis.files
    .map((file) => file.path)
    .filter((file) => /\.html?$/i.test(file));
  if (htmlFiles.length === 0) return [];
  const referenced = new Set<string>();
  for (const htmlPath of htmlFiles.slice(0, 12)) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const html = await readSourceFile(analysis.rootPath, htmlPath);
      for (const match of html.content.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
        referenced.add(
          match[1]
            .split("?")[0]
            .split("#")[0]
            .replace(/^\.\//, "")
            .replace(/^\//, ""),
        );
      }
    } catch {
      // ignore unreadable HTML
    }
  }
  if (referenced.size === 0) return [];
  const warnings: string[] = [];
  for (const filePath of changedFiles) {
    if (!/\.(?:js|mjs|cjs|css)$/i.test(filePath)) continue;
    if (filePath.startsWith(".cie/") || filePath.includes("node_modules/")) continue;
    const normalized = filePath.replace(/^\.\//, "");
    const fileName = path.basename(normalized);
    if (referenced.has(normalized) || referenced.has(fileName)) continue;
    warnings.push(
      `${normalized} is not loaded by any HTML (no <script src> or <link href> points to it).`,
    );
  }
  return warnings.slice(0, 8);
}

export function resolveToolGroups(
  intent: IntentAnalysis | undefined,
  instruction: string,
  workspaceMode: AiWorkspaceMode = "build",
): AgentToolGroup[] {
  if (!intent) {
    if (workspaceMode === "plan") return ["document", "git", "notes"];
    if (workspaceMode === "research") return ["web", "document", "notes"];
    return [...AGENT_TOOL_GROUPS];
  }
  const groups = new Set<AgentToolGroup>(intent.toolGroups);
  if (intent.kind === "edit" || intent.kind === "scaffold") groups.add("edit");
  if (intent.kind === "question" || intent.kind === "analyze") {
    groups.delete("edit");
    if (
      intent.verification !== "test" &&
      intent.verification !== "build"
    ) {
      groups.delete("command");
    }
  }
  if (
    intent.kind === "run" ||
    intent.verification === "test" ||
    intent.verification === "build"
  ) {
    groups.add("command");
  }
  if (intent.verification === "browser") groups.add("browser");
  if (
    /(?:Ek dosya|Attached file|Ekli dosya):|\.(?:pdf|docx?|xlsx?|csv|pptx?|png|jpe?g|webp|gif|bmp|tiff?)\b/i.test(
      instruction,
    )
  ) {
    groups.add("document");
  }
  if (workspaceMode === "plan") {
    groups.delete("edit");
    groups.delete("command");
    groups.add("document");
    groups.add("git");
    groups.add("notes");
  } else if (workspaceMode === "research") {
    groups.delete("edit");
    groups.delete("command");
    groups.add("web");
    groups.add("document");
    groups.add("notes");
  } else if (workspaceMode === "ask") {
    groups.delete("edit");
    groups.delete("command");
  }
  return [...groups];
}

export function agentToolCatalog(
  readOnly: boolean,
  writeApproved: boolean,
  commandsApproved: boolean,
  groups?: readonly AgentToolGroup[],
  projectTools?: ProjectToolHint[],
): string {
  return renderAgentToolCatalog(readOnly, writeApproved, commandsApproved, groups, projectTools);
}

const COLOR_VALUE_PATTERN = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g;

async function auditColorCoverage(
  analysis: AnalysisResult,
  steps: AiAgentStep[],
  summary: string,
): Promise<{ path: string; total: number; missing: string[] } | null> {
  const cssStep = [...steps]
    .reverse()
    .find(
      (step) =>
        step.action === "read_file" &&
        typeof step.args.path === "string" &&
        /\.css$/i.test(step.args.path),
    );
  const filePath =
    (cssStep?.args.path as string | undefined) ??
    (analysis.files.some((file) => file.path === "styles.css") ? "styles.css" : undefined);
  if (!filePath) return null;
  const file = await readSourceFile(analysis.rootPath, filePath).catch(() => null);
  if (!file) return null;
  const colors = [...new Set([...file.content.matchAll(COLOR_VALUE_PATTERN)].map((match) => match[0]))];
  if (colors.length < 3) return null;
  const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, "");
  const answer = normalize(summary);
  return {
    path: filePath,
    total: colors.length,
    missing: colors.filter((color) => !answer.includes(normalize(color))),
  };
}

interface ColorEntry {
  line: number;
  selector: string;
  property: string;
  color: string;
}

interface ColorList {
  path: string;
  entries: ColorEntry[];
  unique: [string, number][];
}

function buildColorAnswer(list: ColorList): string {
  const rows = list.entries
    .map(
      (entry) =>
        `| ${entry.line} | \`${entry.selector || "—"}\` | \`${entry.property || "—"}\` | \`${entry.color}\` |`,
    )
    .join("\n");
  return [
    `## ${list.path} renk listesi`,
    "",
    "| Satır | Seçici | Özellik | Renk |",
    "|---:|---|---|---|",
    rows,
    "",
    "## Benzersiz renk kodları",
    "",
    ...list.unique.map(([color, count]) => `- \`${color}\` — ${count} kez`),
  ].join("\n");
}

const ENTITY_TITLES_TR: Record<string, string> = {
  color: "Renk",
  input: "Girdi",
  button: "Buton",
  link: "Bağlantı",
  function: "Fonksiyon",
  class: "Sınıf",
  component: "Bileşen",
  env: "Ortam değişkeni",
  todo: "Yapılacak",
  route: "Rota",
  import: "İçe aktarım",
  selector: "Seçici",
  asset: "Varlık",
  markdown: "Markdown",
  document: "Belge",
  file: "Dosya",
  text: "Metin",
};

const ENTITY_COLUMNS_TR: Record<string, string> = {
  file: "Dosya",
  line: "Satır",
  name: "Ad",
  type: "Tür",
  placeholder: "Yer tutucu",
  text: "Metin",
  href: "Bağlantı",
  selector: "Seçici",
  property: "Özellik",
  color: "Renk",
  bytes: "Boyut",
  extension: "Uzantı",
  loc: "Satır",
  value: "Değer",
  method: "Metot",
  path: "Yol",
};

function buildMappedSummary(
  changed: string[],
  verification: string,
  language: string,
): string {
  const turkish = language.toLowerCase().startsWith("tr");
  const heading = turkish ? "## Yapılan değişiklik" : "## Change applied";
  const details = changed.map((entry) => `- ${entry}`).join("\n");
  return `${heading}\n\n${details}\n\n${verification}`;
}

function mappedVerificationSummary(
  verified: boolean,
  remaining: number,
  totalColors: number | undefined,
  language: string,
): string {
  const turkish = language.toLowerCase().startsWith("tr");
  if (turkish) {
    if (verified) {
      return totalColors === undefined
        ? "Doğrulama: kalan eski değer yok."
        : `Doğrulama: kalan eski değer yok; kapsamda ${totalColors} renk kullanımı korunuyor.`;
    }
    return `Doğrulama: ${remaining} eski değer hâlâ duruyor.`;
  }
  if (verified) {
    return totalColors === undefined
      ? "Verification: 0 remaining old value(s)."
      : `Verification: 0 remaining old value(s); ${totalColors} color occurrence(s) remain in scope.`;
  }
  return `Verification: ${remaining} old value(s) still remain.`;
}

function buildEntityAnswer(result: EntityResult, language: string): string {
  const turkish = language.toLowerCase().startsWith("tr");
  const title = turkish
    ? `${ENTITY_TITLES_TR[result.kind] ?? result.kind} listesi`
    : `${result.kind} list`;
  const headers = result.headers.map((header) => ({
    ...header,
    label: turkish ? ENTITY_COLUMNS_TR[header.key] ?? header.label : header.label,
  }));
  const escape = (value: string | undefined) =>
    (value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 180);
  const rows = result.items.map(
    (item) => `| ${headers.map((header) => escape(item.values[header.key])).join(" | ")} |`,
  );
  const table = [
    `| ${headers.map((header) => header.label).join(" | ")} |`,
    `|${headers.map(() => "---").join("|")}|`,
    ...rows,
  ].join("\n");
  const uniqueSection =
    result.kind === "color"
      ? `\n\nBenzersiz renk kodları:\n${[
          ...new Set(result.items.map((item) => item.values.color)),
        ].join("\n")}`
      : "";
  return `## ${title} (${result.total})\n\n${table}${uniqueSection}`;
}

function buildInspectionSummary(steps: AiAgentStep[]): string {
  const describe = (step: AiAgentStep): string => {
    const target = agentActionTarget(step.args);
    return `- ${step.action}${target ? ` ${target}` : ""}: ${step.observation
      .replace(/\s+/g, " ")
      .slice(0, 320)}`;
  };
  const runtime = steps
    .filter(
      (step) =>
        /browser_check|run_test_scenario|game_check|graphic_check|mobile_check/.test(step.action) ||
        /PASS|FAIL|painted|banner|visible|"count"|expectStable/i.test(step.observation),
    )
    .slice(-4);
  const code = steps
    .filter(
      (step) =>
        ["read_file", "read_symbol", "find_in_file", "search_code", "project_search"].includes(
          step.action,
        ) &&
        step.ok &&
        !/No matches|Cached read|already read|already searched|already executed/i.test(
          step.observation,
        ),
    )
    .slice(-3);
  const evidence = [...runtime, ...code];
  return [
    "Read-only inspection stopped after enough evidence was collected. Findings:",
    runtime.length > 0 ? `Runtime evidence:\n${runtime.map(describe).join("\n")}` : "",
    code.length > 0 ? `Code evidence:\n${code.map(describe).join("\n")}` : "",
    "The next step is to apply the minimal fix identified above, or confirm the behavior with a saved scenario.",
  ]
    .filter(Boolean)
    .join("\n\n");
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
  const classified = withoutNegativeInstructions(trimmed);
  const question =
    options.askMode === true ||
    QUESTION_INTENT.test(classified) ||
    classified.endsWith("?");
  const editIntent = !question && ACTION_INTENT.test(classified);
  const runIntent =
    !question &&
    /\b(run|çalıştır|test et|build|derle|typecheck|lint|doğrula|verify)\b/i.test(classified) &&
    !editIntent;
  const scaffoldIntent =
    !question &&
    /\b(scaffold|sıfırdan|from scratch|new project|yeni proje|proje oluştur)\b/i.test(classified);

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

function buildPlanFromIntent(
  intent: IntentAnalysis,
  activeFile: string | undefined,
  verificationCommand: string | undefined,
  actionPlan?: ActionPlan,
): AiAgentPlan {
  const needsWrite = actionPlan?.needsWrite ?? (intent.kind === "edit" || intent.kind === "scaffold");
  const needsCommand =
    actionPlan?.needsCommand ??
    (intent.kind === "run" ||
      intent.verification === "test" ||
      intent.verification === "build");
  const planIntent: AiAgentPlan["intent"] =
    intent.kind === "question" || intent.kind === "analyze"
      ? "question"
      : intent.kind === "run"
        ? "run"
        : intent.kind === "scaffold"
          ? "scaffold"
          : intent.scope === "medium" || intent.scope === "large"
            ? "multi_file"
            : "edit";
  const risk: AiAgentPlan["risk"] =
    intent.scope === "large" ? "high" : needsWrite || needsCommand ? "medium" : "low";
  const scope =
    intent.areas.length > 0
      ? intent.areas
      : activeFile
        ? [activeFile]
        : [];
  const steps: AiAgentPlan["steps"] =
    actionPlan?.action === "list"
      ? [
          { label: "Extract the complete inventory with extract_entities" },
          { label: "Verify the total and answer with every item" },
        ]
      : actionPlan?.action === "locate"
        ? [
            { label: "Search for the definition" },
            { label: "Read the exact range" },
            { label: "Answer with file:line evidence" },
          ]
        : actionPlan?.action === "verify"
          ? [
              { label: "Inspect the verification setup" },
              { label: "Run the detected test/typecheck/browser check" },
              { label: "Report the real result" },
            ]
          : planIntent === "question"
      ? [
          { label: "Inspect relevant files" },
          { label: "Answer with evidence" },
        ]
      : planIntent === "run"
        ? [
            { label: "Inspect scripts and configuration" },
            { label: "Run the requested command" },
            { label: "Report the result" },
          ]
        : [
            { label: intent.understanding },
            ...(scope.length > 0 ? [{ label: `Focus: ${scope.slice(0, 4).join(", ")}` }] : []),
            { label: "Make the focused change" },
            { label: "Verify the result" },
          ];
  return {
    intent: planIntent,
    action: actionPlan?.action,
    reason: actionPlan?.reason,
    summary: intent.understanding,
    needsWrite,
    needsCommand,
    risk,
    scope,
    verification: needsWrite ? verificationCommand : undefined,
    steps,
  };
}

export interface MissingSelector {
  id: string;
  file: string;
}

const SELECTOR_SCAN_EXTENSIONS = /\.(?:html?|jsx?|tsx?|vue|svelte|php|erb|ejs|hbs|twig|astro)$/i;

/**
 * After a write, check that IDs referenced by the changed JavaScript are
 * actually defined somewhere in the project markup or templates. This catches
 * half-wired features such as querySelector("#task-assignee") without an input.
 */
export async function auditMissingSelectors(
  analysis: AnalysisResult,
  changedFiles: string[],
): Promise<MissingSelector[]> {
  const references = new Map<string, string>();
  for (const filePath of changedFiles) {
    if (!/\.(?:js|mjs|cjs|jsx|tsx?|vue|svelte)$/i.test(filePath)) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const file = await readSourceFile(analysis.rootPath, filePath);
      const patterns = [
        /querySelector(?:All)?\(\s*["'`]#([A-Za-z0-9_-]+)/g,
        /getElementById\(\s*["'`]([A-Za-z0-9_-]+)/g,
      ];
      for (const pattern of patterns) {
        for (const match of file.content.matchAll(pattern)) {
          const id = match[1];
          if (id && !references.has(id)) references.set(id, filePath);
        }
      }
    } catch {
      // unreadable changed file: skip
    }
  }
  if (references.size === 0) return [];

  const defined = new Set<string>();
  const candidatePaths = new Set([
    ...changedFiles,
    ...analysis.files.map((file) => file.path),
  ]);
  const candidates = [...candidatePaths]
    .filter(
      (filePath) =>
        SELECTOR_SCAN_EXTENSIONS.test(filePath) ||
        /(?:^|\/)templates?\//i.test(filePath),
    )
    .slice(0, 240);
  for (const filePath of candidates) {
    if (references.size === defined.size) break;
    try {
      // eslint-disable-next-line no-await-in-loop
      const content = await fs.readFile(path.resolve(analysis.rootPath, filePath), "utf8");
      if (content.length > 400_000) continue;
      for (const id of references.keys()) {
        if (defined.has(id)) continue;
        const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const idPattern = new RegExp(`id\\s*=\\s*["'\`]${escaped}["'\`]`);
        const setAttributePattern = new RegExp(
          `setAttribute\\(\\s*["']id["']\\s*,\\s*["']${escaped}["']`,
        );
        if (idPattern.test(content) || setAttributePattern.test(content)) {
          defined.add(id);
        }
      }
    } catch {
      // skip unreadable candidate
    }
  }
  return [...references.entries()]
    .filter(([id]) => !defined.has(id))
    .map(([id, file]) => ({ id, file }));
}

export function budgetExceeded(
  tokenUsage: AiTokenUsage | undefined,
  estimatedCostUsd: number | undefined,
  tokenBudget?: number,
  costBudgetUsd?: number,
): boolean {
  if (tokenBudget && tokenUsage && tokenUsage.totalTokens >= tokenBudget) return true;
  return Boolean(
    costBudgetUsd !== undefined &&
      estimatedCostUsd !== undefined &&
      estimatedCostUsd >= costBudgetUsd,
  );
}

export function selectHistory(
  history: { role: "user" | "assistant"; content: string }[] | undefined,
  mode: IntentHistory | "none",
): { role: "user" | "assistant"; content: string }[] {
  if (!history || history.length === 0 || mode === "none") return [];
  const limit = mode === "extended" ? 8 : mode === "recent" ? 4 : 6;
  const chars = mode === "extended" ? 1_200 : mode === "recent" ? 800 : 1_000;
  return history.slice(-limit).map((message) => ({
    role: message.role,
    content: message.content.slice(0, chars),
  }));
}

const CONTINUATION_REQUEST =
  /(?:uygula|düzelt|fix\b|apply\b|implement|devam et|continue|bunu yap|şunu yap|bağla|yansıt)/i;

export function continuationFindings(
  history: { role: "user" | "assistant"; content: string }[] | undefined,
  instruction: string,
): string | null {
  if (!history || history.length === 0) return null;
  const scope = instruction.trim().slice(0, 800);
  if (!scope || !CONTINUATION_REQUEST.test(scope)) return null;
  const lastAssistant = [...history].reverse().find((message) => message.role === "assistant");
  if (!lastAssistant) return null;
  const text = lastAssistant.content.trim();
  if (text.length < 200) return null;
  const hasEvidence =
    /(?:[\w./@-]+\.(?:js|mjs|cjs|ts|tsx|jsx|css|scss|html?|php|py|go|rs|java|kt|swift|dart|rb|vue|svelte)|[\w./@-]+:\d+)/i.test(
      text,
    );
  if (!hasEvidence) return null;
  return text.length > 8_000 ? `${text.slice(0, 8_000)}\n[prior answer truncated]` : text;
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
    workspaceMode?: AiWorkspaceMode;
    history?: { role: "user" | "assistant"; content: string }[];
    interactive?: boolean;
    forceFast?: boolean;
    forceWrite?: boolean;
    /** The task's explicit acceptance criteria, if the loop has them. */
    acceptance?: string;
    /** Original user goal for short-prompt heuristics. */
    goalText?: string;
    /** The loop already decided this is a read-only inspection task. */
    inspection?: boolean;
    /** Original user goal when `instruction` is wrapped task-loop boilerplate. */
    workBriefText?: string;
    tokenBudget?: number;
    /** Safety cap independent of the user budget mode; the task loop narrows/retries. */
    softTokenBudget?: number;
    costBudgetUsd?: number;
    budgetMode?: "off" | "warn" | "stop";
    maxOutputTokens?: number;
    startingUsage?: AiTokenUsage;
    intent?: IntentAnalysis;
    /** Show the local browser window while browser checks run. */
    liveBrowser?: boolean;
    /** A mechanical one-line/small edit; skip global wiring/pending heuristics. */
    microEdit?: boolean;
    /** A focused single-file task; use a tighter read budget but keep normal steps. */
    tightReads?: boolean;
    /** Current relevant code included by the loop so the agent does not re-read it. */
    codeContext?: string;
    /** A saved deterministic scenario that must pass before finish is accepted. */
    requiredScenario?: {
      name: string;
      path: string;
      url?: string;
      steps: BrowserCheckStep[];
      timeoutMs?: number;
    };
  } = {},
  emit: (event: AiAgentEvent) => void = () => {},
  signal?: AbortSignal,
): Promise<AiAgentResult> {
  const analysis = await loadAnalysis(projectId);
  if (!instruction.trim()) throw new Error("An agent instruction is required.");
  const config = await resolveProvider(options.provider, options.model);
  const workspaceMode: AiWorkspaceMode =
    options.workspaceMode ?? (options.mode === "ask" ? "ask" : "build");
  const readOnlyMode = workspaceMode !== "build";
  const askMode = readOnlyMode;
  const autoMode = options.mode === "auto";
  let writeApproved = !readOnlyMode && options.allowWrite === true;
  let commandsApproved = !readOnlyMode && options.allowCommands === true;
  const interactive = !readOnlyMode && options.interactive !== false;
  const runId = `run_${crypto.randomUUID()}`;
  const fastTask =
    options.forceFast === true ||
    (options.intent
      ? options.intent.scope === "trivial" || options.intent.scope === "small"
      : false);
  // No fixed step budget: a task runs until it finishes or stops making
  // progress. Callers can still pass an explicit cap for short internal runs.
  let maxSteps =
    options.maxSteps && Number.isFinite(options.maxSteps) && options.maxSteps > 0
      ? Math.max(2, options.maxSteps)
      : Number.POSITIVE_INFINITY;
  const createdAt = new Date().toISOString();
  const evidence: AiContextFile[] = [];
  const usedSkills: string[] = [];
  const steps: AiAgentStep[] = [];
  const changedFiles: string[] = [];
  const ranCommands: string[] = [];
  const failedCommands = new Map<string, number>();
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
    options: {
      preview?: string;
      previewKind?: "diff" | "text";
      destructive?: boolean;
      forceConfirm?: boolean;
    } = {},
  ): Promise<boolean> => {
    if (readOnlyMode) {
      if (
        (workspaceMode === "research" || workspaceMode === "plan") &&
        tool === "save_note"
      ) {
        return true;
      }
      return false;
    }
    const destructive = options.destructive === true;
    if (!destructive && options.forceConfirm !== true) {
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
        preview: options.preview
          ? options.preview.slice(0, options.previewKind === "diff" ? 5_000 : 900)
          : undefined,
        previewKind: options.preview ? (options.previewKind ?? "text") : undefined,
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
  const verificationCommands = preferredVerificationCommands(verificationTooling);
  const verificationCommand = verificationCommands[0];
  let lastVerification: {
    signature: string;
    ran: boolean;
    ok: boolean;
    command?: string;
    output: string;
    cached: boolean;
    results?: { command: string; ok: boolean; output: string }[];
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
    const commandsToRun = await verificationCommandsForChanges(
      analysis.rootPath,
      changedFiles,
      verificationCommands,
    );
    if (commandsToRun.length === 0) {
      log("warn", "No verification command", "No lint/typecheck/test/build command was detected for this project.");
      return {
        signature: "none",
        ran: false,
        ok: false,
        output: "No lint/typecheck/test/build command was detected for this project.",
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
    verificationAttempts += 1;
    const results: { command: string; ok: boolean; output: string }[] = [];
    let allOk = true;
    for (const [commandIndex, command] of commandsToRun.entries()) {
      const allowed = await requirePermission(
        "command",
        "verify_changes",
        command,
        "Verify the changed files with the project lint/typecheck/test command.",
        { preview: command },
      );
      if (!allowed) {
        const denied = {
          signature,
          ran: results.length > 0,
          ok: false,
          command: results.map((item) => item.command).join(" && ") || command,
          output: "Verification stopped because the user denied a command.",
          cached: false,
          results,
        };
        lastVerification = denied;
        log("warn", "Verification skipped", "The user denied the verification command.");
        return denied;
      }
      log("info", "Verifying changes", command);
      const result = await runProjectCommand(analysis.rootPath, command, undefined, {
        timeoutMs: 120_000,
        signal,
      });
      const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}${
        result.timedOut ? "\nVerification command timed out." : ""
      }`.trim();
      const ok = result.exitCode === 0;
      results.push({ command, ok, output });
      allOk = allOk && ok;
      if (!ok) {
        log("error", "Verification failed", `${command} · exit ${result.exitCode ?? "—"}`);
        break;
      }
      log("success", "Verification passed", command);
      if (commandIndex === commandsToRun.length - 1) break;
    }
    const verification = {
      signature,
      ran: results.length > 0,
      ok: allOk,
      command: results.map((item) => item.command).join(" && "),
      output: results
        .map((item) => `$ ${item.command}\n${item.output}`.trim())
        .join("\n\n"),
      cached: false,
      results,
    };
    lastVerification = verification;
    return verification;
  };

  const actionPlanSource = options.workBriefText?.trim() || instruction;
  const actionPlan = resolveActionPlan(actionPlanSource, options.intent);
  let plan = options.intent
    ? buildPlanFromIntent(options.intent, options.activeFile, verificationCommand, actionPlan)
    : buildAgentPlan(analysis, actionPlanSource, {
        activeFile: options.activeFile,
        askMode: readOnlyMode,
        verificationCommand,
      });
  plan = {
    ...plan,
    action: actionPlan.action,
    reason: actionPlan.reason,
  };
  if (readOnlyMode) {
    plan = {
      ...plan,
      intent: "question",
      needsWrite: false,
      needsCommand: false,
      verification: undefined,
      risk: "low",
      summary:
        workspaceMode === "plan"
          ? "Inspect the project and produce an executable plan."
          : workspaceMode === "research"
            ? "Investigate the project and sources, then answer with evidence."
            : plan.summary,
      steps:
        workspaceMode === "plan"
          ? [
              { label: "Inspect the goal and relevant project evidence" },
              { label: "Write ordered tasks with acceptance criteria" },
              { label: "Save the plan artifact and report open questions" },
            ]
          : workspaceMode === "research"
            ? [
                { label: "Search project and external sources" },
                { label: "Verify claims and collect citations" },
                { label: "Summarize findings and open questions" },
              ]
            : plan.steps,
    };
  }
  if (!readOnlyMode && options.forceWrite === true) {
    plan = {
      ...plan,
      intent: "edit",
      needsWrite: true,
      summary: plan.summary || "Apply the requested change.",
      steps:
        plan.steps.length > 0
          ? plan.steps
          : [
              { label: "Inspect the target files" },
              { label: "Apply the requested change" },
              { label: "Verify the result" },
            ],
    };
  } else if (!readOnlyMode && options.inspection === true) {
    // The loop already classified this task as read-only inspection. Do not
    // let intent-level "edit" wording start a write spiral. Writes stay
    // available so a real missing change can still be applied.
    plan = { ...plan, needsWrite: false };
  }
  activePlan = plan;
  const siteInspection = !plan.needsWrite && isSiteInspection(actionPlanSource);
  const testTask =
    !plan.needsWrite &&
    (siteInspection ||
      actionPlan.action === "run" ||
      actionPlan.action === "verify" ||
      options.intent?.kind === "run");
  if (testTask) maxSteps = Math.min(maxSteps, siteInspection ? 10 : 12);
  const writeIntent =
    options.forceWrite === true || options.intent?.kind === "edit";
  const narrowEdit =
    !readOnlyMode &&
    plan.needsWrite &&
    writeIntent &&
    (options.intent?.scope === "trivial" || options.intent?.scope === "small");
  const contextMode = options.intent?.context ?? "project";
  const historyMode = options.intent?.history ?? "recent";
  const workBriefSource = actionPlanSource;
  const workBrief =
    contextMode !== "none" && options.forceWrite !== true
      ? resolveWorkBrief(workBriefSource)
      : null;
  const extractionBrief = workBrief?.mode === "extract";
  const compoundChange =
    workBrief?.mode === "change" &&
    /\b(ekle|ekley|eklen|oluştur|olustur|add|create|implement|refactor|yeniden düzenle)\w*/i.test(
      instruction,
    );
  const workBriefText = workBrief
    ? workBrief.mode === "extract"
      ? `Work brief: complete extraction task (kind=${workBrief.kind}). Call extract_entities with kind="${workBrief.kind}". Omit scope to scan the whole project unless the user restricted specific files. This is a read-only list task: ignore any generic task-loop boilerplate about reading context files, editing or browser checks. Do not use shell/grep, list_items or browser_check. Do not manually enumerate. Finish with every item in a table written in the user's language; do not summarize or omit entries.`
      : `Work brief: change task (kind=${workBrief.kind}). First call extract_entities with kind="${workBrief.kind}" to identify the current targets; then apply the requested change with replace_many or apply_mapped_changes and verify it. Do not rewrite whole files or invent existing items. After apply_mapped_changes reports Verification with 0 remaining, call finish immediately; do not chase rgb/rgba equivalents, variable names or visual variants unless the user explicitly asked for them.`
    : "";
  const instructionHasProjectBrain = /Persistent project brain/i.test(instruction);
  const projectBrainBrief =
    instructionHasProjectBrain || contextMode === "none" || testTask || options.microEdit === true
      ? ""
      : await ensureProjectBrain(analysis)
          .then((brain) => compactProjectBrainBrief(brain))
          .catch(() => "");
  if (projectBrainBrief) {
    log("info", "Project brain loaded", `${projectBrainBrief.length} chars`);
  }
  const continuation = continuationFindings(options.history, instruction);
  const continuationMode = Boolean(continuation);
  const latestProjectPlan =
    contextMode !== "none" &&
    !testTask &&
    options.microEdit !== true &&
    (workspaceMode === "plan" || workspaceMode === "build")
      ? await readLatestProjectPlan(
          analysis.rootPath,
          workspaceMode === "plan" ? 6_000 : 2_500,
        ).catch(() => "")
      : "";
  const toolGroups = resolveToolGroups(options.intent, instruction, workspaceMode);
  if (options.forceWrite === true && !toolGroups.includes("edit")) {
    toolGroups.push("edit");
  }
  if (actionPlan.needsBrowser && !toolGroups.includes("browser")) {
    toolGroups.push("browser");
  }
  if (actionPlan.needsCommand && !toolGroups.includes("command")) {
    toolGroups.push("command");
  }
  if (testTask) {
    // Verification plans must always be able to open the real page and run
    // the saved scenario, even when intent classification is read-only.
    for (const group of ["browser", "command"] as const) {
      if (!toolGroups.includes(group)) toolGroups.push(group);
    }
    const allowed = new Set<AgentToolGroup>(["core", "browser", "command", "document"]);
    toolGroups.splice(0, toolGroups.length, ...toolGroups.filter((group) => allowed.has(group)));
  }
  if (options.microEdit === true) {
    toolGroups.splice(0, toolGroups.length, "edit", "browser");
  }
  const suggestedTools = suggestToolsForInstruction(actionPlanSource, toolGroups, 8);
  if (suggestedTools.length > 0) {
    log("info", "Capability suggestions", suggestedTools.join(", "));
  }
  const projectToolList = await listProjectTools(analysis.rootPath).catch(() => null);
  const focusedFiles = [
    ...new Set(
      [options.activeFile, ...(options.intent?.areas ?? [])].filter(
        (value): value is string => Boolean(value),
      ),
    ),
  ].slice(0, 8);
  const projectContext =
    contextMode === "none" || options.microEdit === true
      ? ""
      : contextMode === "focused"
        ? compactProjectBrief(analysis)
        : projectBrief(analysis);
  const projectFiles =
    contextMode === "none" || options.microEdit === true
      ? ""
      : contextMode === "focused"
        ? focusedFiles.length > 0
          ? `Focused files:\n${focusedFiles.join("\n")}`
          : ""
        : `Project files (sample):\n${analysis.files.slice(0, 15).map((file) => file.path).join("\n")}`;
  const conversation = selectHistory(options.history, historyMode);
  const context = [
    projectContext,
    projectBrainBrief
      ? `Persistent project brain (authoritative project facts; task summaries are unverified claims):\n${projectBrainBrief}`
      : "",
    "",
    options.intent?.approach ? `Intent approach: ${options.intent.approach}` : "",
    suggestedTools.length > 0
      ? `Likely tools for this request: ${suggestedTools.join(", ")}. Use these before broad exploration.`
      : "",
    options.intent?.needsExhaustiveEvidence
      ? "Evidence requirement: the answer must be exhaustive; collect every matching item and verify the total before finishing."
      : "",
    `Working file (optional): ${options.activeFile ?? "none"}`,
    askMode
      ? "Permissions: read-only; file writes and commands are unavailable."
      : `Permissions: write=${writeApproved ? "pre-approved" : "ask the user before writing"}; commands=${
          commandsApproved ? "pre-approved" : "ask the user before running commands"
        }; delete and rename always need confirmation.`,
    options.codeContext ?? "",
    continuation
      ? `Continuation of your previous answer — implement these findings directly.\nDo not re-research or rescan the project. The findings below are authoritative. Read only the exact lines you will edit or confirm, then make the change and verify it on the real app.\n\n${continuation}`
      : "",
    latestProjectPlan
      ? `${
          workspaceMode === "plan"
            ? "Latest project plan — integrate the new request into this plan. Keep existing items unless the user asks to replace them:"
            : "Latest project plan — guidance for this build. Use it when relevant, but do not treat it as the current task list:"
        }\n${latestProjectPlan}`
      : "",
    conversation.length > 0
      ? `Conversation so far:\n${conversation
          .map((message) => `${message.role}: ${message.content}`)
          .join("\n\n")}`
      : "",
    projectFiles,
  ]
    .filter(Boolean)
    .join("\n");

  const focusedRead =
    (workspaceMode === "ask" || !readOnlyMode) &&
    contextMode === "focused" &&
    !plan.needsWrite;
  const basePromptId = askMode ? "agent.ask" : autoMode ? "agent.auto" : "agent.coding";
  const promptId =
    workspaceMode === "plan"
      ? "agent.plan"
      : workspaceMode === "research"
        ? "agent.research"
        : siteInspection
          ? "agent.site"
          : testTask
            ? "agent.test"
          : narrowEdit
            ? "agent.focused"
            : focusedRead
              ? "agent.inspect"
              : basePromptId;
  const prompt = await getPrompt(promptId, projectId);
  const languageInstruction = aiLanguageInstruction(options.language ?? "en");
  const fastSuffix =
    fastTask &&
    !["agent.focused", "agent.inspect", "agent.test", "agent.site"].includes(prompt.id)
      ? "\n\nFast task profile: this is a small, focused change. Read at most 3 files (for a CSS-only change, read only the stylesheet), make the edit, run at most one verification, and finish. Complete every edit-map item before finishing. Do not read unrelated modules, repeat reads, or keep exploring after the edit."
      : "";
  const narrowEditSuffix =
    narrowEdit && prompt.id !== "agent.focused" && prompt.id !== "agent.inspect"
      ? "\n\nNarrow edit profile: use project_search or find_in_file first and locate the exact selector, property, symbol or snippet. Read at most 3 focused ranges (about 60 lines each). Never read a whole file above 160 lines; if a whole-file read is rejected, read only the matching range. Then use replace_in_file with the exact existing snippet."
      : "";
  const readOnlySuffix =
    workspaceMode === "ask"
      ? "\n\nInspection profile: this task is read-only. Read at most 6 files, never re-read the same range, and finish with a compact report. Do not propose a large next-step list."
      : "";
  const requestedSkills = [...(options.intent?.skills ?? [])];
  const goalText = (options.goalText || instruction).trim();
  const skillLoad = await loadSkillsForPrompt(analysis.rootPath, projectId, goalText, {
    requested: requestedSkills.slice(0, 3),
  }).catch(() => ({
    skills: [] as never[],
    mentions: [] as string[],
    relevant: [] as string[],
    selected: [] as string[],
    index: "",
  }));
  const enabledSkills = skillLoad.skills;
  usedSkills.push(...skillLoad.selected, ...skillLoad.relevant);
  const mentionedSkill = skillLoad.mentions.length > 0;
  const relevantSkill = skillLoad.relevant.length > 0;
  const selectedSkill = skillLoad.selected.length > 0;
  // Full skill bodies are expensive on every turn. Load them only when the
  // user/model selected them; otherwise ship the index and let load_skill
  // pull the body once it is actually needed.
  const includeSkills =
    !testTask &&
    options.microEdit !== true &&
    (fastTask || mentionedSkill || selectedSkill);
  const skillsPrompt = includeSkills ? renderSkillsForPrompt(enabledSkills) : "";
  const capabilityIndex = options.microEdit === true ? "" : skillLoad.index || "";
  if (skillLoad.mentions.length > 0) {
    log("info", "Skill mention", `${skillLoad.mentions.join(", ")} · used for this run only`);
  }
  if (skillLoad.relevant.length > 0) {
    log("info", "Skill auto-match", `${skillLoad.relevant.join(", ")} · matched from the request`);
  }
  if (skillLoad.selected.length > 0) {
    log("info", "Skill selected by intent", skillLoad.selected.join(", "));
  }
  if (enabledSkills.length > 0) {
    log(
      "info",
      includeSkills ? "Skills loaded" : "Skills skipped",
      includeSkills
        ? `${enabledSkills.length} enabled · ${skillsPrompt.length} chars ≈ ${Math.round(skillsPrompt.length / 4)} tokens · ${enabledSkills.map((skill) => skill.record.name).join(", ")}`
        : `${enabledSkills.length} enabled · index only; full text loads with load_skill when needed`,
    );
  }
  const systemContent =
    renderPrompt(prompt.system, {
      tools: agentToolCatalog(
        readOnlyMode,
        writeApproved,
        commandsApproved,
        toolGroups,
        projectToolList?.tools,
      ),
      language: languageInstruction,
    }) +
    (skillsPrompt ? `\n\n${skillsPrompt}` : "") +
    (capabilityIndex ? `\n\n${capabilityIndex}` : "") +
    "\n\nOutput protocol: reply with one JSON object per turn using action and args. For independent read-only work (read_file, find_in_file, search_code, list_files, diagnostics) you may batch up to 4 calls in one reply as {\"actions\":[{...},{...}]}; this saves a full context round-trip. Keep mutating actions to one per reply. Never use <commentary>, <analysis>, <thinking> tags, markdown fences, or prose outside the JSON. The JSON must be complete." +
    "\n\nVerification protocol: when the user asks why something is missing or broken, trace the real wiring (HTML <script>/<link>, imports, event handlers, selectors) and use browser_check/run_test_scenario for runtime proof. State the root cause with file:line evidence; never guess from feature names. For UI or game behavior, save a reusable scenario in .cie/agent/scenarios/<name>.json and run it with run_test_scenario. Do not repeat failures recorded in .cie/agent/LESSONS.md. If a tool call fails, correct its arguments (the file path key is \"path\") and retry the same tool in this run; never finish with a blocker for an error you can fix yourself. If a needed tool does not exist, create a project tool or a small script and use it. Before retrying a failed task, read the newest file under .cie/agent/runs/ to see the exact failed action and error instead of guessing. For timers, counters, toasts or end-screen text, verify stability with a browser_check step {\"action\":\"expectStable\",\"selector\":\"...\",\"durationMs\":800}; text that changes every animation frame means it is being rewritten inside requestAnimationFrame, not that the timer is too fast. Verify the REAL project entry page: a synthetic harness under .cie/ is not proof, even when it passes. If the target state is hard to reach, use an eval step on the real page to put it in that state, wait for delayed elements with waitForSelector, then assert them. When the user asks to apply your previous answer, treat its findings as authoritative and start editing; do not rescan the project." +
    "\n\nRuntime UI playbook:" +
    "\n- A file that no HTML <script>/<link> loads does nothing; check the tags and duplicate tags before editing behavior." +
    "\n- Text that changes every frame is usually rewritten inside requestAnimationFrame or a loop; write one-time values once (guard with a flag), not on every tick." +
    "\n- Prove runtime behavior with browser_check and expectStable (800-1200ms), then save the steps to .cie/agent/scenarios/<name>.json and run them with run_test_scenario." +
    "\n- A failed tool call is not a blocker: fix its arguments (path/content) and retry in the same run. Read .cie/agent/runs/ to see the exact failed action." +
    "\n- Do not claim a feature from a config or variable that is never read at runtime. Wire it into the update/draw path or remove it." +
    "\n- For any complete list/audit (colors, inputs, buttons, links, functions, classes, components, env, routes, imports, selectors, assets, documents, markdown, todos, files), call extract_entities with the matching kind instead of manually reading/counting. Finish immediately with every item in the user's language; do not summarize or omit entries." +
    "\n- For asset references, broken local links or Markdown heading hierarchy, call audit_content and report the actual findings." +
    "\n- For Excel/Word/CSV/TSV/Markdown/JSON/HTML/PDF outputs use create_document with the requested path/format; for archives use create_zip with entries. Verify the created file with read_document (or the relevant query tool)." +
    "\n- For a color/background/button color change, call extract_entities(kind=color) first, then apply the change with apply_mapped_changes or replace_many; never rewrite whole files without a mapping." +
    "\n- For non-color value changes (button labels, import paths, env keys), use apply_mapped_changes(kind=text) or replace_many; verify with a text extraction or search that the old value is gone." +
    "\n- Mappings are applied simultaneously, so color swaps like {\"#fff\":\"#000\",\"#000\":\"#fff\"} are safe. Use dryRun:true to preview a multi-file mapping before writing. If a mapped change was wrong, call undo_change with the file path to restore its latest backup." +
    "\n- For each new item or effect, prove the effect itself with a runtime step (state before/after, expectText/expectStable, canvas/state probe); an event counter alone is not proof." +
    "\n- If PROJECT_MAP reports code files missing from the index, call rescan_project before trusting symbol search." +
    "\n- Test-only artifacts (debug hooks, stable markers, scenario files) must never change the visible game UI. Keep them hidden or under .cie/." +
    "\n- Preserve the direction of a frequency request: if the user says the layer is too sparse, make it more frequent and report the before → after intervals." +
    "\n- UI quality: for HUD/icon work set SVG width/height and a fill with contrast against the background; keep icon and value on one row (flex, align-items:center); distribute HUD items with justify-content, not an empty flex spacer; take a screenshot and reject invisible icons, left-clustered items, and horizontal overflow." +
    fastSuffix +
    narrowEditSuffix +
    readOnlySuffix +
    (options.microEdit === true
      ? "\n\nThis is a micro edit. After the smallest exact edit, call finish immediately. Do not call browser_check: the server runs a deterministic real-page smoke check (page load, console errors, interaction) after your edit. Only run a saved scenario if the task explicitly names one."
      : "");
  log(
    "info",
    "Prompt selected",
    `${prompt.id} v${prompt.version}${prompt.source !== "default" ? ` · ${prompt.source}` : ""}`,
  );
  if (testTask) {
    log(
      "info",
      siteInspection ? "Site inspection profile" : "Verification profile",
      siteInspection
        ? "browser-first · max 10 model turns · project map and full skills skipped"
        : "scenario-first · max 12 model turns · project map and full skills skipped",
    );
  }
  log(
    "info",
    "Context profile",
    `context=${contextMode} · history=${historyMode} · tools=${
      toolGroups.length > 0 ? toolGroups.join("+") : "core"
    } · prompt=${systemContent.length}c · task=${context.length}c`,
  );
  if (fastTask) {
    log(
      "info",
      "Fast task profile selected",
      workspaceMode === "plan"
        ? "planning profile · read-only evidence"
        : workspaceMode === "research"
          ? "research profile · read-only evidence"
          : narrowEdit
            ? "compact focused-edit prompt · focused reads"
            : "small task · focused reads",
    );
  }
  const contextChars = context.length + systemContent.length;
  log(
    "info",
    "Context plan",
    `prompt=${prompt.id} · system=${systemContent.length}c · task=${context.length}c · history=${conversation.length} · brain=${
      projectBrainBrief.length > 0
        ? `${projectBrainBrief.length}c`
        : instructionHasProjectBrain
          ? "in-task"
          : "0c"
    } · skills=${includeSkills ? "full" : "index"}`,
  );
  if (contextChars > 30_000) {
    log(
      "warn",
      "Large context",
      `${contextChars} chars estimated. Reusable evidence is compacted; narrow the task if this keeps growing.`,
    );
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

  /**
   * Old tool observations are re-sent on every model turn. Keep the recent
   * window intact, but shrink observations older than eight messages so a
   * long run does not pay for the same file excerpt twenty times.
   */
  const compactTranscript = () => {
    const cutoff = transcript.length - 6;
    if (cutoff <= 2) return;
    let compacted = 0;
    for (let i = 2; i < cutoff; i += 1) {
      const message = transcript[i];
      if (message.role !== "user" || !message.content.startsWith("Observation (step")) continue;
      if (message.content.length <= 450) continue;
      const headerEnd = message.content.indexOf("\n");
      const header = headerEnd >= 0 ? message.content.slice(0, headerEnd) : "Observation";
      const body = headerEnd >= 0 ? message.content.slice(headerEnd + 1) : message.content;
      transcript[i] = {
        role: "user",
        content: `${header}\n${body.slice(0, 450)}\n… older observation compacted; use the earlier conclusion or re-read only the exact range if still needed.`,
      };
      compacted += 1;
    }
    if (compacted > 0) {
      log("info", "Context compacted", `${compacted} older observation(s) shortened`);
    }
  };

  let summary = "";
  let stoppedReason: AiAgentResult["stoppedReason"] = "max_steps";
  let errorMessage: string | undefined;
  let consecutiveFailures = 0;
  let protocolRetries = 0;
  let protocolFailures = 0;
  let emptyResponseCount = 0;
  const startingUsage = options.startingUsage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const tokenTotal: AiTokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const queuedActions: ParsedToolAction[] = [];
  const readCoverage = new Map<
    string,
    { start: number; end: number; wholeFile: boolean; step: number; observation?: string }[]
  >();
  const readMap = new Map<
    string,
    { path: string; ranges: { start: number; end: number; wholeFile: boolean }[]; symbols: Set<string>; tools: Set<string> }
  >();
  const recordRead = (
    filePath: string,
    start: number | undefined,
    end: number | undefined,
    wholeFile: boolean,
    tool: string,
    symbol?: string,
  ): void => {
    const entry = readMap.get(filePath) ?? {
      path: filePath,
      ranges: [],
      symbols: new Set<string>(),
      tools: new Set<string>(),
    };
    if (start !== undefined && end !== undefined) {
      const range = { start, end, wholeFile };
      if (
        !entry.ranges.some(
          (existing) =>
            existing.start === range.start &&
            existing.end === range.end &&
            existing.wholeFile === range.wholeFile,
        )
      ) {
        entry.ranges.push(range);
      }
    }
    entry.tools.add(tool);
    if (symbol) entry.symbols.add(symbol);
    readMap.set(filePath, entry);
    // Keep one compact ledger message instead of letting the model re-read
    // ranges it already inspected. It is replaced in place each turn.
    const entries = [...readMap.values()]
      .flatMap((item) =>
        item.ranges.slice(-6).map((range) =>
          range.wholeFile ? `${item.path} (whole)` : `${item.path}:${range.start}-${range.end}`,
        ),
      )
      .slice(-20);
    if (entries.length > 0) {
      const content = `Read ledger (already inspected; do not re-read unless the file changed): ${entries.join(", ")}`;
      const existing = transcript.findIndex(
        (message) => message.role === "system" && message.content.startsWith("Read ledger"),
      );
      if (existing >= 0) transcript[existing] = { role: "system", content };
      else transcript.push({ role: "system", content });
    }
  };
  const readOnlyCache = new Map<string, { step: number; ok: boolean }>();
  const findCounts = new Map<string, number>();
  const invalidateReadCaches = (changedPaths?: readonly string[]) => {
    readCoverage.clear();
    readOnlyCache.clear();
    findCounts.clear();
    const ledgerIndex = transcript.findIndex(
      (message) => message.role === "system" && message.content.startsWith("Read ledger"),
    );
    if (ledgerIndex >= 0) {
      transcript[ledgerIndex] = {
        role: "system",
        content: "Read ledger cleared because project files changed; re-read only the exact range you need.",
      };
    }
    invalidateExtractionCache(projectId, changedPaths);
  };
  let modelTurns = 0;
  const microEditMode = options.microEdit === true;
  const tightReadsMode = microEditMode || options.tightReads === true;
  let writeNudges = 0;
  let readRejections = 0;
  let evidenceNudges = 0;
  let planningNudges = 0;
  let selectorNudges = 0;
  let wiringNudges = 0;
  let syntaxNudges = 0;
  let syntaxFailures: { file: string; output: string }[] = [];
  let missingSelectors: MissingSelector[] = [];
  let unreferencedAssets: string[] = [];
  let assetNudges = 0;
  let browserCheckCalls = 0;
  const browserCheckCache = new Map<string, number>();
  let browserCheckBlocked = false;
  const maxBrowserChecks = 4;
  let realBrowserChecks = 0;
  let syntheticBrowserChecks = 0;
  let realScenarioRuns = 0;
  let realCheckAssertions = 0;
  let verificationPassed = false;
  let verifyNudges = 0;
  let claimNudges = 0;
  let claimAuditNudges = 0;
  let lastBrowserKey = "";
  let browserFailureRepeat = 0;
  let remainingWorkRejected = false;
  let unproductiveTurns = 0;
  let progressNudged = false;
  let largeContextLogged = false;
  let readOnlyStepsSinceChange = 0;
  let readDecisionNudged = false;
  let postEditReadNudged = false;
  let postEditReadRejections = 0;
  let inspectionNudged = false;
  let verificationNudged = false;
  let inspectionReadRejections = 0;
  let colorNudges = 0;
  let completeColorList: ColorList | null = null;
  let completeExtraction: EntityResult | null = null;
  let lastExtraction: ExtractionTable | null = null;
  let completeListRejections = 0;
  let extractionRejections = 0;
  let mappedChangeVerified = false;
  let lastMappedObservation = "";
  let lastMappedSummary = "";
  let mapVerifyReads = 0;
  let mapVerifyRejections = 0;
  let codeChangeCount = 0;
  let tokensAtLastCodeChange = 0;
  let postChangeNudged = false;
  type ToolFailure = { action: string; observation: string; index: number };
  const unresolvedToolFailures = new Map<string, ToolFailure>();
  const toolFailureKey = (action: string, args: Record<string, unknown>): string => {
    const target =
      args.path ?? args.file ?? args.filePath ?? args.filename ?? args.target ?? args.url;
    if (typeof target === "string" && target.trim()) {
      return `${action}:${target.trim().slice(0, 200)}`;
    }
    if (typeof args.command === "string" && args.command.trim()) {
      return `${action}:${args.command.trim().slice(0, 160)}`;
    }
    if (typeof args.name === "string" && args.name.trim()) {
      return `${action}:${args.name.trim().slice(0, 160)}`;
    }
    if (typeof args.query === "string" && args.query.trim()) {
      return `${action}:${args.query.trim().slice(0, 160)}`;
    }
    return action;
  };
  const latestToolFailure = (): ToolFailure | null => {
    let latest: ToolFailure | null = null;
    for (const failure of unresolvedToolFailures.values()) {
      if (!latest || failure.index > latest.index) latest = failure;
    }
    return latest;
  };
  let toolFailureNudges = 0;
  let toolRepairs = 0;
  let scenarioRejections = 0;
  let requiredScenarioPassed = false;
  let scenarioCalls = 0;
  let acceptanceAudits = 0;
  let acceptanceAuditFailed = false;
  let transientRetries = 0;
  let budgetWarned = false;
  let budgetWarning: string | undefined;
  let planPath: string | undefined;
  const budgetMode = options.budgetMode ?? "stop";

  for (let index = 1; ; index += 1) {
    if (signal?.aborted) {
      stoppedReason = "aborted";
      summary = "Stopped by the user.";
      break;
    }
    const cumulativeUsage: AiTokenUsage = {
      inputTokens: tokenTotal.inputTokens + startingUsage.inputTokens,
      outputTokens: tokenTotal.outputTokens + startingUsage.outputTokens,
      totalTokens: tokenTotal.totalTokens + startingUsage.totalTokens,
    };
    // The soft guard is per attempt. startingUsage belongs to earlier attempts
    // and must not make a focused retry stop before its first model turn.
    const softUsage = tokenTotal.totalTokens;
    if (options.softTokenBudget && softUsage >= options.softTokenBudget) {
      stoppedReason = "budget";
      summary = `Soft task budget reached: ${softUsage.toLocaleString()} of ${options.softTokenBudget.toLocaleString()} tokens in this attempt${
        startingUsage.totalTokens > 0
          ? ` (${cumulativeUsage.totalTokens.toLocaleString()} total across attempts)`
          : ""
      }. The task loop will continue with a focused retry.`;
      log("warn", "Soft task budget reached", summary.slice(0, 180));
      break;
    }
    if (
      budgetMode !== "off" &&
      (options.tokenBudget || options.costBudgetUsd !== undefined)
    ) {
      const costSoFar = await estimateUsageCost(config.id, config.model, cumulativeUsage).catch(
        () => undefined,
      );
      if (budgetExceeded(cumulativeUsage, costSoFar, options.tokenBudget, options.costBudgetUsd)) {
        const message = `Task budget exceeded: ${cumulativeUsage.totalTokens.toLocaleString()} tokens${
          options.tokenBudget ? ` of ${options.tokenBudget.toLocaleString()}` : ""
        }${costSoFar !== undefined ? ` · $${costSoFar.toFixed(4)}` : ""}${
          options.costBudgetUsd !== undefined ? ` of $${options.costBudgetUsd.toFixed(4)}` : ""
        }.`;
        if (budgetMode === "stop") {
          stoppedReason = "budget";
          summary = `${message} Stopped before the next model call to avoid further cost.`;
          log("warn", "Task budget exceeded", summary.slice(0, 180));
          break;
        }
        if (!budgetWarned) {
          budgetWarned = true;
          budgetWarning = message;
          log("warn", "Task budget exceeded · continuing", message);
        }
      }
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
    if (!readOnlyMode && plan.needsWrite && changedFiles.length === 0 && !verificationPassed) {
      if (continuationMode && modelTurns >= 2 && writeNudges === 0) {
        writeNudges = 1;
        transcript.push({
          role: "system",
          content:
            "This is a continuation of your own prior analysis. The findings are already in context. Stop researching and apply the fix now: read at most one or two exact ranges to confirm line numbers, then use replace_in_file or write_file. Do not rescan the project.",
        });
        log("warn", "Continuation: start editing", "prior findings available; no rescan needed");
      } else if (modelTurns >= (microEditMode ? 2 : 4) && writeNudges === 0) {
        writeNudges = 1;
        transcript.push({
          role: "system",
          content:
            "No file has been changed yet. You have enough context. If the requested behavior already exists, verify it and finish with evidence instead of editing. Otherwise perform the requested edit now with replace_in_file or write_file. Do not read more files unless a single exact line is essential; read only that range.",
        });
        log("warn", "Write reminder", "No files changed yet; asking the model to edit now.");
      } else if (modelTurns >= (microEditMode ? 3 : 8) && writeNudges === 1) {
        writeNudges = 2;
        transcript.push({
          role: "system",
          content:
            "No file has been changed after further reading. If the requested behavior already exists, verify it and finish with evidence. Otherwise make the edit now with the smallest safe change, then verify it. If it is truly impossible, finish with the exact blocker instead of reading more files.",
        });
        log("warn", "Final write reminder", "Still no edits; asking for the smallest change");
      }
    }
    log("model", "Model is thinking…", "Planning the next tool call");
    compactTranscript();
    let truncatedReply = false;
    try {
      inputChars += transcript.reduce((total, message) => total + message.content.length, 0);
      if (inputChars > 90_000 && !largeContextLogged) {
        largeContextLogged = true;
        log(
          "warn",
          "Large context",
          `${Math.round(inputChars / 4).toLocaleString()} estimated input tokens; batched reads and shorter ranges keep this down.`,
        );
      }
      let receivedChars = 0;
      let lastStreamLog = 0;
      const completion = await chatTracked(
        projectId,
        config,
        transcript,
        {
          maxTokens: Math.max(4_000, Math.min(64_000, options.maxOutputTokens ?? 16_000)),
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
      const finishReason = completion.finishReason;
      truncatedReply =
        /length|max.?tokens/i.test(finishReason ?? "") ||
        (stepUsage !== undefined && stepUsage.outputTokens >= 7_800);
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
      const maxTokenError =
        /max_tokens|max.?output|maximum.*token|too many tokens|token limit/i.test(message);
      if (maxTokenError && (options.maxOutputTokens ?? 16_000) > 8_000) {
        log(
          "warn",
          "Output limit rejected · retrying lower",
          `${message.slice(0, 180)} · using 8000 tokens`,
        );
        options.maxOutputTokens = 8_000;
        modelTurns = Math.max(0, modelTurns - 1);
        continue;
      }
      const transient =
        /fetch failed|econnreset|etimedout|timed out|timeout|network|socket|429|rate limit|502|503|504|overloaded|temporarily unavailable|service unavailable|connection reset/i.test(
          message,
        );
      if (transient && transientRetries < 3) {
        transientRetries += 1;
        const delay = [2_000, 5_000, 10_000][transientRetries - 1] ?? 10_000;
        log(
          "warn",
          `Transient model error · retry ${transientRetries}/3`,
          `${message.slice(0, 180)} · waiting ${Math.round(delay / 1_000)}s`,
        );
        // A failed socket request should not consume a model turn.
        modelTurns = Math.max(0, modelTurns - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
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
    transientRetries = 0;
    log("info", "Plan received", `${reply.length} characters`);

    // Some providers emit a native/DSML tool-call block instead of JSON. If it
    // is parseable, accept it; otherwise retry with a strict protocol note.
    const nativeMarkup =
      /provider-native tool call omitted|<\|[^|]*\|>|DSML|<\/?tool_call|<function=|antml:/i.test(
        reply,
      );
    let recoveredNative: Record<string, unknown> | null = null;
    if (nativeMarkup) {
      try {
        const candidate = parseAgentReply(reply);
        if (typeof candidate.action === "string" && candidate.action !== "invalid") {
          recoveredNative = candidate;
          log("info", "Recovered provider-native tool call", candidate.action);
        }
      } catch {
        recoveredNative = null;
      }
    }
    if (nativeMarkup && !recoveredNative) {
      protocolRetries += 1;
      const observation =
        "Your reply used a provider-native tool call instead of the JSON action protocol. Reply again with exactly one complete JSON object using action and args. Do not emit <|...|>, DSML, <tool_call>, <function> or commentary.";
      log("warn", "Provider-native tool call rejected", `protocol retry ${protocolRetries}/2`);
      recordStep({
        index,
        action: "invalid",
        args: {},
        observation,
        ok: false,
        durationMs: Date.now() - started,
        tokenUsage: stepUsage,
      });
      transcript.push({
        role: "user",
        content: `Observation (step ${index}) [protocol]: ${observation}`,
      });
      if (protocolRetries >= 2) {
        errorMessage =
          "Stopped after 2 provider-native tool-call replies. The model did not follow the JSON action protocol.";
        stoppedReason = "error";
        break;
      }
      continue;
    }

    const cleanReply = stripCommentaryTags(stripToolCallMarkup(reply));
    transcript.push({
      role: "assistant",
      content: recoveredNative
        ? JSON.stringify(recoveredNative)
        : cleanReply || "[provider-native tool call omitted; use the JSON action protocol]",
    });

    try {
      parsed = recoveredNative ?? parseAgentReply(cleanReply || reply);
    } catch {
      log("error", "Response was not valid tool JSON", reply.replace(/\s+/g, " ").slice(0, 180));
      const commentaryOnly = /<commentary\b|<analysis\b|<thinking\b/i.test(reply);
      if (commentaryOnly) {
        const observation =
          "Remove <commentary>/<analysis>/<thinking> tags. Reply with exactly one complete JSON object using action and args. Do not explain your next move; perform it.";
        log("warn", "Commentary instead of tool JSON", "Correcting the output protocol.");
        recordStep({
          index,
          action: "invalid",
          args: {},
          observation,
          ok: false,
          durationMs: Date.now() - started,
          tokenUsage: stepUsage,
        });
        transcript.push({ role: "user", content: `Observation (step ${index}) [commentary]: ${observation}` });
        continue;
      }
      if (truncatedReply) {
        const observation =
          "Your last reply was cut off by the output limit (8000 tokens). Do not write an entire large file in one tool call. Use write_file for the first small section, then append_text for the rest, or use replace_in_file/replace_many. Keep every JSON reply complete and small enough to finish.";
        log("warn", "Response truncated", "Write in smaller chunks and keep the JSON valid.");
        recordStep({
          index,
          action: "invalid",
          args: {},
          observation,
          ok: false,
          durationMs: Date.now() - started,
          tokenUsage: stepUsage,
        });
        transcript.push({ role: "user", content: `Observation (step ${index}) [truncated]: ${observation}` });
        continue;
      }
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
    protocolRetries = 0;
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
      "read_symbol",
      "find_in_file",
      "diagnostics",
      "lsp_hover",
      "lsp_completion",
      "list_items",
      "count_matches",
      "list_colors",
      "extract_entities",
      "audit_content",
      "create_document",
      "create_zip",
      "apply_mapped_changes",
      "undo_change",
      "json_query",
      "find_symbols",
      "sqlite_query",
      "csv_query",
      "git_blame",
      "browser_check",
      "run_test_scenario",
      "list_project_tools",
      "run_project_tool",
      "delegate_research",
      "placeholder_asset",
      "list_mobile_devices",
      "boot_mobile_device",
      "mobile_screenshot",
      "open_mobile_url",
      "mobile_logs",
      "install_mobile_app",
      "launch_mobile_app",
      "mobile_check",
      "check_toolchains",
      "rescan_project",
      "install_toolchain",
      "game_check",
      "list_skills",
      "search_skills",
      "load_skill",
      "preview_skill_source",
      "install_skill",
      "set_skill_enabled",
      "remove_skill",
      "create_graphic",
      "graphic_check",
      "project_search",
      "search_conversations",
      "read_document",
      "search_document",
      "convert_document",
      "transform_image",
      "web_fetch",
      "http_request",
      "git_info",
      "git_commit",
      "git_create_branch",
      "git_remote",
      "git_push",
      "compress_video",
      "save_note",
      "list_notes",
      "read_note",
      "search_notes",
      "create_project_tool",
      "create_skill",
      "write_file",
      "replace_in_file",
      "replace_many",
      "append_text",
      "rename_path",
      "delete_file",
      "format_file",
      "run_skill_script",
      "run_command",
      "run_background",
      "stop_background",
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
        read_symbol: "Reading the enclosing symbol…",
        find_in_file: "Searching inside file…",
        diagnostics: "Checking file diagnostics…",
        lsp_hover: "Reading LSP hover…",
        lsp_completion: "Reading LSP completions…",
        list_items: "Extracting list items…",
        count_matches: "Counting matches…",
        list_colors: "Listing CSS colors…",
        extract_entities: "Extracting project entities…",
        audit_content: "Auditing assets and documents…",
        create_document: "Creating document…",
        create_zip: "Creating archive…",
        apply_mapped_changes: "Applying mapped changes…",
        undo_change: "Restoring the last backup…",
        json_query: "Inspecting JSON…",
        find_symbols: "Searching symbols…",
        sqlite_query: "Querying SQLite…",
        csv_query: "Querying CSV…",
        git_blame: "Reading git blame…",
        browser_check: "Inspecting the preview in a browser…",
        run_test_scenario: "Running a saved test scenario…",
        list_project_tools: "Listing saved project tools…",
        list_mobile_devices: "Listing mobile devices…",
        boot_mobile_device: "Booting a mobile device…",
        mobile_screenshot: "Capturing a mobile screenshot…",
        open_mobile_url: "Opening a URL on the mobile device…",
        mobile_logs: "Reading mobile logs…",
        install_mobile_app: "Installing a mobile app…",
        launch_mobile_app: "Launching a mobile app…",
        mobile_check: "Checking a mobile device…",
        check_toolchains: "Checking toolchains…",
        rescan_project: "Rescanning the project index…",
        game_check: "Checking the game scene…",
        list_skills: "Listing skills…",
        search_skills: "Searching the skill catalog…",
        load_skill: "Loading a skill…",
        preview_skill_source: "Previewing a skill source…",
        install_skill: "Installing skills…",
        set_skill_enabled: "Updating a skill…",
        remove_skill: "Removing a skill…",
        create_graphic: "Creating a graphic…",
        graphic_check: "Checking a graphic…",
        web_fetch: "Reading a web page…",
        read_document: "Reading a document…",
        search_document: "Searching inside a document…",
        search_conversations: "Searching earlier conversation…",
        project_search: "Searching the project index and evidence…",
        convert_document: "Converting a document…",
        transform_image: "Processing an image…",
        save_note: "Saving a research note…",
        list_notes: "Listing research notes…",
        read_note: "Reading a research note…",
        search_notes: "Searching research notes…",
        create_project_tool: "Creating a reusable project tool…",
        create_skill: "Creating a skill…",
        git_info: "Inspecting Git…",
        git_commit: "Creating a Git commit…",
        git_create_branch: "Creating a Git branch…",
        git_remote: "Updating a Git remote…",
        git_push: "Pushing commits…",
        http_request: "Sending an HTTP request…",
        compress_video: "Compressing a video…",
        install_toolchain: "Installing a toolchain…",
        run_project_tool: "Running saved project tool…",
        delegate_research: "Delegating read-only research…",
        placeholder_asset: "Creating a placeholder asset…",
        write_file: "Writing file…",
        replace_in_file: "Editing file…",
        append_text: "Appending to file…",
        rename_path: "Moving path…",
        delete_file: "Deleting file…",
        format_file: "Formatting file…",
        run_command: "Running command…",
        run_background: "Starting background server…",
        stop_background: "Stopping background server…",
      };
      log("tool", toolLabel[action] ?? `Running ${action}…`, agentActionTarget(args));
    }

    if (
      askMode &&
      inspectionNudged &&
      !options.intent?.needsExhaustiveEvidence &&
      READ_ONLY_ACTIONS.has(action) &&
      !VERIFICATION_ACTIONS.has(action)
    ) {
      inspectionReadRejections += 1;
      step.ok = false;
      step.observation =
        "Inspection evidence is sufficient. Call finish now with the root cause, file:line evidence and the minimal fix. Do not read more files.";
      step.durationMs = 0;
      recordStep(step);
      log("warn", "Inspection read blocked", action);
      if (inspectionReadRejections >= 2) {
        if (options.intent?.needsExhaustiveEvidence) {
          stoppedReason = "error";
          summary =
            "Stopped: the exhaustive list was not completed. Read the target with list_colors/read_file and finish with every item in the user's language.";
          errorMessage = summary;
        } else {
          stoppedReason = "finished";
          summary = buildInspectionSummary(steps);
          log("warn", "Inspection finished with collected evidence", `${steps.length} steps`);
        }
      }
      if (stoppedReason === "finished") break;
      continue;
    }

    const readBlockedAfterEdit = changedFiles.length > 0 && postEditReadNudged;
    if (
      !askMode &&
      plan.needsWrite &&
      ((!verificationPassed && changedFiles.length === 0 && writeNudges >= 2) ||
        readBlockedAfterEdit) &&
      READ_ONLY_ACTIONS.has(action) &&
      !VERIFICATION_ACTIONS.has(action)
    ) {
      if (readBlockedAfterEdit) postEditReadRejections += 1;
      else readRejections += 1;
      step.ok = false;
      step.observation = readBlockedAfterEdit
        ? "Read budget exhausted after the edit. Do not read more files. Run browser_check or game_check on the real entry page now to verify the changed behavior, fix only a concrete failure, then finish."
        : "Read budget exhausted. No file has changed yet. If the requested behavior already exists, finish with the verification evidence. Otherwise perform the edit now with replace_in_file or write_file, or finish with the exact blocker.";
      step.durationMs = 0;
      recordStep(step);
      log("warn", "Read budget exhausted", action);
      if (readRejections >= 2 || postEditReadRejections >= 2) {
        stoppedReason = "error";
        summary = readBlockedAfterEdit
          ? "Stopped after the final warning because the model kept reading after editing without verifying. No further tokens were spent."
          : "Stopped after the final warning because the model kept trying to read instead of editing. No further tokens were spent.";
      }
      if (stoppedReason === "error") break;
      continue;
    }

    const completeSource = completeColorList
      ? { kind: "color", markdown: buildColorAnswer(completeColorList) }
      : completeExtraction
        ? {
            kind: completeExtraction.kind,
            markdown: buildEntityAnswer(
              completeExtraction,
              options.language ?? "en",
            ),
          }
        : null;
    if (extractionBrief && workBrief && !completeExtraction && action !== "extract_entities") {
      extractionRejections += 1;
      step.ok = false;
      step.observation = `This is a complete ${workBrief.kind} list request. Call extract_entities with {"kind":"${workBrief.kind}"} now instead of searching or reading manually. Omit scope to scan the whole project unless the user restricted specific files.`;
      step.durationMs = Date.now() - started;
      recordStep(step);
      transcript.push({
        role: "user",
        content: `Observation (step ${index}) [extraction-required]: ${step.observation}`,
      });
      log("warn", "Extraction tool required", workBrief.kind);
      if (extractionRejections >= 2) {
        const extracted = await extractEntities(analysis, { kind: workBrief.kind });
        stoppedReason = "finished";
        summary = buildEntityAnswer(extracted, options.language ?? "en");
        log("warn", "Finished from the fallback extraction", `${workBrief.kind} · ${extracted.total}`);
      }
      if (stoppedReason === "finished") break;
      continue;
    }
    if (
      askMode &&
      (extractionBrief ||
        (options.intent?.needsExhaustiveEvidence && workBrief?.mode !== "change")) &&
      completeSource &&
      action !== "finish"
    ) {
      completeListRejections += 1;
      step.ok = false;
      step.observation = `The complete ${completeSource.kind} list is already available from the extraction tool. Call finish now with that list; do not read, count, or search again. Include every item in the user's language.`;
      step.durationMs = Date.now() - started;
      recordStep(step);
      transcript.push({
        role: "user",
        content: `Observation (step ${index}) [complete-list]: ${step.observation}`,
      });
      log("warn", "Complete list already available", "finish is required");
      if (completeListRejections >= 2) {
        stoppedReason = "finished";
        summary = completeSource.markdown;
        log("warn", "Finished from the complete extraction", `${completeSource.kind}`);
      }
      if (stoppedReason === "finished") break;
      continue;
    }

    if (
      !readOnlyMode &&
      mappedChangeVerified &&
      workBrief?.mode === "change" &&
      !compoundChange &&
      READ_ONLY_ACTIONS.has(action)
    ) {
      mapVerifyReads += 1;
      if (mapVerifyReads >= 3) {
        mapVerifyRejections += 1;
        step.ok = false;
        step.observation =
          "The mapped change is already verified: 0 old values remain. Call finish now with the changed files and the verification result. Only call apply_mapped_changes again if another mapping is still required.";
        step.durationMs = Date.now() - started;
        recordStep(step);
        transcript.push({
          role: "user",
          content: `Observation (step ${index}) [mapped-verified]: ${step.observation}`,
        });
        log("warn", "Mapped change already verified", "finish is required");
        if (mapVerifyRejections >= 2) {
          stoppedReason = "finished";
          summary = lastMappedSummary || lastMappedObservation || "Mapped changes applied and verified.";
        }
        if (stoppedReason === "finished") break;
        continue;
      }
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

      const colorRequest =
        Boolean(options.intent?.needsExhaustiveEvidence) &&
        /(?:renk|color)/i.test(
          `${instruction} ${options.intent?.understanding ?? ""}`,
        );
      if (colorRequest) {
        const coverage = await auditColorCoverage(analysis, steps, rawSummary);
        if (coverage && coverage.missing.length > 0) {
          if (colorNudges < 2) {
            colorNudges += 1;
            const observation = `The color list is incomplete: ${coverage.missing.length}/${
              coverage.total
            } unique codes from ${coverage.path} are missing (${coverage.missing
              .slice(0, 20)
              .join(
                ", ",
              )}). Call list_colors on ${coverage.path} and include every occurrence and unique code in the final answer. Write the entire answer in the user's language; do not summarize or omit entries.`;
            log("warn", "Finish rejected: incomplete color list", `${coverage.missing.length} missing`);
            recordStep({
              index,
              action: "invalid",
              args: {},
              observation,
              ok: false,
              durationMs: Date.now() - started,
              tokenUsage: stepUsage,
            });
            transcript.push({ role: "user", content: `Observation (step ${index}) [colors]: ${observation}` });
            continue;
          }
          if (completeColorList) {
            stoppedReason = "finished";
            summary = buildColorAnswer(completeColorList);
            log("warn", "Finished from the complete color list", `${completeColorList.unique.length} unique colors`);
            break;
          }
          if (completeExtraction?.kind === "color") {
            stoppedReason = "finished";
            summary = buildEntityAnswer(completeExtraction, options.language ?? "en");
            log("warn", "Finished from the extracted color list", `${completeExtraction.unique} unique colors`);
            break;
          }
          stoppedReason = "error";
          summary = `Stopped: the complete color list was not produced. ${coverage.missing.length}/${coverage.total} codes from ${coverage.path} are still missing. Run list_colors and include every code in the answer.`;
          errorMessage = summary;
          log("error", "Stopped with an incomplete color list", `${coverage.missing.length} missing`);
          break;
        }
      }

      if (
        !readOnlyMode &&
        syntaxFailures.length > 0 &&
        modelTurns < maxSteps &&
        syntaxNudges < 3
      ) {
        syntaxNudges += 1;
        const observation = `Syntax diagnostics failed after the edit:\n${syntaxFailures
          .map((item) => `- ${item.file}: ${item.output.slice(0, 600)}`)
          .join("\n")}\nFix the syntax errors before finishing.`;
        log("warn", "Finish rejected: syntax diagnostics", syntaxFailures.map((item) => item.file).join(", "));
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

      if (!readOnlyMode && syntaxFailures.length > 0) {
        // Never report a successful finish while the edited file cannot even be
        // parsed. Stop as failed so the user can continue with a stronger model.
        stoppedReason = "error";
        summary = `Task stopped: syntax errors remain after ${syntaxNudges + 1} repair attempts.\n\n${syntaxFailures
          .map((item) => `**${item.file}**\n${item.output.slice(0, 900)}`)
          .join("\n\n")}\n\nThe file was left as written. Continue with a stronger model, or fix the syntax manually.`;
        errorMessage = "Syntax errors remained after the edit.";
        log("error", "Stopped with syntax errors", syntaxFailures.map((item) => item.file).join(", "));
        break;
      }

      if (!readOnlyMode && unreferencedAssets.length > 0 && assetNudges < 2) {
        assetNudges += 1;
        const observation = `Finish rejected: ${unreferencedAssets.join(
          " ",
        )} Add the missing <script src> / <link href> or import so the changed asset is actually loaded.`;
        log("warn", "Finish rejected: asset not loaded", unreferencedAssets.join(", "));
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

      const taskContextText = `${options.goalText ?? ""}\n${options.acceptance ?? ""}\n${options.workBriefText ?? ""}\n${instruction.slice(0, 4_000)}`;
      const removalContext =
        /(?:remove|delete|hide|drop|kaldır|sil|gizle)/i.test(taskContextText) &&
        /(?:list|menu|panel|button|section|selector|level-select|harita|liste|menü|düğme|buton)/i.test(
          taskContextText,
        );
      if (
        !readOnlyMode &&
        !testTask &&
        !options.microEdit &&
        modelTurns < maxSteps &&
        wiringNudges < 2 &&
        !(mappedChangeVerified && workBrief?.mode === "change" && workBrief.kind === "color" && !compoundChange) &&
        reportsIncompleteWiring(rawSummary, removalContext)
      ) {
        wiringNudges += 1;
        const observation =
          "Your own summary says the change is incomplete (missing markup, form control or wiring). Complete it now: add the missing input/control and update the data, render and persistence paths, then finish with the full result.";
        log(
          "warn",
          "Finish rejected: incomplete wiring",
          rawSummary.replace(/\s+/g, " ").slice(0, 160),
        );
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

      const explainedMissingSelectors =
        missingSelectors.length > 0 &&
        /dynamic|runtime|created|generated|oluştur|dinamik|çalışma anında/i.test(rawSummary) &&
        missingSelectors.every((item) =>
          rawSummary.toLowerCase().includes(item.id.toLowerCase()),
        );
      if (
        !readOnlyMode &&
        missingSelectors.length > 0 &&
        !explainedMissingSelectors &&
        modelTurns < maxSteps &&
        selectorNudges < 2
      ) {
        selectorNudges += 1;
        const detail = missingSelectors
          .map((item) => `#${item.id} (referenced in ${item.file})`)
          .join(", ");
        const observation = `UI wiring is incomplete: ${detail} is referenced but not defined in any project markup. Add the missing input/control to the HTML/template (or explain why it is created dynamically), then finish with the complete change.`;
        log("warn", "Finish rejected: missing UI control", detail);
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
        workspaceMode !== "plan" &&
        looksLikePlanningText(rawSummary)
      ) {
        planningNudges += 1;
        const observation = readOnlyMode
          ? "Your finish summary is an internal plan or next-step note, not an answer. Do not finish with phrases like 'need to read', 'let's check' or 'I will inspect'. Call the needed tool now, collect the evidence, then finish with the actual answer in Markdown. If something truly blocks you, state the exact blocker and what you tried."
          : "Your finish summary is a next-step note, not a completed change. Do not finish with phrases like 'let me read', 'I will inspect' or 'need to check'. Make the requested edit now, verify it, and only then finish with the actual changed files and result.";
        log(
          "warn",
          "Finish rejected: internal plan",
          rawSummary.replace(/\s+/g, " ").slice(0, 160),
        );
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
        if (planningNudges >= 2) {
          stoppedReason = "error";
          errorMessage =
            "The model kept returning an internal plan instead of an answer. Retry or switch to a stronger model.";
          summary = errorMessage;
          break;
        }
        continue;
      }

      if (options.intent?.needsExhaustiveEvidence && evidenceNudges < 3) {
        const lastTruncated = steps.reduce(
          (max, item) =>
            /truncated|cut off|only part|not all/i.test(item.observation) &&
            ["read_document", "read_file", "search_document"].includes(item.action)
              ? Math.max(max, item.index)
              : max,
          -1,
        );
        const completeAfter = steps.some(
          (item) =>
            item.index > lastTruncated &&
            item.ok &&
            [
              "read_document",
              "read_file",
              "read_symbol",
              "search_document",
              "search_code",
              "find_in_file",
              "count_matches",
            ].includes(item.action) &&
            !/truncated|cut off|only part/i.test(item.observation),
        );
        const admitsIncomplete =
          /truncated|cut off|only part|not all|kalan.*görüntülenemedi|kesildi/i.test(rawSummary);
        const summaryHasDeliverable =
          rawSummary.split("\n").filter((line) => line.trim()).length >= 6 &&
          /(?:^|\n)\s*(?:\||\d+\.|[-*])\s/.test(rawSummary);
        if (
          !summaryHasDeliverable &&
          ((lastTruncated >= 0 && !completeAfter) || admitsIncomplete)
        ) {
          evidenceNudges += 1;
          const observation =
            "The answer is not exhaustive. Do not finish with a partial list or a truncated read. Use search_document/count_matches or continue read_document with the returned startChar (or read_file with startLine) until every item is collected, verify the total, then finish with the complete result.";
          log("warn", "Finish rejected: evidence incomplete", rawSummary.replace(/\s+/g, " ").slice(0, 160));
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
      }

      if (
        !readOnlyMode &&
        !testTask &&
        !options.microEdit &&
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

      const toolFailure = latestToolFailure();
      if (
        !readOnlyMode &&
        toolFailure &&
        !(browserCheckBlocked && toolFailure.action === "browser_check") &&
        !/Project tool .* was not found|No saved project tools exist/i.test(
          toolFailure.observation,
        ) &&
        toolFailureNudges < 2 &&
        modelTurns < maxSteps &&
        (changedFiles.length === 0 ||
          /(?:bloker|blocked|could not|couldn't|unable to|not applied|uygulanamadı|reddedildi|değişiklik yapılmadı|hiçbir değişiklik|failed)/i.test(
            rawSummary,
          ))
      ) {
        toolFailureNudges += 1;
        const observation = `Finish rejected: your last ${toolFailure.action} call failed and was not resolved. Fix the call and complete the work yourself instead of stopping.\nError: ${toolFailure.observation.slice(0, 700)}${toolArgHint(
          toolFailure.action,
        )}`;
        log(
          "warn",
          "Finish rejected: unresolved tool error",
          `${toolFailure.action} · ${toolFailure.observation.slice(0, 140)}`,
        );
        recordStep({
          index,
          action: "invalid",
          args: {},
          observation,
          ok: false,
          durationMs: Date.now() - started,
          tokenUsage: stepUsage,
        });
        transcript.push({ role: "user", content: `Observation (step ${index}) [tool-error]: ${observation}` });
        continue;
      }

      const acceptanceText = options.acceptance?.trim() ?? "";
      const noChangeClaim =
        changedFiles.length === 0 &&
        /(?:already|no changes?|nothing to change|no edit|zaten|gerek yok|mevcut|uygulanmış|eklenmiş|yapılmış)/i.test(
          rawSummary,
        );
      if (
        !readOnlyMode &&
        plan.needsWrite &&
        acceptanceText &&
        noChangeClaim &&
        acceptanceAudits < (acceptanceAuditFailed ? 2 : 1) &&
        modelTurns < maxSteps
      ) {
        acceptanceAudits += 1;
        const audit = await auditNoChangeAcceptance(
          projectId,
          config,
          `${instruction}\n\nAcceptance: ${acceptanceText}`,
          rawSummary,
          steps,
        );
        if (audit && !audit.ok) {
          acceptanceAuditFailed = true;
          const observation = `Finish rejected: the acceptance criteria are not proven.\n- ${audit.missing.length > 0 ? audit.missing.join("\n- ") : "The evidence does not demonstrate the requested end state."}\nDo not claim a visual/layout change from a similar input guard. Implement the missing change or cite exact file:line and runtime evidence for every acceptance item, then finish.`;
          log("warn", "Finish rejected: acceptance not proven", audit.missing.join("; ").slice(0, 200));
          recordStep({
            index,
            action: "invalid",
            args: {},
            observation,
            ok: false,
            durationMs: Date.now() - started,
            tokenUsage: stepUsage,
          });
          transcript.push({
            role: "user",
            content: `Observation (step ${index}) [acceptance]: ${observation}`,
          });
          if (acceptanceAudits >= 2) {
            stoppedReason = "aborted";
            summary = `Acceptance audit failed twice with no new evidence: ${
              audit.missing.join("; ").slice(0, 500) || "the acceptance criteria are not proven"
            }. Stopped to prevent a retry loop.`;
            break;
          }
          continue;
        }
      }

      if (options.requiredScenario && !requiredScenarioPassed) {
        const scenario = options.requiredScenario;
        const runScenario = () =>
          runBrowserCheck(analysis.id, analysis.rootPath, {
            path: scenario.path,
            url: scenario.url,
            steps: scenario.steps,
            timeoutMs: scenario.timeoutMs,
            signal,
          }).catch((error: unknown) => ({
            ok: false,
            summary: error instanceof Error ? error.message : "Required scenario failed.",
            steps: [] as { index: number; action: string; ok: boolean; detail: string }[],
          }));
        let check = await runScenario();
        if (!check.ok) {
          // Page loads and the ?test=1 hook can race under load. Retry once on
          // a fresh page before rejecting an implementation that is correct.
          await new Promise((resolve) => setTimeout(resolve, 250));
          const retry = await runScenario();
          if (retry.ok) {
            check = retry;
          } else if (retry.steps.some((step) => !step.ok)) {
            check = retry;
          }
        }
        if (check.ok) {
          requiredScenarioPassed = true;
          log("success", "Required scenario passed", scenario.name);
        } else {
          scenarioRejections += 1;
          const failed = check.steps
            .filter((item) => !item.ok)
            .map((item) => `#${item.index} ${item.action}: ${item.detail.slice(0, 300)}`)
            .join("\n");
          const observation = `Finish rejected: required scenario ${scenario.name} failed.\n${check.summary}${
            failed ? `\n${failed}` : ""
          }\nFix the implementation or the scenario, run the scenario again, and do not finish until it passes.`;
          log("warn", "Finish rejected: required scenario failed", scenario.name);
          recordStep({
            index,
            action: "invalid",
            args: {},
            observation,
            ok: false,
            durationMs: Date.now() - started,
            tokenUsage: stepUsage,
          });
          transcript.push({
            role: "user",
            content: `Observation (step ${index}) [scenario]: ${observation}`,
          });
          if (scenarioRejections >= 2) {
            stoppedReason = "error";
            errorMessage = `Required scenario ${scenario.name} failed twice. The task is not verified. ${check.summary}`;
            break;
          }
          continue;
        }
      }

      const projectHasHtml = analysis.files.some((file) => /\.html?$/i.test(file.path));
      const uiFilesChanged = changedFiles.some(
        (file) =>
          /\.(?:html?|css|scss|sass|less|jsx|tsx|vue|svelte)$/i.test(file) ||
          (projectHasHtml && /\.(?:m?js)$/i.test(file)),
      );
      const claimsApplied =
        /(?:uygulandı|düzeltildi|düzelttim|fixed|applied|değiştirildi|güncellendi|implemented)/i.test(
          rawSummary,
        ) &&
        !/(?:no (?:file|change)|not applied|not changed|already (?:present|exists|implemented|applied|there|complete)|no changes? (?:are )?(?:needed|required)|nothing to change|uygulanamadı|değişiklik yapılmadı|hiçbir değişiklik|zaten (?:var|mevcut|tamam)|değişiklik gerekmiyor)/i.test(
          rawSummary,
        );
      const claimsVerified =
        /(?:doğrulandı|doğruladım|verified|tested|passed|geçti|✅)/i.test(rawSummary) &&
        !/(?:not verified|unverified|doğrulanamadı|test edilemedi)/i.test(rawSummary);
      const explainedNoCheck =
        /(?:tarayıcı (?:yok|kullanılamıyor)|browser (?:is )?(?:not available|unavailable)|cannot run (?:a )?browser|mümkün değil)/i.test(
          rawSummary,
        );

      if (
        !readOnlyMode &&
        claimNudges < 1 &&
        changedFiles.length === 0 &&
        claimsApplied
      ) {
        claimNudges += 1;
        const observation =
          "Your summary says the change was applied, but no file was actually changed. Do not report a fix that was not written. Make the edit now with write_file or replace_in_file, or state clearly that nothing needed to change and why. Partial rewrites that produce identical content do not count.";
        log("warn", "Finish rejected: claimed change without an edit", rawSummary.replace(/\s+/g, " ").slice(0, 160));
        recordStep({
          index,
          action: "invalid",
          args: {},
          observation,
          ok: false,
          durationMs: Date.now() - started,
          tokenUsage: stepUsage,
        });
        transcript.push({ role: "user", content: `Observation (step ${index}) [claim]: ${observation}` });
        continue;
      }

      if (
        !readOnlyMode &&
        !mappedChangeVerified &&
        verifyNudges < 1 &&
        projectHasHtml &&
        uiFilesChanged &&
        !explainedNoCheck &&
        options.microEdit !== true &&
        realBrowserChecks + realScenarioRuns === 0 &&
        modelTurns >= 2
      ) {
        verifyNudges += 1;
        const observation =
          "No verification ran against the real project entry page. A synthetic harness under .cie/ does not prove the app, even when it passes. Run browser_check or run_test_scenario on the real entry page (for example index.html). If the target state is hard to reach, use an eval step on the real page to put it in that state, then assert it with expectText/expectVisible/expectStable. Then finish.";
        log("warn", "Finish rejected: no real-page verification", "synthetic checks do not count");
        await appendLesson(
          analysis.rootPath,
          "A synthetic harness under .cie/ is not proof. Verify the real project entry page; use an eval step to reach a hidden state, then assert it.",
        ).catch(() => {});
        recordStep({
          index,
          action: "invalid",
          args: {},
          observation,
          ok: false,
          durationMs: Date.now() - started,
          tokenUsage: stepUsage,
        });
        transcript.push({ role: "user", content: `Observation (step ${index}) [verify]: ${observation}` });
        continue;
      }

      if (
        !readOnlyMode &&
        !mappedChangeVerified &&
        verifyNudges < 2 &&
        uiFilesChanged &&
        claimsVerified &&
        realCheckAssertions === 0 &&
        !explainedNoCheck
      ) {
        verifyNudges += 1;
        const observation =
          "Your real-page check only proved that the page loads. Assert the changed behavior itself with expectText, expectValue, expectStable or expectCount on the real entry page before claiming verification. A passing harness or a screenshot is not behavior evidence.";
        log("warn", "Finish rejected: no behavior assertion", "real check had no expect* step");
        await appendLesson(
          analysis.rootPath,
          "A real check that only proves the page loads is not verification. Assert the changed behavior with expectText/expectValue/expectStable/expectCount.",
        ).catch(() => {});
        recordStep({
          index,
          action: "invalid",
          args: {},
          observation,
          ok: false,
          durationMs: Date.now() - started,
          tokenUsage: stepUsage,
        });
        transcript.push({ role: "user", content: `Observation (step ${index}) [verify]: ${observation}` });
        continue;
      }

      if (!readOnlyMode && changedFiles.length > 0) {
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
          rawSummary = `${rawSummary}\n\n**Verification:** \`${verification.command}\` passed.`.trim();
        } else if (verification.ran && !verification.ok) {
          rawSummary = `${rawSummary}\n\n**Verification failed:** \`${verification.command}\`\n\`\`\`\n${verification.output.slice(0, 3_000)}\n\`\`\``.trim();
        } else if (verification.output) {
          rawSummary = `${rawSummary}\n\n**Verification:** ${verification.output}`.trim();
        }
      }

      if (rawSummary.trim()) {
        const commandEvidence = steps
          .filter((step) => step.action === "run_command")
          .map((step) => ({
            command: String(step.args.command ?? ""),
            ok: step.ok,
          }));
        const audit = auditClaims(rawSummary, {
          changedFiles,
          readFiles: [...readMap.keys()],
          commands: commandEvidence,
          verification: {
            ran: lastVerification?.ran === true,
            ok: lastVerification?.ok === true,
            command: lastVerification?.command,
          },
          browserChecks: [
            {
              ok: realBrowserChecks > 0 || realScenarioRuns > 0,
              assertions: realCheckAssertions,
            },
          ],
          extractionComplete: Boolean(completeExtraction && completeExtraction.total > 0),
          mappedChangeVerified,
          readOnly: readOnlyMode,
        });
        if (audit.issues.length > 0) {
          const observation = `Finish rejected: the summary claims more than the tools proved.\n- ${audit.issues.join(
            "\n- ",
          )}\nRun the missing read/test/browser check or correct the summary. Do not claim verification without evidence.`;
          if (claimAuditNudges < 1) {
            claimAuditNudges += 1;
            log(
              "warn",
              "Finish rejected: unsupported claim",
              audit.issues.join(" · ").slice(0, 200),
            );
            recordStep({
              index,
              action: "invalid",
              args: {},
              observation,
              ok: false,
              durationMs: Date.now() - started,
              tokenUsage: stepUsage,
            });
            transcript.push({
              role: "user",
              content: `Observation (step ${index}) [claim-audit]: ${observation}`,
            });
            continue;
          }
          rawSummary = `${rawSummary}\n\n**Evidence warning:** ${audit.issues.join(" ")}`.trim();
        }
      }

      if (askMode && completeExtraction && completeExtraction.total > 0) {
        const answerText = rawSummary.toLowerCase();
        const missing = completeExtraction.items.filter((item) => {
          const primary =
            item.values.name ||
            item.values.color ||
            item.values.text ||
            item.values.href ||
            item.values.file ||
            item.key;
          return primary ? !answerText.includes(primary.toLowerCase()) : true;
        });
        if (missing.length > 0) {
          rawSummary = `${rawSummary}\n\n${buildEntityAnswer(
            completeExtraction,
            options.language ?? "en",
          )}`;
          log(
            "info",
            "Appended complete extraction table",
            `${missing.length} item(s) were missing from the summary`,
          );
        }
      }
      summary = rawSummary || "The agent finished without a summary.";
      if (!readOnlyMode && missingSelectors.length > 0 && !explainedMissingSelectors) {
        summary += `\n\n**UI wiring warning:** ${missingSelectors
          .map((item) => `#${item.id} (${item.file})`)
          .join(", ")} is referenced but not defined in any project markup.`;
      }
      if (!readOnlyMode && syntaxFailures.length > 0) {
        summary += `\n\n**Syntax diagnostics:** ${syntaxFailures
          .map((item) => `${item.file} — ${item.output.slice(0, 300)}`)
          .join("; ")}`;
      }
      if (
        !readOnlyMode &&
        browserCheckCalls === 0 &&
        changedFiles.some((file) => /\.(?:html?|css|scss|sass|less|jsx|tsx|vue|svelte)$/i.test(file))
      ) {
        summary += "\n\n**UI check:** browser_check was not run for the changed interface.";
      }
      if (workspaceMode === "plan" && summary.trim()) {
        const savedPlan = await savePlan(analysis.rootPath, summary, {
          goal: instruction,
        }).catch(() => null);
        if (savedPlan) {
          planPath = savedPlan.path;
          log("success", "Plan saved", savedPlan.path);
        }
      }
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
      const argumentError = validateToolArgs(action, args);
      if (argumentError) throw new Error(argumentError);
      const toolContext: AgentToolContext = {
        projectId,
        analysis,
        args,
        readOnly: readOnlyMode,
        liveBrowser: options.liveBrowser === true,
        signal,
        log,
        requirePermission,
        evidence,
        changedFiles,
        ranCommands,
        invalidate: invalidateReadCaches,
        normalizePath: (value) => normalizeAgentPath(analysis.rootPath, value),
        pathFromArgs,
        isSecretPath: isSecretAgentPath,
      };
      const registeredResult = await runRegisteredTool(action, toolContext);
      if (registeredResult) {
        observation = registeredResult.observation;
        ok = registeredResult.ok;
        if (ok && action === "load_skill" && typeof args.key === "string") {
          usedSkills.push(args.key);
        }
      }
      if (!registeredResult) {
        actionCacheKeyValue = READ_ONLY_ACTIONS.has(action)
          ? `${action}:${stableActionKey(args)}`
          : "";
        cachedAction = actionCacheKeyValue ? readOnlyCache.get(actionCacheKeyValue) : undefined;
        if (cachedAction) {
        observation = `Already executed in step ${cachedAction.step} with the same arguments. Reuse that observation; do not repeat this call.`;
        ok = cachedAction.ok;
        log("info", "Skipped duplicate tool call", `${action} · step ${cachedAction.step}`);
      } else if (action === "list_files") {
        const rawPrefix = normalizeAgentPath(analysis.rootPath, pathFromArgs(args));
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
          recordRead(result.path, result.line, result.line, false, "search_code");
        }
        log(
          "info",
          found.source === "index" ? "Index search completed" : "Disk scan completed",
          `${found.results.length} matches · ${query}`,
        );
        ok = true;
      } else if (action === "git_blame") {
        const filePath = normalizeAgentPath(analysis.rootPath, pathFromArgs(args));
        if (!filePath) throw new Error("A file path is required.");
        if (isSecretAgentPath(filePath)) throw new Error("Reading environment, key or Git internals files is denied.");
        const startLine = Math.max(1, Number(args.startLine ?? 1) || 1);
        const endLine = Math.max(startLine, Number(args.endLine ?? startLine + 39) || startLine + 39);
        const blame = await getGitBlame(analysis.rootPath, filePath, startLine, endLine);
        observation = `Git blame: ${filePath}:${startLine}-${endLine}\n${clampObservation(blame, 2_800)}`;
        evidence.push({ path: filePath, label: "Git blame", startLine, endLine });
        recordRead(filePath, startLine, endLine, false, "git_blame");
        log("info", "Git blame read", `${filePath}:${startLine}-${endLine}`);
        ok = true;
      } else if (action === "sqlite_query") {
        const filePath = normalizeAgentPath(analysis.rootPath, pathFromArgs(args));
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
        const filePath = normalizeAgentPath(analysis.rootPath, pathFromArgs(args));
        if (!filePath) throw new Error("A CSV path is required.");
        if (isSecretAgentPath(filePath)) throw new Error("Reading environment, key or Git internals files is denied.");
        observation = await queryCsvFile(analysis.rootPath, filePath, args);
        evidence.push({ path: filePath, label: "CSV query" });
        log("info", "CSV query executed", filePath);
        ok = true;
      } else if (action === "read_symbol") {
        const rawName = String(args.name ?? args.query ?? "").trim();
        const rawPath = typeof args.path === "string" ? args.path : "";
        const targetLine = Math.max(0, Number(args.line ?? args.startLine ?? 0) || 0);
        if (!rawName && !rawPath) {
          throw new Error("Provide a symbol name, or a path plus line.");
        }
        const normalizedPath = rawPath
          ? normalizeAgentPath(analysis.rootPath, rawPath)
          : undefined;
        if (normalizedPath && isSecretAgentPath(normalizedPath)) {
          throw new Error("Reading environment, key or Git internals files is denied.");
        }
        let candidates = analysis.symbols.filter((symbol) => {
          if (normalizedPath && symbol.filePath !== normalizedPath) return false;
          if (!rawName) return true;
          const needle = rawName.toLowerCase();
          return (
            symbol.name.toLowerCase().includes(needle) ||
            symbol.qualifiedName.toLowerCase().includes(needle)
          );
        });
        if (targetLine > 0) {
          const enclosing = candidates
            .filter((symbol) => symbol.startLine <= targetLine && symbol.endLine >= targetLine)
            .sort(
              (a, b) =>
                (a.endLine - a.startLine) - (b.endLine - b.startLine),
            );
          if (enclosing.length > 0) candidates = [enclosing[0]];
        }
        candidates = candidates
          .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))
          .slice(0, 12);

        if (candidates.length === 0) {
          if (normalizedPath && targetLine > 0) {
            const file = await readSourceFile(analysis.rootPath, normalizedPath);
            const lines = file.content.split("\n");
            const startLine = Math.max(1, targetLine - 20);
            const endLine = Math.min(lines.length, targetLine + 60);
            const window = lines.slice(startLine - 1, endLine).join("\n");
            observation = `No indexed symbol at ${normalizedPath}:${targetLine}. Showing ${startLine}-${endLine} instead.\n${numberedContent(
              window.length > 6_000 ? `${window.slice(0, 6_000)}\n… truncated …` : window,
              startLine,
            )}`;
            evidence.push({ path: normalizedPath, label: "Focused range", startLine, endLine });
            log("info", "Symbol not indexed; read focused range", `${normalizedPath}:${targetLine}`);
            ok = true;
          } else {
            observation = `No indexed symbol matched "${rawName}"${
              normalizedPath ? ` in ${normalizedPath}` : ""
            }. Try find_symbols or project_search.`;
            ok = true;
          }
        } else if (candidates.length > 1) {
          const seen = new Set<string>();
          observation = [
            `Multiple symbols match. Choose one and call read_symbol again with its name and path.`,
            ...candidates
              .filter((symbol) => {
                const key = `${symbol.filePath}:${symbol.startLine}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
              })
              .map(
                (symbol) =>
                  `- ${symbol.kind} ${symbol.qualifiedName} — ${symbol.filePath}:${symbol.startLine}-${symbol.endLine}`,
              ),
          ].join("\n");
          ok = true;
        } else {
          const symbol = candidates[0];
          const file = await readSourceFile(analysis.rootPath, symbol.filePath);
          const lines = file.content.split("\n");
          const startLine = Math.max(1, symbol.startLine);
          const endLine = Math.min(lines.length, Math.max(startLine, symbol.endLine));
          const window = lines.slice(startLine - 1, endLine).join("\n");
          observation = [
            `Symbol: ${symbol.kind} ${symbol.qualifiedName} — ${symbol.filePath}:${startLine}-${endLine}`,
            symbol.signature ? `Signature: ${symbol.signature}` : "",
            "",
            numberedContent(
              window.length > 8_000 ? `${window.slice(0, 8_000)}\n… symbol truncated …` : window,
              startLine,
            ),
          ]
            .filter(Boolean)
            .join("\n");
          evidence.push({
            path: symbol.filePath,
            label: symbol.qualifiedName,
            startLine,
            endLine,
          });
          const ranges = readCoverage.get(symbol.filePath) ?? [];
          ranges.push({
            start: startLine,
            end: endLine,
            wholeFile: startLine === 1 && endLine >= lines.length,
            step: index,
            observation,
          });
          readCoverage.set(symbol.filePath, ranges);
          recordRead(
            symbol.filePath,
            startLine,
            endLine,
            startLine === 1 && endLine >= lines.length,
            "read_symbol",
            symbol.qualifiedName,
          );
          log(
            "info",
            "Symbol read",
            `${symbol.qualifiedName} · ${symbol.filePath}:${startLine}-${endLine}`,
          );
          ok = true;
        }
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
        const filePath = normalizeAgentPath(analysis.rootPath, pathFromArgs(args));
        if (!filePath) throw new Error("A file path is required.");
        if (isSecretAgentPath(filePath)) throw new Error("Reading environment, key or Git internals files is denied.");
        const requestedStart = Math.max(1, Number(args.startLine ?? 1) || 1);
        const openEnd = args.endLine === undefined;
        const wholeFile = openEnd && requestedStart === 1;
        const requestedEnd = openEnd
          ? Number.POSITIVE_INFINITY
          : Math.max(requestedStart, Number(args.endLine) || requestedStart);
        const ranges = readCoverage.get(filePath) ?? [];
        const coveredEntry = ranges.find(
          (entry) =>
            entry.start <= requestedStart &&
            (wholeFile ? entry.wholeFile : entry.end >= requestedEnd),
        );
        const covered = readRangeCovered(ranges, requestedStart, wholeFile, requestedEnd);
        if (covered && coveredEntry) {
          const cachedContent =
            !tightReadsMode && coveredEntry.observation
              ? clampObservation(coveredEntry.observation, 3_000)
              : "";
          observation =
            `Cached read: ${filePath}${
              wholeFile ? " (whole file)" : `:${requestedStart}-${requestedEnd}`
            } from step ${coveredEntry.step}. Do not request this range again; use this evidence for the answer or make only the smallest missing edit.` +
            (cachedContent ? `\n\n${cachedContent}` : " Reuse the earlier observation.");
          log("info", "Read served from context cache", `${filePath} · step ${coveredEntry.step}`);
          ok = true;
        } else {
          const file = await readSourceFile(analysis.rootPath, filePath);
          const lines = file.content.split("\n");
          const narrowEditActive =
            !askMode &&
            plan.needsWrite &&
            options.intent?.kind === "edit" &&
            (options.intent.scope === "trivial" || options.intent.scope === "small");
          const requestedSpan = openEnd
            ? Number.POSITIVE_INFINITY
            : requestedEnd - requestedStart + 1;
          // A focused read that is one line over the limit should be clamped,
          // not rejected: the rejection stays "unresolved" and blocks finish.
          const fullReadFriendly = lines.length <= FULL_READ_MAX_LINES;
          const narrowClipped =
            narrowEditActive &&
            !fullReadFriendly &&
            lines.length > NARROW_EDIT_MAX_READ_LINES &&
            requestedSpan > NARROW_EDIT_MAX_READ_LINES;
          const startLine = requestedStart;
          const endLine = Math.max(
            startLine,
            Math.min(
              lines.length,
              openEnd
                ? fullReadFriendly
                  ? lines.length
                  : startLine + (narrowClipped ? NARROW_EDIT_MAX_READ_LINES - 1 : 260)
                : narrowClipped
                  ? startLine + NARROW_EDIT_MAX_READ_LINES - 1
                  : requestedEnd,
            ),
          );
          const window = lines.slice(startLine - 1, endLine).join("\n");
          const clipped = window.length > AGENT_READ_CHARS ? `${window.slice(0, AGENT_READ_CHARS)}\n… file window truncated; continue with startLine=${endLine + 1} …` : window;
          observation = `File: ${file.filePath} (${lines.length} lines, showing ${startLine}-${Math.min(endLine, lines.length)})${
            narrowClipped
              ? `\n(Focused read limited to ${NARROW_EDIT_MAX_READ_LINES} lines; continue with startLine=${Math.min(endLine + 1, lines.length)} if needed.)`
              : ""
          }\n${numberedContent(clipped, startLine)}`;
          evidence.push({ path: file.filePath, label: "Read by agent", startLine });
          ranges.push({
            start: startLine,
            end: endLine,
            wholeFile: startLine === 1 && endLine >= lines.length,
            step: index,
          });
          readCoverage.set(filePath, ranges);
          recordRead(
            file.filePath,
            startLine,
            Math.min(endLine, lines.length),
            wholeFile,
            "read_file",
          );
          log("info", `${lines.length} lines read`, `${file.filePath} (${startLine}-${Math.min(endLine, lines.length)})`);
          ok = true;
        }
      } else if (action === "diagnostics") {
        const filePath = normalizeAgentPath(analysis.rootPath, pathFromArgs(args));
        if (!filePath) throw new Error("A file path is required.");
        if (isSecretAgentPath(filePath)) throw new Error("Reading environment, key or Git internals files is denied.");
        const lsp = await lspDiagnostics(analysis.rootPath, filePath).catch(() => null);
        if (lsp?.supported) {
          const issues = lsp.diagnostics.filter(
            (item) => item.severity === "error" || item.severity === "warning",
          );
          observation = `LSP diagnostics: ${filePath} — ${lsp.diagnostics.length} issue(s)${
            issues.length > 0
              ? `\n${issues
                  .slice(0, 60)
                  .map(
                    (item) =>
                      `- ${item.line}:${item.character} ${item.severity}${item.code ? ` [${item.code}]` : ""} ${item.message}`,
                  )
                  .join("\n")}`
              : "\nNo errors or warnings."
          }`;
          ok = !lsp.diagnostics.some((item) => item.severity === "error");
        } else {
          const result = await checkFileSyntax(analysis, filePath);
          observation = result.supported
            ? `Diagnostics: ${result.filePath} — ${result.ok ? "OK" : "FAILED"}${
                result.command ? `\nCommand: ${result.command}` : ""
              }\n${(result.output || "No diagnostics reported.").slice(0, 3_000)}`
            : `Diagnostics unavailable for ${result.filePath}: ${result.output}`;
          ok = result.supported ? result.ok : true;
        }
        evidence.push({ path: filePath, label: "Diagnostics" });
        recordRead(filePath, undefined, undefined, false, "diagnostics");
        log(ok ? "info" : "warn", ok ? "Diagnostics checked" : "Diagnostics failed", filePath);
      } else if (action === "lsp_hover") {
        const filePath = normalizeAgentPath(analysis.rootPath, pathFromArgs(args));
        if (!filePath) throw new Error("A file path is required.");
        if (isSecretAgentPath(filePath)) throw new Error("Reading environment, key or Git internals files is denied.");
        const hover = await lspHover(
          analysis.rootPath,
          filePath,
          Math.max(1, Number(args.line) || 1),
          Math.max(1, Number(args.character) || 1),
        );
        observation = hover?.contents?.trim() || `No LSP hover information at ${filePath}:${args.line ?? 1}.`;
        evidence.push({ path: filePath, label: "LSP hover" });
        recordRead(filePath, undefined, undefined, false, "lsp_hover");
        log(hover ? "info" : "warn", hover ? "LSP hover read" : "LSP hover empty", filePath);
        ok = true;
      } else if (action === "lsp_completion") {
        const filePath = normalizeAgentPath(analysis.rootPath, pathFromArgs(args));
        if (!filePath) throw new Error("A file path is required.");
        if (isSecretAgentPath(filePath)) throw new Error("Reading environment, key or Git internals files is denied.");
        const items = await lspCompletion(
          analysis.rootPath,
          filePath,
          Math.max(1, Number(args.line) || 1),
          Math.max(1, Number(args.character) || 1),
        );
        observation = items.length > 0
          ? `LSP completions at ${filePath}:${args.line ?? 1}:\n${items
              .slice(0, 40)
              .map((item) => `- ${item.label}${item.detail ? ` — ${item.detail}` : ""}`)
              .join("\n")}`
          : `No LSP completions at ${filePath}:${args.line ?? 1}.`;
        evidence.push({ path: filePath, label: "LSP completion" });
        recordRead(filePath, undefined, undefined, false, "lsp_completion");
        log(items.length > 0 ? "info" : "warn", "LSP completions read", `${items.length} items`);
        ok = true;
      } else if (action === "find_in_file") {
        const filePath = normalizeAgentPath(analysis.rootPath, pathFromArgs(args));
        const query = String(args.query ?? "").trim();
        if (!filePath) throw new Error("A file path is required.");
        if (!query) throw new Error("A search query is required.");
        if (isSecretAgentPath(filePath)) throw new Error("Reading environment, key or Git internals files is denied.");
        const fullRead = (readCoverage.get(filePath) ?? []).find((entry) => entry.wholeFile);
        const previousFindCount = findCounts.get(filePath) ?? 0;
        if (previousFindCount >= 3) {
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
          const matches = `Matches for "${query}" in ${file.filePath} (${lines.length} lines):\n${hits.join("\n---\n")}`;
          observation =
            hits.length > 0
              ? `${fullRead ? `File was already read fully in step ${fullRead.step}; this is a compact match list.\n` : ""}${matches}`
              : `No matches for "${query}" in ${file.filePath}.`;
          evidence.push({ path: file.filePath, label: "Search in file" });
          recordRead(file.filePath, undefined, undefined, false, "find_in_file");
          log("info", `${hits.length} matches in file`, query);
          ok = true;
        }
      } else if (action === "list_items") {
        const filePath = normalizeAgentPath(analysis.rootPath, pathFromArgs(args));
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
        recordRead(filePath, undefined, undefined, false, "list_items");
        log("info", `${items.length} items extracted`, filePath);
        ok = true;
      } else if (action === "count_matches") {
        const query = String(args.query ?? "").trim();
        if (!query) throw new Error("A search query is required.");
        const target = normalizeAgentPath(analysis.rootPath, pathFromArgs(args));
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
        for (const entry of top.slice(0, 10)) {
          evidence.push({ path: entry.path, label: "Counted matches" });
          recordRead(entry.path, undefined, undefined, false, "count_matches");
        }
        log("info", `${scanned} files scanned · ${total} matches`, query);
        ok = true;
      } else if (action === "list_colors") {
        const filePath = normalizeAgentPath(
          analysis.rootPath,
          pathFromArgs(args) ?? "styles.css",
        );
        if (!filePath) throw new Error("A file path is required.");
        if (isSecretAgentPath(filePath)) throw new Error("Reading environment, key or Git internals files is denied.");
        const file = await readSourceFile(analysis.rootPath, filePath);
        const lines = file.content.split("\n");
        const colorPattern = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g;
        const entries: { line: number; selector: string; property: string; color: string }[] = [];
        let selector = "";
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          if (line.includes("{")) selector = line.split("{")[0].trim();
          const property = line.split(":")[0].trim();
          for (const match of line.matchAll(colorPattern)) {
            entries.push({ line: index + 1, selector, property, color: match[0] });
          }
        }
        if (entries.length === 0) {
          observation = `No color values were found in ${filePath}.`;
        } else {
          const counts = new Map<string, number>();
          for (const entry of entries) counts.set(entry.color, (counts.get(entry.color) ?? 0) + 1);
          completeColorList = {
            path: filePath,
            entries,
            unique: [...counts.entries()],
          };
          observation = [
            `Color audit: ${filePath} — ${entries.length} occurrences, ${counts.size} unique colors`,
            ...entries.map(
              (entry) =>
                `${filePath}:${entry.line} — ${entry.selector || "(no selector)"} · ${entry.property}: ${entry.color}`,
            ),
            "",
            "Unique codes:",
            ...[...counts.entries()].map(([color, count]) => `${color} (${count})`),
          ].join("\n");
        }
        evidence.push({ path: filePath, label: "Color audit" });
        log("info", "CSS colors listed", `${entries.length} occurrences · ${new Set(entries.map((entry) => entry.color)).size} unique`);
        ok = true;
      } else if (action === "extract_entities") {
        const kind = String(args.kind ?? "").trim() as EntityKind;
        if (!kind) {
          throw new Error(
            "An extraction kind is required. Supported kinds: color, input, button, link, function, class, component, env, todo, route, import, selector, asset, document, markdown, file, text.",
          );
        }
        if (workBrief?.mode === "extract" && kind !== workBrief.kind) {
          throw new Error(
            `This request asks for a complete ${workBrief.kind} list. Call extract_entities with kind="${workBrief.kind}" instead of "${kind}".`,
          );
        }
        const result = await extractEntities(analysis, {
          kind,
          scope: (args.scope ?? args.path) as string | string[] | undefined,
          query: typeof args.query === "string" ? args.query : undefined,
          limit: Number(args.limit) || undefined,
        });
        completeExtraction = result;
        lastExtraction = extractionTableOf(result);
        observation = result.markdown;
        if (result.items[0]) {
          evidence.push({ path: result.items[0].file, label: "Extraction" });
        }
        if (extractionBrief && workBrief?.mode === "extract") {
          observation += `\n\nComplete list ready (${result.total} item(s)). Call finish now with every item in the user's language; do not search or read again.`;
        }
        log(
          "info",
          result.fromCache ? "Entities extracted from cache" : "Entities extracted",
          `${result.kind} · ${result.total} item(s) · ${result.unique} unique`,
        );
        ok = true;
      } else if (action === "apply_mapped_changes") {
        const kind = String(args.kind ?? "color").trim().toLowerCase();
        if (kind !== "color" && kind !== "text") {
          throw new Error("apply_mapped_changes supports kind=color or kind=text.");
        }
        const rawMapping =
          args.mapping && typeof args.mapping === "object" && !Array.isArray(args.mapping)
            ? (args.mapping as Record<string, unknown>)
            : {};
        const pairs = Object.entries(rawMapping)
          .map(([from, to]) => [from.trim(), typeof to === "string" ? to : ""] as const)
          .filter(([from, to]) => from.length > 0 && to.length > 0);
        if (pairs.length === 0) {
          throw new Error(
            "A mapping of old value to new value is required, e.g. {'#22d3ee':'#ff5c8a'}. First call extract_entities(kind=color) to list the current colors.",
          );
        }
        const dryRun = args.dryRun === true || args.preview === true;
        const scope = (args.scope ?? args.path) as string | string[] | undefined;
        const targetFiles = new Set<string>();
        if (kind === "color") {
          const extracted = await extractEntities(analysis, {
            kind: "color",
            scope,
            limit: 2_000,
          });
          for (const item of extracted.items) targetFiles.add(item.file);
        } else {
          for (const [from] of pairs) {
            // eslint-disable-next-line no-await-in-loop
            const extracted = await extractEntities(analysis, {
              kind: "text",
              scope,
              query: from,
              limit: 2_000,
            });
            for (const item of extracted.items) targetFiles.add(item.file);
          }
        }
        const files = [...targetFiles];
        if (files.length === 0) {
          observation = `No ${kind} targets were found in the selected scope; no changes were made.`;
          ok = true;
        } else {
          let changedFilesCount = 0;
          let replacements = 0;
          const changed: string[] = [];
          const writtenPaths: string[] = [];
          for (const filePath of files) {
            // eslint-disable-next-line no-await-in-loop
            const file = await readSourceFile(analysis.rootPath, filePath).catch(() => null);
            if (!file) continue;
            const mapped = applyMappingsToContent(file.content, kind, pairs);
            if (mapped.count === 0 || mapped.content === file.content) continue;
            const preview = `${pairs.map(([from, to]) => `${from} → ${to}`).join("\n")}\n\n${mappedPreview(
              file.content,
              mapped.content,
            )}`.slice(0, 2_000);
            if (dryRun) {
              changed.push(`${file.filePath} (${mapped.count})\n${mappedPreview(file.content, mapped.content)}`);
              replacements += mapped.count;
              changedFilesCount += 1;
              continue;
            }
            // eslint-disable-next-line no-await-in-loop
            const allowed = await requirePermission(
              "write",
              "apply_mapped_changes",
              filePath,
              `${mapped.count} mapped replacement(s) in ${filePath}`,
              { preview },
            );
            if (!allowed) throw new Error("The user denied permission to apply mapped changes.");
            // eslint-disable-next-line no-await-in-loop
            const written = await writeSourceFile(projectId, analysis.rootPath, filePath, mapped.content);
            if (!changedFiles.includes(written.filePath)) changedFiles.push(written.filePath);
            if (!writtenPaths.includes(written.filePath)) writtenPaths.push(written.filePath);
            evidence.push({ path: written.filePath, label: "Mapped change" });
            const summary = mapped.replacements.map((entry) => `${entry.from}→${entry.to}×${entry.count}`).join(", ");
            changed.push(`${written.filePath} (${mapped.count}${summary ? `: ${summary}` : ""})`);
            changedFilesCount += 1;
            replacements += mapped.count;
          }
          if (dryRun) {
            observation =
              changedFilesCount > 0
                ? `Preview only: ${replacements} mapped replacement(s) in ${changedFilesCount} file(s). No files were written.\n\n${changed.join("\n\n")}\n\nCall apply_mapped_changes again without dryRun to apply.`
                : "Preview only: the mapping matched no occurrences; no files were changed.";
            log(
              "info",
              "Mapped changes preview",
              `${replacements} replacement(s) · ${changedFilesCount} file(s)`,
            );
            ok = true;
          } else {
          invalidateReadCaches(writtenPaths);
          let verificationText = "";
          let remainingCount = 0;
          let totalColorsAfter: number | undefined;
          observation =
            changedFilesCount > 0
              ? `Applied ${replacements} mapped replacement(s) in ${changedFilesCount} file(s):\n${changed.join("\n")}`
              : "The mapping matched no occurrences; no files were changed.";
          if (changedFilesCount > 0 && kind === "color") {
            const after = await extractEntities(analysis, {
              kind: "color",
              scope,
              limit: 2_000,
            });
            const remaining = after.items.filter((item) =>
              pairs.some(
                ([from]) =>
                  item.values.color?.toLowerCase() === from.toLowerCase(),
              ),
            ).length;
            remainingCount = remaining;
            totalColorsAfter = after.total;
            mappedChangeVerified = remaining === 0;
            verificationText = mappedChangeVerified
              ? `Verification: 0 remaining ${pairs
                  .map(([from]) => from)
                  .join(", ")} occurrence(s); ${after.total} color occurrence(s) remain in scope.`
              : `Verification: ${remaining} old color occurrence(s) still remain; fix them before finishing.`;
            observation += `\n\n${verificationText}${
              mappedChangeVerified ? " The mapped change is verified; call finish after any remaining requested mapping." : ""
            }`;
          } else if (changedFilesCount > 0) {
            let remainingOld = 0;
            for (const [from] of pairs) {
              // eslint-disable-next-line no-await-in-loop
              const after = await extractEntities(analysis, {
                kind: "text",
                scope,
                query: from,
                limit: 2_000,
              });
              remainingOld += after.items.length;
            }
            mappedChangeVerified = remainingOld === 0;
            remainingCount = remainingOld;
            verificationText = mappedChangeVerified
              ? `Verification: 0 remaining "${pairs
                  .map(([from]) => from)
                  .join('", "')}" occurrence(s).`
              : `Verification: ${remainingOld} old text occurrence(s) still remain; fix them before finishing.`;
            observation += `\n\n${verificationText}`;
          }
          if (changedFilesCount > 0) {
            lastMappedObservation = observation;
            lastMappedSummary = buildMappedSummary(
              changed,
              mappedVerificationSummary(
                mappedChangeVerified,
                remainingCount,
                totalColorsAfter,
                options.language ?? "en",
              ),
              options.language ?? "en",
            );
            mapVerifyReads = 0;
            mapVerifyRejections = 0;
          }
          log(
            changedFilesCount > 0 ? "success" : "warn",
            "Mapped changes applied",
            `${replacements} replacement(s) · ${changedFilesCount} file(s)`,
          );
          ok = true;
          }
        }
      } else if (action === "undo_change") {
        const filePath = normalizeAgentPath(analysis.rootPath, pathFromArgs(args));
        if (!filePath) throw new Error("A file path is required.");
        if (isSecretAgentPath(filePath)) throw new Error("Editing environment, key or Git internals files is denied.");
        const allowed = await requirePermission(
          "write",
          "undo_change",
          filePath,
          "Restore the latest editor backup for this file.",
        );
        if (!allowed) throw new Error("The user denied the undo request.");
        const restored = await restoreLatestEditorBackup(projectId, analysis.rootPath, filePath);
        invalidateReadCaches([restored.filePath]);
        observation = `Restored ${restored.filePath} from its latest backup (${restored.backupPath}).`;
        evidence.push({ path: restored.filePath, label: "Restored backup" });
        log("success", "Backup restored", restored.filePath);
        ok = true;
      } else if (action === "audit_content") {
        const inventory = await auditContentInventory(analysis);
        observation = renderContentInventory(inventory);
        for (const item of inventory.broken.slice(0, 5)) {
          evidence.push({ path: item.file, label: "Broken reference", startLine: item.line });
        }
        for (const item of inventory.unreferenced.slice(0, 5)) {
          evidence.push({ path: item.path, label: "Unreferenced asset" });
        }
        log(
          "info",
          "Content inventory audited",
          `${inventory.summary.broken} broken · ${inventory.summary.unreferenced} unreferenced · ${inventory.summary.headingWarnings} heading warnings`,
        );
        ok = true;
      } else if (action === "json_query") {
        const filePath = normalizeAgentPath(analysis.rootPath, pathFromArgs(args));
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
        const fromPath = normalizeAgentPath(analysis.rootPath, pathFromArgs(args));
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
        invalidateReadCaches([renamed.from, renamed.to]);
        observation = `Renamed ${renamed.from} → ${renamed.to}.`;
        log("success", "Path moved", `${renamed.from} → ${renamed.to}`);
        ok = true;
      } else if (action === "delete_file") {
        const targetPath = normalizeAgentPath(analysis.rootPath, pathFromArgs(args));
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
        invalidateReadCaches([deleted.path]);
        observation = `Deleted ${deleted.path}${deleted.kind === "directory" ? " (empty directory)" : ""}.`;
        log("success", "Path deleted", deleted.path);
        ok = true;
      } else if (action === "rescan_project") {
        const fresh = await analyzeProject(analysis.rootPath);
        await saveAnalysis(fresh);
        startProjectIndexBuild(fresh.id, fresh);
        Object.assign(analysis, fresh);
        invalidateReadCaches();
        observation = `Rescanned project: ${fresh.files.length} files, ${fresh.symbols.length} symbols. Rebuilt the analysis and search index; the project map will refresh on the next run.`;
        log("success", "Project rescanned", `${fresh.files.length} files · ${fresh.symbols.length} symbols`);
        ok = true;
      } else if (action === "game_check") {
        const gamePath = typeof args.path === "string" ? args.path : "index.html";
        const gameSteps = Array.isArray(args.steps) ? args.steps : undefined;
        const result = await runGameCheck(analysis.id, analysis.rootPath, {
          path: gamePath,
          url: typeof args.url === "string" ? args.url : undefined,
          steps: gameSteps as BrowserCheckStep[] | undefined,
          screenshot: args.screenshot !== false,
          live: options.liveBrowser === true,
          visible: args.visible === true,
          signal,
        });
        if (result.check.screenshotPath) {
          evidence.push({ path: result.check.screenshotPath, label: "Game check screenshot" });
        }
        observation = result.summary;
        ok = result.check.ok && result.check.metrics.canvases > 0;
        if (ok) verificationPassed = true;
        log(result.check.ok ? "success" : "error", "Game check complete", `${result.engine} · ${result.check.metrics.fps ?? "—"} fps`);
      } else if (action === "run_test_scenario") {
        if (options.requiredScenario && scenarioCalls >= 1) {
          throw new Error(
            `The required scenario ${options.requiredScenario.name} is checked automatically at finish. Do not call it again; make the edit and finish.`,
          );
        }
        scenarioCalls += 1;
        const rawName = String(args.name ?? args.path ?? "").trim();
        if (!rawName) throw new Error("A test scenario name is required.");
        const relative = rawName.endsWith(".json")
          ? rawName
          : `.cie/agent/scenarios/${rawName.replace(/^.*[\\/]/, "")}.json`;
        if (!relative.startsWith(".cie/agent/scenarios/")) {
          throw new Error("Test scenarios must live under .cie/agent/scenarios/.");
        }
        const scenarioFile = await readSourceFile(analysis.rootPath, relative);
        const scenario = JSON.parse(scenarioFile.content) as {
          path?: string;
          mobile?: boolean;
          timeoutMs?: number;
          steps?: BrowserCheckStep[];
        };
        if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) {
          throw new Error("The test scenario has no steps.");
        }
        if (options.liveBrowser === true || args.visible === true) {
          log("info", "Live browser opened", `${relative} · ${scenario.steps.length} steps`);
        }
        const result = await runBrowserCheck(analysis.id, analysis.rootPath, {
          path: scenario.path,
          mobile: scenario.mobile,
          timeoutMs: scenario.timeoutMs,
          steps: scenario.steps,
          live: options.liveBrowser === true,
          visible: args.visible === true,
          signal,
        });
        const failedSteps = result.steps.filter((step) => !step.ok);
        const scenarioSynthetic = isSyntheticCheckPath(scenario.path);
        if (scenarioSynthetic) syntheticBrowserChecks += 1;
        else {
          realScenarioRuns += 1;
          realCheckAssertions += countCheckAssertions(scenario.steps);
        }
        observation = `Test scenario ${relative}: ${result.ok ? "PASSED" : "FAILED"}${
          scenarioSynthetic
            ? "\nNote: this scenario runs a synthetic page under .cie/; it does not prove the real app. Verify the project entry page too."
            : ""
        }\n${result.summary}${
          failedSteps.length > 0
            ? `\nFailed steps:\n${failedSteps
                .map((step) => `- ${step.index}. ${step.action}: ${step.detail.slice(0, 240)}`)
                .join("\n")}`
            : ""
        }\nConsole errors: ${result.consoleErrors.slice(0, 5).join(" | ") || "none"}`;
        evidence.push({ path: relative, label: "Test scenario" });
        log(result.ok ? "success" : "warn", "Test scenario finished", result.summary.slice(0, 160));
        ok = result.ok;
        if (ok && !scenarioSynthetic) verificationPassed = true;
      } else if (action === "browser_check") {
        const browserPath = typeof args.path === "string" ? args.path : "index.html";
        // Validate and normalize before consuming the per-task browser budget.
        // A bad step shape is a retryable argument error, not a spent check.
        const rawSteps = normalizeBrowserSteps(args.steps);
        const browserKey = `${browserPath}::${JSON.stringify(rawSteps)}`;
        const cachedCheckFiles = browserCheckCache.get(browserKey);
        if (cachedCheckFiles !== undefined && cachedCheckFiles === changedFiles.length) {
          throw new Error(
            "This exact browser check already ran since the last file change. Do not repeat it; use the previous result, change the steps, or fix the code first.",
          );
        }
        if (browserCheckCalls >= maxBrowserChecks) {
          browserCheckBlocked = true;
          throw new Error(
            `Browser check budget exhausted for this task (${maxBrowserChecks} calls). Do not call browser_check again; report the exact blocker or finish with the evidence you already have.`,
          );
        }
        browserCheckCalls += 1;
        browserCheckCache.set(browserKey, changedFiles.length);
        const liveBrowser = options.liveBrowser === true || args.visible === true;
        if (liveBrowser) {
          log("info", "Live browser opened", `${browserPath} · ${rawSteps.length} steps`);
        }
        const syntheticCheck = isSyntheticCheckPath(browserPath);
        const result = await runBrowserCheck(analysis.id, analysis.rootPath, {
          path: browserPath,
          url: typeof args.url === "string" ? args.url : undefined,
          steps: rawSteps,
          mobile: args.mobile === true,
          screenshot: args.screenshot === true,
          live: options.liveBrowser === true,
          visible: args.visible === true,
          signal,
        });
        if (syntheticCheck) syntheticBrowserChecks += 1;
        else {
          realBrowserChecks += 1;
          realCheckAssertions += countCheckAssertions(rawSteps);
        }
        if (result.ok) {
          browserFailureRepeat = 0;
          if (!syntheticCheck) verificationPassed = true;
        } else if (browserKey === lastBrowserKey) {
          browserFailureRepeat += 1;
        } else {
          browserFailureRepeat = 1;
        }
        if (!result.ok && browserCheckCalls >= maxBrowserChecks) {
          browserCheckBlocked = true;
        }
        lastBrowserKey = browserKey;
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
          result.resourceErrors.length > 0
            ? `Resource errors:\n${result.resourceErrors.slice(0, 8).join("\n")}`
            : "",
          syntheticCheck
            ? "Note: this check ran a synthetic page under .cie/, not the project entry page. It does not prove the real app."
            : "",
          !result.ok && browserFailureRepeat >= (testTask ? 2 : 3)
            ? `The same check has failed ${browserFailureRepeat} times in a row. ${
                testTask
                  ? "Stop repeating it: switch to DOM-visible checks or report the exact blocker."
                  : "Change the steps or fix the underlying page; repeating it will not help."
              }`
            : "",
          !result.ok && browserCheckCalls >= maxBrowserChecks
            ? "Browser check budget is now exhausted. Do not call browser_check again; finish with the evidence you have and report the exact blocker."
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
      } else if (action === "search_conversations") {
        const query = String(args.query ?? "").trim();
        if (!query) throw new Error("A conversation search query is required.");
        const hits = await searchConversations(analysis.id, query, Number(args.limit) || 5);
        observation =
          hits.length === 0
            ? `No earlier conversation matched "${query}".`
            : [
                `${hits.length} earlier conversation matches for "${query}" (earlier answers are claims; verify them against files/tools):`,
                ...hits.map(
                  (hit) =>
                    `- ${hit.title}${hit.snippet ? ` — ${hit.snippet}` : ""}${hit.answer ? `\n  ${hit.answer.slice(0, 400)}` : ""}`,
                ),
              ].join("\n");
        log("info", "Conversation searched", `${hits.length} matches`);
        ok = true;
      } else if (action === "project_search") {
        const query = String(args.query ?? "").trim();
        if (!query) throw new Error("A search query is required.");
        const limit = Math.max(1, Math.min(30, Number(args.limit ?? 15) || 15));
        const found = await agentSearch(analysis, query, limit);
        const symbols = queryProjectSymbols(analysis, query, undefined, Math.min(12, limit));
        const conversations =
          args.includeConversations === true
            ? await searchConversations(analysis.id, query, 5).catch(() => [])
            : [];
        const lines: string[] = [`Project search: ${query}`];
        if (found.results.length > 0) {
          lines.push("", "Best file hits:");
          lines.push(
            ...found.results.map(
              (result) =>
                `- ${result.path}:${result.line} — ${result.text.slice(0, 400)}\n  next: read_file path="${result.path}" startLine=${Math.max(1, result.line - 8)} endLine=${result.line + 24}`,
            ),
          );
          lines.push(
            "",
            "Likely files to inspect:",
            ...[...new Set(found.results.map((result) => result.path))].slice(0, 8).map((file) => `- ${file}`),
          );
        }
        if (symbols.length > 0) {
          lines.push("", "Matching symbols:");
          lines.push(
            ...symbols.map(
              (symbol) =>
                `- ${symbol.kind} ${symbol.qualifiedName} — ${symbol.filePath}:${symbol.startLine}`,
            ),
          );
        }
        if (conversations.length > 0) {
          lines.push("", "Related earlier conversations:");
          lines.push(
            ...conversations.map(
              (hit) => `- ${hit.title}${hit.snippet ? ` — ${hit.snippet}` : ""}`,
            ),
          );
        }
        if (found.results.length === 0 && symbols.length === 0) {
          lines.push("", "No index or symbol hits. Try different terms or list_files/read_file.");
        }
        observation = lines.join("\n");
        for (const result of found.results.slice(0, 10)) {
          evidence.push({ path: result.path, label: "Project search", startLine: result.line });
        }
        log("info", "Project search completed", `${found.results.length} hits · ${symbols.length} symbols`);
        ok = true;
      } else if (action === "write_file") {
        if (changedFiles.length >= AGENT_MAX_WRITES) throw new Error(`Write limit reached (${AGENT_MAX_WRITES} files).`);
        const filePath = normalizeAgentPath(analysis.rootPath, pathFromArgs(args));
        const content = contentFromArgs(args);
        if (!filePath) throw new Error("A file path is required.");
        if (
          !content &&
          !Object.keys(args).some((key) =>
            ["content", "text", "code", "body", "value", "source"].includes(key),
          )
        ) {
          throw new Error("The content field must be a string.");
        }
        if (content.length > 200_000) {
          throw new Error(
            "File content is too large for one tool call (200k character limit). Write the first section with write_file, then use append_text for the rest. Keep each JSON reply complete.",
          );
        }
        if (isSecretAgentPath(filePath)) throw new Error("Writing environment, key or Git internals files is denied.");
        const previous = await readSourceFile(analysis.rootPath, filePath).catch(() => null);
        const writeAllowed = await requirePermission(
          "write",
          "write_file",
          filePath,
          `${content.split("\n").length} lines · ${Buffer.byteLength(content, "utf8")} bytes`,
          {
            preview: permissionDiffPreview(previous?.content ?? null, content),
            previewKind: "diff",
          },
        );
        if (!writeAllowed) throw new Error("The user denied permission to write this file.");
        const written = await writeSourceFile(projectId, analysis.rootPath, filePath, content);
        const effectiveChange = !previous || previous.content !== content;
        if (effectiveChange) changedFiles.push(written.filePath);
        evidence.push({ path: written.filePath, label: "Written by agent" });
        invalidateReadCaches([written.filePath]);
        observation = effectiveChange
          ? `Wrote ${written.bytes} bytes to ${written.filePath}${written.backupPath ? " (backup created)" : ""}.`
          : `Wrote ${written.bytes} bytes to ${written.filePath}, but the content is identical to the previous version (no effective change).`;
        log("success", "File written", `${written.bytes} bytes${written.backupPath ? " · backup created" : ""}`);
        ok = true;
      } else if (action === "replace_in_file") {
        const filePath = normalizeAgentPath(analysis.rootPath, pathFromArgs(args));
        const find = findFromArgs(args);
        const replace = replaceFromArgs(args);
        if (!filePath) throw new Error("A file path is required.");
        if (!find) throw new Error("The find field is required.");
        if (isSecretAgentPath(filePath)) throw new Error("Editing environment, key or Git internals files is denied.");
        const file = await readSourceFile(analysis.rootPath, filePath);
        const occurrences = file.content.split(find).length - 1;
        if (occurrences === 0) throw new Error("The find snippet was not found in the file.");
        if (occurrences > 1) throw new Error(`The find snippet occurs ${occurrences} times; make it unique.`);
        const nextContent = file.content.replace(find, replace);
        const replaceAllowed = await requirePermission(
          "write",
          "replace_in_file",
          filePath,
          `Replace 1 snippet · ${find.length} → ${replace.length} chars`,
          {
            preview: permissionDiffPreview(file.content, nextContent),
            previewKind: "diff",
          },
        );
        if (!replaceAllowed) throw new Error("The user denied permission to edit this file.");
        const written = await writeSourceFile(projectId, analysis.rootPath, filePath, nextContent);
        const effectiveChange = nextContent !== file.content;
        if (effectiveChange && !changedFiles.includes(written.filePath)) changedFiles.push(written.filePath);
        evidence.push({ path: written.filePath, label: "Edited by agent" });
        invalidateReadCaches([written.filePath]);
        observation = effectiveChange
          ? `Replaced one snippet in ${written.filePath} (${written.bytes} bytes).`
          : `The replacement produced identical content in ${written.filePath}; no effective change was made.`;
        log("success", "File edited", written.filePath);
        ok = true;
      } else if (action === "append_text") {
        const filePath = normalizeAgentPath(analysis.rootPath, pathFromArgs(args));
        const content = contentFromArgs(args);
        if (!filePath) throw new Error("A file path is required.");
        if (!content.trim()) throw new Error("The content to append is required.");
        if (isSecretAgentPath(filePath)) throw new Error("Editing environment, key or Git internals files is denied.");
        if (changedFiles.length >= AGENT_MAX_WRITES && !changedFiles.includes(filePath)) {
          throw new Error(`Write limit reached (${AGENT_MAX_WRITES} files).`);
        }
        const existing = await readSourceFile(analysis.rootPath, filePath).catch(() => null);
        const normalized = content.trim();
        if (existing && existing.content.trimEnd().endsWith(normalized)) {
          observation = `The requested content is already at the end of ${filePath}; no change was needed.`;
          ok = true;
        } else {
          const separator =
            existing && existing.content.length > 0 && !existing.content.endsWith("\n") ? "\n" : "";
          const nextContent = `${existing?.content ?? ""}${separator}${content}`;
          const allowed = await requirePermission(
            "write",
            "append_text",
            filePath,
            `Append ${content.length} chars to the end of the file.`,
            {
              preview: permissionDiffPreview(existing?.content ?? null, nextContent),
              previewKind: "diff",
            },
          );
          if (!allowed) throw new Error("The user denied permission to append to this file.");
          const written = await writeSourceFile(projectId, analysis.rootPath, filePath, nextContent);
          const effectiveChange = nextContent !== (existing?.content ?? "");
          if (effectiveChange && !changedFiles.includes(written.filePath)) changedFiles.push(written.filePath);
          evidence.push({ path: written.filePath, label: "Appended by agent" });
          invalidateReadCaches([written.filePath]);
          observation = effectiveChange
            ? `Appended ${content.length} chars to ${written.filePath} (${written.bytes} bytes).`
            : `The append produced identical content in ${written.filePath}; no effective change was made.`;
          log("success", "File appended", written.filePath);
          ok = true;
        }
      } else if (action === "replace_many") {
        const filePath = normalizeAgentPath(analysis.rootPath, pathFromArgs(args));
        if (!filePath) throw new Error("A file path is required.");
        if (isSecretAgentPath(filePath)) throw new Error("Editing environment, key or Git internals files is denied.");
        const rawEdits = Array.isArray(args.edits) ? args.edits : [];
        const edits = rawEdits
          .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
          .map((item) => ({
            find: findFromArgs(item),
            replace: replaceFromArgs(item),
          }))
          .filter((item) => item.find);
        if (edits.length === 0) throw new Error("At least one find/replace edit is required.");
        if (edits.length > 20) throw new Error("At most 20 edits can be applied in one call.");
        const file = await readSourceFile(analysis.rootPath, filePath);
        let nextContent = file.content;
        for (const [index, edit] of edits.entries()) {
          const occurrences = nextContent.split(edit.find).length - 1;
          if (occurrences === 0) {
            throw new Error(`Edit ${index + 1}: the find snippet was not found in the file.`);
          }
          if (occurrences > 1) {
            throw new Error(`Edit ${index + 1}: the find snippet occurs ${occurrences} times; make it unique.`);
          }
          nextContent = nextContent.replace(edit.find, edit.replace);
        }
        const manyAllowed = await requirePermission(
          "write",
          "replace_many",
          filePath,
          `Apply ${edits.length} localized edits in one write.`,
          {
            preview: permissionDiffPreview(file.content, nextContent),
            previewKind: "diff",
          },
        );
        if (!manyAllowed) throw new Error("The user denied permission to edit this file.");
        const written = await writeSourceFile(projectId, analysis.rootPath, filePath, nextContent);
        const effectiveChange = nextContent !== file.content;
        if (effectiveChange && !changedFiles.includes(written.filePath)) changedFiles.push(written.filePath);
        evidence.push({ path: written.filePath, label: "Edited by agent (multiple)" });
        invalidateReadCaches([written.filePath]);
        observation = effectiveChange
          ? `Applied ${edits.length} localized edits to ${written.filePath} in one write (${written.bytes} bytes).`
          : `The edits produced identical content in ${written.filePath}; no effective change was made.`;
        if (effectiveChange && workBrief?.mode === "change" && workBrief.kind === "color") {
          const normalizeColor = (value: string) => value.toLowerCase().replace(/\s+/g, "");
          const oldColors = [
            ...new Set(
              edits.flatMap((edit) => {
                const found =
                  edit.find.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g) ?? [];
                const replaced = new Set(
                  (edit.replace.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g) ?? []).map(
                    normalizeColor,
                  ),
                );
                return found.map(normalizeColor).filter((color) => !replaced.has(color));
              }),
            ),
          ];
          if (oldColors.length > 0) {
            const after = await extractEntities(analysis, { kind: "color", limit: 2_000 });
            const remaining = after.items.filter((item) =>
              oldColors.includes(normalizeColor(item.values.color ?? "")),
            ).length;
            mappedChangeVerified = remaining === 0;
            const verificationText = mappedChangeVerified
              ? `Verification: 0 remaining target color occurrence(s).`
              : `Verification: ${remaining} old color occurrence(s) still remain.`;
            observation += `\n\n${verificationText}${
              mappedChangeVerified ? " The mapped change is verified; call finish after any remaining requested edit." : ""
            }`;
            lastMappedObservation = observation;
            lastMappedSummary = buildMappedSummary(
              [`${written.filePath} (${edits.length} localized edits)`],
              mappedVerificationSummary(
                mappedChangeVerified,
                remaining,
                undefined,
                options.language ?? "en",
              ),
              options.language ?? "en",
            );
            mapVerifyReads = 0;
            mapVerifyRejections = 0;
          }
        }
        log("success", "File edited with multiple replacements", written.filePath);
        ok = true;
      } else if (action === "format_file") {
        const filePath = normalizeAgentPath(analysis.rootPath, pathFromArgs(args));
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
        invalidateReadCaches([formatted.filePath]);
        observation = `${formatted.command}\n${formatted.formatted ? "File formatted." : "File was already formatted."}`;
        log("success", "File formatted", formatted.filePath);
        ok = true;
      } else if (action === "run_command") {
        if (ranCommands.length >= AGENT_MAX_COMMANDS) throw new Error(`Command limit reached (${AGENT_MAX_COMMANDS}).`);
        const command = String(args.command ?? "").trim();
        if (!command) throw new Error("A command is required.");
        if (isBlockedAgentCommand(command)) {
          throw new Error(
            /\b(?:p?kill|killall|nohup)\b/i.test(command)
              ? "Do not kill or restart the dev server. The app manages background jobs; use the job Stop/Preview controls or browser_check the existing URL."
              : "That command is blocked by the agent safety policy.",
          );
        }
        if (
          isDevServerCommand(command) &&
          !/\b(?:build|test|lint|typecheck|tsc|compile|check)\b/i.test(command)
        ) {
          throw new Error(
            `"${command}" looks like a long-running server. Use run_background instead, then browser_check the URL it returns.`,
          );
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
        const result = await withCommandLock(projectId, () =>
          runProjectCommand(analysis.rootPath, command, cwd, { signal }),
        );
        ranCommands.push(command);
        log(result.exitCode === 0 ? "success" : "error", "Command finished", `exit ${result.exitCode ?? "—"} · ${result.durationMs} ms`);
        const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
        const environmentHint = pythonEnvironmentHint(command, result.exitCode, output);
        const failures = result.exitCode === 0 ? 0 : (failedCommands.get(command) ?? 0) + 1;
        if (result.exitCode === 0) failedCommands.delete(command);
        else failedCommands.set(command, failures);
        const repeatHint =
          failures >= 2
            ? "\n\nThe same command already failed twice. Do not run it again unchanged: change the interpreter/environment (use the project `.venv`) or the command itself."
            : "";
        observation = clampObservation(
          `Command: ${command}\nCWD: ${result.cwd}\nExit: ${result.exitCode ?? "—"}\nDuration: ${result.durationMs} ms\n${output || "(no output)"}${environmentHint}${repeatHint}`,
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
        if (
          ok &&
          (command === verificationCommand ||
            /\b(?:test|tests|pytest|build|typecheck|lint|verify|doğrula|derle)\b/i.test(command))
        ) {
          verificationPassed = true;
        }
      } else if (action === "run_background") {
        if (ranCommands.length >= AGENT_MAX_COMMANDS) {
          throw new Error(
            `Command limit reached (${AGENT_MAX_COMMANDS}). Stop a background job or finish with the evidence you already have.`,
          );
        }
        const command = String(args.command ?? "").trim();
        if (!command) throw new Error("A command is required.");
        if (isBlockedAgentCommand(command)) {
          throw new Error(
            /\b(?:p?kill|killall|nohup)\b/i.test(command)
              ? "Do not kill or restart the dev server. Use stop_background with the job id returned by run_background."
              : "That command is blocked by the agent safety policy.",
          );
        }
        const bgCwdInput = normalizeAgentPath(analysis.rootPath, args.cwd);
        const bgCwd = bgCwdInput || undefined;
        const bgAllowed = await requirePermission(
          "command",
          "run_background",
          command,
          `Background process. Working directory: ${bgCwd ?? "."}`,
          { preview: command },
        );
        if (!bgAllowed) throw new Error("The user denied permission to start the background process.");
        const job = await startBackgroundProcess(analysis.rootPath, projectId, command, bgCwd);
        ranCommands.push(command);
        const url = await waitForBackgroundUrl(projectId, job.id, 15_000);
        const current =
          listBackgroundProcesses(projectId).find((item) => item.id === job.id) ?? job;
        const bgOutput = current.output?.slice(-2_000) ?? "";
        const running = current.status === "running";
        const portHint = /EADDRINUSE|address already in use/i.test(bgOutput)
          ? "Port is already in use. Retry with an explicit free port, for example PORT=3100 node server.js."
          : "";
        ok = running;
        observation = clampObservation(
          [
            `Background job ${job.id} started.`,
            `Command: ${job.command}`,
            `Status: ${current.status}`,
            url
              ? `URL: ${url}`
              : "URL: not detected yet (the process may still be starting; inspect the output below).",
            running
              ? `Next: call browser_check with url="${url ?? "http://127.0.0.1:<port>"}" and assert the real behavior. Stop it with stop_background jobId="${job.id}" when done.`
              : "The process exited before a URL was detected. Fix the command or the project server and try again.",
            portHint,
            bgOutput ? `Output:\n${bgOutput}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          4_000,
        );
        log(
          running ? "success" : "error",
          running ? "Background server started" : "Background server failed",
          url ?? job.command,
        );
      } else if (action === "stop_background") {
        const jobId = String(args.jobId ?? args.id ?? "").trim();
        if (!jobId) {
          throw new Error("A jobId is required. Use the id returned by run_background.");
        }
        const job = stopBackgroundProcess(projectId, jobId);
        observation = `Stopped background job ${jobId} (${job.command}). Status: ${job.status}.`;
        ok = true;
        log("info", "Background server stopped", job.command);
      }
      }
      if (actionCacheKeyValue && !cachedAction && ok) {
        readOnlyCache.set(actionCacheKeyValue, { step: index, ok });
      }
    } catch (toolError) {
      observation = toolError instanceof Error ? toolError.message : "The tool call failed.";
      if (/required|must be a string|limit reached|too large|outside the project|denied/i.test(observation)) {
        observation += `\n\nFix the arguments and retry the same tool now. Do not finish while this call is failing.${toolArgHint(action)}`;
      }
      if (
        toolRepairs < 1 &&
        /required|does not match|syntax error|unknown .*action|value is required|selector is required|read budget/i.test(
          observation,
        )
      ) {
        toolRepairs += 1;
        const suggestion = await suggestToolRepair(config, action, args, observation);
        if (suggestion) {
          observation += `\n\nCorrected call suggestion (use it, or fix the argument yourself):\n${suggestion}`;
          log("warn", "Tool call repair suggested", `${action} · ${suggestion.slice(0, 140)}`);
        }
      }
      unresolvedToolFailures.set(toolFailureKey(action, args), { action, observation, index });
      ok = false;
    }
    if (ok) {
      // A later successful call resolves the earlier failure for the same tool
      // and target. This is what lets a corrected read range or browser step
      // stop blocking finish.
      unresolvedToolFailures.delete(toolFailureKey(action, args));
      for (const [key, failure] of unresolvedToolFailures) {
        if (
          failure.action === action &&
          (["browser_check", "game_check", "run_test_scenario"].includes(action) ||
            /required|must be a string|limit reached|too large|outside the project|denied|narrow edit|read at most|read budget exhausted|unknown .*action|selector is required|value is required/i.test(
              failure.observation,
            ))
        ) {
          unresolvedToolFailures.delete(key);
        }
      }
      // Editing invalidates page evidence collected before the edit.
      if (
        ["write_file", "append_text", "replace_in_file", "replace_many", "rename_path", "delete_file"].includes(
          action,
        )
      ) {
        for (const [key, failure] of unresolvedToolFailures) {
          if (["browser_check", "game_check", "run_test_scenario"].includes(failure.action)) {
            unresolvedToolFailures.delete(key);
          }
        }
      }
      // A hallucinated project-tool name is a tool-choice mistake, not a
      // project defect. Do not let it block finish after a successful check.
      for (const [key, failure] of unresolvedToolFailures) {
        if (/Project tool .* was not found|No saved project tools exist/i.test(failure.observation)) {
          unresolvedToolFailures.delete(key);
        }
      }
    }

    if (actionCount > 1) {
      observation = `${observation}\n\n(Your reply contained ${actionCount} tool calls; all were executed in order. Batched read-only calls are encouraged; keep mutating actions one per reply.)`;
    }
    if (
      ok &&
      !readOnlyMode &&
      ["write_file", "replace_in_file", "replace_many", "rename_path", "delete_file", "format_file"].includes(action)
    ) {
      missingSelectors = await auditMissingSelectors(analysis, changedFiles).catch(() => []);
      if (missingSelectors.length > 0) {
        const detail = missingSelectors
          .map((item) => `#${item.id} (referenced in ${item.file})`)
          .join(", ");
        observation = `${observation}\n\nUI wiring check: ${detail} is not defined in any project markup. Add the corresponding input/control to the form/template (or explain why it is created dynamically) before finishing.`;
        log("warn", "UI wiring incomplete", detail);
      }
      unreferencedAssets = await auditUnreferencedAssets(analysis, changedFiles).catch(() => []);
      if (unreferencedAssets.length > 0) {
        observation = `${observation}\n\nAsset wiring check: ${unreferencedAssets.join(" ")} Add the script/link tag or import before finishing.`;
        log("warn", "Asset not loaded", unreferencedAssets.join(" · "));
      }
    }
    if (
      ok &&
      !readOnlyMode &&
      ["write_file", "replace_in_file", "replace_many", "rename_path", "delete_file", "format_file"].includes(action)
    ) {
      const diagnostics = await Promise.all(
        changedFiles.slice(0, 6).map(async (filePath) => {
          const syntax = await checkFileSyntax(analysis, filePath).catch(() => null);
          return syntax
            ? {
                file: syntax.filePath,
                supported: syntax.supported,
                ok: syntax.ok,
                output: syntax.output,
              }
            : null;
        }),
      );
      syntaxFailures = diagnostics
        .filter(
          (item): item is NonNullable<typeof item> =>
            Boolean(item && item.supported && !item.ok),
        )
        .map((item) => ({ file: item.file, output: item.output }));
      if (syntaxFailures.length > 0) {
        observation = `${observation}\n\nSyntax diagnostics failed:\n${syntaxFailures
          .map((item) => `- ${item.file}: ${item.output.slice(0, 500)}`)
          .join("\n")}`;
        log("warn", "Syntax diagnostics failed", syntaxFailures.map((item) => item.file).join(", "));
      }
    }
    const observationLimit =
      step.action === "read_file" || step.action === "find_in_file"
        ? 3_200
        : step.action === "list_colors"
          ? 12_000
        : step.action === "extract_entities"
          ? 14_000
        : step.action === "append_text"
          ? 2_000
          : step.action === "diagnostics"
            ? 3_500
          : step.action === "lsp_hover"
            ? 2_500
            : step.action === "lsp_completion"
              ? 2_500
        : step.action === "read_symbol"
          ? 6_000
        : step.action === "web_fetch"
          ? 8_000
          : step.action === "read_note"
            ? 12_000
            : step.action === "git_info"
              ? 8_000
              : step.action === "http_request"
                ? 8_000
                : step.action === "git_push"
                  ? 4_000
                  : step.action === "read_document"
                    ? 12_000
                    : step.action === "search_document"
                      ? 6_000
                      : step.action === "search_conversations"
                        ? 4_000
                        : step.action === "project_search"
                          ? 8_000
                      : step.action === "convert_document" || step.action === "transform_image"
                        ? 3_000
              : step.action === "list_notes" || step.action === "search_notes"
                ? 4_000
                : step.action === "compress_video"
                  ? 4_000
                  : step.action === "run_command"
                    ? 2_500
                    : 1_500;
    step.observation = clampObservation(observation, observationLimit);
    step.ok = ok;
    step.durationMs = Date.now() - started;
    step.tokenUsage = stepUsage;
    log(ok ? "success" : "error", ok ? "Tool completed" : "Tool failed", action);
    recordStep(step);
    if (READ_ONLY_ACTIONS.has(step.action) && ok) {
      readOnlyStepsSinceChange += 1;
    } else if (!READ_ONLY_ACTIONS.has(step.action)) {
      readOnlyStepsSinceChange = 0;
    }
    if (
      ok &&
      !READ_ONLY_ACTIONS.has(step.action) &&
      !VERIFICATION_ACTIONS.has(step.action)
    ) {
      // A write (or a mutating command) happened; a repeated browser check is
      // legitimate again after the code changed. A new write also re-opens a
      // small read window for line numbers/context.
      postEditReadNudged = false;
      postEditReadRejections = 0;
      browserCheckCache.clear();
    }
    if (
      readOnlyMode &&
      readOnlyStepsSinceChange >= (microEditMode ? 4 : tightReadsMode ? 6 : 8) &&
      !inspectionNudged
    ) {
      inspectionNudged = true;
      transcript.push({
        role: "system",
        content: options.intent?.needsExhaustiveEvidence
          ? "Exhaustive list task: you have enough evidence. Collect every matching item (for CSS colors call list_colors with the stylesheet path), then finish with the complete list in the user's language. Do not summarize and do not omit entries. browser_check/run_test_scenario remain available if needed."
          : "Inspection decision point: you have enough evidence. Finish now with a compact diagnosis: root cause, file:line evidence, runtime proof, and the minimal fix that would be needed. Do not read more files. browser_check, run_test_scenario and game_check remain available if one final runtime proof is needed.",
      });
      log("warn", "Inspection decision point", `${readOnlyStepsSinceChange} read-only calls`);
    }
    if (
      !readOnlyMode &&
      plan.needsWrite &&
      changedFiles.length === 0 &&
      !verificationPassed &&
      readOnlyStepsSinceChange >= (microEditMode ? 3 : tightReadsMode ? 5 : 8) &&
      !readDecisionNudged
    ) {
      readDecisionNudged = true;
      writeNudges = 2;
      readRejections = 0;
      queuedActions.length = 0;
      transcript.push({
        role: "system",
        content:
          "Decision point: you have made 8+ read-only calls without changing a file. Stop reading. If the requested behavior already exists, verify it and call finish with file:line evidence and no edit. Otherwise make the smallest edit now with replace_in_file or write_file. Further file-reading/search calls are blocked, but browser_check, run_test_scenario and game_check remain available for verification. Then finish.",
      });
      log("warn", "Decision point: edit or finish", `${readOnlyStepsSinceChange} read-only calls · no edit`);
    }
    if (
      !readOnlyMode &&
      plan.needsWrite &&
      changedFiles.length > 0 &&
      readOnlyStepsSinceChange >= (microEditMode ? 2 : tightReadsMode ? 3 : 4) &&
      !postEditReadNudged
    ) {
      postEditReadNudged = true;
      queuedActions.length = 0;
      transcript.push({
        role: "system",
        content:
          "Code already changed. Stop reading. Run browser_check or game_check on the real entry page now to verify the changed behavior. If it fails, fix only that concrete failure with the smallest edit, then verify again and finish. Further read/search calls are blocked.",
      });
      log(
        "warn",
        "Post-edit decision point",
        `${readOnlyStepsSinceChange} read-only calls after a change`,
      );
    }
    if (
      !readOnlyMode &&
      verificationPassed &&
      changedFiles.length === 0 &&
      readOnlyStepsSinceChange >= (microEditMode ? 3 : tightReadsMode ? 5 : 8) &&
      !verificationNudged
    ) {
      verificationNudged = true;
      transcript.push({
        role: "system",
        content:
          "A real verification already passed and no edit is needed. Finish now with the evidence: file:line references, the verification result, and why no change is required. Do not read more files.",
      });
      log("warn", "Verification decision point", "verification passed; finish with evidence");
    }
    if (step.action === "invalid") {
      protocolFailures += 1;
      if (protocolFailures >= 2) {
        stoppedReason = "error";
        const detail = step.observation.replace(/\s+/g, " ").slice(0, 500);
        summary = `The model repeatedly returned an invalid tool protocol. Last reply: ${detail} Switch model or retry; the task was stopped early to avoid burning tokens.`;
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

    // Progress watchdog: run without a fixed step budget, but stop when the
    // model keeps failing or repeating the same calls with no new information.
    const repeatObservation = /Already executed in step \d+ with the same arguments/.test(
      step.observation,
    );
    const unproductive =
      !ok || step.action === "invalid" || (READ_ONLY_ACTIONS.has(step.action) && repeatObservation);
    unproductiveTurns = unproductive ? unproductiveTurns + 1 : 0;
    if (unproductiveTurns === 4 && !progressNudged) {
      progressNudged = true;
      transcript.push({
        role: "system",
        content:
          "Four turns produced no progress. Change approach now: fix the failing tool arguments, read a different range or file, or make the edit. Do not repeat the same calls.",
      });
      log("warn", "No-progress warning", "4 turns without new information");
    }
    if (unproductiveTurns >= 8) {
      stoppedReason = "error";
      summary = `Stopped after ${unproductiveTurns} turns without progress: the same failing or repeated calls kept coming back. Last observation: ${step.observation.slice(
        0,
        400,
      )} Fix the failing call or provide a different instruction, then continue.`;
      errorMessage = summary;
      log("error", "Stopping a loop without progress", `${unproductiveTurns} unproductive turns`);
      break;
    }

    // Count only the current run. startingUsage belongs to earlier attempts and
    // must not make a fresh retry begin already over the guard.
    const spentThisRun = tokenTotal.totalTokens;
    const currentCodeChanges = changedFiles.filter((file) => !file.startsWith(".cie/")).length;
    if (currentCodeChanges > codeChangeCount) {
      codeChangeCount = currentCodeChanges;
      tokensAtLastCodeChange = spentThisRun;
      postChangeNudged = false;
    } else if (codeChangeCount > 0 && spentThisRun - tokensAtLastCodeChange >= 200_000 && !postChangeNudged) {
      postChangeNudged = true;
      transcript.push({
        role: "system",
        content:
          "You already changed runtime code but have spent 200k tokens since the last code edit. Stop verifying in circles. Finish with the current evidence, or make the one remaining code edit now.",
      });
      log("warn", "Post-change verification warning", `${spentThisRun - tokensAtLastCodeChange} tokens since the last code edit`);
    } else if (codeChangeCount > 0 && spentThisRun - tokensAtLastCodeChange >= 300_000) {
      stoppedReason = "error";
      summary = `Post-change verification stop: ${(
        spentThisRun - tokensAtLastCodeChange
      ).toLocaleString()} tokens spent since the last runtime code change. The change itself is preserved. Finish from the current files or run one focused verification, then stop.`;
      errorMessage = summary;
      log("error", "Post-change verification stop", `${spentThisRun - tokensAtLastCodeChange} tokens since the last code edit`);
      break;
    }
    const spentLimit = readOnlyMode
      ? READ_ONLY_TOKEN_LIMIT
      : changedFiles.length === 0
        ? NO_PROGRESS_TOKEN_LIMIT
        : WORKING_TOKEN_LIMIT;
    if (spentThisRun >= spentLimit) {
      stoppedReason = "error";
      summary = `Token safety stop: ${spentThisRun.toLocaleString()} tokens spent with ${
        readOnlyMode
          ? "no final answer"
          : changedFiles.length === 0
            ? "no file changed"
            : "no completion"
      }. The run was stopped to prevent an endless loop. ${
        changedFiles.length === 0
          ? "Split the task into smaller single-behavior tasks or retry with a narrower scope."
          : "Finish from the current files or report the exact remaining blocker."
      }`;
      errorMessage = summary;
      log("error", "Token safety stop", `${spentThisRun.toLocaleString()} tokens · ${changedFiles.length} file(s) changed`);
      break;
    }
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
      const finalCompletion = await chatCompleteTracked(
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
        {
          maxTokens: 2500,
          temperature: 0.1,
          timeoutMs: 90_000,
          signal,
          onToken: (chunk) => emit({ type: "token", text: chunk }),
        },
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
        summary = `${summary}\n\n**Verification:** \`${finalVerification.command}\` passed.`.trim();
      }
      if (finalVerification?.ran && !finalVerification.ok) {
        summary = `${summary}\n\n**Verification failed:** \`${finalVerification.command}\`\n\`\`\`\n${finalVerification.output.slice(0, 3_000)}\n\`\`\``.trim();
      }
    } catch {
      // keep the step-limit summary
    }
  }

  if (stoppedReason === "aborted") {
    summary = summary || "Stopped by the user.";
  } else if (
    stoppedReason !== "finished" &&
    stoppedReason !== "error" &&
    stoppedReason !== "budget"
  ) {
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
      ? ` Last successful tool: ${lastSuccess.action} — ${lastSuccess.observation.slice(0, 700)}`
      : "";
    const reason =
      errorMessage?.trim() ||
      summary.trim() ||
      "The agent stopped because a request failed.";
    summary = `${reason}${worked}${lastEvidence}`;
  }

  summary = stripCommentaryTags(summary);
  if (!summary.trim() && errorMessage) summary = errorMessage;

  if (isToolCallLeak(summary)) {
    const cleaned = stripToolCallMarkup(summary);
    summary =
      cleaned ||
      "The agent could not produce a clean final answer because the model returned provider tool-call markup. Check the tool steps and retry or switch models.";
  }

  if (budgetWarning && summary.trim()) {
    summary = `${summary}\n\n**Budget warning:** ${budgetWarning} The task continued because task budget enforcement is set to warn.`;
  }

  if (stoppedReason === "finished" && summary.trim()) {
    await recordConversation(projectId, instruction, summary, config.id, config.model).catch(() => {
      // conversation indexing is best-effort
    });
  }

  const costUsd = await estimateUsageCost(config.id, config.model, tokenTotal).catch(() => undefined);
  const invalidProtocolSteps = steps.filter((step) => step.action === "invalid").length;
  await recordModelOutcome(config.id, config.model, {
    success: stoppedReason === "finished" && invalidProtocolSteps < 2,
    protocolFailure:
      invalidProtocolSteps >= 2 ||
      /invalid tool protocol|provider-native tool call omitted/i.test(summary || errorMessage || ""),
    emptyFailure: /empty response/i.test(summary || errorMessage || ""),
    unavailable: /error 410\b|end of life|no longer available|model_not_found|model .* not found/i.test(
      `${summary || ""} ${errorMessage || ""}`,
    ),
  }).catch(() => {
    // health tracking must never break an agent run
  });

  let changeReport: ChangeReport | undefined;
  if (!readOnlyMode && changedFiles.length > 0) {
    try {
      changeReport = (await buildChangeReport(projectId, analysis)).report;
    } catch (error) {
      log(
        "warn",
        "Change report unavailable",
        error instanceof Error ? error.message.slice(0, 200) : "could not build change report",
      );
    }
  }

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
    planPath,
    skillsUsed: [...new Set(usedSkills)],
    usage: {
      inputChars,
      estimatedTokens: Math.ceil(inputChars / 4),
      contextFiles: evidence.slice(0, 30),
    },
    tokenUsage: tokenTotal,
    costUsd,
    logs,
    changeReport,
    extraction: lastExtraction ?? undefined,
    readMap: [...readMap.values()]
      .slice(0, 300)
      .map((entry) => ({
        path: entry.path,
        ranges: entry.ranges,
        symbols: [...entry.symbols],
        tools: [...entry.tools],
      })),
  };
}
