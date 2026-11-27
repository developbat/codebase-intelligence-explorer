import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { AnalysisResult, SymbolRecord } from "../../../shared/types";
import type { ProjectDiagnosis, DiagnosisDesign, DiagnosisFact, DiagnosisFailureMode, DiagnosisVerification } from "../../../shared/diagnosis";
import type { BrowserCheckStep } from "../../../shared/browserCheck";
import type { AiProviderId } from "../../../shared/ai";
import { chatComplete } from "./complete";
import { resolveAgentRole } from "./settings";
import { recordUsage } from "./usage";
import { estimateUsageCost } from "./pricing";
import { compactProjectBrainBrief, ensureProjectBrain } from "../projectBrain";
import { ensureProjectMap } from "../projectMap";
import { readSourceFile } from "../editor";
import { runBrowserCheck } from "../browserCheck";

const DIAGNOSIS_FILE = "diagnosis.json";
const DIAGNOSIS_MARKDOWN_FILE = "diagnosis.md";
const MAX_CONTEXT_CHARS = 18_000;
const MAX_EXCERPT_CHARS = 9_000;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "add", "fix", "make", "get", "set", "use", "from",
  "this", "that", "var", "let", "const", "into", "only", "just", "please", "should",
  "would", "could", "when", "then", "than", "have", "has", "bir", "bu", "şu", "ve",
  "ile", "için", "olarak", "olan", "ama", "fakat", "çok", "daha", "gibi", "kadar",
  "her", "hem", "veya", "yok", "var", "değil", "olsun", "olsun", "yap", "yapalım",
  "düzelt", "düzeltme", "ekle", "kaldır", "değiştir", "güncelle", "kontrol", "et",
  "bunu", "şunu", "aynı", "farklı", "önce", "sonra", "üzerinde", "içinde", "mı", "mi",
]);

export function diagnosisPaths(rootPath: string): { json: string; markdown: string } {
  const directory = path.join(rootPath, ".cie", "agent");
  return {
    json: path.join(directory, DIAGNOSIS_FILE),
    markdown: path.join(directory, DIAGNOSIS_MARKDOWN_FILE),
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function clip(value: unknown, max: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function stringList(value: unknown, limit = 12): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => clip(item, 500))
        .slice(0, limit)
    : [];
}

function extractJson(text: string): Record<string, unknown> | null {
  const trimmed = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function riskValue(value: unknown): DiagnosisDesign["risk"] {
  const risk = String(value ?? "").toLowerCase();
  return risk === "low" || risk === "high" ? risk : "medium";
}

function normalizeFacts(value: unknown): DiagnosisFact[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      claim: clip(item.claim ?? item.text ?? item.fact, 400),
      file: typeof item.file === "string" ? clip(item.file, 240) : undefined,
      line: Number(item.line) || undefined,
      evidence: typeof item.evidence === "string" ? clip(item.evidence, 400) : undefined,
    }))
    .filter((fact) => fact.claim)
    .slice(0, 20);
}

function normalizeDesigns(value: unknown): DiagnosisDesign[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      name: clip(item.name ?? item.title ?? "Design", 120),
      summary: clip(item.summary ?? item.description ?? "", 700),
      pros: stringList(item.pros, 6),
      cons: stringList(item.cons, 6),
      files: stringList(item.files, 10),
      risk: riskValue(item.risk),
    }))
    .filter((design) => design.summary)
    .slice(0, 3);
}

function normalizeFailureModes(value: unknown): DiagnosisFailureMode[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      scenario: clip(item.scenario ?? item.case ?? "", 300),
      impact: clip(item.impact ?? "", 300),
      mitigation: clip(item.mitigation ?? item.mitigation ?? "", 300),
    }))
    .filter((mode) => mode.scenario)
    .slice(0, 10);
}

const BROWSER_ACTIONS = new Set([
  "click",
  "fill",
  "press",
  "pressKeys",
  "eval",
  "expectText",
  "expectValue",
  "expectVisible",
  "expectCount",
  "expectStable",
  "waitForText",
  "waitForSelector",
]);

