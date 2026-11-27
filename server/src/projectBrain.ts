import fs from "node:fs/promises";
import path from "node:path";
import type { AnalysisResult } from "../../shared/types";
import type { AiAgentResult } from "../../shared/ai";
import type {
  ProjectTask,
  ProjectTaskHistoryEntry,
  ProjectTaskQueue,
} from "../../shared/tasks";
import type {
  ProjectBrain,
  ProjectBrainChange,
  ProjectBrainConstraint,
  ProjectBrainDecision,
  ProjectBrainFeature,
  ProjectBrainFile,
  ProjectBrainGlossaryEntry,
  ProjectBrainIssue,
  ProjectBrainKind,
  ProjectBrainModule,
  ProjectBrainView,
} from "../../shared/projectBrain";
import { auditProjectKnowledge, type ProjectMapAudit } from "./projectMap";
import { loadQueue, loadTaskHistory } from "./tasks";

const BRAIN_VERSION = 1 as const;
const BRAIN_GENERATOR_VERSION = 3;
const BRAIN_FILE = "project-brain.json";
const BRAIN_MARKDOWN_FILE = "project-brain.md";
const MAX_FEATURES = 24;
const MAX_RECENT = 24;
const MAX_ISSUES = 16;
const MAX_DECISIONS = 20;
const MAX_CONSTRAINTS = 20;
const MAX_MODULES = 10;
const MAX_KEY_FILES = 24;
const MAX_BRIEF_CHARS = 4_200;

const inFlight = new Map<string, Promise<ProjectBrain>>();