function normalizeSteps(value: unknown): BrowserCheckStep[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => {
      const action = String(item.action ?? "").trim();
      if (!BROWSER_ACTIONS.has(action)) return null;
      const step: BrowserCheckStep = { action: action as BrowserCheckStep["action"] };
      if (typeof item.selector === "string" && item.selector.trim()) step.selector = item.selector.trim();
      if (typeof item.value === "string") step.value = item.value;
      if (typeof item.text === "string") step.text = item.text;
      if (typeof item.expectText === "string") step.expectText = item.expectText;
      if (typeof item.script === "string") step.script = item.script;
      if (typeof item.expression === "string") step.expression = item.expression;
      if (typeof item.code === "string") step.code = item.code;
      if (typeof item.contains === "string") step.contains = item.contains;
      if (typeof item.expected === "string") step.expected = item.expected;
      if (Array.isArray(item.keys)) step.keys = item.keys.filter((key): key is string => typeof key === "string");
      if (typeof item.count === "number") step.count = item.count;
      return step;
    })
    .filter((step): step is BrowserCheckStep => Boolean(step))
    .slice(0, 8);
}

function normalizeVerification(
  value: unknown,
  fallbackCommands: string[],
  entryPath?: string,
): DiagnosisVerification {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const steps = normalizeSteps(record.steps);
  return {
    command:
      typeof record.command === "string" && record.command.trim()
        ? clip(record.command, 400)
        : fallbackCommands[0],
    path:
      typeof record.path === "string" && record.path.trim()
        ? clip(record.path, 240)
        : entryPath,
    steps,
    checks: stringList(record.checks, 8),
    expected: stringList(record.expected, 8),
  };
}

function goalTokens(goal: string): string[] {
  return [...new Set((goal.toLowerCase().match(/[a-z0-9_çğıöşü]{3,}/g) ?? []))]
    .filter((token) => !STOPWORDS.has(token))
    .slice(0, 30);
}

function scoreSymbol(symbol: SymbolRecord, tokens: string[], goalFiles: Set<string>): number {
  const haystack = `${symbol.name} ${symbol.qualifiedName} ${symbol.filePath}`.toLowerCase();
  let score = 0;
  for (const token of tokens) if (haystack.includes(token)) score += 4;
  if (goalFiles.has(symbol.filePath)) score += 3;
  score += Math.min(4, ((symbol as unknown as { callerCount?: number }).callerCount ?? 0) / 3);
  return score;
}

function candidateSymbols(analysis: AnalysisResult, goal: string): SymbolRecord[] {
  const tokens = goalTokens(goal);
  const goalFiles = new Set(
    analysis.files
      .filter((file) => tokens.some((token) => file.path.toLowerCase().includes(token)))
      .map((file) => file.path),
  );
  return [...analysis.symbols]
    .filter((symbol) => !/\.(?:test|spec)\./i.test(symbol.filePath))
    .map((symbol) => ({ symbol, score: scoreSymbol(symbol, tokens, goalFiles) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map((entry) => entry.symbol);
}

function candidateFiles(analysis: AnalysisResult, symbols: SymbolRecord[], goal: string): string[] {
  const tokens = goalTokens(goal);
  const fromGoal = analysis.files
    .filter((file) => tokens.some((token) => file.path.toLowerCase().includes(token)))
    .map((file) => file.path);
  const fromSymbols = symbols.map((symbol) => symbol.filePath);
  const entry = analysis.files
    .filter((file) => /(^|\/)(index\.html?|main\.[jt]sx?|app\.[jt]s|server\.[jt]s|package\.json)$/i.test(file.path))
    .map((file) => file.path);
  return [...new Set([...fromGoal, ...fromSymbols, ...entry])]
    .filter((file) => !file.startsWith(".cie/") && !file.startsWith(".git/"))
    .slice(0, 10);
}

function edgeHighlights(analysis: AnalysisResult, symbols: SymbolRecord[]): string[] {
  const ids = new Set(symbols.map((symbol) => symbol.id));
  const nodes = new Map(analysis.nodes.map((node) => [node.id, node]));
  const out: string[] = [];
  for (const edge of analysis.edges) {
    if (!["CALLS", "IMPORTS", "ROUTES_TO", "READS_FROM", "WRITES_TO"].includes(edge.kind)) continue;
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    if (!source || !target) continue;
    if (!ids.has(source.id) && !ids.has(target.id)) continue;
    const from = `${source.label}${source.filePath ? ` (${source.filePath}${source.startLine ? `:${source.startLine}` : ""})` : ""}`;
    const to = `${target.label}${target.filePath ? ` (${target.filePath}${target.startLine ? `:${target.startLine}` : ""})` : ""}`;
    out.push(`${edge.kind}: ${from} → ${to}`);
  }
  return [...new Set(out)].slice(0, 24);
}

function includeHighlights(analysis: AnalysisResult, files: string[]): string[] {
  const out: string[] = [];
  for (const file of analysis.files) {
    if (!files.includes(file.path)) continue;
    for (const imported of file.imports.slice(0, 12)) {
      out.push(`${file.path} imports ${imported}`);
    }
  }
  return [...new Set(out)].slice(0, 24);
}

async function readExcerpts(
  analysis: AnalysisResult,
  symbols: SymbolRecord[],
  files: string[],
): Promise<string[]> {
  const blocks: string[] = [];
  let used = 0;
  const seen = new Set<string>();
  for (const symbol of symbols) {
    if (used >= MAX_EXCERPT_CHARS) break;
    const file = await readSourceFile(analysis.rootPath, symbol.filePath).catch(() => null);
    if (!file) continue;
    const lines = file.content.split("\n");
    const start = Math.max(1, symbol.startLine - 12);
    const end = Math.min(lines.length, symbol.endLine + 12);
    const key = `${symbol.filePath}:${start}-${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const body = lines.slice(start - 1, end).map((line, index) => `${start + index} │ ${line}`).join("\n");
    const block = `--- ${symbol.filePath}:${start}-${end} · ${symbol.name} ---\n${body}`;
    if (used + block.length > MAX_EXCERPT_CHARS) break;
    blocks.push(block);
    used += block.length;
  }
  for (const filePath of files) {
    if (used >= MAX_EXCERPT_CHARS) break;
    if (symbols.some((symbol) => symbol.filePath === filePath)) continue;
    const file = await readSourceFile(analysis.rootPath, filePath).catch(() => null);
    if (!file) continue;
    const lines = file.content.split("\n").slice(0, 90);
    const body = lines.map((line, index) => `${index + 1} │ ${line}`).join("\n");
    const block = `--- ${filePath}:1-${lines.length} ---\n${body}`;
    if (used + block.length > MAX_EXCERPT_CHARS) break;
    blocks.push(block);
    used += block.length;
  }
  return blocks;
}

async function buildDiagnosisContext(
  analysis: AnalysisResult,
  goal: string,
  constraints: string[],
): Promise<string> {
  const symbols = candidateSymbols(analysis, goal);
  const files = candidateFiles(analysis, symbols, goal);
  const [brain, projectMap, excerpts] = await Promise.all([
    ensureProjectBrain(analysis).catch(() => null),
    ensureProjectMap(analysis).catch(() => ""),
    readExcerpts(analysis, symbols, files),
  ]);
  const brainBrief = brain ? compactProjectBrainBrief(brain) : "";
  const routeNodes = analysis.nodes
    .filter((node) => node.kind === "route" || node.kind === "database" || node.kind === "event")
    .slice(0, 20)
    .map((node) => `${node.kind}: ${node.label}${node.filePath ? ` — ${node.filePath}${node.startLine ? `:${node.startLine}` : ""}` : ""}`);
  const verification = [
    ...(analysis.tooling?.testCommands ?? []),
    ...(analysis.tooling?.typecheckCommands ?? []),
    ...(analysis.tooling?.buildCommands ?? []),
    ...(analysis.tooling?.lintCommands ?? []),
  ];
  const blocks = [
    brainBrief ? `## Project brain\n${brainBrief}` : "",
    projectMap ? `## Project map\n${projectMap.slice(0, 2_500)}` : "",
    `## Goal\n${goal}`,
    constraints.length ? `## User constraints\n${constraints.map((item) => `- ${item}`).join("\n")}` : "",
    symbols.length
      ? `## Candidate symbols\n${symbols.map((symbol) => `- ${symbol.name} — ${symbol.filePath}:${symbol.startLine} (${symbol.kind})`).join("\n")}`
      : "",
    files.length ? `## Candidate files\n${files.join("\n")}` : "",
    edgeHighlights(analysis, symbols).length
      ? `## Call/import edges\n${edgeHighlights(analysis, symbols).join("\n")}`
      : "",
    includeHighlights(analysis, files).length
      ? `## Includes/imports\n${includeHighlights(analysis, files).join("\n")}`
      : "",
    routeNodes.length ? `## Routes/data/events\n${routeNodes.join("\n")}` : "",
    verification.length ? `## Verification commands\n${verification.join(" | ")}` : "",
    excerpts.length ? `## Code excerpts\n${excerpts.join("\n\n")}` : "",
  ].filter(Boolean);
  const text = blocks.join("\n\n");
  return text.length > MAX_CONTEXT_CHARS ? `${text.slice(0, MAX_CONTEXT_CHARS)}\n… [diagnosis context truncated]` : text;
}

const DIAGNOSIS_SYSTEM = `You are a senior software diagnostician for a coding agent. You do not write code. Return JSON only, no markdown fences.
Schema:
{"problem":"one sentence","rootCause":"one or two sentences","confidence":0.0,"facts":[{"claim":"verified fact","file":"path","line":1,"evidence":"short quote or observation"}],"constraints":["user/project constraint"],"unknowns":["unresolved question"],"callSites":["file:line — symbol/behavior"],"includes":["import/include chain"],"impact":["affected module/route/data"],"designs":[{"name":"short","summary":"what to change","pros":["..."],"cons":["..."],"files":["path"],"risk":"low|medium|high"}],"chosenDesign":"design name","rationale":"why chosen","failureModes":[{"scenario":"what can fail","impact":"user/system impact","mitigation":"guard/rollback"}],"rollback":"how to undo safely","verification":{"command":"command or empty","path":"index.html","steps":[{"action":"click","selector":"#start-btn"},{"action":"eval","script":"...","expectText":"..."}],"checks":["runtime/DOM/DB check"],"expected":["observable result"]},"todos":["small ordered step"]}
Rules:
- Ground every fact in the provided project brain, graph edges, excerpts or explicit user constraints. Cite file:line. Do not invent files, APIs or behavior.
- If the project has a real HTML/UI entry, 'verification.steps' is REQUIRED: include 2-6 concrete steps with at least one interaction (click/fill/press/pressKeys/eval) and one assertion (expectText/expectValue/expectCount/expectStable or an eval with expectText). Use only selectors/text you saw in the evidence. For canvas/global behavior, a single eval step with expectText is valid. Example: [{"action":"click","selector":"#start-btn"},{"action":"eval","script":"...","expectText":"true"}]. If the project has no HTML/UI entry, leave steps empty and describe prose checks instead.
- Read the Project brain first; reuse it instead of rediscovering.
- If evidence is insufficient, list it under unknowns; do not guess.
- Produce exactly two designs (or one when only one is genuinely viable) and choose one. Include concrete tradeoffs, failure modes and a rollback.
- This is diagnosis only: no edits. The planner will turn it into tasks.
- Respect user constraints (server-only, do not touch X, no secrets in responses).
- Return ONLY the JSON object. No prose, markdown or commentary. Keep every string short.
- Limits: at most 4 facts, 2 designs, 2 pros/cons each, 3 failure modes, 5 todos. Every string must be <= 220 characters.`;

export interface DiagnoseResult {
  diagnosis: ProjectDiagnosis;
  provider: string;
  model: string;
  tokenUsage?: ProjectDiagnosis["tokenUsage"];
  costUsd?: number;
  usedFallback: boolean;
}

function fallbackDiagnosis(
  analysis: AnalysisResult,
  goal: string,
  constraints: string[],
  reason: string,
): ProjectDiagnosis {
  const files = analysis.files
    .filter((file) => !file.path.startsWith(".cie/") && !file.path.startsWith(".git/"))
    .slice(0, 8);
  const verificationCommands = [
    ...(analysis.tooling?.testCommands ?? []),
    ...(analysis.tooling?.typecheckCommands ?? []),
    ...(analysis.tooling?.buildCommands ?? []),
  ];
  return {
    version: 1,
    goal,
    createdAt: nowIso(),
    problem: clip(goal, 500),
    rootCause:
      "The diagnosis model did not return a reliable structured analysis. Inspect the candidate files and the project brain before editing.",
    confidence: 0.2,
    facts: files.map((file) => ({
      claim: `${file.path} is part of the project (${file.loc} lines).`,
      file: file.path,
    })),
    constraints,
    unknowns: [clip(reason, 500), "Root cause, call sites and the safest design still need confirmation."],
    callSites: [],
    includes: [],
    impact: [],
    designs: [],
    chosenDesign: "Inspect then make the smallest safe change",
    rationale: "Fallback diagnosis because the model output could not be parsed.",
    failureModes: [],
    rollback: "Revert only the files changed by the task; keep unrelated work intact.",
    verification: {
      command: verificationCommands[0],
      checks: analysis.files.some((file) => /\.html?$/i.test(file.path))
        ? ["Open the real entry page and assert the changed behavior with browser_check."]
        : ["Verify the changed behavior with the project's existing entry point."],
      expected: ["The requested behavior works and no existing flow regresses."],
    },
    todos: [
      "Read the candidate files and confirm the root cause.",
      "Choose the smallest safe change and apply it.",
      "Run the verification commands and real-page check.",
    ],
  };
}

function normalizeDiagnosis(
  raw: Record<string, unknown>,
  analysis: AnalysisResult,
  goal: string,
  constraints: string[],
): ProjectDiagnosis {
  const designs = normalizeDesigns(raw.designs);
  const chosenDesign =
    typeof raw.chosenDesign === "string" && raw.chosenDesign.trim()
      ? clip(raw.chosenDesign, 160)
      : designs[0]?.name ?? "Smallest safe change";
  const facts = normalizeFacts(raw.facts);
  const entryPath =
    analysis.files.find((file) => /(^|\/)index\.html?$/i.test(file.path))?.path ??
    analysis.files.find((file) => /\.html?$/i.test(file.path))?.path;
  const verification = normalizeVerification(
    raw.verification,
    [
      ...(analysis.tooling?.testCommands ?? []),
      ...(analysis.tooling?.typecheckCommands ?? []),
      ...(analysis.tooling?.buildCommands ?? []),
    ],
    entryPath,
  );
  return {
    version: 1,
    goal,
    createdAt: nowIso(),
    problem: clip(raw.problem ?? goal, 800),
    rootCause: clip(raw.rootCause ?? raw.root_cause ?? "Root cause not stated.", 1_200),
    confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0.5)),
    facts,
    constraints: [...new Set([...constraints, ...stringList(raw.constraints, 12)])].slice(0, 16),
    unknowns: stringList(raw.unknowns, 12),
    callSites: stringList(raw.callSites ?? raw.call_sites, 20),
    includes: stringList(raw.includes ?? raw.include_chain, 20),
    impact: stringList(raw.impact, 16),
    designs,
    chosenDesign,
    rationale: clip(raw.rationale, 1_200),
    failureModes: normalizeFailureModes(raw.failureModes ?? raw.failure_modes),
    rollback: clip(raw.rollback, 800),
    verification,
    todos: stringList(raw.todos, 12),
  };
}

export async function diagnoseProject(
  analysis: AnalysisResult,
  goal: string,
  options: {
    provider?: AiProviderId;
    model?: string;
    constraints?: string[];
    language?: string;
    signal?: AbortSignal;
  } = {},
): Promise<DiagnoseResult> {
  const constraints = [...new Set((options.constraints ?? []).map((item) => clip(item, 300)).filter(Boolean))];
  const config = await resolveAgentRole("diagnosis", {
    provider: options.provider,
    model: options.model,
  });
  const context = await buildDiagnosisContext(analysis, goal, constraints);
  let rawText = "";
  let tokenUsage: ProjectDiagnosis["tokenUsage"] | undefined;
  try {
    const messages = [
      { role: "system" as const, content: DIAGNOSIS_SYSTEM },
      {
        role: "user" as const,
        content: `${context}\n\nReturn the diagnosis JSON now. Write all strings in ${options.language ?? "the user's language"}.`,
      },
    ];
    const run = (jsonMode: boolean) =>
      chatComplete(
        config,
        messages,
        {
          maxTokens: 4_500,
          temperature: 0.1,
          timeoutMs: 120_000,
          ...(jsonMode ? { responseFormat: "json" as const } : {}),
        },
        {
          maxContinuations: 1,
          continuationPrompt:
            "Continue the JSON object exactly where it stopped. Do not repeat earlier text. Do not add prose, markdown, explanations or a new object.",
        },
      );
    let completion: Awaited<ReturnType<typeof chatComplete>>;
    try {
      completion = await run(true);
    } catch {
      // Some OpenAI-compatible providers reject response_format; retry once.
      completion = await run(false);
    }
    rawText = completion.text;
    tokenUsage = completion.tokenUsage;
    const parsed = extractJson(rawText);
    if (!parsed) {
      if (process.env.CIE_DEBUG_DIAGNOSIS === "1") {
        console.warn("[diagnosis] parse failed; first 4000 chars:\n", rawText.slice(0, 4_000));
      }
      throw new Error("Diagnosis model did not return JSON.");
    }
    const diagnosis = normalizeDiagnosis(parsed, analysis, goal, constraints);
    diagnosis.provider = config.id;
    diagnosis.model = config.model;
    diagnosis.tokenUsage = tokenUsage;
    const costUsd = await estimateUsageCost(config.id, config.model, tokenUsage).catch(() => undefined);
    diagnosis.costUsd = costUsd;
    if (diagnosis.verification.steps?.length) {
      const valid = await validateDiagnosisScenario(analysis, diagnosis);
      if (!valid) {
        diagnosis.verification.steps = [];
        diagnosis.unknowns.push(
          "The generated browser verification steps failed on the real page, so they were dropped; use the prose checks.",
        );
      }
    }
    await saveDiagnosis(analysis.rootPath, diagnosis).catch(() => undefined);
    await saveDiagnosisScenario(analysis.rootPath, diagnosis).catch(() => undefined);
    await recordUsage({
      projectId: analysis.id,
      provider: config.id,
      model: config.model,
      kind: "agent-diagnosis",
      inputTokens: tokenUsage.inputTokens,
      outputTokens: tokenUsage.outputTokens,
      totalTokens: tokenUsage.totalTokens,
      costUsd,
    }).catch(() => undefined);
    return {
      diagnosis,
      provider: config.id,
      model: config.model,
      tokenUsage,
      costUsd,
      usedFallback: false,
    };
  } catch (error) {
    const diagnosis = fallbackDiagnosis(
      analysis,
      goal,
      constraints,
      error instanceof Error ? error.message : "Diagnosis model failed.",
    );
    diagnosis.provider = config.id;
    diagnosis.model = config.model;
    diagnosis.tokenUsage = tokenUsage;
    await saveDiagnosis(analysis.rootPath, diagnosis).catch(() => undefined);
    await saveDiagnosisScenario(analysis.rootPath, diagnosis).catch(() => undefined);
    return {
      diagnosis,
      provider: config.id,
      model: config.model,
      tokenUsage,
      usedFallback: true,
    };
  }
}

export function diagnosisScenarioName(goal: string): string {
  return `diagnosis-${crypto.createHash("sha1").update(goal.trim()).digest("hex").slice(0, 10)}`;
}

export function isUsableDiagnosisScenario(diagnosis: ProjectDiagnosis | null): boolean {
  if (!diagnosis?.verification.path) return false;
  const steps = diagnosis.verification.steps ?? [];
  if (steps.length < 2) return false;
  const interaction = steps.some((step) =>
    ["click", "fill", "press", "pressKeys", "eval"].includes(step.action),
  );
  const assertion = steps.some(
    (step) =>
      ["expectText", "expectValue", "expectCount", "expectStable", "waitForText"].includes(step.action) ||
      (step.action === "eval" && Boolean(step.expectText ?? step.contains ?? step.expected)),
  );
  return interaction && assertion;
}

/** Persist the diagnosis verification as a reusable browser scenario. */
export async function saveDiagnosisScenario(
  rootPath: string,
  diagnosis: ProjectDiagnosis,
): Promise<{ name: string; path: string; steps: BrowserCheckStep[] } | null> {
  if (!isUsableDiagnosisScenario(diagnosis)) return null;
  const name = diagnosisScenarioName(diagnosis.goal);
  const directory = path.join(rootPath, ".cie", "agent", "scenarios");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${name}.json`);
  const payload = {
    name,
    path: diagnosis.verification.path,
    steps: diagnosis.verification.steps,
    timeoutMs: 30_000,
    createdAt: diagnosis.createdAt,
    source: "diagnosis",
  };
  await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return {
    name,
    path: diagnosis.verification.path!,
    steps: diagnosis.verification.steps!,
  };
}

/**
 * A model-written scenario is only useful if it actually passes on the real
 * page. Validate once before binding it as a required finish check; a broken
 * scenario would reject every task even when the code is correct.
 */
export async function validateDiagnosisScenario(
  analysis: AnalysisResult,
  diagnosis: ProjectDiagnosis,
): Promise<boolean> {
  if (!isUsableDiagnosisScenario(diagnosis)) return false;
  const result = await runBrowserCheck(analysis.id, analysis.rootPath, {
    path: diagnosis.verification.path,
    steps: diagnosis.verification.steps,
    timeoutMs: 30_000,
  }).catch(() => null);
  return result?.ok === true;
}

export async function saveDiagnosis(rootPath: string, diagnosis: ProjectDiagnosis): Promise<void> {
  const paths = diagnosisPaths(rootPath);
  const directory = path.dirname(paths.json);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = `${paths.json}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(diagnosis, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temp, paths.json);
  await fs.writeFile(paths.markdown, renderDiagnosisMarkdown(diagnosis), { encoding: "utf8", mode: 0o600 });
}

export async function loadDiagnosis(rootPath: string): Promise<ProjectDiagnosis | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(diagnosisPaths(rootPath).json, "utf8")) as ProjectDiagnosis;
    return parsed?.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