export function projectBrainPaths(rootPath: string): { json: string; markdown: string } {
  const directory = path.join(rootPath, ".cie", "agent");
  return {
    json: path.join(directory, BRAIN_FILE),
    markdown: path.join(directory, BRAIN_MARKDOWN_FILE),
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function clip(value: string | undefined, max: number): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

/** Never persist credentials or tokens from task summaries into project memory. */
export function redactSecrets(value: string): string {
  return value
    .replace(
      /\b(api[_-]?key|secret|password|passwd|token|authorization|bearer)\b\s*[:=]\s*(["']?)[^\s"',;]+/gi,
      (_match, key: string, quote: string) => `${key}: ${quote}[redacted]${quote}`,
    )
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "sk-[redacted]")
    .replace(/\bghp_[A-Za-z0-9]{20,}\b/g, "ghp_[redacted]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "AIza[redacted]");
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeTextAtomic(file: string, content: string): Promise<void> {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temp, file);
}

export async function loadProjectBrain(rootPath: string): Promise<ProjectBrain | null> {
  const { json } = projectBrainPaths(rootPath);
  const brain = await readJson<ProjectBrain>(json);
  if (!brain || brain.version !== BRAIN_VERSION) return null;
  return brain;
}

export async function saveProjectBrain(brain: ProjectBrain): Promise<void> {
  const paths = projectBrainPaths(brain.rootPath);
  const next = { ...brain, updatedAt: nowIso() };
  await writeTextAtomic(paths.json, `${JSON.stringify(next, null, 2)}\n`);
  await writeTextAtomic(paths.markdown, renderProjectBrainMarkdown(next));
}

/* ------------------------------------------------------------------ */
/* Generation                                                          */
/* ------------------------------------------------------------------ */

function inferKind(analysis: AnalysisResult, audit: ProjectMapAudit): ProjectBrainKind {
  const files = analysis.files.map((file) => file.path);
  const frameworks = (analysis.frameworks ?? []).join(" ").toLowerCase();
  const hasHtml = files.some((file) => /\.html?$/i.test(file));
  const hasPhp = files.some((file) => /\.php$/i.test(file));
  const hasServerApi = files.some((file) => /(^|\/)(api|server|routes?|controllers?|handlers?)\//i.test(file));
  const hasMobile =
    files.some((file) => /(^|\/)(android|ios)\//i.test(file)) ||
    files.some((file) => /(^|\/)(pubspec\.yaml|Podfile|build\.gradle)$/i.test(file));
  const hasGame = files.some((file) => /(^|\/)(game|maze|player|enemy|level|sprite)\b/i.test(file));
  const hasUiFramework = /react|vue|svelte|angular|solid|next|nuxt/.test(frameworks);
  const hasBin =
    files.some((file) => /(^|\/)bin\//i.test(file)) ||
    files.some((file) => /(^|\/)(cli|command)\b/i.test(file));

  if (hasGame) return "game";
  if (hasMobile) return "mobile";
  if (hasPhp || hasServerApi) return "api";
  if (hasUiFramework || (hasHtml && files.some((file) => /\.(?:jsx?|tsx?|vue|svelte)$/i.test(file)))) {
    return "web-app";
  }
  if (hasHtml) return "static-site";
  if (hasBin) return "cli";
  if (analysis.tooling?.manifests.length && !hasHtml) return "library";
  return "unknown";
}

function inferRole(
  filePath: string,
  kind: ProjectBrainKind,
  entryPoints: string[] = [],
): string {
  const lower = filePath.toLowerCase();
  if (entryPoints.includes(filePath)) {
    if (/\.html?$/i.test(lower)) return "entry page";
    if (/(^|\/)(main|index)\.[jt]sx?$/i.test(lower)) return "entry script";
  }
  if (/(^|\/)(test|tests|__tests__|spec)\//.test(lower) || /\.(?:test|spec)\.[a-z0-9]+$/i.test(lower)) {
    return "tests";
  }
  if (/\.(?:md|mdx|txt)$/i.test(lower) || /(^|\/)readme/i.test(lower)) return "documentation";
  if (/(^|\/)(package\.json|composer\.json|pyproject\.toml|requirements\.txt|go\.mod|cargo\.toml|pom\.xml|build\.gradle|pubspec\.yaml)$/i.test(lower)) {
    return "manifest";
  }
  if (/(^|\/)(tsconfig|vite|next|nuxt|eslint|prettier|tailwind|postcss|webpack|rollup|babel|jest|vitest|playwright|docker|compose)[^/]*\.(?:json|js|ts|mjs|cjs|yaml|yml)$/i.test(lower)) {
    return "tooling";
  }
  if (/(^|\/)index\.html?$/i.test(lower)) return "entry page";
  if (/(^|\/)(main|index)\.[jt]sx?$/i.test(lower)) return "entry script";
  if (/\.html?$/i.test(lower)) return "page";
  if (/\.(?:css|scss|sass|less)$/i.test(lower)) return "styles";
  if (/(^|\/)(api|server|routes?|controllers?|handlers?)\//i.test(lower)) return "server/API";
  if (/\.php$/i.test(lower)) return "server/API";
  if (/\.(?:sql|prisma)$/i.test(lower) || /(^|\/)(db|database|models?|migrations?|schema)\//i.test(lower)) {
    return "data model";
  }
  if (/(^|\/)(components?|pages?|views?|screens?|ui)\//i.test(lower)) return "UI";
  if (/(^|\/)(game|maze|player|enemy|level|sprite)\b/i.test(lower)) return "game logic";
  if (/(^|\/)(utils?|lib|shared|helpers?)\//i.test(lower)) return "shared logic";
  if (/\.(?:js|mjs|cjs|jsx|ts|tsx|vue|svelte)$/i.test(lower)) {
    return kind === "api" ? "server logic" : "application logic";
  }
  return "source";
}

function isKeyFileRole(role: string): boolean {
  return ["entry page", "entry script", "server/API", "game logic", "application logic", "server logic", "data model", "styles", "UI", "manifest", "tooling"].includes(
    role,
  );
}

function inferConventions(analysis: AnalysisResult, audit: ProjectMapAudit): string[] {
  const conventions: string[] = [];
  const tooling = analysis.tooling;
  const hasHtml = analysis.files.some((file) => /\.html?$/i.test(file.path));
  const hasTests = tooling?.hasTests === true;
  const languageCount = Object.keys(analysis.languages).length;
  if (languageCount === 1) {
    conventions.push(`Primary language: ${Object.keys(analysis.languages)[0]}. Keep new files in the same language.`);
  }
  if (hasHtml && audit.loaded.length > 0) {
    conventions.push(`Runtime is loaded by HTML. Entry assets: ${audit.loaded.slice(0, 6).join(", ")}.`);
  }
  if (tooling?.testCommands.length) {
    conventions.push(`Run the project tests before finishing: ${tooling.testCommands.slice(0, 2).join(" | ")}.`);
  }
  if (tooling?.typecheckCommands.length) {
    conventions.push(`Typecheck command: ${tooling.typecheckCommands.slice(0, 2).join(" | ")}.`);
  }
  if (tooling?.lintCommands.length) {
    conventions.push(`Lint command: ${tooling.lintCommands.slice(0, 2).join(" | ")}.`);
  }
  if (hasTests) conventions.push("Preserve existing tests and add a focused check for new behavior.");
  if (analysis.git?.available) {
    conventions.push(`Git branch: ${analysis.git.branch ?? "unknown"}. Do not rewrite unrelated dirty files.`);
  }
  const styles = analysis.files.filter((file) => /\.(?:css|scss|sass|less)$/i.test(file.path));
  if (styles.length > 0) {
    conventions.push(`Styles live in ${styles.slice(0, 4).map((file) => file.path).join(", ")}.`);
  }
  return unique(conventions).slice(0, 8);
}

function inferVerification(analysis: AnalysisResult): ProjectBrain["verification"] {
  const tooling = analysis.tooling;
  const commands = unique([
    ...(tooling?.testCommands ?? []),
    ...(tooling?.typecheckCommands ?? []),
    ...(tooling?.buildCommands ?? []),
    ...(tooling?.lintCommands ?? []),
  ]).slice(0, 8);
  const hasHtml = analysis.files.some((file) => /\.html?$/i.test(file.path));
  const checks: string[] = [];
  if (hasHtml) {
    checks.push("Open the real entry page with browser_check; drive the changed flow and assert the HUD/DOM/state result.");
  }
  if ((tooling?.testCommands ?? []).length > 0) {
    checks.push("Run the detected test command once after the final edit.");
  }
  if ((tooling?.typecheckCommands ?? []).length > 0) {
    checks.push("Run the detected typecheck/build command once after the final edit.");
  }
  if (checks.length === 0) checks.push("Verify the concrete behavior with the project's existing entry point; do not claim a visual change without runtime evidence.");
  return { commands, checks: unique(checks) };
}

function summarizeArchitecture(
  identity: ProjectBrain["identity"],
  modules: ProjectBrainModule[],
  routes: ProjectBrain["architecture"]["routes"],
  stats: AnalysisResult["stats"],
): string {
  const moduleNames = modules.slice(0, 5).map((module) => `${module.name} (${module.role})`);
  const routePart = routes.length > 0 ? `${routes.length} route(s)` : "no detected routes";
  return `${identity.name} is a ${identity.kind} project with ${stats.files} files and ${stats.symbols} symbols. Main modules: ${moduleNames.join(", ") || "none detected"}. ${routePart}.`;
}

function buildModules(
  analysis: AnalysisResult,
  kind: ProjectBrainKind,
  entryPoints: string[],
  unreferencedPaths: string[] = [],
): ProjectBrainModule[] {
  const unreferenced = new Set(unreferencedPaths);
  const codeFiles = analysis.files
    .filter((file) => /\.(?:js|mjs|cjs|jsx|ts|tsx|vue|svelte|php|py|go|rs|java|kt|swift|dart|rb|html?|css|scss|sass|less)$/i.test(file.path))
    .filter((file) => !(unreferenced.has(file.path) && analysis.symbols.every((symbol) => symbol.filePath !== file.path)));
  const symbolsByFile = new Map<string, string[]>();
  for (const symbol of analysis.symbols) {
    const list = symbolsByFile.get(symbol.filePath) ?? [];
    if (list.length < 8) list.push(symbol.name);
    symbolsByFile.set(symbol.filePath, list);
  }
  if (codeFiles.length <= 10) {
    return codeFiles.slice(0, MAX_MODULES).map((file) => ({
      name: file.path,
      path: file.path,
      role: inferRole(file.path, kind, entryPoints),
      files: [file.path],
      symbols: symbolsByFile.get(file.path) ?? [],
    }));
  }
  const groups = new Map<string, ProjectBrainModule>();
  for (const file of codeFiles) {
    const parts = file.path.split("/");
    const groupPath = parts.length > 1 ? `${parts[0]}/${parts[1] ?? ""}`.replace(/\/$/, "") : "root";
    const existing = groups.get(groupPath) ?? {
      name: groupPath === "root" ? "root files" : groupPath,
      path: groupPath === "root" ? "" : groupPath,
      role: inferRole(file.path, kind, entryPoints),
      files: [],
      symbols: [],
    };
    if (existing.files.length < 8) existing.files.push(file.path);
    for (const symbol of symbolsByFile.get(file.path) ?? []) {
      if (existing.symbols.length < 10 && !existing.symbols.includes(symbol)) existing.symbols.push(symbol);
    }
    groups.set(groupPath, existing);
  }
  return [...groups.values()].slice(0, MAX_MODULES);
}

function buildKeyFiles(
  analysis: AnalysisResult,
  audit: ProjectMapAudit,
  entryPoints: string[],
  kind: ProjectBrainKind,
): ProjectBrainFile[] {
  const symbolCount = new Map<string, number>();
  const topSymbolsByFile = new Map<string, string[]>();
  for (const symbol of analysis.symbols) {
    symbolCount.set(symbol.filePath, (symbolCount.get(symbol.filePath) ?? 0) + 1);
    const list = topSymbolsByFile.get(symbol.filePath) ?? [];
    if (list.length < 6) list.push(`${symbol.name}:${symbol.startLine}`);
    topSymbolsByFile.set(symbol.filePath, list);
  }
  const scores = new Map<string, number>();
  for (const file of analysis.files) {
    const role = inferRole(file.path, kind, entryPoints);
    let score = 0;
    if (entryPoints.includes(file.path)) score += 30;
    if (role === "entry page" || role === "entry script") score += 24;
    if (role === "game logic" || role === "server/API" || role === "application logic") score += 14;
    if (role === "data model") score += 10;
    if (role === "styles") score += 7;
    if (role === "tests" || role === "documentation" || role === "tooling") score -= 6;
    score += Math.min(12, symbolCount.get(file.path) ?? 0);
    if (audit.loaded.some((loaded) => loaded === file.path || loaded.endsWith(`/${file.path}`))) score += 6;
    if (audit.unreferenced.includes(file.path)) score -= 8;
    scores.set(file.path, score);
  }
  return [...analysis.files]
    .filter((file) => !file.path.startsWith(".cie/") && !file.path.startsWith(".git/"))
    .filter((file) => !(audit.unreferenced.includes(file.path) && (symbolCount.get(file.path) ?? 0) === 0))
    .filter((file) => inferRole(file.path, kind, entryPoints) !== "tests")
    .sort((a, b) => (scores.get(b.path) ?? 0) - (scores.get(a.path) ?? 0) || a.path.localeCompare(b.path))
    .slice(0, MAX_KEY_FILES)
    .map((file) => {
      const role = inferRole(file.path, kind, entryPoints);
      const why = entryPoints.includes(file.path)
        ? "entry point"
        : audit.unreferenced.includes(file.path)
          ? "not loaded by the entry page; verify before relying on it"
          : audit.loaded.some((loaded) => loaded === file.path || loaded.endsWith(`/${file.path}`))
            ? "loaded by the entry page"
            : undefined;
      return {
        path: file.path,
        role,
        loc: file.loc,
        symbols: symbolCount.get(file.path) ?? 0,
        topSymbols: topSymbolsByFile.get(file.path) ?? [],
        why,
      };
    })
    .filter((file) => isKeyFileRole(file.role) || file.symbols > 0);
}

function statusOf(task: ProjectTask): ProjectBrainFeature["status"] {
  if (task.status === "done") return "done";
  if (task.status === "in_progress") return "active";
  if (task.status === "pending") return "planned";
  return "broken";
}

const NO_CHANGE_SUMMARY =
  /(?:already (?:present|exists|implemented|applied|there|complete|satisf|fits|matches|renders|sits|works|has|generates|produces|uses|creates|handles|supports|includes|contains|does)|no files? (?:was|is|were|are) changed|no (?:further )?(?:code )?changes? (?:needed|required)|nothing (?:was|is) (?:changed|rewritten)|zaten (?:var|mevcut|uyguluyor|uygulanmış|yapılmış)|hiçbir dosya değiştirilmedi|dosya değiştirilmedi|değişiklik (?:gerekmiyor|yapılmadı))/i;
const ISSUE_SIGNAL =
  /\b(?:error|exception|crash|failed|failure|blocked|blocker|cannot|can't|unable|missing|not found|timeout|regression|broken)\b|hata|başarısız|engellendi|bulunamadı|eksik|çalışmıyor|bozuk|regresyon/i;

function looksLikeRealIssue(text: string): boolean {
  return ISSUE_SIGNAL.test(text) && !NO_CHANGE_SUMMARY.test(text);
}

function featureFromTask(
  task: ProjectTask,
  at: string,
  evidence: "verified" | "claimed" = "claimed",
): ProjectBrainFeature {
  return {
    id: `task:${task.id}:${task.createdAt}`,
    name: clip(task.title, 160) || `Task ${task.id}`,
    status: statusOf(task),
    files: task.changedFiles.slice(0, 8),
    notes: clip(redactSecrets(task.resultSummary ?? task.notes ?? ""), 420),
    evidence,
    updatedAt: task.updatedAt || at,
  };
}

function recentFromTask(
  task: ProjectTask,
  evidence: "verified" | "claimed" = "claimed",
): ProjectBrainChange | null {
  if (!task.resultSummary && task.changedFiles.length === 0) return null;
  return {
    at: task.updatedAt,
    kind: task.status === "failed" || task.status === "blocked" ? "issue" : "task",
    summary: clip(redactSecrets(task.resultSummary ?? task.title), 420),
    files: task.changedFiles.slice(0, 12),
    taskId: task.id,
    status: task.status,
    evidence,
  };
}

function mergeFeatures(
  previous: ProjectBrainFeature[],
  incoming: ProjectBrainFeature[],
): ProjectBrainFeature[] {
  const byName = new Map<string, ProjectBrainFeature>();
  for (const feature of [...previous, ...incoming]) {
    const key = feature.name.toLowerCase().replace(/\s+/g, " ").trim();
    const current = byName.get(key);
    if (!current || current.updatedAt < feature.updatedAt) byName.set(key, feature);
  }
  return [...byName.values()]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_FEATURES);
}

function mergeChanges(
  previous: ProjectBrainChange[],
  incoming: ProjectBrainChange[],
): ProjectBrainChange[] {
  const byKey = new Map<string, ProjectBrainChange>();
  for (const change of [...incoming, ...previous]) {
    const key = `${change.taskId ?? ""}:${change.at}:${change.summary.slice(0, 80)}`;
    if (!byKey.has(key)) byKey.set(key, change);
  }
  return [...byKey.values()]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, MAX_RECENT);
}

function mergeIssues(
  previous: ProjectBrainIssue[],
  incoming: ProjectBrainIssue[],
): ProjectBrainIssue[] {
  const byText = new Map<string, ProjectBrainIssue>();
  for (const issue of [...incoming, ...previous]) {
    const key = issue.text.toLowerCase().replace(/\s+/g, " ").trim();
    if (!byText.has(key)) byText.set(key, issue);
  }
  return [...byText.values()].slice(0, MAX_ISSUES);
}

function mergeDecisions(
  previous: ProjectBrainDecision[],
  incoming: ProjectBrainDecision[],
): ProjectBrainDecision[] {
  const byText = new Map<string, ProjectBrainDecision>();
  for (const decision of [...incoming, ...previous]) {
    const key = decision.text.toLowerCase().replace(/\s+/g, " ").trim();
    if (!byText.has(key)) byText.set(key, decision);
  }
  return [...byText.values()].slice(0, MAX_DECISIONS);
}

function mergeConstraints(
  previous: ProjectBrainConstraint[],
  incoming: ProjectBrainConstraint[],
): ProjectBrainConstraint[] {
  const byText = new Map<string, ProjectBrainConstraint>();
  for (const constraint of [...previous, ...incoming]) {
    const key = `${constraint.scope ?? ""}|${constraint.goal ?? ""}|${constraint.text}`
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    if (!byText.has(key)) byText.set(key, constraint);
  }
  return [...byText.values()].slice(0, MAX_CONSTRAINTS);
}

function buildHistoryFeatures(
  history: ProjectTaskHistoryEntry[],
  queue: ProjectTaskQueue | null,
): ProjectBrainFeature[] {
  const features: ProjectBrainFeature[] = [];
  for (const entry of history.slice(0, 8)) {
    for (const task of entry.tasks) {
      if (task.status === "done" || task.status === "in_progress") {
        features.push(featureFromTask(task, entry.updatedAt));
      }
    }
  }
  for (const task of queue?.tasks ?? []) features.push(featureFromTask(task, queue?.updatedAt ?? nowIso()));
  return features;
}

function buildHistoryChanges(
  history: ProjectTaskHistoryEntry[],
  queue: ProjectTaskQueue | null,
): ProjectBrainChange[] {
  const changes: ProjectBrainChange[] = [];
  for (const entry of history.slice(0, 8)) {
    for (const task of entry.tasks) {
      const change = recentFromTask(task);
      if (change) changes.push(change);
    }
  }
  for (const task of queue?.tasks ?? []) {
    const change = recentFromTask(task);
    if (change) changes.push(change);
  }
  return changes;
}

function orderEntryPoints(analysis: AnalysisResult, audit: ProjectMapAudit): string[] {
  const htmlEntries = analysis.files
    .map((file) => file.path)
    .filter((file) => /(^|\/)index\.html?$/i.test(file))
    .slice(0, 4);
  const loaded = audit.loaded
    .filter((file) => !/\.(?:css|scss|sass|less)$/i.test(file))
    .filter((file) =>
      analysis.files.some(
        (candidate) =>
          candidate.path === file ||
          candidate.path.endsWith(`/${file}`) ||
          file.endsWith(`/${candidate.path}`),
      ),
    );
  const fallback = audit.entries.filter((entry) =>
    /(^|\/)(index|main|app|server|cli)\.[a-z0-9]+$/i.test(entry),
  );
  return unique([...htmlEntries, ...loaded, ...fallback]).slice(0, 8);
}

export async function buildProjectBrain(
  analysis: AnalysisResult,
  options: {
    previous?: ProjectBrain | null;
    history?: ProjectTaskHistoryEntry[];
    queue?: ProjectTaskQueue | null;
  } = {},
): Promise<ProjectBrain> {
  const audit = await auditProjectKnowledge(analysis).catch<ProjectMapAudit>(() => ({
    files: [],
    missingFromIndex: [],
    indexedButMissing: [],
    symbols: { total: 0, kinds: {} },
    entries: [],
    scripts: [],
    loaded: [],
    unreferenced: [],
    keySymbols: [],
  }));
  const history = options.history ?? (await loadTaskHistory(analysis.rootPath).catch(() => []));
  const queue = options.queue === undefined ? await loadQueue(analysis.rootPath, analysis.id).catch(() => null) : options.queue;
  const previous = options.previous ?? (await loadProjectBrain(analysis.rootPath));
  const kind = inferKind(analysis, audit);
  const entryPoints = orderEntryPoints(analysis, audit);
  const modules = buildModules(analysis, kind, entryPoints, audit.unreferenced);
  const routes = analysis.nodes
    .filter((node) => node.kind === "route")
    .slice(0, 24)
    .map((node) => ({
      label: node.label,
      filePath: node.filePath,
      startLine: node.startLine,
      framework: typeof node.metadata?.framework === "string" ? node.metadata.framework : undefined,
    }));
  const dataModel = analysis.nodes
    .filter((node) => node.kind === "database")
    .slice(0, 24)
    .map((node) => ({
      label: node.label,
      filePath: node.filePath,
      startLine: node.startLine,
    }));
  const identity: ProjectBrain["identity"] = {
    name: analysis.projectName,
    kind,
    stack: unique([
      ...Object.keys(analysis.languages),
      ...(analysis.tooling?.frameworks ?? []),
    ]).slice(0, 12),
    frameworks: (analysis.frameworks ?? []).slice(0, 12),
    languages: Object.keys(analysis.languages).slice(0, 12),
    entryPoints,
    packageManagers: (analysis.tooling?.packageManagers ?? []).slice(0, 6),
    commands: {
      run: unique([
        ...(analysis.tooling?.buildCommands ?? []).filter((command) => /start|serve|dev|run/i.test(command)),
      ]).slice(0, 6),
      test: (analysis.tooling?.testCommands ?? []).slice(0, 6),
      build: (analysis.tooling?.buildCommands ?? []).slice(0, 6),
      typecheck: (analysis.tooling?.typecheckCommands ?? []).slice(0, 6),
      lint: (analysis.tooling?.lintCommands ?? []).slice(0, 6),
      format: (analysis.tooling?.formatCommands ?? []).slice(0, 6),
    },
    git: analysis.git
      ? {
          available: analysis.git.available,
          branch: analysis.git.branch,
          head: analysis.git.head,
          dirty: analysis.git.dirty,
        }
      : undefined,
  };
  const architecture = {
    summary: "",
    modules,
    routes,
    dataModel,
    externalServices: (analysis.externalModules ?? []).slice(0, 12),
    stateManagement: undefined,
  } satisfies ProjectBrain["architecture"];
  architecture.summary = summarizeArchitecture(identity, modules, routes, analysis.stats);

  const incomingFeatures = buildHistoryFeatures(history, queue);
  const incomingChanges = buildHistoryChanges(history, queue);
  const incomingIssues: ProjectBrainIssue[] = [
    ...analysis.warnings.slice(0, 6).map((text) => ({ text, severity: "medium" as const })),
    ...(queue?.tasks ?? [])
      .filter((task) => task.status === "failed" || task.status === "blocked")
      .map((task) => ({
        task,
        text: clip(redactSecrets(task.notes ?? task.resultSummary ?? task.title), 420),
      }))
      .filter(({ text }) => looksLikeRealIssue(text))
      .slice(0, 6)
      .map(({ task, text }) => ({
        text,
        severity: "high" as const,
        files: task.changedFiles.slice(0, 8),
        at: task.updatedAt,
      })),
  ];
  const previousBrain = previous ?? null;
  const brain: ProjectBrain = {
    version: BRAIN_VERSION,
    generatorVersion: BRAIN_GENERATOR_VERSION,
    projectId: analysis.id,
    rootPath: analysis.rootPath,
    generatedAt: previousBrain?.generatedAt ?? nowIso(),
    updatedAt: nowIso(),
    analysisAt: analysis.createdAt,
    identity,
    architecture,
    inventory: {
      files: buildKeyFiles(analysis, audit, entryPoints, kind),
      directories: modules.map((module) => ({ path: module.path, role: module.role })).slice(0, MAX_MODULES),
    },
    features: mergeFeatures(previousBrain?.features ?? [], incomingFeatures),
    conventions: unique([...(previousBrain?.conventions ?? []), ...inferConventions(analysis, audit)]).slice(0, 12),
    decisions: mergeDecisions(previousBrain?.decisions ?? [], []),
    constraints: mergeConstraints(previousBrain?.constraints ?? [], []),
    knownIssues: mergeIssues(previousBrain?.knownIssues ?? [], incomingIssues),
    recentChanges: mergeChanges(previousBrain?.recentChanges ?? [], incomingChanges),
    verification: inferVerification(analysis),
    glossary: previousBrain?.glossary ?? [],
    openQuestions: unique([
      ...(previousBrain?.openQuestions ?? []),
      ...(analysis.stats.unresolvedEdges > 0
        ? [`${analysis.stats.unresolvedEdges} unresolved graph edge(s); confirm call relationships before relying on them.`]
        : []),
      ...(analysis.stats.truncated
        ? ["Analysis was truncated; some files or symbols may be missing from the graph."]
        : []),
    ]).slice(0, 12),
  };
  return brain;
}

export async function ensureProjectBrain(
  analysis: AnalysisResult,
  options: { force?: boolean; queue?: ProjectTaskQueue | null } = {},
): Promise<ProjectBrain> {
  const key = analysis.rootPath;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const run = (async () => {
    const current = await loadProjectBrain(analysis.rootPath);
    if (
      current &&
      !options.force &&
      current.analysisAt === analysis.createdAt &&
      current.generatorVersion === BRAIN_GENERATOR_VERSION
    ) {
      return current;
    }
    const brain = await buildProjectBrain(analysis, {
      previous: current,
      queue: options.queue,
    });
    await saveProjectBrain(brain).catch(() => undefined);
    return brain;
  })();
  inFlight.set(key, run);
  try {
    return await run;
  } finally {
    inFlight.delete(key);
  }
}

export async function refreshProjectBrain(analysis: AnalysisResult): Promise<ProjectBrain> {
  return ensureProjectBrain(analysis, { force: true });
}

/* ------------------------------------------------------------------ */
/* Incremental update after a task                                     */
/* ------------------------------------------------------------------ */

export async function updateProjectBrainFromTask(
  analysis: AnalysisResult,
  task: ProjectTask,
  result: Pick<AiAgentResult, "summary" | "changedFiles">,
  status: ProjectTask["status"],
  evidence: "verified" | "claimed" = "claimed",
): Promise<ProjectBrain> {
  const brain = await ensureProjectBrain(analysis);
  const updatedTask: ProjectTask = {
    ...task,
    status,
    resultSummary: result.summary ?? task.resultSummary,
    changedFiles: result.changedFiles ?? task.changedFiles,
    updatedAt: nowIso(),
  };
  const feature = featureFromTask(updatedTask, nowIso(), evidence);
  const change = recentFromTask(updatedTask, evidence);
  const issueText = clip(redactSecrets(result.summary ?? task.notes ?? task.title), 420);
  const issue: ProjectBrainIssue | null =
    (status === "failed" || status === "blocked") && looksLikeRealIssue(issueText)
      ? {
          text: issueText,
          severity: "high",
          files: updatedTask.changedFiles.slice(0, 8),
          at: nowIso(),
        }
      : null;
  const next: ProjectBrain = {
    ...brain,
    updatedAt: nowIso(),
    features: mergeFeatures(brain.features, [feature]),
    recentChanges: change ? mergeChanges(brain.recentChanges, [change]) : brain.recentChanges,
    knownIssues: issue ? mergeIssues(brain.knownIssues, [issue]) : brain.knownIssues,
  };
  await saveProjectBrain(next).catch(() => undefined);
  return next;
}

/* ------------------------------------------------------------------ */
/* Brief + markdown                                                    */
/* ------------------------------------------------------------------ */

export function compactProjectBrainBrief(
  brain: ProjectBrain,
  maxChars = MAX_BRIEF_CHARS,
): string {
  const identity = brain.identity;
  const commands = identity.commands;
  const commandLine = [
    commands.run.length ? `run: ${commands.run.slice(0, 2).join(" | ")}` : "",
    commands.test.length ? `test: ${commands.test.slice(0, 2).join(" | ")}` : "",
    commands.build.length ? `build: ${commands.build.slice(0, 2).join(" | ")}` : "",
    commands.typecheck.length ? `typecheck: ${commands.typecheck.slice(0, 2).join(" | ")}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const keyFiles = brain.inventory.files
    .slice(0, 10)
    .map((file) => {
      const symbols = file.topSymbols?.length
        ? ` · ${file.topSymbols.slice(0, 3).join(", ")}`
        : "";
      return `${file.path} — ${file.role}${file.why ? ` (${file.why})` : ""}${symbols}`;
    })
    .join("\n");
  const modules = brain.architecture.modules
    .slice(0, 6)
    .map((module) => `${module.name} — ${module.role}${module.files.length ? `: ${module.files.slice(0, 3).join(", ")}` : ""}`)
    .join("\n");
  const routes = brain.architecture.routes
    .slice(0, 8)
    .map((route) => `${route.label}${route.filePath ? ` — ${route.filePath}${route.startLine ? `:${route.startLine}` : ""}` : ""}`)
    .join("\n");
  const features = brain.features
    .slice(0, 8)
    .map((feature) => `- [${feature.status}${feature.evidence ? `/${feature.evidence}` : ""}] ${feature.name}${feature.files.length ? ` — ${feature.files.slice(0, 3).join(", ")}` : ""}`)
    .join("\n");
  const recent = brain.recentChanges
    .slice(0, 6)
    .map((change) => `- ${change.at.slice(0, 10)} [${change.evidence ?? "claimed"}] ${clip(change.summary, 150)}${change.files.length ? ` — ${change.files.slice(0, 3).join(", ")}` : ""}`)
    .join("\n");
  const constraints = brain.constraints
    .slice(0, 6)
    .map((constraint) => `- ${constraint.text}`)
    .join("\n");
  const issues = brain.knownIssues
    .slice(0, 5)
    .map((issue) => `- ${issue.text}`)
    .join("\n");

  const blocks: string[] = [
    `## Project brain — ${identity.name} (${identity.kind})`,
    "Persistent project memory. Project facts are authoritative. Work-history, recent-change and task summaries are unverified claims unless marked verified; confirm them against code or a real-page check before relying on them. Read only the exact files/line ranges you still need.",
    `Stack: ${identity.stack.join(", ") || "unknown"}${identity.frameworks.length ? ` · frameworks: ${identity.frameworks.join(", ")}` : ""}`,
    `Entry: ${identity.entryPoints.join(", ") || "unknown"}${commandLine ? ` · ${commandLine}` : ""}`,
    `Architecture: ${brain.architecture.summary}`,
    modules ? `Modules:\n${modules}` : "",
    routes ? `Routes:\n${routes}` : "",
    keyFiles ? `Key files:\n${keyFiles}` : "",
    features ? `Work history:\n${features}` : "",
    constraints ? `Constraints:\n${constraints}` : "",
    recent ? `Recent changes:\n${recent}` : "",
    issues ? `Known issues:\n${issues}` : "",
    brain.verification.commands.length || brain.verification.checks.length
      ? `Verification: ${[...brain.verification.commands, ...brain.verification.checks].slice(0, 6).join(" · ")}`
      : "",
    brain.openQuestions.length ? `Open questions:\n${brain.openQuestions.slice(0, 4).map((item) => `- ${item}`).join("\n")}` : "",
  ].filter(Boolean);
  const full = blocks.join("\n");
  if (full.length <= maxChars) return full;
  // Keep the highest-value sections; drop recent/issue tail first.
  const compact = blocks.filter((block, index) => index < blocks.length - 2 || block.startsWith("Verification"));
  const text = compact.join("\n");
  return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 24))}\n… [brain brief truncated]` : text;
}

export function renderProjectBrainMarkdown(brain: ProjectBrain): string {
  const lines: string[] = [
    `# Project brain — ${brain.identity.name}`,
    "",
    `Generated by B.A.D IDE. Updated ${brain.updatedAt}.`,
    "",
    "## Identity",
    `- Kind: ${brain.identity.kind}`,
    `- Stack: ${brain.identity.stack.join(", ") || "unknown"}`,
    `- Frameworks: ${brain.identity.frameworks.join(", ") || "none"}`,
    `- Entry points: ${brain.identity.entryPoints.join(", ") || "unknown"}`,
    `- Package managers: ${brain.identity.packageManagers.join(", ") || "none"}`,
  ];
  const commandRows = Object.entries(brain.identity.commands).filter(([, values]) => values.length > 0);
  if (commandRows.length > 0) {
    lines.push("- Commands:");
    for (const [kind, values] of commandRows) lines.push(`  - ${kind}: ${values.join(" | ")}`);
  }
  if (brain.identity.git?.available) {
    lines.push(`- Git: ${brain.identity.git.branch ?? "unknown"}${brain.identity.git.dirty ? " (dirty)" : ""}`);
  }
  lines.push("", "## Architecture", brain.architecture.summary, "");
  if (brain.architecture.modules.length > 0) {
    lines.push("### Modules");
    for (const module of brain.architecture.modules) {
      lines.push(`- **${module.name}** — ${module.role}${module.files.length ? `: ${module.files.join(", ")}` : ""}`);
    }
    lines.push("");
  }
  if (brain.architecture.routes.length > 0) {
    lines.push("### Routes");
    for (const route of brain.architecture.routes) {
      lines.push(`- ${route.label}${route.filePath ? ` — ${route.filePath}${route.startLine ? `:${route.startLine}` : ""}` : ""}`);
    }
    lines.push("");
  }
  if (brain.architecture.dataModel.length > 0) {
    lines.push("### Data model");
    for (const object of brain.architecture.dataModel) {
      lines.push(`- ${object.label}${object.filePath ? ` — ${object.filePath}${object.startLine ? `:${object.startLine}` : ""}` : ""}`);
    }
    lines.push("");
  }
  if (brain.architecture.externalServices.length > 0) {
    lines.push("### External services", ...brain.architecture.externalServices.map((service) => `- ${service}`), "");
  }
  lines.push("## Key files");
  for (const file of brain.inventory.files) {
    const symbols = file.topSymbols?.length ? ` · ${file.topSymbols.slice(0, 4).join(", ")}` : "";
    lines.push(`- \`${file.path}\` — ${file.role} · ${file.loc} lines · ${file.symbols} symbols${file.why ? ` · ${file.why}` : ""}${symbols}`);
  }
  lines.push("", "## Work history");
  if (brain.features.length === 0) lines.push("- Nothing recorded yet.");
  for (const feature of brain.features) {
    lines.push(`- [${feature.status}${feature.evidence ? `/${feature.evidence}` : ""}] ${feature.name}${feature.files.length ? ` — ${feature.files.join(", ")}` : ""}`);
    if (feature.notes) lines.push(`  - ${feature.notes}`);
  }
  lines.push("", "## Conventions");
  if (brain.conventions.length === 0) lines.push("- None recorded yet.");
  for (const convention of brain.conventions) lines.push(`- ${convention}`);
  lines.push("", "## Constraints");
  if (brain.constraints.length === 0) lines.push("- None recorded yet.");
  for (const constraint of brain.constraints) lines.push(`- ${constraint.text} (${constraint.kind})`);
  lines.push("", "## Recent changes");
  if (brain.recentChanges.length === 0) lines.push("- Nothing recorded yet.");
  for (const change of brain.recentChanges) {
    lines.push(`- ${change.at} [${change.evidence ?? "claimed"}] · ${change.summary}${change.files.length ? ` — ${change.files.join(", ")}` : ""}`);
  }
  lines.push("", "## Known issues");
  if (brain.knownIssues.length === 0) lines.push("- None recorded.");
  for (const issue of brain.knownIssues) lines.push(`- ${issue.text}`);
  lines.push("", "## Verification");
  for (const command of brain.verification.commands) lines.push(`- \`${command}\``);
  for (const check of brain.verification.checks) lines.push(`- ${check}`);
  if (brain.openQuestions.length > 0) {
    lines.push("", "## Open questions");
    for (const question of brain.openQuestions) lines.push(`- ${question}`);
  }
  if (brain.glossary.length > 0) {
    lines.push("", "## Glossary");
    for (const entry of brain.glossary) lines.push(`- **${entry.term}** — ${entry.meaning}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function getProjectBrainView(analysis: AnalysisResult): Promise<ProjectBrainView> {
  const brain = await ensureProjectBrain(analysis);
  return {
    brain,
    brief: compactProjectBrainBrief(brain),
    paths: {
      json: `.cie/agent/${BRAIN_FILE}`,
      markdown: `.cie/agent/${BRAIN_MARKDOWN_FILE}`,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Constraints learned from user requests                              */
/* ------------------------------------------------------------------ */

export function extractProjectConstraints(text: string): string[] {
  const constraints: string[] = [];
  for (const match of text.matchAll(/\b(?:do not|don't|never)\s+(?:touch|change|modify|edit|remove)\s+([^\n.]{2,140})/gi)) {
    constraints.push(`Do not touch/change: ${match[1].trim()}`);
  }
  for (const match of text.matchAll(/(?:uygulama(?:ya)?|koduna|istemciye)\s+dokunma[^\n.]{0,80}/gi)) {
    constraints.push(match[0].trim());
  }
  if (/\bserver[- ]side only\b|\bsadece sunucu(?:da| tarafında)?\b/i.test(text)) {
    constraints.push("Server-side only; do not change the client/application UI.");
  }
  if (/(?:parola|password|passwd|credential|secret|token)[^\n.]{0,100}(?:gösterme|göstermeyin|görünme|expose|loglama|log'lama|döndürme)/i.test(text)) {
    constraints.push("Never expose passwords, tokens or credentials in responses or logs.");
  }
  for (const match of text.matchAll(/\bonly\s+(?:change|edit|touch|modify)\s+([^\n.]{2,140})/gi)) {
    constraints.push(`Only change/edit: ${match[1].trim()}`);
  }
  return unique(constraints).slice(0, 8);
}

function constraintKind(text: string): ProjectBrainConstraint["kind"] {
  if (/(?:password|passwd|secret|token|credential|parola|api[_-]?key)/i.test(text)) return "security";
  if (/[\w.-]+\.(?:ts|tsx|js|jsx|php|py|go|rs|java|kt|css|html)|\/[\w./-]+/i.test(text)) return "path";
  if (/(?:style|format|convention|isim|adlandır)/i.test(text)) return "style";
  if (/(?:only|sadece|touch|change|modify|do not|dokunma)/i.test(text)) return "behavior";
  return "other";
}

function constraintScope(text: string): "project" | "task" {
  if (
    /\bserver[- ]side only\b|\bsadece sunucu/i.test(text) ||
    /uygulama(?:ya| koduna)? dokunma|do not touch (?:the )?(?:application|app|client)/i.test(text) ||
    /(?:password|parola|secret|token|credential)/i.test(text)
  ) {
    return "project";
  }
  if (/\b(?:only|sadece)\b/i.test(text) || /[\w./-]+\.(?:php|js|ts|tsx|jsx|css|html|py|go|rs|java|kt|swift|dart)\b/i.test(text)) {
    return "task";
  }
  return "project";
}

export async function addProjectConstraints(
  analysis: AnalysisResult,
  texts: string[],
  source = "request",
  goal?: string,
): Promise<ProjectBrain> {
  const clean = unique(texts.map((text) => clip(redactSecrets(text), 300)));
  if (clean.length === 0) return ensureProjectBrain(analysis);
  const brain = await ensureProjectBrain(analysis);
  const incoming: ProjectBrainConstraint[] = clean.map((text) => {
    const scope = constraintScope(text);
    return {
      id: `constraint-${text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48)}`,
      text,
      kind: constraintKind(text),
      source,
      scope,
      goal: scope === "task" ? goal : undefined,
    };
  });
  const next: ProjectBrain = {
    ...brain,
    updatedAt: nowIso(),
    constraints: mergeConstraints(brain.constraints, incoming),
  };
  await saveProjectBrain(next).catch(() => undefined);
  return next;
}