export function compactDiagnosisBrief(diagnosis: ProjectDiagnosis | null, maxChars = 2_800): string {
  if (!diagnosis) return "";
  const facts = diagnosis.facts
    .slice(0, 8)
    .map((fact) => `- ${fact.claim}${fact.file ? ` (${fact.file}${fact.line ? `:${fact.line}` : ""})` : ""}`)
    .join("\n");
  const designs = diagnosis.designs
    .slice(0, 2)
    .map((design) => `- ${design.name}: ${design.summary}${design.risk ? ` · risk ${design.risk}` : ""}`)
    .join("\n");
  const failures = diagnosis.failureModes
    .slice(0, 5)
    .map((mode) => `- ${mode.scenario} → ${mode.mitigation}`)
    .join("\n");
  const blocks = [
    "## Diagnosis",
    `Problem: ${diagnosis.problem}`,
    `Root cause: ${diagnosis.rootCause}`,
    `Confidence: ${Math.round(diagnosis.confidence * 100)}%`,
    facts ? `Facts:\n${facts}` : "",
    diagnosis.constraints.length ? `Constraints:\n${diagnosis.constraints.map((item) => `- ${item}`).join("\n")}` : "",
    designs ? `Designs:\n${designs}` : "",
    `Chosen design: ${diagnosis.chosenDesign}${diagnosis.rationale ? `\nWhy: ${diagnosis.rationale}` : ""}`,
    diagnosis.callSites.length ? `Call sites/impact:\n${diagnosis.callSites.slice(0, 8).map((item) => `- ${item}`).join("\n")}` : "",
    failures ? `Failure modes:\n${failures}` : "",
    `Rollback: ${diagnosis.rollback}`,
    diagnosis.verification.command || diagnosis.verification.checks.length
      ? `Verification: ${[diagnosis.verification.command, ...diagnosis.verification.checks].filter(Boolean).join(" · ")}`
      : "",
    diagnosis.verification.steps?.length
      ? `Browser steps (${diagnosis.verification.path ?? "entry"}): ${diagnosis.verification.steps
          .map((step) => `${step.action}${step.selector ? ` ${step.selector}` : ""}`)
          .join(" → ")}`
      : "",
    diagnosis.unknowns.length ? `Unknowns:\n${diagnosis.unknowns.slice(0, 6).map((item) => `- ${item}`).join("\n")}` : "",
    diagnosis.todos.length ? `Todos:\n${diagnosis.todos.slice(0, 8).map((item) => `- ${item}`).join("\n")}` : "",
  ].filter(Boolean);
  const text = blocks.join("\n");
  return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 24))}\n… [diagnosis brief truncated]` : text;
}

export function renderDiagnosisMarkdown(diagnosis: ProjectDiagnosis): string {
  const lines: string[] = [
    "# Diagnosis",
    "",
    `Goal: ${diagnosis.goal}`,
    `Generated: ${diagnosis.createdAt}${diagnosis.provider ? ` · ${diagnosis.provider}/${diagnosis.model}` : ""}`,
    `Confidence: ${Math.round(diagnosis.confidence * 100)}%`,
    "",
    "## Problem",
    diagnosis.problem,
    "",
    "## Root cause",
    diagnosis.rootCause,
    "",
    "## Facts",
  ];
  if (diagnosis.facts.length === 0) lines.push("- None recorded.");
  for (const fact of diagnosis.facts) {
    lines.push(`- ${fact.claim}${fact.file ? ` — ${fact.file}${fact.line ? `:${fact.line}` : ""}` : ""}${fact.evidence ? ` — ${fact.evidence}` : ""}`);
  }
  lines.push("", "## Constraints");
  if (diagnosis.constraints.length === 0) lines.push("- None recorded.");
  for (const constraint of diagnosis.constraints) lines.push(`- ${constraint}`);
  lines.push("", "## Call sites and impact");
  for (const item of diagnosis.callSites) lines.push(`- ${item}`);
  for (const item of diagnosis.includes) lines.push(`- include: ${item}`);
  for (const item of diagnosis.impact) lines.push(`- impact: ${item}`);
  lines.push("", "## Designs");
  for (const design of diagnosis.designs) {
    lines.push(`### ${design.name} (${design.risk})`);
    lines.push(design.summary);
    if (design.pros.length) lines.push(`- Pros: ${design.pros.join("; ")}`);
    if (design.cons.length) lines.push(`- Cons: ${design.cons.join("; ")}`);
    if (design.files.length) lines.push(`- Files: ${design.files.join(", ")}`);
  }
  lines.push("", `## Chosen design: ${diagnosis.chosenDesign}`, diagnosis.rationale);
  lines.push("", "## Failure modes and rollback");
  for (const mode of diagnosis.failureModes) lines.push(`- ${mode.scenario} → ${mode.impact} → ${mode.mitigation}`);
  lines.push(`- Rollback: ${diagnosis.rollback}`);
  lines.push("", "## Verification");
  if (diagnosis.verification.command) lines.push(`- Command: \`${diagnosis.verification.command}\``);
  for (const check of diagnosis.verification.checks) lines.push(`- Check: ${check}`);
  for (const expected of diagnosis.verification.expected) lines.push(`- Expected: ${expected}`);
  if (diagnosis.verification.steps?.length) {
    lines.push(
      `- Browser steps (${diagnosis.verification.path ?? "entry"}): ${diagnosis.verification.steps
        .map((step) => `${step.action}${step.selector ? ` ${step.selector}` : ""}`)
        .join(" → ")}`,
    );
  }
  lines.push("", "## Unknowns");
  if (diagnosis.unknowns.length === 0) lines.push("- None.");
  for (const unknown of diagnosis.unknowns) lines.push(`- ${unknown}`);
  lines.push("", "## Todos");
  if (diagnosis.todos.length === 0) lines.push("- None.");
  for (const todo of diagnosis.todos) lines.push(`- ${todo}`);
  return `${lines.join("\n")}\n`;
}
