import type { AnalysisResult } from "../../../shared/types";
import type {
  AiAgentEvent,
  AiAgentResult,
  AiAgentStep,
  AiTokenUsage,
  AiWorkspaceMode,
} from "../../../shared/ai";
import type { IntentAnalysis } from "../../../shared/intent";
import type { ProjectDiagnosis } from "../../../shared/diagnosis";
import type {
  ProjectTask,
  ProjectTaskEffort,
  ProjectTaskLoopOptions,
  ProjectTaskLoopResult,
  ProjectTaskQueue,
  ProjectTaskRole,
} from "../../../shared/tasks";
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir, loadAnalysis } from "../store";
import { readSourceFile } from "../editor";
import { loadSkillsForPrompt, recordSkillOutcomes } from "../skills";
import {
  createPlanMeta,
  isLowImpactPlanQuestion,
  reviewProjectPlan,
  shouldReviewPlan,
} from "./planReview";
import { intentNeedsConfirmation, isContinuationInstruction } from "./intent";
import { ensureDevServerForRequest } from "../processes";
import { checkFileSyntax } from "../syntax";
import { pngStats } from "../pngStats";
import { runBrowserCheck } from "../browserCheck";
import { requestIsRunPreview } from "../../../shared/projectMatch";
import {
  findTaskScenario,
  isScenarioVerificationTask,
  type TaskScenarioMatch,
} from "./scenarioMatch";
import {
  appendAgentRunEvent,
  appendLesson,
  appendTaskContext,
  createQueue,
  loadQueue,
  emptyQueue,
  markTask,
  nextPendingTask,
  saveAgentRun,
  saveQueue,
  startAgentRunLive,
} from "../tasks";
import { chat, type ChatMessage } from "./providers";
import { ensureProjectMap } from "../projectMap";
import { recordUsage } from "./usage";
import { getPublicSettings, resolveAgentRole, resolveProvider } from "./settings";
import { pickAlternateAgentModel } from "./agents";
import {
  addProjectConstraints,
  compactProjectBrainBrief,
  ensureProjectBrain,
  extractProjectConstraints,
  updateProjectBrainFromTask,
} from "../projectBrain";
import {
  compactDiagnosisBrief,
  diagnoseProject,
  diagnosisPaths,
  diagnosisScenarioName,
  isUsableDiagnosisScenario,
  type DiagnoseResult,
} from "./diagnosis";
import { auditProjectConstraints } from "./constraintRules";
import { auditCompletedWork } from "./completionAudit";
import {
  RECOVERY_POLICY,
  buildResumeContract,
  cleanTaskDetail,
  environmentRepairNote,
  isEnvironmentFailure,
  isReadLoopFailure,
  narrowTaskForEditFirst,
} from "./recovery";
import {
  healthKey,
  modelHealthByProviderModel,
  recordModelFallback,
} from "./modelStats";
import { estimateUsageCost } from "./pricing";
import { prepareDomainBrief } from "./domainKnowledge";
import { removeIndexedPath } from "../indexer";
import { formatUsd } from "../../../shared/pricing";
import { resolveWorkBrief } from "../extractors";
import {
  continuationFindings,
  looksLikePlanningText,
  queryProjectSymbols,
  preferredVerificationCommand,
  reportsRemainingWork,
  runAgentTask,
} from "./service";

const MAX_PLANNED_TASKS = 12;
const DEFAULT_MAX_TASKS = 12;
const DEFAULT_MAX_MINUTES = 45;

function parseReviewReply(text: string): { verdict: "ok" | "issues"; summary: string; issues: string[] } {
  const candidate = text.match(/\{[\s\S]*\}/)?.[0];
  if (candidate) {
    try {
      const raw = JSON.parse(candidate) as {
        verdict?: unknown;
        summary?: unknown;
        issues?: unknown;
      };
      const issues = Array.isArray(raw.issues)
        ? raw.issues.filter((item): item is string => typeof item === "string").slice(0, 6)
        : [];
      return {
        verdict: raw.verdict === "ok" || (issues.length === 0 && raw.verdict !== "issues") ? "ok" : "issues",
        summary:
          typeof raw.summary === "string" && raw.summary.trim()
            ? raw.summary.trim().slice(0, 500)
            : issues.length > 0
              ? "Reviewer reported issues."
              : "Reviewer found no blocking issues.",
        issues,
      };
    } catch {
      // Fall through to the text interpretation below.
    }
  }
  const clean = text.trim().replace(/\s+/g, " ");
  const looksBad = /\b(issue|error|broken|missing|incorrect|bug|should|must|risk)\b/i.test(clean);
  return {
    verdict: looksBad ? "issues" : "ok",
    summary: clean.slice(0, 500) || "Reviewer returned no findings.",
    issues: looksBad ? [clean.slice(0, 300)] : [],
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function emptyUsage(): AiTokenUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function addUsage(total: AiTokenUsage, next?: AiTokenUsage): AiTokenUsage {
  if (!next) return total;
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    totalTokens: total.totalTokens + next.totalTokens,
  };
}

function extractJson(text: string): unknown {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Planner did not return JSON.");
  return JSON.parse(cleaned.slice(start, end + 1)) as unknown;
}

function normalizeEffort(value: unknown): ProjectTaskEffort {
  return value === "simple" || value === "hard" ? value : "standard";
}

function roleForEffort(effort: ProjectTaskEffort): ProjectTaskRole {
  return effort === "simple" ? "fast" : "main";
}

function projectFacts(analysis: AnalysisResult): string {
  const tooling = analysis.tooling;
  return [
    `Project: ${analysis.projectName}`,
    `Root: ${analysis.rootPath}`,
    `Languages: ${Object.entries(analysis.languages).map(([name, count]) => `${name} (${count})`).join(", ") || "unknown"}`,
    `Frameworks: ${(analysis.frameworks ?? []).join(", ") || "none detected"}`,
    `Test commands: ${tooling?.testCommands.join(" | ") || "none"}`,
    `Typecheck commands: ${tooling?.typecheckCommands?.join(" | ") || "none"}`,
    `Build commands: ${tooling?.buildCommands.join(" | ") || "none"}`,
    `Files (sample): ${analysis.files.slice(0, 30).map((file) => file.path).join(", ")}`,
  ].join("\n");
}

const PLANNER_SYSTEM = `You are a senior software project planner. Decompose the user's goal into a short, ordered task queue that another coding agent can execute one task at a time.
Return JSON only. Do not write code. Do not use Markdown fences.
Schema:
{"tasks":[{"title":"short imperative title","detail":"exact work, files/areas if known","acceptance":"how to verify this task","effort":"simple|standard|hard","action":"create|update|remove|move|verify|run|document|other","surface":"ui|api|data|config|docs|game|other"}]}
Rules:
- 2-8 tasks. Each task must be independently verifiable.
- Split multi-feature goals: if the goal asks for several independent changes (add X, replace Y, change Z, check W), return one task per feature. Never put the whole goal in one task.
- Each task must describe one behavior change with its own acceptance check. A task that says "and" for two unrelated features must be split.
- Keep each task small enough to finish in about 8 tool calls. If it needs more, split it into another behavior task.
- Do not ask for new check scripts, scenarios, test hooks or verification files. Use the project's existing tests and run command.
- Do not create tasks that only edit tests, scenarios, test hooks or verification scripts. Fold that work into the behavior task it verifies. A task must change runtime behavior or fix a bug.
- Order tasks by dependency and value: correctness and item effects first, then spawn frequency, then visual/feedback polish.
- Never create a task only to deduplicate or normalize existing definitions. Put the "do not re-add existing items" constraint in the relevant behavior task's acceptance instead.
- Small mechanical edits are "simple"; normal implementation is "standard"; broad refactors/debugging are "hard".
- Fold verification into the last behavior task. Do not create a separate verification-only task; the executor runs the project's verification command itself.
- For game/canvas score verification, put the exact browser_check steps in the acceptance: a pressKeys step with the public key sequence (for example ["3","0","*","1","Enter"]) followed by expectText on the score/HUD. Never tell the executor to call startRound, round, state or other closure internals.
- Do not invent files that do not exist; inspect is allowed later by the executor.
- Use the project map and goal-relevant symbols to name the correct file/function. If a symbol hint points to a file, use that file as the primary edit target. Prefer files loaded by the HTML entry or imported by it. Do not add runtime behavior to a file that is not loaded; verify an import before using an unreferenced file.
- Do not invent cleanup/dedup tasks unless the project map or a concrete duplicate shows it is needed. Verify first.
- If the Existing-code preflight shows a requested feature already exists, either omit it or make it a verification-only task that changes no files. A verification-only task must assert presence AND the requested shape, placement and acceptance on the real page; a symbol, icon constant, element id or plain "visible" check is not enough. Never create a task that re-adds it.
- The context notes in .cie/agent/context.md and .cie/agent/TASKS.md are for continuity; you may mention them.
- Write task titles, details and acceptance in English. Keep quoted user text, file paths, function names and code identifiers unchanged.
- Never return placeholder tasks such as "...", "TODO", "TBD" or "fill me". Every task must contain a real title, detail and acceptance.
- When an intent spec with behaviors is provided, create one task per behavior and copy its action/surface. Do not merge independent behaviors.
- Preserve the user's exact rule and qualifiers (smaller/larger/only/never). Never replace them with an example-specific shortcut: if the user says the smaller of the two operands, write min(a,b), not "the second operand"; examples are illustrations, not the rule.
- Do not invent a gameplay subsystem that is not in the code (a new pellet spawner, respawn loop, item type or second data table) when the user names an existing object. Fix the existing spawn/placement path and reuse the current item/level data.
- Distinguish the level data table from the level selection UI. "Remove the level/map list" means remove the selection UI, not the LEVELS/map data needed for random starts.
- For "random on every start" behavior, the acceptance must start/restart at least 5 times and observe a different level each time; do not require calls to hidden internals such as state or startRound.
- If the preflight code already implements the requested rule, do not create an edit task that claims a flat bonus or missing guard; create a verification-only task or fold the verification into the behavior task.
- If a domain brief is provided, treat its rules, defaults and pitfalls as constraints and turn its verification checklist into concrete acceptance checks for the relevant tasks. Do not override the brief with generic memory.
- Implement every user extra (theme, colors, mascot, style) in a task with its own acceptance. A theme must never change domain rules; keep rules and presentation separate.`;

export function applyPlanReview(
  queue: ProjectTaskQueue,
  goal: string,
  review: Awaited<ReturnType<typeof reviewProjectPlan>>,
): ProjectTaskQueue {
  const done = queue.tasks.filter((task) => task.status === "done");
  const changed = [...new Set(queue.tasks.flatMap((task) => task.changedFiles))];
  const note = changed.length
    ? `Previous attempt changed ${changed.join(", ")}. Inspect the current files and do not undo working changes.`
    : "";
  const requirements = queue.planMeta?.requirements.length
    ? queue.planMeta.requirements
    : [goal];
  const revised =
    review.tasks.length > 0
      ? review.tasks
      : requirements.map((requirement) => ({
          title: requirement.slice(0, 120),
          detail: requirement,
          acceptance: `The requested behavior for "${requirement}" works and is verified.`,
          effort: "standard" as const,
          action: "update" as const,
          surface: "other" as const,
        }));
  const at = nowIso();
  const tasks: ProjectTask[] = revised.map((task, index) => {
    const inferredVerify = /(?:^|\s)(verify|test|typecheck|lint|build|do[gğ]rula|test et|derle)(?:\s|$)/i.test(
      `${task.title} ${task.detail}`,
    );
    const action = task.action ?? (inferredVerify ? "verify" : "update");
    const verify = action === "verify";
    return {
      id: `task-${done.length + index + 1}`,
      title: task.title,
      detail: note ? `${task.detail}\n\n${note}` : task.detail,
      acceptance: task.acceptance,
      status: "pending",
      effort: task.effort,
      role: "main",
      action,
      surface: task.surface ?? "other",
      readOnly: verify ? true : undefined,
      verificationOnly: verify ? true : undefined,
      dependsOn:
        index === 0
          ? done.length > 0
            ? [done[done.length - 1].id]
            : []
          : [`task-${done.length + index}`],
      attempts: 0,
      changedFiles: [],
      commands: [],
      createdAt: at,
      updatedAt: at,
    };
  });
  return {
    ...queue,
    tasks: [...done, ...tasks],
    status: "idle",
    planMeta: createPlanMeta(goal, review, (queue.planMeta?.reviewCount ?? 0) + 1),
  };
}

export function splitLargeGoal(goal: string, verification?: string): ProjectTask[] | null {
  if (goal.length < 160) return null;
  if (/```|\{\s*"|https?:\/\//.test(goal)) return null;
  // Goals that contain constraints, verification or "do not re-add" rules are
  // one instruction, not a list of independent features. Splitting them
  // produces fragments like "zaten var olan itemleri yeniden ekleme" as tasks.
  if (
    /(?:yeniden ekleme|ekleme\b|bozma|kanıtla|doğrula|raporla|(?<![a-zçğıöşü])göster(?![a-zçğıöşü])|listele|kullanılmıyorsa|zaten var|mevcut .{0,30}koru|sadece .{0,30}bakma)/i.test(
      goal,
    )
  ) {
    return null;
  }
  const sentences = goal
    .split(/(?:[.!?;]+|\n+)\s*/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 12 && sentence.split(/\s+/).length >= 3);
  if (sentences.length < 3) return null;
  const at = nowIso();
  const tasks: ProjectTask[] = sentences.slice(0, 6).map((sentence, index) => ({
    id: `task-${index + 1}`,
    title: sentence.slice(0, 140),
    detail: sentence,
    acceptance: `The behavior described in "${sentence.slice(0, 100)}" works and the affected files are verified.`,
    status: "pending",
    effort: "standard",
    role: "main",
    action: "update",
    surface: "other",
    dependsOn: index === 0 ? [] : [`task-${index}`],
    attempts: 0,
    changedFiles: [],
    commands: [],
    createdAt: at,
    updatedAt: at,
  }));
  if (verification) {
    tasks.push({
      id: `task-${tasks.length + 1}`,
      title: "Verify and fix",
      detail: `Run ${verification}, inspect failures, and fix them without reverting completed work.`,
      acceptance: "The verification command exits successfully.",
      status: "pending",
      effort: "standard",
      role: "main",
      action: "verify",
      surface: "other",
      verificationOnly: true,
      readOnly: true,
      dependsOn: [tasks[tasks.length - 1].id],
      attempts: 0,
      changedFiles: [],
      commands: [],
      verification: { command: verification },
      createdAt: at,
      updatedAt: at,
    });
  }
  return tasks;
}

function fallbackTasks(
  goal: string,
  verification?: string,
  context: { projectMap?: string; intent?: IntentAnalysis } = {},
): ProjectTask[] {
  const split = splitLargeGoal(goal, verification);
  if (split) return split;
  const at = nowIso();
  const first: ProjectTask = {
    id: "task-1",
    title: goal.length > 90 ? `${goal.slice(0, 87)}…` : goal,
    detail: [
      goal,
      context.intent?.areas?.length ? `Likely areas: ${context.intent.areas.join(", ")}` : "",
      context.projectMap
        ? `Project map (use it to identify the exact file and symbols):\n${context.projectMap.slice(
            0,
            1_800,
          )}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 4_000),
    acceptance:
      "Implement the requested behavior in the files identified above, preserve existing working behavior, and verify the real page. Do not add duplicate items or test-only UI.",
    status: "pending",
    effort: "standard",
    role: "main",
    action: "update",
    surface: "other",
    dependsOn: [],
    attempts: 0,
    changedFiles: [],
    commands: [],
    createdAt: at,
    updatedAt: at,
  };
  const tasks = [first];
  if (verification) {
    tasks.push({
      id: "task-2",
      title: "Verify and fix",
      detail: `Run ${verification}, inspect failures, and fix them without reverting completed work.`,
      acceptance: "The verification command exits successfully.",
      status: "pending",
      effort: "standard",
      role: "main",
      action: "verify",
      surface: "other",
      verificationOnly: true,
      readOnly: true,
      dependsOn: ["task-1"],
      attempts: 0,
      changedFiles: [],
      commands: [],
      verification: { command: verification },
      createdAt: at,
      updatedAt: at,
    });
  }
  return tasks;
}

function isVerificationOnlyTask(task: ProjectTask): boolean {
  if (task.verificationOnly === true) return true;
  if (task.action && ["create", "update", "remove", "move", "document"].includes(task.action)) {
    return false;
  }
  const text = `${task.title} ${task.detail}`;
  if (
    /^(verify|verify and fix|final verification|run .*verification)/i.test(task.title.trim()) &&
    /(tsc|typecheck|test|build|verify|check|eslint|lint|format)/i.test(task.detail) &&
    !/[A-Za-z0-9_./-]+\.(?:js|mjs|cjs|jsx|ts|tsx|php|py|go|rs|java|kt|swift|dart|rb|html?|css|vue|svelte)/i.test(
      task.detail,
    )
  ) {
    return true;
  }
  const verify =
    /\b(verify|verification|validate|prove|confirm|runtime check|test the|run the test|doğrula|kontrol et|test et|çalışma zamanı|kanıtla)/i.test(
      text,
    );
  const reportingOnly =
    /(?:before\/after|evidence table|final answer|report the evidence|deliver the)/i.test(text) &&
    !/\b(?:fix|update|change|implement|create|remove|delete|replace|refactor)\b|düzelt|güncelle|değiştir|kaldır|sil/i.test(
      text,
    );
  if (verify && reportingOnly) return true;
  const withoutNegatedWrites = text.replace(
    /\b(?:do not|don't|never|without|no)\s+(?:\w+\s+){0,3}(?:add|fix|update|change|implement|create|remove|delete|replace|write|refactor|ensure|make|modify)\b/gi,
    "",
  );
  const write =
    /\b(add|fix|update|change|implement|create|remove|delete|rename|refactor|move|write|repair|wire|restore|ensure|enable|tune|adjust|enforce|expose|register|route|convert|support|extend|validate|return|reject|handle|respond)\b|düzelt|ekle|güncelle|değiştir|kaldır|sil|taşı|yaz|onar|bağla/i.test(
      withoutNegatedWrites,
    );
  return verify && !write;
}

function foldTrailingVerification(tasks: ProjectTask[]): ProjectTask[] {
  if (tasks.length < 2) return tasks;
  const last = tasks[tasks.length - 1];
  if (!isVerificationOnlyTask(last)) return tasks;
  const previous = tasks[tasks.length - 2];
  const merged: ProjectTask = {
    ...previous,
    detail: `${previous.detail}\nVerification: ${last.detail}`.slice(0, 4_000),
    acceptance: [previous.acceptance, last.acceptance].filter(Boolean).join(" ").slice(0, 1_000),
    updatedAt: nowIso(),
  };
  return [...tasks.slice(0, -2), merged];
}

function collapseVerificationTasks(tasks: ProjectTask[]): ProjectTask[] {
  if (tasks.length < 2) return tasks;
  if (!tasks.every((task) => isVerificationOnlyTask(task))) return tasks;
  const [first, ...rest] = tasks;
  return [
    {
      ...first,
      detail: [first.detail, ...rest.map((task) => task.detail)]
        .filter(Boolean)
        .join("\n")
        .slice(0, 4_000),
      acceptance: [first.acceptance, ...rest.map((task) => task.acceptance)]
        .filter(Boolean)
        .join(" ")
        .slice(0, 1_000),
      dependsOn: [],
      updatedAt: nowIso(),
    },
  ];
}

function isCleanupOnlyTask(task: ProjectTask): boolean {
  const text = `${task.title} ${task.detail}`;
  const cleanup = /(duplicate|dedup|tekilleştir|tekrarı engelle|normalleştir|normalize)/i.test(text);
  const behavior =
    /\b(add|fix|update|change|implement|create|increase|decrease|make|render|draw|spawn|collect|apply|speed|score|effect|repair|wire|restore|ensure|enable|tune|adjust|enforce|report|expose|register|route|convert|support|extend|validate|return|reject|handle|respond)\b|görünür|sıklık|etki|hız|puan|çiz|topla|uygula|artır|azalt|onar|bağla/i.test(
      text,
    );
  return cleanup && !behavior;
}

function foldTrailingCleanup(tasks: ProjectTask[]): ProjectTask[] {
  if (tasks.length < 2) return tasks;
  const last = tasks[tasks.length - 1];
  if (!isCleanupOnlyTask(last)) return tasks;
  const previous = tasks[tasks.length - 2];
  return [
    ...tasks.slice(0, -2),
    {
      ...previous,
      acceptance: [previous.acceptance, last.acceptance, "Do not introduce duplicate item definitions."]
        .filter(Boolean)
        .join(" ")
        .slice(0, 1_000),
      updatedAt: nowIso(),
    },
  ];
}

function usableRawPlannerTasks(raw: unknown): Record<string, unknown>[] | null {
  const list = (raw as { tasks?: unknown } | undefined)?.tasks;
  if (!Array.isArray(list) || list.length === 0) return null;
  const placeholder = /^(?:\.{2,}|…|todo|tbd|placeholder|n\/a|fix me|fill me|<[^>]*>)$/i;
  const usable: Record<string, unknown>[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const value = item as Record<string, unknown>;
    const title = typeof value.title === "string" ? value.title.trim() : "";
    const detail = typeof value.detail === "string" ? value.detail.trim() : "";
    if (title.length < 8 || detail.length < 12) return null;
    if (placeholder.test(title) || placeholder.test(detail)) return null;
    usable.push(value);
  }
  return usable.length === list.length ? usable : null;
}

const TASK_ACTIONS = new Set([
  "create",
  "update",
  "remove",
  "move",
  "verify",
  "run",
  "document",
  "other",
]);
const TASK_SURFACES = new Set(["ui", "api", "data", "config", "docs", "game", "other"]);

function taskAction(value: unknown): ProjectTask["action"] | undefined {
  return typeof value === "string" && TASK_ACTIONS.has(value)
    ? (value as ProjectTask["action"])
    : undefined;
}

function taskSurface(value: unknown): ProjectTask["surface"] | undefined {
  return typeof value === "string" && TASK_SURFACES.has(value)
    ? (value as ProjectTask["surface"])
    : undefined;
}

function normalizeTasks(raw: unknown, goal: string, verification?: string): ProjectTask[] {
  const candidate = raw as { tasks?: unknown };
  const list = Array.isArray(candidate?.tasks) ? candidate.tasks : [];
  const at = nowIso();
  const tasks: ProjectTask[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const value = item as Record<string, unknown>;
    const title = typeof value.title === "string" ? value.title.trim() : "";
    const detail = typeof value.detail === "string" ? value.detail.trim() : "";
    if (!title || !detail) continue;
    const effort = normalizeEffort(value.effort);
    const inferredVerify = /(?:^|\s)(verify|test|typecheck|lint|build|do[gğ]rula|test et|derle)(?:\s|$)/i.test(
      `${title} ${detail}`,
    );
    const action = taskAction(value.action) ?? (inferredVerify ? "verify" : "update");
    const surface = taskSurface(value.surface) ?? "other";
    const previous = tasks[tasks.length - 1];
    tasks.push({
      id: `task-${tasks.length + 1}`,
      title: title.slice(0, 140),
      detail,
      acceptance:
        typeof value.acceptance === "string" && value.acceptance.trim()
          ? value.acceptance.trim()
          : undefined,
      status: "pending",
      effort,
      role: roleForEffort(effort),
      action,
      surface,
      verificationOnly: action === "verify" ? true : undefined,
      readOnly: action === "verify" ? true : undefined,
      microEdit: value.microEdit === true ? true : undefined,
      dependsOn: previous ? [previous.id] : [],
      attempts: 0,
      changedFiles: [],
      commands: [],
      createdAt: at,
      updatedAt: at,
    });
    if (tasks.length >= MAX_PLANNED_TASKS) break;
  }
  if (tasks.length === 0) return fallbackTasks(goal, verification);
  const hasVerification = tasks.some(
    (task) =>
      task.verificationOnly === true ||
      task.action === "verify" ||
      /(verif|test|typecheck|build|doğrula|test et|derle)/i.test(`${task.title} ${task.detail}`),
  );
  if (verification && !hasVerification) {
    tasks.push({
      id: `task-${tasks.length + 1}`,
      title: "Verify and fix",
      detail: `Run ${verification}, inspect failures, and fix them without reverting completed work.`,
      acceptance: "The verification command exits successfully.",
      status: "pending",
      effort: "standard",
      role: "main",
      action: "verify",
      surface: "other",
      verificationOnly: true,
      readOnly: true,
      dependsOn: [tasks[tasks.length - 1].id],
      attempts: 0,
      changedFiles: [],
      commands: [],
      verification: { command: verification },
      createdAt: at,
      updatedAt: at,
    });
  }
  return tasks;
}

export async function planProjectTasks(
  projectId: string,
  goal: string,
  options: {
    language?: string;
    signal?: AbortSignal;
    replan?: boolean;
    intent?: IntentAnalysis;
    history?: { role: "user" | "assistant"; content: string }[];
    /** Read-only diagnosis generated before planning. */
    diagnosis?: ProjectDiagnosis;
    /** Build a queue for inspection without writing it to the project. */
    dryRun?: boolean;
  } = {},
): Promise<ProjectTaskQueue> {
  const analysis = await loadAnalysis(projectId);
  const verification = preferredVerificationCommand(analysis.tooling);
  const config = await resolveAgentRole("planner");
  const [projectMap, preflightHints, skillLoad, projectBrainBrief, domainBrief] = await Promise.all([
    ensureProjectMap(analysis).catch(() => ""),
    featurePreflightHints(analysis, goal).catch(() => []),
    loadSkillsForPrompt(analysis.rootPath, projectId, goal, {
      requested: options.intent?.skills,
    }).catch(() => ({
      relevant: [] as string[],
      selected: [] as string[],
    })),
    ensureProjectBrain(analysis)
      .then((brain) => compactProjectBrainBrief(brain))
      .catch(() => ""),
    prepareDomainBrief(analysis.rootPath, goal, { write: options.dryRun !== true }).catch(
      () => null,
    ),
  ]);
  const goalTokens = [...new Set((goal.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []))].filter(
    (token) => !["the", "and", "for", "with", "add", "fix", "make", "get", "set", "use", "from", "this", "that", "var", "let", "const"].includes(token),
  );
  const goalFiles = analysis.files
    .map((file) => file.path)
    .filter((file) => goalTokens.some((token) => file.toLowerCase().includes(token)))
    .slice(0, 12);
  const allFiles = analysis.files.map((file) => file.path).join(", ");
  const goalHints = featureExistenceHints(analysis, {
    title: goal,
    detail: goal,
  } as ProjectTask);
  const messages: ChatMessage[] = [
    { role: "system", content: PLANNER_SYSTEM },
    {
      role: "user",
      content: [
        projectFacts(analysis),
        projectBrainBrief
          ? `Persistent project brain (authoritative; reuse it instead of rediscovering the project):\n${projectBrainBrief}`
          : "",
        domainBrief
          ? `Domain brief (authoritative; use its rules as constraints and derive acceptance checks from its verification checklist):\n${domainBrief.facts}\nBrief file: ${domainBrief.relPath}`
          : "",
        options.diagnosis
          ? `Pre-edit diagnosis (authoritative; build tasks from this, do not repeat the analysis):\n${compactDiagnosisBrief(options.diagnosis)}`
          : "",
        `Project files (all): ${allFiles}`,
        goalFiles.length > 0 ? `Goal-relevant files: ${goalFiles.join(", ")}` : "",
        goalHints.length > 0
          ? `Goal-relevant existing symbols (use these files as primary edit targets): ${goalHints.join(
              "; ",
            )}`
          : "",
        preflightHints.length > 0
          ? `Existing-code preflight (the requested behavior may already exist; verify before planning and never create an edit task that re-adds it):\n${preflightHints.join("\n")}`
          : "",
        [...new Set([...(skillLoad.selected ?? []), ...skillLoad.relevant])].length > 0
          ? `Relevant skills (reference only; fold their guidance into task details/acceptance when useful): ${[
              ...new Set([...(skillLoad.selected ?? []), ...skillLoad.relevant]),
            ].join(", ")}`
          : "",
        projectMap ? `Project map (use it for file and symbol ownership):\n${projectMap.slice(0, 14_000)}` : "",
        "Write task titles, details and acceptance in English. Keep quoted user text, file paths and code identifiers unchanged.",
        `Verification command: ${verification ?? "none detected"}`,
        options.intent
          ? [
              "Intent analyst:",
              `Understanding: ${options.intent.understanding}`,
              options.intent.normalizedRequest
                ? `Normalized request: ${options.intent.normalizedRequest}`
                : "",
              options.intent.behaviors?.length
                ? `Behaviors (one task per behavior): ${JSON.stringify(
                    options.intent.behaviors.map((behavior) => ({
                      action: behavior.action,
                      surface: behavior.surface,
                      target: behavior.target,
                      details: behavior.details,
                      acceptance: behavior.acceptance,
                    })),
                  ).slice(0, 2_000)}`
                : "",
              options.intent.constraints?.length
                ? `Constraints: ${options.intent.constraints.join("; ")}`
                : "",
              options.intent.confidence !== undefined
                ? `Intent confidence: ${options.intent.confidence}`
                : "",
              `Scope: ${options.intent.scope} · mode: ${options.intent.mode}`,
              options.intent.approach ? `Approach: ${options.intent.approach}` : "",
              options.intent.needsExhaustiveEvidence ? "This answer must be exhaustive; collect every item and verify the total." : "",
              options.intent.areas.length > 0
                ? `Likely areas: ${options.intent.areas.join(", ")}`
                : "",
              options.intent.extras && options.intent.extras.length > 0
                ? `User extras (required; separate from domain rules): ${options.intent.extras.join(
                    ", ",
                  )}`
                : "",
              options.intent.assumptions.length > 0
                ? `Assumptions: ${options.intent.assumptions.join("; ")}`
                : "",
            ]
              .filter(Boolean)
              .join("\n")
          : "",
        options.history && options.history.length > 0
          ? `Recent conversation:\n${options.history
              .slice(-8)
              .map((message) => `${message.role}: ${message.content.slice(0, 1_000)}`)
              .join("\n")}`
          : "",
        `User goal:\n${goal.trim()}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];
  let tokenUsage: AiTokenUsage | undefined;
  let tasks: ProjectTask[] | undefined;
  let plannerError: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const text = await chat(config, messages, {
        maxTokens: 4_000,
        temperature: 0.1,
        timeoutMs: 120_000,
        signal: options.signal,
        onUsage: (usage) => {
          tokenUsage = usage;
        },
      });
      const inputChars = messages.reduce((sum, message) => sum + message.content.length, 0);
      const attemptUsage: AiTokenUsage =
        tokenUsage ?? {
          inputTokens: Math.ceil(inputChars / 4),
          outputTokens: Math.ceil(text.length / 4),
          totalTokens: Math.ceil(inputChars / 4) + Math.ceil(text.length / 4),
        };
      tokenUsage = attemptUsage;
      // eslint-disable-next-line no-await-in-loop
      await recordUsage({
        projectId,
        provider: config.id,
        model: config.model,
        kind: "tasks.plan",
        inputTokens: attemptUsage.inputTokens,
        outputTokens: attemptUsage.outputTokens,
        totalTokens: attemptUsage.totalTokens,
      });
      const raw = extractJson(text) as { tasks?: unknown } | undefined;
      const usableRaw = usableRawPlannerTasks(raw);
      if (!usableRaw) {
        throw new Error("The planner reply did not contain a non-empty, non-placeholder tasks array.");
      }
      tasks = normalizeTasks({ tasks: usableRaw }, goal, verification);
      if (tasks.length === 0) throw new Error("The planner returned no usable tasks.");
      break;
    } catch (error) {
      plannerError = error instanceof Error ? error.message : String(error);
      if (attempt === 0) {
        messages.push({
          role: "user",
          content:
            "Your previous reply was not valid planner JSON. Return ONLY the JSON object with a non-empty tasks array. No prose, no markdown fences.",
        });
      }
    }
  }
  if (!tasks || tasks.length === 0) {
    try {
      const minimalPrompt = [
        `Project files: ${analysis.files
          .map((file) => file.path)
          .slice(0, 20)
          .join(", ")}`,
        `User goal:\n${goal.trim()}`,
        "Return ONLY the JSON object with 1-6 tasks. Each task must describe one behavior change with acceptance criteria. No prose, no Markdown fences.",
      ].join("\n\n");
      const minimalText = await chat(
        config,
        [
          { role: "system", content: PLANNER_SYSTEM },
          { role: "user", content: minimalPrompt },
        ],
        {
          maxTokens: 3_000,
          temperature: 0.1,
          timeoutMs: 120_000,
          signal: options.signal,
          onUsage: (usage) => {
            tokenUsage = usage;
          },
        },
      );
      const minimalRaw = extractJson(minimalText) as { tasks?: unknown } | undefined;
      const usableMinimal = usableRawPlannerTasks(minimalRaw);
      if (usableMinimal) {
        tasks = normalizeTasks({ tasks: usableMinimal }, goal, verification);
        const minimalInput = Math.ceil(minimalPrompt.length / 4);
        const minimalUsage: AiTokenUsage = tokenUsage ?? {
          inputTokens: minimalInput,
          outputTokens: Math.ceil(minimalText.length / 4),
          totalTokens: minimalInput + Math.ceil(minimalText.length / 4),
        };
        await recordUsage({
          projectId,
          provider: config.id,
          model: config.model,
          kind: "tasks.plan",
          inputTokens: minimalUsage.inputTokens,
          outputTokens: minimalUsage.outputTokens,
          totalTokens: minimalUsage.totalTokens,
        }).catch(() => undefined);
        if (!options.dryRun) {
          await appendTaskContext(
            analysis.rootPath,
            "Planner minimal retry",
            "The full planner prompt failed twice; a minimal file-list retry produced the task queue.",
          ).catch(() => undefined);
        }
      }
    } catch (error) {
      plannerError = error instanceof Error ? error.message : String(error);
    }
  }
  if (!tasks || tasks.length === 0) {
    tasks = fallbackTasks(goal, verification, {
      projectMap,
      intent: options.intent,
    });
    if (!options.dryRun) {
      await appendTaskContext(
        analysis.rootPath,
        "Planner fallback",
        `The planner did not return valid tasks: ${(plannerError ?? "unknown").slice(
          0,
          500,
        )}. A single fallback task was created; re-plan when the model is healthy.`,
      ).catch(() => {});
    }
  }

  if (tasks.length === 1) {
    const behaviorTasks = options.intent ? tasksFromBehaviors(options.intent, goal) : [];
    const split =
      behaviorTasks.length > 1
        ? behaviorTasks
        : splitLargeGoal(goal, verification) ?? splitGoalSections(goal, verification);
    if (split && split.length > 1) {
      tasks = split;
      if (!options.dryRun) {
        await appendTaskContext(
          analysis.rootPath,
          "Plan split",
          `The goal contained multiple independent changes; it was split into ${split.length} tasks instead of one large task.`,
        );
      }
    }
  }
  tasks = foldTrailingVerification(tasks);
  tasks = foldTrailingCleanup(tasks);
  tasks = collapseVerificationTasks(tasks);
  if (options.intent && tasks.length > 0) {
    const limit =
      options.intent.scope === "small"
        ? 3
        : options.intent.scope === "medium"
          ? 5
          : options.intent.scope === "large"
            ? 8
            : 2;
    if (tasks.length > limit) {
      const verificationTask = [...tasks]
        .reverse()
        .find((task) => taskLooksLikeVerification(task) && !taskLooksLikeWrite(task));
      const kept = tasks.slice(0, limit);
      if (verificationTask && !kept.includes(verificationTask)) {
        kept[limit - 1] = verificationTask;
      }
      tasks = kept;
    }
  }

  if (options.dryRun) {
    return {
      ...emptyQueue(projectId, goal.trim()),
      tasks,
      updatedAt: nowIso(),
      stageUsage: tokenUsage ? { planner: tokenUsage } : undefined,
      planMeta: createPlanMeta(goal),
    };
  }

  const queue = await createQueue(analysis.rootPath, projectId, goal.trim(), tasks);
  queue.intent = options.intent;
  queue.planMeta = createPlanMeta(goal);
  if (tokenUsage) queue.stageUsage = { ...(queue.stageUsage ?? {}), planner: tokenUsage };
  await saveQueue(analysis.rootPath, queue);
  await appendTaskContext(
    analysis.rootPath,
    `Plan · ${new Date().toLocaleString()}`,
    [
      `Goal: ${goal.trim()}`,
      `Planner: ${config.id}/${config.model}`,
      `Tasks: ${tasks.length}`,
      options.intent ? `Intent: ${options.intent.understanding}` : "",
      options.intent ? `Scope: ${options.intent.scope} · mode: ${options.intent.mode}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return queue;
}

export function taskLooksLikeWrite(task: ProjectTask): boolean {
  if (task.readOnly === true) return false;
  return (
    task.action !== undefined &&
    ["create", "update", "remove", "move", "document"].includes(task.action)
  );
}

export function blockDependentsOf(
  queue: ProjectTaskQueue,
  failedId: string,
): ProjectTaskQueue {
  const blockedIds = new Set<string>([failedId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of queue.tasks) {
      if (item.status !== "pending" || blockedIds.has(item.id)) continue;
      if (item.dependsOn.some((dependency) => blockedIds.has(dependency))) {
        blockedIds.add(item.id);
        changed = true;
      }
    }
  }
  return {
    ...queue,
    tasks: queue.tasks.map((item) =>
      blockedIds.has(item.id) && item.id !== failedId && item.status === "pending"
        ? {
            ...item,
            status: "blocked",
            resultSummary: `Blocked because dependency ${failedId} failed.`,
            updatedAt: nowIso(),
          }
        : item,
    ),
  };
}

export function taskLooksLikeInspection(task: ProjectTask): boolean {
  return task.readOnly === true || task.action === "verify";
}

export function taskLooksLikeVerification(task: ProjectTask): boolean {
  return task.verificationOnly === true || task.action === "verify";
}

export function summaryAllowsNoChanges(summary: string): boolean {
  if (/\b(not complete|incomplete|not done|failed|missing|tamamlanmadı|yapılmadı|eksik)\b/i.test(summary)) {
    return false;
  }
  return /already (?:present|exists|implemented|applied|there|complete|complete and|satisf(?:y|ies|ied)|fits|matches|generates|produces|uses|creates|handles|supports|includes|contains|does|implemented and verified)|no (?:further )?(?:code )?changes? (?:are |was |were )?(?:needed|required)|nothing needed to change|none needed|task[\s-]*\d*\s*(?:is\s*)?complete|görev[\s-]*\d*\s*tamamlandı|created and verified|verified|confirmed|nothing (?:was|is) (?:changed|rewritten)|no (?:changes|modifications) (?:made|required)|no files? (?:was|is|were|are) changed|already (?:meets|satisfies|matches)|zaten (?:var|mevcut|tamam|tam|işlevsel|karşılan|karşılıyor|uyumlu|uygulanmış|uyguluyor|uyguluyordur|uygundur|eklenmiş|yapılmış|mevcutmuş)|değişiklik (?:gerekmiyor|yapılmadı)|(?:hiçbir )?dosya değiştirilmedi|değişmedi|gerek yok/i.test(
    summary,
  );
}

/**
 * A narrower signal than summaryAllowsNoChanges: the report explicitly says a
 * requested item already exists or needed no change. This can happen inside a
 * task that changed another file, so it must be checked per request.
 */
export function summaryClaimsAlreadyPresent(summary: string): boolean {
  return /already (?:present|exists|implemented|applied|there|complete|satisf(?:y|ies|ied)|fits|matches|renders|sits|works|has|generates|produces|uses|creates|handles|supports|includes|contains|does)|no (?:further )?(?:code )?changes? (?:are |was |were )?(?:needed|required)|nothing needed to change|none needed|nothing (?:was|is) (?:changed|rewritten)|no (?:changes|modifications) (?:made|required)|no files? (?:was|is|were|are) changed|already (?:meets|satisfies|matches)|zaten (?:var|mevcut|tamam|tam|işlevsel|karşılan|karşılıyor|uyumlu|uygulanmış|uyguluyor|uyguluyordur|uygundur|eklenmiş|yapılmış|mevcutmuş)|değişiklik (?:gerekmiyor|yapılmadı)|(?:hiçbir )?dosya değiştirilmedi|değişmedi|gerek yok/i.test(
    summary,
  );
}

export function compactRetryContext(result: AiAgentResult): string {
  const failed = result.steps
    .filter((step) => !step.ok)
    .slice(-3)
    .map((step) => `${step.action}: ${(step.observation ?? "").replace(/\s+/g, " ").slice(0, 300)}`)
    .join("\n");
  return [
    "Previous attempt failed; do not repeat it. The current code is included below.",
    `Summary: ${(result.summary ?? "").replace(/\s+/g, " ").slice(0, 1_200)}`,
    result.changedFiles.length > 0 ? `Changed: ${result.changedFiles.join(", ")}` : "",
    failed ? `Failed steps:\n${failed}` : "",
    result.error ? `Error: ${result.error.replace(/\s+/g, " ").slice(0, 500)}` : "",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 3_000);
}

export function reviewFileExcerpt(content: string, max = 3_000): string {
  if (content.length <= max) return content;
  return `${content.slice(0, max)}\n… [excerpt truncated; the file continues] …`;
}

export function summaryReportsBlocker(summary: string): boolean {
  return /\b(blocker|blocked|cannot|can't|unable to|not present|does not appear|missing|failed to|verification failed|could not|not verified|unverified|unproven|not proven|incomplete|did not verify)\b|yapılamadı|başarısız|engellendi|eksik|bulunamadı|doğrulanmadı|doğrulanamadı|doğrulanamayan|kanıtlanamadı|kanıtlanmadı|kanıtlanamayan|test edilmedi|çalıştırılmadı|calistirilmadi|kabul edilmedi|tamamlanamadı|bloker/i.test(
    summary,
  );
}

const FEATURE_SYNONYMS: Record<string, string[]> = {
  "ateş": ["bullet", "fire", "shoot"],
  "atış": ["bullet", "fire", "shoot"],
  "uçağa": ["bullet", "fire", "player"],
  "meteor": ["meteor", "obstacle"],
  "engel": ["obstacle", "meteor"],
  "hız": ["speed", "velocity"],
  "hızlı": ["speed", "velocity"],
  "komik": ["comedy", "joke"],
  "şaka": ["joke", "comedy"],
  "can": ["life", "lives"],
  "puan": ["score", "points"],
  "ses": ["sound", "audio"],
  "satış": ["sales", "sale"],
  "satışları": ["sales", "sale"],
  "gün": ["day", "daily"],
  "günü": ["day", "daily"],
  "ay": ["month", "monthly"],
  "değişim": ["change", "delta"],
  "json": ["json", "export", "download"],
  "csv": ["csv", "export", "download"],
  "dışa": ["export", "download"],
  "aktar": ["export", "download"],
};

function featureExistenceHints(analysis: AnalysisResult, task: ProjectTask): string[] {
  const stop = new Set([
    "ekle", "değiştir", "olsun", "daha", "kontrol", "edin", "bir", "için", "farklı",
    "atışta", "patlasın", "hareket", "etsin", "hala", "gelmedi", "onuda", "uçağa",
    "edebilme", "özelliği", "küçüğüne", "büyüğü", "büyüğe", "göre", "hızlı",
  ]);
  const text = `${task.title} ${task.detail ?? ""}`.toLowerCase();
  const words = (text.match(/[a-zçğıöşü0-9_]+/gi) ?? [])
    .map((word) => word.toLowerCase())
    .filter((word) => word.length >= 4 && !stop.has(word));
  const queries = new Set<string>();
  for (const word of words) {
    queries.add(word);
    for (const synonym of FEATURE_SYNONYMS[word] ?? []) queries.add(synonym);
  }
  const hints = new Map<string, string>();
  for (const query of queries) {
    for (const symbol of queryProjectSymbols(analysis, query, undefined, 6)) {
      const key = `${symbol.filePath}:${symbol.qualifiedName}`;
      if (!hints.has(key)) hints.set(key, `${symbol.filePath}:${symbol.name} (${symbol.kind}, line ${symbol.startLine})`);
      if (hints.size >= 8) break;
    }
    if (hints.size >= 8) break;
  }
  return [...hints.values()];
}

const CODE_FILE_PATTERN =
  /[A-Za-z0-9_./-]+\.(?:py|js|mjs|cjs|jsx|ts|tsx|vue|svelte|html?|css|scss|sass|less|php|go|rs|java|kt|kts|cs|rb|swift|dart|ex|exs|json|ya?ml|toml|md|sql|sh|bash)/gi;

/**
 * Best-effort file ownership for a task. Used by the parallel scheduler to
 * avoid running two agents that may edit the same file at the same time.
 */
export function taskTargetFiles(
  analysis: AnalysisResult,
  task: ProjectTask,
): string[] {
  const found = new Set<string>();
  const add = (value: string) => {
    const normalized = value.replace(/^[\s`"'(]+|[`"'(),.;:]+$/g, "").replace(/^\.\//, "");
    if (!normalized || normalized.startsWith(".cie/")) return;
    found.add(normalized);
  };
  for (const file of task.changedFiles) add(file);
  const text = `${task.title}\n${cleanTaskDetail(task.detail)}\n${task.acceptance ?? ""}`;
  for (const match of text.match(CODE_FILE_PATTERN) ?? []) add(match);
  // Symbol hints catch a feature mentioned only by name (e.g. monthly chart).
  for (const hint of featureExistenceHints(analysis, task)) {
    const path = hint.split(":")[0];
    if (path && CODE_FILE_EXTENSION.test(path)) add(path);
  }
  return [...found].slice(0, 8);
}

function lockKey(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.?\//, "").toLowerCase();
}

export function tasksOverlap(left: string[], right: Set<string>): boolean {
  return left.some((file) => right.has(lockKey(file)));
}

const CODE_FILE_EXTENSION =
  /\.(?:py|js|mjs|cjs|jsx|ts|tsx|vue|svelte|html?|css|scss|sass|less|php|go|rs|java|kt|kts|cs|rb|swift|dart|ex|exs|json|ya?ml|toml|md|sql|sh|bash)$/i;

const PREFLIGHT_STOP = new Set([
  "ekle", "ekley", "eklen", "oluştur", "olustur", "güncelle", "guncelle",
  "değiştir", "degistir", "göster", "goster", "yap", "olsun", "için", "icin",
  "bir", "ve", "ile", "daha", "çok", "cok", "olan", "olarak", "da", "de",
  "dışında", "disinda", "add", "create", "update", "change", "show", "display",
  "with", "from", "this", "that", "the", "and", "for", "make", "use",
]);

/**
 * Extract compact feature queries from a goal. These are used before planning
 * to find behavior that already exists, so the planner does not create a task
 * that re-adds it.
 */
export function buildFeatureQueries(goal: string, limit = 8): string[] {
  const chunks = goal
    .split(/\n|;|\.|,|\?|!/)
    .map((chunk) => chunk.replace(/^[\s*+\-\d.)]+/, "").trim())
    .filter((chunk) => chunk.length >= 6 && chunk.split(/\s+/).length >= 2)
    .slice(0, 10);
  const queries = new Set<string>();
  for (const chunk of chunks) {
    const words = (chunk.toLowerCase().match(/[a-zçğıöşü0-9_]+/gi) ?? []).filter(
      (word) => word.length >= 3 && !PREFLIGHT_STOP.has(word),
    );
    if (words.length === 0) continue;
    queries.add(words.slice(0, 3).join(" "));
    for (const word of words.slice(0, 4)) {
      queries.add(word);
      for (const synonym of FEATURE_SYNONYMS[word] ?? []) queries.add(synonym);
    }
    if (queries.size >= limit * 2) break;
  }
  return [...queries].slice(0, limit);
}

/**
 * Search the real files for the requested features before planning. Symbol
 * hints alone miss plain strings such as `st.download_button("JSON indir")`;
 * code hits let the planner say "this already exists" and skip a duplicate task.
 */
export async function featurePreflightHints(
  analysis: AnalysisResult,
  goal: string,
  limit = 8,
): Promise<string[]> {
  const sourcePattern =
    /\.(?:py|js|mjs|cjs|jsx|ts|tsx|vue|svelte|html?|css|scss|sass|less|php|go|rs|java|kt|kts|cs|rb|swift|dart|ex|exs|json|ya?ml|toml|md|txt)$/i;
  const files = analysis.files
    .filter(
      (file) =>
        sourcePattern.test(file.path) &&
        !/^(?:\.cie|node_modules|dist|build|vendor|\.git)\//.test(file.path),
    )
    .slice(0, 180);
  const documents: { path: string; lines: string[] }[] = [];
  await Promise.all(
    files.map(async (file) => {
      try {
        const absolute = path.resolve(analysis.rootPath, file.path);
        const stat = await fs.stat(absolute);
        if (!stat.isFile() || stat.size > 300_000) return;
        const content = await fs.readFile(absolute, "utf8");
        documents.push({ path: file.path, lines: content.split("\n") });
      } catch {
        // unreadable files are skipped
      }
    }),
  );

  const hints = new Map<string, string>();
  for (const query of buildFeatureQueries(goal, 8)) {
    const tokens = query
      .toLowerCase()
      .split(/\s+/)
      .filter((token) => token.length >= 4 && !PREFLIGHT_STOP.has(token));
    if (tokens.length === 0) continue;
    const matches: { path: string; line: number; text: string; score: number }[] = [];
    for (const document of documents) {
      for (let index = 0; index < document.lines.length; index += 1) {
        const text = document.lines[index];
        if (!text.trim()) continue;
        const lower = text.toLowerCase();
        const score = tokens.reduce((total, token) => total + (lower.includes(token) ? 1 : 0), 0);
        if (score > 0) matches.push({ path: document.path, line: index + 1, text, score });
      }
    }
    matches.sort((left, right) => right.score - left.score);
    for (const match of matches.slice(0, 2)) {
      const key = `${match.path}:${match.line}`;
      if (hints.has(key)) continue;
      hints.set(
        key,
        `${query}: ${match.path}:${match.line} — ${match.text.replace(/\s+/g, " ").trim().slice(0, 180)}`,
      );
      if (hints.size >= limit) break;
    }
    if (hints.size >= limit) break;
  }
  return [...hints.values()];
}

interface UiSmokeResult {
  ok: boolean;
  summary: string;
  screenshotPath?: string;
}

async function staticHtmlEntry(
  analysis: AnalysisResult,
  changedFiles: string[] = [],
): Promise<string | null> {
  const html = [...new Set([...analysis.files.map((file) => file.path), ...changedFiles])].filter(
    (file) => /\.html?$/i.test(file),
  );
  const entry = html.find((file) => /(^|\/)index\.html?$/i.test(file)) ?? html[0] ?? null;
  if (!entry) return null;
  try {
    await fs.access(path.resolve(analysis.rootPath, entry));
    return entry;
  } catch {
    return null;
  }
}

/**
 * Deterministic baseline for static HTML changes when the agent did not run an
 * interactive check. It clicks safe buttons / canvas points and reports page
 * errors, console errors and horizontal overflow. Task-specific assertions are
 * still required; this only prevents a completely unchecked page.
 */
export async function runUiEntrySmoke(
  analysis: AnalysisResult,
  changedFiles: string[] = [],
): Promise<UiSmokeResult | null> {
  const entry = await staticHtmlEntry(analysis, changedFiles);
  if (!entry) return null;
  // A React/Next/Vue dev-server page cannot be validated through the static
  // preview route; leave those to the agent's browser_check.
  const requiresDevServer = (analysis.frameworks ?? []).some((framework) =>
    /^(?:react|next|vue|nuxt|svelte|angular|solid|astro|expo)/
      .test(framework),
  );
  if (requiresDevServer) return null;
  const script = `(() => {
    const before = document.body.innerText;
    const buttons = [...document.querySelectorAll('button')].filter((button) =>
      button.offsetParent && !button.disabled &&
      !/delete|remove|logout|sil|çıkış|cikis|reset|temizle/i.test(button.textContent || '')
    ).slice(0, 3);
    for (const button of buttons) { try { button.click(); } catch {} }
    const canvas = document.querySelector('canvas');
    if (canvas) {
      const rect = canvas.getBoundingClientRect();
      for (const [fx, fy] of [[0.12, 0.28], [0.5, 0.5], [0.82, 0.75]]) {
        try {
          canvas.dispatchEvent(new PointerEvent('pointerdown', {
            clientX: rect.left + rect.width * fx,
            clientY: rect.top + rect.height * fy,
            bubbles: true,
            pointerId: 9,
          }));
        } catch {}
      }
    }
    const parseRgb = (value) => {
      const match = (value || '').match(/rgba?\(([^)]+)\)/);
      if (!match) return null;
      const parts = match[1].split(',').map((part) => parseFloat(part));
      if (parts.length < 3) return null;
      const alpha = parts.length > 3 ? parts[3] : 1;
      return alpha < 0.5 ? null : parts.slice(0, 3);
    };
    const luminance = (rgb) => {
      const channel = (value) => {
        const v = value / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
    };
    const contrast = (a, b) => {
      const l1 = Math.max(luminance(a), luminance(b));
      const l2 = Math.min(luminance(a), luminance(b));
      return (l1 + 0.05) / (l2 + 0.05);
    };
    const backgroundRgb = (el) => {
      let node = el;
      while (node) {
        const rgb = parseRgb(getComputedStyle(node).backgroundColor);
        if (rgb) return rgb;
        node = node.parentElement;
      }
      return [7, 11, 18];
    };
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width >= 2 && rect.height >= 2 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
    };
    let svgIcons = 0;
    let invisibleIcons = 0;
    for (const svg of document.querySelectorAll('svg')) {
      if (!visible(svg)) continue;
      const shape = svg.querySelector('path, circle, rect, polygon');
      const fill = parseRgb(getComputedStyle(shape || svg).fill) || parseRgb(getComputedStyle(svg).color);
      if (!fill) continue;
      svgIcons += 1;
      if (contrast(fill, backgroundRgb(svg)) < 1.3) invisibleIcons += 1;
    }
    let lowContrastText = 0;
    let checkedText = 0;
    for (const el of document.querySelectorAll('body *')) {
      if (checkedText >= 300) break;
      if (el.children.length > 0) continue;
      const text = (el.textContent || '').trim();
      if (!text || el.getAttribute('aria-hidden') === 'true' || !visible(el)) continue;
      const fg = parseRgb(getComputedStyle(el).color);
      if (!fg) continue;
      checkedText += 1;
      if (contrast(fg, backgroundRgb(el)) < 1.3) lowContrastText += 1;
    }
    return JSON.stringify({
      buttons: buttons.length,
      canvas: Boolean(canvas),
      changed: before !== document.body.innerText,
      svgIcons,
      invisibleIcons,
      lowContrastText,
    });
  })()`;
  const result = await runBrowserCheck(analysis.id, analysis.rootPath, {
    path: entry,
    steps: [
      { action: "expectVisible", selector: "body" },
      { action: "eval", value: script },
    ],
    screenshot: true,
    timeoutMs: 15_000,
  }).catch(() => null);
  if (!result) return { ok: false, summary: "UI smoke could not run." };
  const evalDetail = result.steps.find((step) => step.action === "eval")?.detail ?? "";
  const interactive = /"buttons":[1-9]|"canvas":true/.test(evalDetail);
  const changed = /"changed":true/.test(evalDetail);
  const errors = [...result.consoleErrors, ...result.pageErrors, ...result.resourceErrors];
  const overflow = result.metrics.horizontalOverflow;
  if (!result.ok) return { ok: false, summary: result.summary.slice(0, 500) };
  if (errors.length > 0) {
    return { ok: false, summary: `Console/page errors: ${errors.slice(0, 3).join(" · ")}` };
  }
  if (overflow) return { ok: false, summary: "The page has horizontal overflow." };
  const invisibleIcons = Number(evalDetail.match(/"invisibleIcons":(\d+)/)?.[1] ?? 0);
  if (invisibleIcons > 0) {
    return {
      ok: false,
      summary: `${invisibleIcons} visible icon(s) have near-invisible contrast against the background.`,
    };
  }
  const lowContrastText = Number(evalDetail.match(/"lowContrastText":(\d+)/)?.[1] ?? 0);
  if (lowContrastText > 0) {
    return {
      ok: false,
      summary: `${lowContrastText} visible text element(s) have near-invisible contrast.`,
    };
  }
  const screenshotPath = result.screenshotPath;
  if (screenshotPath) {
    const stat = await fs
      .stat(path.resolve(analysis.rootPath, screenshotPath))
      .catch(() => null);
    if (stat && stat.size < 5_000) {
      return {
        ok: false,
        summary: `UI screenshot looks blank (${stat.size} bytes).`,
        screenshotPath,
      };
    }
    const pixels = await pngStats(path.resolve(analysis.rootPath, screenshotPath)).catch(() => null);
    if (pixels && (pixels.uniqueColors < 4 || pixels.nonUniformRatio < 0.02)) {
      return {
        ok: false,
        summary: `UI screenshot is nearly uniform (${pixels.uniqueColors} colors).`,
        screenshotPath,
      };
    }
  }
  if (interactive && !changed) {
    return {
      ok: false,
      summary: "Interactive elements did not change visible state after a click.",
    };
  }
  return {
    ok: true,
    summary: `UI smoke passed (${interactive ? "interactive" : "static"})${
      screenshotPath ? ` · screenshot ${screenshotPath}` : ""
    }.`,
    screenshotPath,
  };
}

async function filesChangedSince(
  analysis: AnalysisResult,
  sinceIso: string | undefined,
): Promise<string[]> {
  if (!sinceIso) return [];
  const since = Date.parse(sinceIso);
  if (!Number.isFinite(since)) return [];
  const found: string[] = [];
  for (const file of analysis.files.slice(0, 4_000)) {
    if (/^(?:\.cie|node_modules|dist|build|\.git)\//.test(file.path)) continue;
    if (
      !/\.(?:js|mjs|cjs|ts|tsx|jsx|css|scss|sass|less|html?|php|py|go|rs|java|kt|swift|dart|rb|vue|svelte)$/i.test(
        file.path,
      )
    ) {
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const stat = await fs.stat(path.join(analysis.rootPath, file.path));
      if (stat.mtimeMs > since + 1_000) found.push(file.path);
    } catch {
      // missing file
    }
    if (found.length >= 20) break;
  }
  return found;
}

function taskInstruction(
  task: ProjectTask,
  total: number,
  verification?: string,
  priorTasks: ProjectTask[] = [],
  continuation = false,
  changedSinceGoal: string[] = [],
  existingCode: string[] = [],
  inspection = false,
  runPreviewUrl?: string,
  parallelNote?: string,
  originalRequest?: string,
  language?: string,
  projectBrief?: string,
  diagnosisBrief?: string,
): string {
  const brief = resolveWorkBrief(task.title);
  const extractionTask = brief?.mode === "extract";
  const scoreVerification = !extractionTask &&
    /\bpresskeys\b|scoring|\bscore\b|\bpuan\b|çarpma|\bmultiply\b|skor/i.test(
      `${task.title}\n${task.detail}\n${task.acceptance ?? ""}`,
    );
  const visualVerification =
    !extractionTask && taskRequestsVisualShapeOrPlacement(task);
  const spawnPlacementTask = !extractionTask && taskLooksLikeSpawnPlacement(task);
  const removalTask = !extractionTask && taskLooksLikeRemoval(task);
  const randomStartTask = !extractionTask && taskLooksLikeRandomStart(task);
  const gameBehaviorText = `${task.title}\n${task.detail}\n${task.acceptance ?? ""}`;
  const wallBreakTask =
    !extractionTask &&
    /(?=.*\b(?:duvar|wall)\w*\b)(?=.*\b(?:patlat|blast|break|kır)\w*\b)/i.test(gameBehaviorText);
  const mazeGenerationTask =
    !extractionTask &&
    /(?=.*\b(?:maz|maze|labirent)\b)(?=.*\b(?:otomatik|procedur|generat|üret|oluştur|random|rastgele)\b)/i.test(
      gameBehaviorText,
    );
  const fogRevealTask =
    !extractionTask &&
    /\b(?:fog|explored|reveal|keşif|görün|minimap)\b|alt kademe/i.test(gameBehaviorText);
  const prior = priorTasks
    .filter((item) => item.status === "done" && item.resultSummary)
    .slice(-8)
    .map(
      (item) =>
        `- ${item.id} ${item.title}: ${(item.resultSummary ?? "").replace(/\n+/g, " ").slice(0, 260)}${
          item.changedFiles.length > 0 ? ` · files: ${item.changedFiles.join(", ")}` : ""
        }`,
    )
    .join("\n");
  const resumeContract =
    priorTasks.some((item) => item.status === "done") || (task.repairAttempts ?? 0) > 0
      ? buildResumeContract(priorTasks, task)
      : "";
  return [
    `You are executing task ${task.id} of ${total} in a persistent project task loop.`,
    originalRequest
      ? `Original user request (authoritative; resolve conflicts in its favor):\n${originalRequest}`
      : "",
    projectBrief
      ? `Persistent project brain (authoritative project memory; trust this before rediscovering the repository):\n${projectBrief}`
      : "",
    diagnosisBrief
      ? `Pre-edit diagnosis (authoritative; follow this root cause/design/verification instead of repeating the analysis):\n${diagnosisBrief}`
      : "",
    `Task: ${task.title}`,
    cleanTaskDetail(task.detail),
    task.acceptance ? `Acceptance: ${task.acceptance}` : "",
    task.notes ? `Retry note: ${task.notes}` : "",
    task.retryContext
      ? `Previous attempt evidence (do not repeat; fix only this):\n${task.retryContext}`
      : "",
    resumeContract,
    runPreviewUrl
      ? `The active project's dev server is already running at ${runPreviewUrl}. The active project is already open in this workspace: use its files, the task notes and .cie/agent context instead of asking the user to choose a project or repeat information. Open this URL in the preview; do not start a second server and do not switch projects. Use browser_check on this URL when you need UI evidence.`
      : "",
    parallelNote ?? "",
    prior ? `Previous task summaries (use this before reading context.md):\n${prior}` : "",
    extractionTask
      ? "This is a read-only complete-list task. Do not read .cie/agent context files, do not run grep/shell commands, do not use list_items or browser_check. Call extract_entities with the matching kind once, then finish with every item in the user's language."
      : continuation
        ? "This is a continuation of your previous answer. Its findings are authoritative. Do not rescan or re-read the project; read only the exact lines you will edit, then apply the change and verify it on the real app."
        : "Read .cie/agent/context-digest.md first for compact prior context. Read .cie/agent/context.md only when the digest and summaries are insufficient; if it is large, search it with find_in_file or read only the relevant tail. Append useful durable context if you learn something new.",
    extractionTask
      ? ""
      : "For game or domain-specific work, read the matching .cie/agent/knowledge/*.md brief before deciding rules or mechanics.",
    extractionTask
      ? "Do not edit files and do not add runtime checks; the extraction table is the evidence."
      : inspection
        ? "This is a read-only inspection/diagnosis task. Do not edit files. Collect the minimum evidence, then finish with a compact diagnosis: root cause, file:line evidence, runtime proof, and the exact fix that would be needed. Do not keep reading after you have evidence."
        : "Before editing, check whether the requested behavior already exists. Presence alone is not enough: verify presence, the exact shape/form, the exact placement and the acceptance behavior. Cite file:line and rendered evidence. If any of the four differs, edit; do not label it 'already present'.",
    extractionTask
      ? ""
      : existingCode.length > 0
        ? `Existing code that may already implement this task: ${existingCode.join(
            "; ",
          )}. Inspect these exact symbols first. If they satisfy the request, verify and finish without editing.`
        : "",
    extractionTask
      ? ""
      : "For a field/control change, wire all layers: data model, creation form/markup, rendering and persistence. A selector referenced in JS but absent from the markup is incomplete; run browser_check when the change is visual and available.",
    changedSinceGoal.length > 0 && !extractionTask
      ? `Files changed since this goal started: ${changedSinceGoal.join(
          ", ",
        )}. They may contain partial work from an interrupted run. Inspect them first. A symbol, icon constant, element id or 'visible' check only proves presence; also verify shape, placement and acceptance on the real page. If all four match, finish with file:line and rendered evidence; otherwise edit. Do not rewrite or duplicate unrelated work.`
      : "",
    extractionTask ? "" : "Do not re-read files already fully read by a previous task unless the current task needs exact content after a change.",
    extractionTask ? "" : "Batch up to 4 independent read-only calls in one reply (read_file, find_in_file, search_code, list_files). One context round-trip per batch instead of one per read.",
    extractionTask ? "" : "Put all UI assertions into one browser_check call (up to 6 steps). Run the verification command once after the final edit; do not repeat a successful check unless code changed.",
    extractionTask ? "" : "Do not create .cie/agent/checks or .cie/agent/scenarios files for a one-off verification; use the existing tests and browser_check.",
    extractionTask ? "" : "Do not add window.__debug/test hooks or test-only globals to runtime code. Verify with browser_check eval on existing state/data or DOM/canvas observations; if a value is not reachable, observe the rendered result instead of changing production code for the test.",
    extractionTask ? "" : "Before the first edit, search for the exact feature name, symbol or label. If it already exists, verify presence + shape + placement + acceptance with file:line and rendered evidence before finishing; a selector, icon constant or element id alone is not proof.",
    extractionTask
      ? ""
      : "Compare the task detail with the original user request before editing. If the detail narrows or contradicts it (for example the original says the smaller operand, while the detail says the second operand), follow the original request and state the discrepancy.",
    extractionTask ? "" : "For HTML/canvas changes, run browser_check or game_check on the real entry page before finish. Canvas games need a real pointer/click or eval step and an asserted HUD/score/status change, not just canvas visibility. If you cannot verify, report the exact blocker; do not call it complete.",
    extractionTask
      ? ""
      : "For scoring/round logic use the canvas-game-verification recipe: find the owning function, then drive the real page with browser_check pressKeys and assert #score deltas (before/after). Never call startRound, round or state from eval. If the behavior already exists, finish with a before/after evidence table.",
    scoreVerification
      ? `Required score-verification shape: {"action":"browser_check","args":{"path":"index.html","steps":[{"action":"pressKeys","keys":["3","0","*","1","Enter"]},{"action":"expectText","selector":"#score","text":"1"}]}}. Prepare a deterministic target/operation with one short eval wait before these steps; do not call startRound/round/state from eval. First check .cie/agent/scenarios for a matching saved scenario and run it with run_test_scenario.`
      : "",
    visualVerification
      ? `Required visual-verification shape: one browser_check with an eval step that returns the rendered geometry (getBoundingClientRect for DOM placement, or canvas getImageData for a drawn shape) plus an expectText/expectValue assertion. A symbol, icon constant, element id or expectVisible only proves presence; it does not prove shape or placement. Measure each requested item separately (for example, the inventory rect and the key pixels); one item's geometry does not prove another. If the rendered result differs, edit the code.`
      : "",
    spawnPlacementTask
      ? "For a spawn/collectible task, fix the data that positions the OBJECT itself (for example level.rewards or the reward spawn helper), not the player start. Validate the object's cell with the existing walkability helper and relocate it to a reachable floor cell when invalid. Then prove at runtime that the object's RESOLVED cell is walkable and reachable from the player start, and that collecting it changes score/inventory. For a respawn task, run one eval that repeats collection 3 times. In a classic script, top-level state and move/collect functions are reachable from browser_check eval: pick a reward from state.rewards, set state.player = {x: reward.x, y: reward.y}, call the game's move(0,0)/collect path, then read the new state.rewards cell and assert with expectText that every new cell has isWall(x,y)===false, is not the player/exit/key, and that score/inventory increased each time. Return a single distinctive string such as 'respawnOk=true' and put expectText on the eval step itself. Repeat on a second level. Printing a value without an assertion is not evidence. Avoid substring traps: expectText '0' also matches '100'; assert the whole value or a distinctive string. Changing findWalkableStart/state.player for the player without collecting the object is a different concern and does not fix the object. If the user names a drawn object by color/shape (for example a blue small ball), find the drawing branch that uses that color and the data that places it; do not assume the first matching element."
      : "",
    removalTask
      ? "Remove means delete the node from the markup and delete or neutralize its population code and CSS. Setting hidden, display:none or removeAttribute is NOT removal and will be rejected. Then assert the removed selector is absent with expectCount 0 or an eval with its own expectText on the null/length-0 check, and confirm the replacement behavior still works."
      : "",
    randomStartTask
      ? "For random-start behavior, start the game several times and assert the observed level set varies; one start does not prove randomness. Put the expected result on the eval step itself with expectText, not a separate print."
      : "",
    wallBreakTask
      ? "For wall-breaking, verify on the real page with one browser_check eval: read the player cell, the target wall cell and the energy before; move into that wall; assert the energy decreased by the expected cost and the target cell is now walkable (or the level map cell changed). Return a distinctive string such as 'wallBroken=true' and put that exact value on the eval step's expectText; a printed value without expectText is not an assertion. Pressing a movement key on open floor is not proof. If breaking mutates a shared LEVELS map, confirm restart/level-load resets it."
      : "",
    mazeGenerationTask
      ? "For procedural maze generation, start or restart several times and assert the actual layout (walls/cells) differs, not only the level name/index. Return a distinctive string such as 'mazeGenerated=true' and put it on the eval step's expectText. If the project only has a fixed LEVELS array and shuffles its order, do not call that procedural generation; implement real generation or report the gap."
      : "",
    fogRevealTask
      ? "For fog/explored reveal, move the player and assert the explored cell count or minimap pixels increase; return 'fogRevealed=true' and put it on the eval step's expectText. A static canvas or visibility check is not proof."
      : "",
    extractionTask
      ? ""
      : "If a tool call fails, fix only that call's arguments and retry. For a script syntax/runtime error make one focused repair attempt; do not restart the task or re-read the whole file.",
    extractionTask ? "" : "Never kill, pkill, killall or nohup the dev server; the app manages the server and the preview.",
    extractionTask ? "" : "Large files: use a small write_file skeleton plus append_text sections (max ~120 lines each); never send a whole large file in one call.",
    extractionTask ? "" : "Read the smallest range you need. Do not read a whole large file before planning; read the relevant functions, then edit. If you have read the same file twice without editing, stop reading and make the smallest change.",
    (task.repairAttempts ?? 0) > 0
      ? `Narrow retry: read at most ${RECOVERY_POLICY.maxFilesForNarrowRetry} files (or none when the content is already in context), apply the smallest edit, then verify. Do not repeat earlier reads.`
      : "",
    `Final answer: write one concise report in ${language && language !== "unknown" ? language : "the user's language"}. Start with the outcome, then what changed, verification evidence and changed files. Do not include planning notes, task checklists, English analysis or internal tool logs; those belong in Details. Do not use Markdown task-list checkboxes.`,
    "Stay scoped to this task. Do not do later tasks. Do not revert earlier work.",
    verification && !extractionTask ? `Verification command: ${verification}` : "",
    extractionTask
      ? "Finish only after the extraction tool returned the complete list; do not summarize or omit items."
      : "The app runs the detected verification command automatically after this task. Run it yourself only when you need failure output to fix a specific issue; do not run it twice. If the task includes validation, permissions, errors or limits, verify both the accepted and rejected path. Finish only when this task is complete, or report the exact blocker.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function actionableRepairInstruction(summary: string): string | null {
  const text = summary.trim();
  if (!text) return null;
  if (/(?:blocker|kalan|tamamlanmadı|incomplete|remaining|not done)/i.test(text) === false &&
      /(?:fazla|silinmeli|kaldır|remove|delete|duplicate|tekrar|ekle|add|düzelt|fix|change|replace|rename|missing|eksik)/i.test(text) === false) {
    return null;
  }
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const actionable = lines.filter(
    (line) =>
      /(?:fazla|silinmeli|kaldır|remove|delete|duplicate|tekrar|ekle|add|düzelt|fix|change|replace|rename|missing|eksik|should|must)/i.test(
        line,
      ) &&
      /(?:[\w./-]+\.(?:js|mjs|cjs|ts|tsx|jsx|css|html?|php|py|go|rs|java|kt|swift|dart|rb)|[\w./-]+:\d+)/i.test(
        line,
      ),
  );
  const chosen = actionable.length > 0 ? actionable : lines;
  return chosen.join(" ").slice(0, 900) || null;
}

export function taskBudgetForEffort(effort: ProjectTaskEffort): {
  tokens: number;
  costUsd: number;
} {
  if (effort === "simple") return { tokens: 80_000, costUsd: 0.05 };
  if (effort === "hard") return { tokens: 320_000, costUsd: 0.25 };
  return { tokens: 160_000, costUsd: 0.12 };
}

export function taskStepBudget(effort: ProjectTaskEffort): number {
  if (effort === "simple") return 10;
  if (effort === "hard") return 20;
  return 14;
}

/**
 * Soft safety cap: a task may go a little over its normal budget to finish, but
 * not 2x. When hit, the loop continues with a focused retry instead of blocking.
 */
export function softTaskTokenBudget(effort: ProjectTaskEffort): number {
  return Math.round(taskBudgetForEffort(effort).tokens * 1.25);
}

/** Absolute safety cap across manual retries; Continue must not reset it. */
export function hardTaskTokenCap(task: ProjectTask): number {
  return Math.max(240_000, taskBudgetForEffort(taskBudgetEffort(task)).tokens * 2);
}

export function retryBudgetExhausted(task: ProjectTask): boolean {
  return (task.lifetimeTokens ?? 0) >= hardTaskTokenCap(task);
}

/**
 * A "simple" edit can still require a real browser round-trip and several
 * reads. Give UI/verification tasks the standard safety budget so they do not
 * burn a whole retry on a short verification.
 */
export function taskBudgetEffort(task: ProjectTask): ProjectTaskEffort {
  if (task.patch === true) return "simple";
  if (task.effort !== "simple") return task.effort;
  if (task.surface === "ui" || task.surface === "game" || task.verificationOnly === true) {
    return "standard";
  }
  return "simple";
}

/** A mechanical edit with an exact file/line target should use a short context budget. */
export function isMicroEditTask(task: ProjectTask): boolean {
  return task.microEdit === true;
}

interface RetryRecovery {
  note: string;
  quarantined: string[];
  restored: string[];
}

async function findRecoveryBackup(
  projectId: string,
  relativePath: string,
  startedAt?: string,
): Promise<{ path: string; content: string } | null> {
  if (!startedAt) return null;
  const backupDir = path.join(getDataDir(), "editor-backups", projectId);
  const safeName = relativePath.replace(/[\\/]/g, "__");
  let entries: string[] = [];
  try {
    entries = await fs.readdir(backupDir);
  } catch {
    return null;
  }
  const startStamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
  const candidates = entries
    .filter((name) => name.endsWith(`-${safeName}`))
    .map((name) => ({
      name,
      stamp: name.slice(0, name.length - safeName.length - 1),
    }))
    .filter((entry) => entry.stamp < startStamp)
    .sort((a, b) => b.stamp.localeCompare(a.stamp));
  const best = candidates[0];
  if (!best) return null;
  try {
    const backupPath = path.join(backupDir, best.name);
    return { path: backupPath, content: await fs.readFile(backupPath, "utf8") };
  } catch {
    return null;
  }
}

/**
 * Before re-running a failed task, inspect files that were written during the
 * failed attempt. Broken new files are moved to .cie/agent/recovery instead of
 * being left in the project. Broken existing files are restored from the last
 * backup taken before the task started. The retry then starts from a coherent
 * project state rather than half-written JSON/JS.
 */
export async function prepareTaskRetry(
  analysis: AnalysisResult,
  task: ProjectTask,
): Promise<RetryRecovery> {
  const startedMs = Date.parse(task.startedAt ?? task.createdAt);
  const candidates = new Set(
    task.changedFiles.filter((file) => !file.startsWith(".cie/")),
  );
  // Previous failure notes often mention the exact partial file (for example
  // comedy.js). Pull those paths from the task text and recent context so a
  // stale half-written file is cleaned even when changedFiles was not recorded.
  let mentioned = `${task.notes ?? ""}\n${task.resultSummary ?? ""}\n${task.detail ?? ""}`;
  for (const contextFile of [".cie/agent/context.md", ".cie/agent/context-digest.md"]) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const text = await fs.readFile(path.join(analysis.rootPath, contextFile), "utf8");
      mentioned += `\n${text.slice(-20_000)}`;
      for (const match of `${mentioned}`.matchAll(
        /(?:^|[\s`"'(])([A-Za-z0-9_@./-]+\.(?:js|mjs|cjs|jsx|ts|tsx|css|html|py|php|go|rs|java|kt|swift|dart|rb|lua))(?=$|[\s`"'),:])/gm,
      )) {
        const candidate = match[1].replace(/^\.\//, "");
        if (candidate.startsWith(".cie/")) continue;
        // eslint-disable-next-line no-await-in-loop
        const exists = await fs.stat(path.join(analysis.rootPath, candidate)).then(() => true).catch(() => false);
        if (exists) candidates.add(candidate);
      }
    } catch {
      // context files may not exist
    }
  }
  for (const file of analysis.files) {
    if (
      file.path.startsWith(".cie/") ||
      file.path.includes("node_modules/") ||
      file.path.startsWith("dist/") ||
      file.path.startsWith("build/")
    ) {
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const stat = await fs.stat(path.join(analysis.rootPath, file.path));
      if (Number.isFinite(startedMs) && stat.mtimeMs >= startedMs - 1_000) {
        candidates.add(file.path);
      }
    } catch {
      // deleted files are handled through changedFiles
    }
  }

  const quarantined: string[] = [];
  const restored: string[] = [];
  const notes: string[] = [];
  for (const relative of [...candidates].slice(0, 24)) {
    const absolute = path.join(analysis.rootPath, relative);
    const syntax = await checkFileSyntax(analysis, relative).catch(() => null);
    if (!syntax || !syntax.supported || syntax.ok) continue;
    const backup = await findRecoveryBackup(analysis.id, relative, task.startedAt);
    if (backup) {
      try {
        await fs.writeFile(absolute, backup.content, "utf8");
        restored.push(relative);
        notes.push(`${relative}: restored the pre-task backup before retrying.`);
        continue;
      } catch {
        // Fall through to quarantine/leave in place.
      }
    }
    let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;
    try {
      stat = await fs.stat(absolute);
    } catch {
      stat = null;
    }
    const isNewOrTouched = Boolean(
      stat && (!Number.isFinite(startedMs) || stat.mtimeMs >= startedMs - 1_000),
    );
    if (!backup && isNewOrTouched) {
      const recoveryDir = path.join(
        analysis.rootPath,
        ".cie",
        "agent",
        "recovery",
        `${task.id}-${Date.now().toString(36)}`,
      );
      const target = path.join(recoveryDir, relative);
      try {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.rename(absolute, target);
        quarantined.push(relative);
        notes.push(
          `${relative}: moved to ${path.relative(analysis.rootPath, target)} because the previous attempt left invalid syntax. The retry should recreate it cleanly.`,
        );
        await removeIndexedPath(analysis.id, relative).catch(() => undefined);
      } catch {
        notes.push(`${relative}: still has invalid syntax and could not be quarantined.`);
      }
    } else {
      notes.push(
        `${relative}: still has invalid syntax. Repair it before adding new features.`,
      );
    }
  }

  if (quarantined.length > 0) {
    analysis.files = analysis.files.filter((file) => !quarantined.includes(file.path));
  }

  return {
    note: notes.length > 0 ? `Retry recovery: ${notes.join(" ")}` : "",
    quarantined,
    restored,
  };
}

export function shouldRetryWithEditFirst(
  stoppedReason: string,
  changedFiles: string[],
): boolean {
  return stoppedReason === "max_steps" && changedFiles.length === 0;
}

/**
 * A UI task is only verified by a real interaction plus an assertion. A
 * screenshot/visibility check alone does not prove buttons, canvas keys or
 * forms work.
 */
export function summarizeVerificationSteps(
  steps: AiAgentStep[],
): { checks: number; durationMs: number } {
  const checks = steps.filter(
    (step) =>
      step.ok &&
      ["browser_check", "run_test_scenario", "game_check"].includes(step.action),
  );
  return {
    checks: checks.length,
    durationMs: checks.reduce((total, step) => total + (step.durationMs || 0), 0),
  };
}

export function isInteractiveUiCheck(step: AiAgentStep): boolean {
  if (!step.ok) return false;
  if (step.action === "run_test_scenario") return true;
  if (step.action !== "browser_check" && step.action !== "game_check") return false;
  const raw = step.args?.steps;
  const steps = Array.isArray(raw) ? raw : [];
  const actions = steps
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => String(item.action ?? ""));
  const hasInteraction = actions.some((action) =>
    ["click", "fill", "press", "eval"].includes(action),
  );
  const hasAssertion =
    actions.some((action) =>
      ["expectText", "expectValue", "expectVisible", "expectCount", "expectStable"].includes(action),
    ) ||
    steps.some(
      (item) =>
        item &&
        typeof item === "object" &&
        String((item as Record<string, unknown>).action ?? "") === "eval" &&
        typeof (item as Record<string, unknown>).expectText === "string",
    );
  if (hasInteraction && hasAssertion) return true;
  // Older observations may not retain args; use their PASS/FAIL detail.
  return (
    /\b(click|fill|press|eval)\b/i.test(step.observation ?? "") &&
    /\b(expectText|expectValue|expectVisible|expectCount|expectStable)\b/i.test(
      step.observation ?? "",
    )
  );
}

const VISUAL_SHAPE_PLACEMENT =
  /\b(?:shape|shaped|icon|glyph|sprite|drawn|draw|render(?:ed|ing)?|top[-\s]?left|left[-\s]?top|top[-\s]?right|right[-\s]?top|bottom[-\s]?left|bottom[-\s]?right|corner)\b|şekil(?:inde|li)?|ikon|simge|sol[-\s]?üst|üst[-\s]?sol|sağ[-\s]?üst|üst[-\s]?sağ|sol[-\s]?alt|sağ[-\s]?alt|köşe|hizala|çiz|görünüm/i;

/** True when the request is about how something looks or where it sits. */
export function taskRequestsVisualShapeOrPlacement(task: ProjectTask): boolean {
  return VISUAL_SHAPE_PLACEMENT.test(`${task.title}\n${task.detail}\n${task.acceptance ?? ""}`);
}

/** A real file:line reference, not just a bare symbol or file name. */
export function summaryCitesFileLines(summary: string): boolean {
  return /(?:^|[\s(`"'])[\w./@-]+\.(?:[cm]?[jt]sx?|vue|svelte|astro|html?|css|scss|sass|less|php|py|go|rs|java|kt|kts|cs|rb|swift|scala|json|toml|ya?ml|md|txt|sh|sql):\d+(?:-\d+)?/i.test(
    summary,
  );
}

/**
 * Rendered geometry evidence: an eval step that reads a bounding box or canvas
 * pixels, plus an assertion. A "visible" check or a symbol constant does not
 * prove the requested shape or placement.
 */
export function isGeometryEvidenceCheck(step: AiAgentStep): boolean {
  if (!step.ok) return false;
  if (!["browser_check", "game_check", "run_test_scenario"].includes(step.action)) {
    return false;
  }
  const raw = step.args?.steps;
  const steps = Array.isArray(raw)
    ? raw.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
  const hasGeometryEval = steps.some((item) => {
    if (String(item.action ?? "") !== "eval") return false;
    const script = String(item.script ?? "");
    return /getBoundingClientRect|getClientRects|getImageData|offsetLeft|offsetTop|offsetWidth|offsetHeight|clientWidth|clientHeight|toDataURL/i.test(
      script,
    );
  });
  const hasAssertion =
    steps.some((item) =>
      ["expectText", "expectValue", "expectVisible", "expectCount", "expectStable"].includes(
        String(item.action ?? ""),
      ),
    ) ||
    steps.some(
      (item) =>
        String(item.action ?? "") === "eval" && typeof item.expectText === "string",
    );
  if (hasGeometryEval && hasAssertion) return true;
  const observation = step.observation ?? "";
  return (
    /getBoundingClientRect|getImageData|bounding box|pixel|canvas/i.test(observation) &&
    /expectText|expectValue|expectVisible|expectCount|expectStable|PASS/i.test(observation)
  );
}

/**
 * A changed visual task is not verified by "the page loads" or a visibility
 * check. It needs a rendered-geometry assertion, even when files changed.
 */
export function needsRenderedGeometryEvidence(
  task: ProjectTask,
  steps: AiAgentStep[],
  projectHasUi: boolean,
): boolean {
  return (
    projectHasUi &&
    taskRequestsVisualShapeOrPlacement(task) &&
    !steps.some(isGeometryEvidenceCheck)
  );
}

const SPAWN_PLACEMENT_TASK =
  /respawn|spawn|collectible|pickup|pick up|toplanabilir|alınabilir|mavi top|hareket edilebilir|yürünebilir|geçilebilir|reachable|walkable|item.*(?:position|place|yer)|yerleştir|doğ(?:sun|ar)|çıksın/i;
const REMOVAL_TASK = /\b(?:remove|delete|hide|drop|kaldır|sil|gizle)\b/i;
const REMOVAL_UI_TARGET =
  /\b(?:list|menu|panel|button|section|selector|dropdown|tab|card|overlay|form|input|level-select|harita|liste|menü|düğme|buton|kart|sekme)\b/i;
const RANDOM_START_TASK =
  /(?:random|rastgele).*(?:start|başlat|level|bölüm|map|harita)|(?:start|başlat|level|bölüm|map|harita).*(?:random|rastgele)/i;

function taskFocusText(task: ProjectTask): string {
  // The planner appends the full original request to every detail, so use the
  // task-specific title/acceptance here. Otherwise one goal keyword would make
  // every split task demand the same evidence family.
  return `${task.title}\n${task.acceptance ?? ""}`;
}

export function taskLooksLikeSpawnPlacement(task: ProjectTask): boolean {
  return SPAWN_PLACEMENT_TASK.test(taskFocusText(task));
}

export function taskLooksLikeRemoval(task: ProjectTask): boolean {
  const text = taskFocusText(task);
  return REMOVAL_TASK.test(text) && REMOVAL_UI_TARGET.test(text);
}

export function taskLooksLikeRandomStart(task: ProjectTask): boolean {
  return RANDOM_START_TASK.test(taskFocusText(task));
}

function browserCheckSteps(step: AiAgentStep): Record<string, unknown>[] {
  const raw = step.args?.steps;
  return Array.isArray(raw)
    ? raw.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
}

/** The eval step itself must assert its result, not just print it. */
function evalHasAssertion(item: Record<string, unknown>): boolean {
  return ["expectText", "expected", "contains"].some(
    (key) => typeof item[key] === "string" && String(item[key]).trim().length > 0,
  );
}

/** A real behavior assertion in the same check (visibility alone is not enough). */
function hasBehaviorAssertion(steps: Record<string, unknown>[]): boolean {
  return steps.some((item) => {
    const action = String(item.action ?? "");
    if (["expectText", "expectValue", "expectCount", "expectStable"].includes(action)) {
      return true;
    }
    return action === "eval" && typeof item.expectText === "string";
  });
}

/** Runtime proof that a spawned item is on a walkable/reachable cell or collectible. */
export function isSpawnPlacementEvidenceCheck(step: AiAgentStep): boolean {
  if (!step.ok) return false;
  if (!["browser_check", "game_check", "run_test_scenario"].includes(step.action)) {
    return false;
  }
  const steps = browserCheckSteps(step);
  const probeItem = steps.find((item) => {
    if (String(item.action ?? "") !== "eval") return false;
    const script = String(item.script ?? "");
    return (
      /rewards?|collectible|pickup|pellet|gem|blue|ball|mavi|top|item/i.test(script) &&
      /isWall|reachable|walkable|BFS|path|duvar|geçilebilir|hareket|map|floor|zemin/i.test(script)
    );
  });
  if (probeItem && (evalHasAssertion(probeItem) || hasBehaviorAssertion(steps))) {
    return true;
  }
  const observation = step.observation ?? "";
  return (
    /rewards?|collectible|pickup|pellet|gem|blue|ball|mavi|top|item|gained|respawn/i.test(observation) &&
    /isWall|reachable|walkable|duvar|geçilebilir|floor|wall|zemin|map|walk|notSpecial/i.test(observation) &&
    /PASS|expectText|expectValue|expectCount|expectStable/i.test(observation)
  );
}

/** Runtime proof that a removed UI element is gone (not merely hidden). */
export function isRemovalEvidenceCheck(step: AiAgentStep): boolean {
  if (!step.ok) return false;
  if (!["browser_check", "game_check", "run_test_scenario"].includes(step.action)) {
    return false;
  }
  const steps = browserCheckSteps(step);
  const countZero = steps.some(
    (item) =>
      String(item.action ?? "") === "expectCount" && Number(item.count) === 0,
  );
  const selectorAbsentEval = steps.some((item) => {
    if (String(item.action ?? "") !== "eval") return false;
    const script = String(item.script ?? "");
    const checksAbsence =
      /querySelector(?:All)?\s*\(|getElementById|getElementsBy/i.test(script) &&
      /null|undefined|length\s*===?\s*0|!\s*document|===?\s*0/i.test(script);
    return checksAbsence && evalHasAssertion(item);
  });
  const hiddenOnly = steps.some((item) =>
    /hidden|display\s*:\s*none|visibility\s*:\s*hidden/i.test(
      `${item.script ?? ""} ${item.expectText ?? ""}`,
    ),
  );
  if ((countZero || selectorAbsentEval) && !hiddenOnly) return true;
  const observation = step.observation ?? "";
  if (/hidden|display\s*:\s*none|visibility\s*:\s*hidden/i.test(observation)) return false;
  return (
    /count is 0|null|removed|absent|yok|kaldırıldı/i.test(observation) &&
    /PASS|expectText|expectCount|expectValue/i.test(observation)
  );
}

/** Runtime proof that repeated starts yield a varying/random level. */
export function isRandomStartEvidenceCheck(step: AiAgentStep): boolean {
  if (!step.ok) return false;
  if (!["browser_check", "game_check", "run_test_scenario"].includes(step.action)) {
    return false;
  }
  const steps = browserCheckSteps(step);
  const probeItem = steps.find(
    (item) =>
      String(item.action ?? "") === "eval" &&
      /LEVELS|level|start|restart|Math\.random|bölüm/i.test(String(item.script ?? "")),
  );
  if (probeItem && (evalHasAssertion(probeItem) || hasBehaviorAssertion(steps))) {
    return true;
  }
  const observation = step.observation ?? "";
  return (
    /random|rastgele|levels?\s*[:=]|bölüm|\d+\/\d+/i.test(observation) &&
    /PASS|expectText|expectValue|expectStable/i.test(observation)
  );
}

/**
 * A task may only complete without an edit when it proves the four acceptance
 * dimensions: presence, shape, placement and behavior. This is the deterministic
 * guard behind "Already present (verified, no edit)".
 */
export function noChangeCompletionEvidence(
  task: ProjectTask,
  result: Pick<AiAgentResult, "summary" | "steps" | "changedFiles">,
  projectHasUi: boolean,
  scenarioPassed = false,
): { ok: boolean; reason: string } {
  if (!summaryCitesFileLines(result.summary ?? "")) {
    return {
      ok: false,
      reason:
        "No-change completion rejected: cite the exact file:line for every item claimed as already present.",
    };
  }
  const visual = taskRequestsVisualShapeOrPlacement(task);
  const hasGeometry = result.steps.some(isGeometryEvidenceCheck);
  if (visual && !hasGeometry) {
    return {
      ok: false,
      reason:
        "No-change completion rejected: the request asks for a visual shape or placement. A constant, icon name, element id or plain 'visible' check only proves presence. Verify the rendered result with browser_check eval (getBoundingClientRect or getImageData) plus an assertion, or edit the code to match the requested shape/placement.",
    };
  }
  if (
    !visual &&
    projectHasUi &&
    !hasGeometry &&
    !scenarioPassed &&
    !result.steps.some(isInteractiveUiCheck)
  ) {
    return {
      ok: false,
      reason:
        "No-change completion rejected: add a passing interactive real-page check with an assertion, or edit the code.",
    };
  }
  return { ok: true, reason: "" };
}

/**
 * A changed behavior is not verified by a smoke check. When the task names a
 * concrete game behavior (maze generation, fog reveal, wall breaking), at least
 * one successful real-page check must exercise and assert that behavior.
 */
const BEHAVIOR_EVIDENCE_RULES: {
  id: string;
  label: string;
  task: RegExp;
  proof: RegExp;
  action: RegExp;
  requiresChange?: boolean;
}[] = [
  {
    id: "maze-generation",
    label: "procedural maze generation",
    task: /(?=.*\b(?:maz|maze|labirent)\b)(?=.*\b(?:otomatik|procedur|generat|üret|oluştur|random|rastgele)\b)/i,
    proof: /\b(?:LEVELS|level|map|maze|labirent|grid|oda|room)\b/i,
    action: /\b(?:generat|procedur|random|Math\.random|shuffle|üret|oluştur|levelOrder|different|farklı)\b/i,
    requiresChange: true,
  },
  {
    id: "fog-reveal",
    label: "fog / explored reveal",
    task: /\b(?:fog|explored|reveal|keşif|görün|minimap)\b|alt kademe/i,
    proof: /\b(?:explored|reveal|fog|minimap|harita|keşif|görün)\b/i,
    action: /\b(?:reveal|explored|keşf|açıl|görün|farklı)\b/i,
  },
  {
    id: "wall-break",
    label: "wall breaking",
    task: /(?=.*\b(?:duvar|wall)\w*\b)(?=.*\b(?:patlat|blast|break|kır)\w*\b)/i,
    proof: /\b(?:energy|enerji|isWall|wall|duvar|map|grid|cell|hücre)\b/i,
    action: /\b(?:isWall|wallBroken|broken|patlat|kır|map\[|cell|hücre)\b/i,
    requiresChange: true,
  },
];

function stepEvidenceText(step: AiAgentStep): string {
  const raw = typeof step.args === "string" ? step.args : JSON.stringify(step.args ?? {});
  return `${raw}\n${step.observation ?? ""}`;
}

function evidenceHasAssertion(step: AiAgentStep): boolean {
  if (isInteractiveUiCheck(step)) return true;
  const text = stepEvidenceText(step);
  return (
    /"action"\s*:\s*"(?:expectText|expectValue|expectCount|expectStable|waitForText)"/.test(text) ||
    /"expectText"\s*:/.test(text)
  );
}

function evidenceShowsChange(text: string): boolean {
  for (const label of ["energy", "enerji", "score", "skor", "level", "lives", "can"]) {
    const before = new RegExp(`${label}\\w*?(?:before|önce)\\D{0,12}(\\d+(?:\\.\\d+)?)`, "i").exec(text);
    const after = new RegExp(`${label}\\w*?(?:after|sonra)\\D{0,12}(\\d+(?:\\.\\d+)?)`, "i").exec(text);
    if (before && after && Number(before[1]) !== Number(after[1])) return true;
  }
  return /\b(?:changed|different|farklı|arttı|azaldı|düştü|generated|procedural|wallBroken|broken|true)\b/i.test(
    text,
  );
}

export function taskBehaviorEvidence(
  task: ProjectTask,
  result: Pick<AiAgentResult, "steps" | "changedFiles">,
  projectHasUi: boolean,
  goalText?: string,
): { ok: boolean; missing: string[]; reason: string } {
  if (!projectHasUi) return { ok: true, missing: [], reason: "" };
  const taskText = goalText ?? taskFocusText(task);
  const checks = result.steps.filter(
    (step) =>
      step.ok &&
      ["browser_check", "game_check", "run_test_scenario"].includes(step.action),
  );
  const missing: string[] = [];
  for (const rule of BEHAVIOR_EVIDENCE_RULES) {
    if (!rule.task.test(taskText)) continue;
    const proved = checks.some((step) => {
      const text = stepEvidenceText(step);
      if (!rule.proof.test(text) || !rule.action.test(text)) return false;
      if (!evidenceHasAssertion(step)) return false;
      if (rule.requiresChange && !evidenceShowsChange(text)) return false;
      return true;
    });
    if (!proved) missing.push(rule.label);
  }
  if (missing.length === 0) return { ok: true, missing: [], reason: "" };
  return {
    ok: false,
    missing,
    reason: `No runtime check proved the requested behavior: ${missing.join(", ")}. Add a real-page check that exercises it and asserts a concrete change (energy, map cell, score, level or visibility); a smoke check or expectVisible is not proof.`,
  };
}

/**
 * Compact, user-facing summary of failed tool/protocol calls in one task.
 * Keeps the task card useful without making users read the full live log.
 */
export function summarizeToolIssues(steps: AiAgentStep[]): string[] {
  const groups = new Map<string, { count: number; sample: string }>();
  for (const step of steps) {
    if (step.ok || step.action === "finish") continue;
    let label: string = step.action;
    if (step.action === "invalid") {
      const text = step.observation ?? "";
      label = /provider-native|DSML|invalid tool protocol/i.test(text)
        ? "protocol"
        : /truncated|output limit/i.test(text)
          ? "truncated reply"
          : /real-page verification|no verification/i.test(text)
            ? "verification"
            : "invalid reply";
    } else if (
      step.action === "run_project_tool" &&
      /was not found/i.test(step.observation ?? "")
    ) {
      label = "missing project tool";
    }
    // A failure followed by a successful call to the same tool was recovered
    // and should not look like a blocker in the task card.
    const recovered = steps.some(
      (later) => later.index > step.index && later.ok && later.action === step.action,
    );
    if (recovered) label = `recovered ${label}`;
    const sample = (step.observation ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
    const current = groups.get(label);
    if (current) current.count += 1;
    else groups.set(label, { count: 1, sample });
  }
  return [...groups.entries()]
    .slice(0, 5)
    .map(
      ([label, value]) =>
        `${label} ×${value.count}${value.sample ? `: ${value.sample}` : ""}`,
    );
}

export function isInspectionAnswer(summary: string): boolean {
  return (
    summary.trim().length >= 120 &&
    !looksLikePlanningText(summary) &&
    !/reached the step limit|invalid tool protocol|empty response|no readable text/i.test(
      summary,
    )
  );
}

function aggregateResult(
  goal: string,
  queue: ProjectTaskQueue,
  taskResults: AiAgentResult[],
  provider: string,
  model: string,
): AiAgentResult {
  const done = queue.tasks.filter((task) => task.status === "done").length;
  const failed = queue.tasks.filter((task) => task.status === "failed" || task.status === "blocked").length;
  const changedFiles = [...new Set(queue.tasks.flatMap((task) => task.changedFiles))];
  const commands = [...new Set(queue.tasks.flatMap((task) => task.commands))];
  const steps = taskResults.flatMap((result) => result.steps);
  const tokenUsage = taskResults.reduce(
    (total, result) => addUsage(total, result.tokenUsage),
    emptyUsage(),
  );
  const costUsd = queue.tasks.reduce((total, task) => total + (task.costUsd ?? 0), 0);
  const budgetBlocked = queue.tasks.some(
    (task) =>
      task.status === "blocked" &&
      /task budget exceeded/i.test(`${task.notes ?? ""} ${task.resultSummary ?? ""}`),
  );
  const stoppedReason: AiAgentResult["stoppedReason"] =
    queue.status === "stopped"
      ? "aborted"
      : queue.status === "completed"
        ? "finished"
        : budgetBlocked
          ? "budget"
          : "max_steps";
  const planPath = taskResults.find((result) => result.planPath)?.planPath;
  const changeReport = [...taskResults].reverse().find((result) => result.changeReport)?.changeReport;
  const readMap = taskResults.flatMap((result) => result.readMap ?? []);
  const extraction = [...taskResults].reverse().find((result) => result.extraction)?.extraction;
  const lines = [
    `Task loop finished for: **${goal}**`,
    "",
    `- Completed: ${done}/${queue.tasks.length}`,
    `- Blocked/failed: ${failed}`,
    costUsd > 0 ? `- Estimated cost: ${formatUsd(costUsd)}` : "",
    changedFiles.length > 0 ? `- Changed files: ${changedFiles.map((file) => `\`${file}\``).join(", ")}` : "",
    commands.length > 0 ? `- Commands: ${commands.map((command) => `\`${command}\``).join(", ")}` : "",
    planPath ? `- Plan: \`${planPath}\`` : "",
    "",
    "### Tasks",
    ...queue.tasks.map(
      (task) =>
        `- ${task.status === "done" ? "✅" : task.status === "failed" ? "❌" : task.status === "blocked" ? "⏸" : "⏳"} \`${task.id}\` ${task.title} · ${task.role}/${task.effort}${
          task.resultSummary ? ` — ${task.resultSummary}` : ""
        }`,
    ),
  ].filter(Boolean);

  return {
    instruction: goal,
    summary: lines.join("\n"),
    steps,
    changedFiles,
    ranCommands: commands,
    stoppedReason,
    stages: queue.stageUsage,
    provider,
    model,
    createdAt: new Date().toISOString(),
    tokenUsage,
    costUsd: costUsd > 0 ? Number(costUsd.toFixed(6)) : undefined,
    planPath,
    taskQueue: queue,
    changeReport,
    readMap,
    extraction,
  };
}

function behaviorRequirements(intent?: IntentAnalysis): string[] {
  return (intent?.behaviors ?? [])
    .map((behavior) => `${behavior.target}${behavior.details ? `: ${behavior.details}` : ""}`.trim())
    .filter(Boolean);
}

function tasksFromBehaviors(intent: IntentAnalysis, goal: string): ProjectTask[] {
  const behaviors = intent.behaviors ?? [];
  if (behaviors.length <= 1) return [];
  const at = nowIso();
  return behaviors.map((behavior, index) => ({
    id: `task-${index + 1}`,
    title: `${behavior.action} ${behavior.target}`.slice(0, 140),
    detail: [behavior.target, behavior.details, behavior.acceptance ? `Acceptance: ${behavior.acceptance}` : "", goal.trim()]
      .filter(Boolean)
      .join("\n"),
    acceptance:
      behavior.acceptance ||
      `The requested behavior for "${behavior.target}" works and is verified on the real page.`,
    status: "pending",
    effort: "standard",
    role: "main",
    action: behavior.action,
    surface: behavior.surface,
    readOnly: behavior.action === "verify" ? true : undefined,
    verificationOnly: behavior.action === "verify" ? true : undefined,
    dependsOn: index === 0 ? [] : [`task-${index}`],
    attempts: 0,
    changedFiles: [],
    commands: [],
    createdAt: at,
    updatedAt: at,
  }));
}

/**
 * Deterministic fallback for a large goal when the AI planner fails: split by
 * markdown sections so a single fallback task cannot swallow the whole spec.
 */
export function splitGoalSections(goal: string, verification?: string): ProjectTask[] | null {
  const sections: { title: string; body: string[] }[] = [];
  let current: { title: string; body: string[] } | null = null;
  for (const line of goal.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      if (current && current.body.join("\n").trim()) sections.push(current);
      current = { title: heading[1].trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current && current.body.join("\n").trim()) sections.push(current);
  if (sections.length < 2) return null;

  const isConstraint = /^(teknoloji|teknolojiler|dosya yapısı|dosya yapisi|constraints?|tech|stack|requirements?)/i;
  const isVerify = /^(kontroller|kontrol|doğrulama|dogrulama|verification|tests?|acceptance)/i;
  const constraints = sections
    .filter((section) => isConstraint.test(section.title))
    .map((section) => `${section.title}:\n${section.body.join("\n").trim()}`)
    .join("\n\n");
  const selected = sections.filter((section) => !isConstraint.test(section.title)).slice(0, 5);
  if (selected.length < 2) return null;

  const at = nowIso();
  return selected.map((section, index) => {
    const verify = isVerify.test(section.title);
    const surface: ProjectTask["surface"] = verify
      ? "other"
      : /(görsel|gorsel|arayüz|arayuz|ui|style|tasarım|tasarim)/i.test(section.title)
        ? "ui"
        : /(oyun|game|mekanik|mechanic|movement|hareket)/i.test(section.title)
          ? "game"
          : "other";
    return {
      id: `task-${index + 1}`,
      title: section.title.slice(0, 140),
      detail: [section.body.join("\n").trim(), constraints ? `Project constraints:\n${constraints}` : ""]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, 4_000),
      acceptance: verify
        ? "Every item in this section is verified on the real page."
        : `The behavior described in "${section.title}" works and is verified on the real page.`,
      status: "pending",
      effort: "standard",
      role: "main",
      action: verify ? "verify" : "update",
      surface,
      readOnly: verify ? true : undefined,
      verificationOnly: verify ? true : undefined,
      dependsOn: index === 0 ? [] : [`task-${index}`],
      attempts: 0,
      changedFiles: [],
      commands: [],
      createdAt: at,
      updatedAt: at,
    };
  });
}

const BUILD_SESSION_MAX_FILES = 12;
const BUILD_SESSION_MAX_BYTES = 40_000;

export function isSmallProjectForBuildSession(analysis: AnalysisResult): boolean {
  const files = analysis.files.filter(
    (file) => !file.path.startsWith(".cie/") && !file.path.startsWith(".git/"),
  );
  if (files.length === 0 || files.length > BUILD_SESSION_MAX_FILES) return false;
  return files.reduce((sum, file) => sum + (file.bytes || 0), 0) <= BUILD_SESSION_MAX_BYTES;
}

/**
 * Phase 1 orchestration: a small/medium project is one agent session, not one
 * session per behavior. The plan tasks become a checklist inside a single
 * build task; plan coverage and acceptance stay intact.
 */
export function collapseToBuildSession(
  queue: ProjectTaskQueue,
  analysis: AnalysisResult,
  goal: string,
  intent?: IntentAnalysis,
  verification?: string,
): ProjectTaskQueue {
  if (queue.tasks.length <= 1) return queue;
  if (!queue.tasks.every((task) => task.status === "pending")) return queue;
  if (queue.tasks.some((task) => (task.changedFiles?.length ?? 0) > 0)) return queue;
  if (!isSmallProjectForBuildSession(analysis)) return queue;

  const tasks = queue.tasks;
  const at = nowIso();
  const firstLine =
    goal
      .split(/\r?\n/)
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find(Boolean) ?? "Build the requested project";
  const checklist = tasks.map((task) => ({
    id: task.id,
    title: task.title,
    acceptance: task.acceptance ?? "The behavior works and is verified.",
  }));
  const surface =
    tasks.map((task) => task.surface).find((value) => value && value !== "other") ??
    (intent && isUiIntent(goal, intent) ? "ui" : "other");
  const detail = [
    "Execute this project as ONE build session. Implement every checklist item; do not stop after a subset.",
    "Checklist:",
    ...tasks.map((task, index) =>
      [
        `${index + 1}. ${task.title}`,
        task.detail.slice(0, 700),
        task.acceptance ? `Acceptance: ${task.acceptance.slice(0, 400)}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    "After implementing, run browser_check on the real entry page. Prefer one end-to-end check, but every checklist item must have its own concrete assertion: the spawned object's resolved cell is walkable/reachable and collectible, the removed selector is absent (querySelector null or expectCount 0, not hidden), and repeated starts yield a different level. Do not run redundant checks.",
    verification ? `Verification command: ${verification}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const task: ProjectTask = {
    id: "task-1",
    title: `Build: ${firstLine}`.slice(0, 140),
    detail,
    acceptance: [
      "Every checklist item is implemented.",
      "One end-to-end browser check on the real entry page passes.",
      ...tasks
        .map((item) => item.acceptance)
        .filter((value): value is string => Boolean(value))
        .slice(0, 6),
    ]
      .join(" ")
      .slice(0, 1_200),
    status: "pending",
    effort: "standard",
    role: "main",
    action: "update",
    surface,
    readOnly: false,
    verificationOnly: false,
    microEdit: false,
    buildSession: true,
    checklist,
    stepBudget: 20,
    dependsOn: [],
    attempts: 0,
    changedFiles: [],
    commands: [],
    createdAt: at,
    updatedAt: at,
  };
  return {
    ...queue,
    tasks: [task],
    status: "idle",
    updatedAt: at,
    planMeta: queue.planMeta,
  };
}

const CODE_CONTEXT_MAX_CHARS = 8_000;
const CODE_CONTEXT_FILE_MAX = 4_000;

/**
 * Phase 2 context: pass the relevant real code instead of making the agent
 * re-read files every turn. Small builds get template/module files; patches
 * get their target files.
 */
async function buildTaskCodeContext(
  analysis: AnalysisResult,
  task: ProjectTask,
  activeFile?: string,
): Promise<string> {
  const paths = new Set<string>();
  const add = (value: string | undefined) => {
    if (!value) return;
    const clean = value.replace(/^[\s`"'(]+|[`"'(),.;:]+$/g, "").replace(/^\.\//, "");
    if (!clean || clean.startsWith(".cie/") || clean.startsWith(".git/")) return;
    paths.add(clean);
  };
  if (task.buildSession === true) {
    analysis.files
      .filter((file) => !file.path.startsWith(".cie/") && !file.path.startsWith(".git/"))
      .slice(0, 12)
      .forEach((file) => add(file.path));
  } else {
    taskTargetFiles(analysis, task)
      .slice(0, 4)
      .forEach((file) => add(file));
    add(activeFile);
  }
  if (paths.size === 0) return "";
  const blocks: string[] = [];
  let used = 0;
  for (const filePath of paths) {
    // eslint-disable-next-line no-await-in-loop
    const file = await readSourceFile(analysis.rootPath, filePath).catch(() => null);
    if (!file) continue;
    const truncated =
      file.content.length > CODE_CONTEXT_FILE_MAX
        ? `${file.content.slice(0, CODE_CONTEXT_FILE_MAX)}\n… [file excerpt truncated]`
        : file.content;
    const block = `--- ${filePath} (${file.content.length} chars) ---\n${truncated}`;
    if (used + block.length > CODE_CONTEXT_MAX_CHARS) break;
    blocks.push(block);
    used += block.length;
  }
  if (blocks.length === 0) return "";
  return [
    "Current code (authoritative; use it instead of re-reading these files. Read only an exact line after you edit it.):",
    ...blocks,
  ].join("\n\n");
}

function isUiIntent(goal: string, intent: IntentAnalysis): boolean {
  if (intent.behaviors?.some((behavior) => behavior.surface === "ui" || behavior.surface === "game")) {
    return true;
  }
  const areas = intent.areas.join(" ").toLowerCase();
  return /\.(?:html?|css|jsx?|tsx?|vue|svelte)\b/.test(areas);
}

function conventionalAcceptance(
  goal: string,
  intent: IntentAnalysis,
  verification?: string,
): string {
  const parts: string[] = [];
  for (const behavior of intent.behaviors ?? []) {
    if (behavior.acceptance) parts.push(`${behavior.target}: ${behavior.acceptance}`);
  }
  if (isUiIntent(goal, intent)) {
    parts.push(
      "UI quality is verified on the real page: icon/label contrast, one-row alignment, no horizontal overflow, with screenshot or browser evidence.",
    );
  }
  if (intent.kind === "edit" || intent.kind === "scaffold") {
    parts.push("Existing behavior and scenarios still pass.");
  }
  if (verification) parts.push(`Verification (${verification}) passes.`);
  if (intent.kind === "question" || intent.kind === "analyze") {
    parts.push("The answer cites file:line evidence and no project files are changed.");
  }
  if (intent.kind === "run") {
    parts.push("The command exits successfully and its output is reported.");
  }
  if (intent.needsExhaustiveEvidence) {
    parts.push("Every requested item is listed and the total is verified.");
  }
  return parts.join(" ");
}

function conventionalGuidance(
  goal: string,
  intent: IntentAnalysis,
  verification?: string,
): string {
  const ui = isUiIntent(goal, intent);
  const lines: string[] = [];
  if (ui) {
    lines.push(
      "UI quality: give icons explicit size/color with contrast; keep icon and value on one row; distribute HUD items; check horizontal overflow; verify on the real page with a browser check or screenshot.",
    );
  }
  if (intent.kind === "edit" || intent.kind === "scaffold") {
    lines.push(
      "Preserve existing behavior and scenarios; edit the existing structure instead of rewriting unrelated files.",
    );
  }
  if (verification) lines.push(`Verification: ${verification} must pass.`);
  if (intent.kind === "question" || intent.kind === "analyze") {
    lines.push("Answer with file:line evidence; change no project files.");
  }
  if (intent.kind === "run") {
    lines.push("Report the real command output and exit status.");
  }
  if (intent.needsExhaustiveEvidence) {
    lines.push("Collect every requested item and verify the total count before finishing.");
  }
  return lines.join("\n");
}

export function intentTask(
  goal: string,
  intent: IntentAnalysis,
  verification?: string,
  workspaceMode: AiWorkspaceMode = "build",
): ProjectTask {
  const at = nowIso();
  const readOnly =
    workspaceMode !== "build" ||
    intent.kind === "question" ||
    intent.kind === "analyze" ||
    intent.kind === "run";
  const baseEffort: ProjectTaskEffort =
    workspaceMode === "ask"
      ? "simple"
      : workspaceMode !== "build"
        ? "standard"
        : readOnly
          ? "simple"
          : intent.scope === "trivial" || intent.scope === "small"
            ? "simple"
            : intent.scope === "medium"
              ? "standard"
              : "hard";
  // A long spec with several requirements is a real build even when the
  // intent model calls it "small"; a 100k soft budget would stop it after the
  // first write. Keep a standard floor for multi-feature build tasks.
  const multiFeatureGoal =
    (intent.behaviors?.length ?? 0) > 1 ||
    goal.trim().length >= 800 ||
    intent.scope === "large";
  const plannedEffort: ProjectTaskEffort =
    workspaceMode === "build" && !readOnly && multiFeatureGoal && baseEffort === "simple"
      ? "standard"
      : baseEffort;
  // A short single-behavior edit on an existing project is a patch, not a
  // project build: no planner/review, a small turn budget and the target code
  // in context.
  const patch =
    workspaceMode === "build" &&
    !readOnly &&
    !isContinuationInstruction(goal) &&
    !intentNeedsConfirmation(intent, goal).needed &&
    intent.kind === "edit" &&
    (intent.scope === "trivial" || intent.scope === "small") &&
    (intent.behaviors?.length ?? 0) <= 1 &&
    goal.trim().length < 400;
  const effort: ProjectTaskEffort = patch ? "simple" : plannedEffort;
  const assumptions = intent.assumptions.filter(
    (item) => !/Intent analyst could not parse|Intent analysis could not run/i.test(item),
  );
  const behavior = intent.behaviors?.[0];
  const action =
    behavior?.action ??
    (intent.kind === "question" || intent.kind === "analyze"
      ? "other"
      : intent.kind === "run"
        ? "run"
        : "update");
  const surface = behavior?.surface ?? (isUiIntent(goal, intent) ? "ui" : "other");
  const readOnlyTask =
    workspaceMode !== "build" || intent.kind === "question" || intent.kind === "analyze";
  return {
    id: "task-1",
    title: goal.length > 90 ? `${goal.slice(0, 87)}…` : goal,
    detail: [
      intent.normalizedRequest || intent.understanding,
      intent.behaviors?.length
        ? `Behaviors:\n${intent.behaviors
            .map(
              (behavior) =>
                `- ${behavior.action} ${behavior.target}${behavior.details ? `: ${behavior.details}` : ""}${
                  behavior.acceptance ? ` (acceptance: ${behavior.acceptance})` : ""
                }`,
            )
            .join("\n")}`
        : "",
      intent.constraints?.length ? `Constraints: ${intent.constraints.join("; ")}` : "",
      intent.approach ? `Approach: ${intent.approach}` : "",
      intent.areas.length > 0 ? `Likely areas: ${intent.areas.join(", ")}` : "",
      assumptions.length > 0 ? `Assumptions: ${assumptions.join("; ")}` : intent.understanding ? "" : goal,
      conventionalGuidance(goal, intent, verification)
        ? `Conventional checks:\n${conventionalGuidance(goal, intent, verification)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    acceptance:
      workspaceMode === "plan"
        ? "A concrete plan with ordered tasks, acceptance criteria and verification is saved."
        : workspaceMode === "research"
          ? "The answer cites the evidence and states open questions."
          : readOnly
            ? "The question is answered with code-referenced evidence; no project files are changed."
            : `The requested change is implemented and verified.${
                intent.behaviors?.length
                  ? ` ${intent.behaviors
                      .map((behavior) => behavior.acceptance || `${behavior.target} is verified.`)
                      .join(" ")}`
                  : ""
              }${
                intent.constraints?.length ? ` Constraints: ${intent.constraints.join("; ")}` : ""
              } ${conventionalAcceptance(goal, intent, verification)}`.trim(),
    status: "pending",
    effort,
    role:
      workspaceMode === "ask" || workspaceMode !== "build" || effort !== "simple"
        ? "main"
        : "fast",
    action,
    surface,
    readOnly: readOnlyTask,
    verificationOnly: !readOnlyTask && action === "verify",
    microEdit:
      !readOnlyTask &&
      action !== "run" &&
      intent.scope === "trivial" &&
      (intent.behaviors?.length ?? 0) <= 1 &&
      intent.areas.length === 1,
    patch: patch || undefined,
    stepBudget: patch ? 8 : undefined,
    dependsOn: [],
    attempts: 0,
    changedFiles: [],
    commands: [],
    tokenBudget:
      effort === "simple" ? 80_000 : effort === "hard" ? 320_000 : 160_000,
    costBudgetUsd: effort === "simple" ? 0.05 : effort === "hard" ? 0.25 : 0.12,
    verification: verification && !readOnly ? { command: verification } : undefined,
    createdAt: at,
    updatedAt: at,
  };
}

export async function runProjectLoop(
  projectId: string,
  goal: string,
  options: ProjectTaskLoopOptions = {},
  emit: (event: AiAgentEvent) => void = () => {},
  signal?: AbortSignal,
): Promise<ProjectTaskLoopResult> {
  if (!goal.trim()) throw new Error("A task goal is required.");
  const analysis = await loadAnalysis(projectId);
  const settings = await getPublicSettings().catch(() => null);
  const autoSwitchModels = settings?.autoSwitchModels !== false;
  let main = await resolveAgentRole("main", {
    provider: options.provider,
    model: options.model,
  });
  const health = await modelHealthByProviderModel();
  if (health.get(healthKey(main.id, main.model))?.unavailable === true) {
    if (!autoSwitchModels) {
      throw new Error(
        `The selected model ${main.id}/${main.model} is unavailable. Choose another model or enable "Automatic model switching" in Settings → General.`,
      );
    }
    const alternate = await pickAlternateAgentModel({
      provider: main.id,
      model: main.model,
    }).catch(() => null);
    if (alternate) {
      const switched = await resolveProvider(alternate.provider, alternate.model).catch(() => null);
      if (switched) {
        const from = { provider: main.id, model: main.model };
        emit({
          type: "log",
          entry: {
            id: `log-${Date.now()}-model-switch`,
            at: nowIso(),
            level: "warn",
            label: "Model unavailable",
            detail: `${from.provider}/${from.model} → ${switched.id}/${switched.model}`,
          },
        });
        emit({
          type: "model",
          from,
          to: { provider: switched.id, model: switched.model },
          reason: "The selected model is unavailable (end of life or removed).",
        });
        await recordModelFallback({
          fromProvider: from.provider,
          fromModel: from.model,
          toProvider: switched.id,
          toModel: switched.model,
          reason: "The selected model is unavailable (end of life or removed).",
        }).catch(() => undefined);
        main = switched;
        options.provider = alternate.provider;
        options.model = alternate.model;
      }
    }
  }
  const verification = preferredVerificationCommand(analysis.tooling);
  const requestConstraints = [
    ...new Set([
      ...(options.intent?.constraints ?? []),
      ...extractProjectConstraints(goal),
    ]),
  ];
  if (requestConstraints.length > 0) {
    await addProjectConstraints(analysis, requestConstraints, "request", goal).catch(() => undefined);
  }
  const projectBrain = await ensureProjectBrain(analysis).catch(() => null);
  const projectBriefText = projectBrain ? compactProjectBrainBrief(projectBrain) : "";
  if (projectBriefText) {
    emit({
      type: "log",
      entry: {
        id: `log-${Date.now()}-project-brain`,
        at: nowIso(),
        level: "info",
        label: "Project brain loaded",
        detail: `${projectBriefText.length} chars · ${projectBrain?.features.length ?? 0} features · ${projectBrain?.recentChanges.length ?? 0} recent changes`,
      },
    });
  }
  const runPreviewRequest = requestIsRunPreview(goal);
  let runPreviewUrl: string | null = null;
  if (runPreviewRequest) {
    const started = await ensureDevServerForRequest(projectId, analysis.rootPath).catch(() => null);
    if (started) {
      runPreviewUrl = started.url;
      emit({
        type: "log",
        entry: {
          id: `log-${Date.now()}-dev-server`,
          at: nowIso(),
          level: "success",
          label: started.url ? "Dev server ready" : "Dev server started",
          detail: `${started.job.command}${started.url ? ` · ${started.url}` : ""}`,
        },
      });
      await appendTaskContext(
        analysis.rootPath,
        "Run preview",
        `${started.job.command}\nURL: ${started.url ?? "waiting for the server to print a URL"}\nThe preview panel picks this URL up automatically; do not start a second server.`,
      ).catch(() => undefined);
    } else {
      emit({
        type: "log",
        entry: {
          id: `log-${Date.now()}-no-dev-server`,
          at: nowIso(),
          level: "warn",
          label: "No runnable dev server detected",
          detail: "The agent will inspect the entry points and report the exact command that is missing.",
        },
      });
    }
  }
  const workspaceMode: AiWorkspaceMode = options.workspaceMode ?? "build";
  let queue = await loadQueue(analysis.rootPath, projectId);
  const sameGoal = queue?.goal.trim() === goal.trim();
  if (queue && sameGoal && options.retryFailed === true) {
    const audit = await auditCompletedWork(analysis, queue).catch(() => null);
    if (audit?.completed) {
      queue = audit.queue;
      await saveQueue(analysis.rootPath, queue);
      emit({
        type: "log",
        entry: {
          id: `log-${Date.now()}-continuation-audit`,
          at: nowIso(),
          level: "success",
          label: "Continuation audit passed",
          detail: `${audit.task?.id ?? "task"} · ${audit.reason} No model replay was needed.`,
        },
      });
      emit({ type: "task", queue });
      const result = aggregateResult(goal.trim(), queue, [], main.id, main.model);
      emit({ type: "done", result });
      return {
        queue,
        summary: result.summary,
        completed: queue.tasks.filter((task) => task.status === "done").length,
        failed: queue.tasks.filter((task) => task.status === "failed" || task.status === "blocked").length,
        stopped: false,
        stages: queue.stageUsage,
      };
    }
  }
  if (queue && sameGoal) {
    const stalled = queue.tasks.filter(
      (task) =>
        (task.status === "pending" || task.status === "in_progress") &&
        (task.tokenUsage?.totalTokens ?? 0) >= 300_000 &&
        (task.changedFiles?.length ?? 0) === 0,
    );
    if (stalled.length > 0 && stalled.length === queue.tasks.length) {
      const split = splitLargeGoal(queue.goal, verification);
      if (split && split.length > 1) {
        queue = { ...queue, tasks: split, status: "idle", updatedAt: nowIso() };
        queue = await saveQueue(analysis.rootPath, queue);
        await appendTaskContext(
          analysis.rootPath,
          "Stalled task auto-split",
          `A task spent 300k+ tokens without changing a file. It was replaced by ${split.length} smaller tasks so the next run has a single behavior and edit target.`,
        );
        emit({ type: "task", queue });
      } else {
        queue = {
          ...queue,
          tasks: queue.tasks.map((task) =>
            stalled.includes(task)
              ? {
                  ...task,
                  status: "blocked",
                  notes:
                    "Blocked: this task spent 300k+ tokens without changing a file. Split it into smaller tasks or narrow the scope before retrying.",
                  updatedAt: nowIso(),
                }
              : task,
          ),
          updatedAt: nowIso(),
        };
        queue = await saveQueue(analysis.rootPath, queue);
        emit({ type: "task", queue });
      }
    }
  }
  const intent = options.intent;
  const multiPartGoal =
    (intent?.kind === "edit" || intent?.kind === "scaffold" || intent?.kind === "run") &&
    (intent?.behaviors?.length ?? 0) > 1;
  // A long, low-confidence "single" goal is usually a full spec that the
  // intent model collapsed into one behavior. Plan it properly instead of
  // spending the whole budget on one monolithic task.
  const lowConfidenceLargeGoal =
    goal.trim().length >= 800 && (intent?.confidence ?? 1) < 0.8;
  const needsIntentConfirmation = intent
    ? intentNeedsConfirmation(intent, goal).needed
    : false;
  const patchGoal =
    workspaceMode === "build" &&
    !isContinuationInstruction(goal) &&
    !needsIntentConfirmation &&
    intent?.kind === "edit" &&
    (intent?.scope === "trivial" || intent?.scope === "small") &&
    (intent?.behaviors?.length ?? 0) <= 1 &&
    goal.trim().length < 400;
  const intentSingle =
    workspaceMode !== "build" ||
    patchGoal ||
    (intent?.mode === "single" &&
      !multiPartGoal &&
      !lowConfidenceLargeGoal &&
      !needsIntentConfirmation);
  const diagnosisWanted =
    workspaceMode === "build" &&
    !patchGoal &&
    intent?.kind !== "question" &&
    intent?.kind !== "analyze" &&
    intent?.kind !== "run" &&
    goal.trim().length > 0;
  let diagnosis: ProjectDiagnosis | null =
    queue?.diagnosis &&
    queue.diagnosis.goal.trim() === goal.trim() &&
    options.replan !== true
      ? queue.diagnosis
      : null;
  let diagnosisResult: DiagnoseResult | null = null;
  if (diagnosisWanted && !diagnosis) {
    emit({
      type: "log",
      entry: {
        id: `log-${Date.now()}-diagnosis-start`,
        at: nowIso(),
        level: "info",
        label: "Diagnosis started",
        detail: "Read-only root-cause and design analysis before planning.",
      },
    });
    diagnosisResult = await diagnoseProject(analysis, goal, {
      provider: options.provider,
      model: options.model,
      constraints: options.intent?.constraints,
      language: options.language,
      signal,
    }).catch(() => null);
    if (diagnosisResult) {
      const ready = diagnosisResult.diagnosis;
      diagnosis = ready;
      emit({
        type: "log",
        entry: {
          id: `log-${Date.now()}-diagnosis-ready`,
          at: nowIso(),
          level: diagnosisResult.usedFallback ? "warn" : "success",
          label: diagnosisResult.usedFallback ? "Diagnosis fallback" : "Diagnosis ready",
          detail: `${ready.chosenDesign} · ${Math.round(ready.confidence * 100)}% · ${
            diagnosisResult.tokenUsage?.totalTokens?.toLocaleString() ?? "0"
          } tokens${diagnosisResult.usedFallback ? " · structured diagnosis unavailable" : ""} · ${ready.rootCause.slice(0, 160)}`,
        },
      });
    }
  } else if (diagnosis) {
    emit({
      type: "log",
      entry: {
        id: `log-${Date.now()}-diagnosis-reuse`,
        at: nowIso(),
        level: "info",
        label: "Diagnosis reused",
        detail: `${diagnosis.chosenDesign} · ${Math.round(diagnosis.confidence * 100)}% (same goal)`,
      },
    });
  }
  const diagnosisBrief = diagnosis ? compactDiagnosisBrief(diagnosis) : "";
  const diagnosisScenario: TaskScenarioMatch | null =
    diagnosis && isUsableDiagnosisScenario(diagnosis)
      ? {
          name: diagnosisScenarioName(diagnosis.goal),
          path: diagnosis.verification.path!,
          steps: diagnosis.verification.steps!,
          timeoutMs: 30_000,
          score: 0,
        }
      : null;
  let plannedNow = false;
  if (
    !queue ||
    options.replan ||
    queue.tasks.length === 0 ||
    !sameGoal ||
    queue.status === "completed" ||
    (intentSingle && queue.status === "failed" && !options.retryFailed)
  ) {
    if (intent && intentSingle) {
      plannedNow = true;
      queue = await createQueue(analysis.rootPath, projectId, goal.trim(), [
        intentTask(goal, intent, verification, workspaceMode),
      ]);
      queue.intent = intent;
      queue.planMeta = createPlanMeta(goal);
      await appendTaskContext(
        analysis.rootPath,
        `Plan · ${new Date().toLocaleString()}`,
        [
          `Goal: ${goal.trim()}`,
          `Intent: ${intent.understanding}`,
          `Scope: ${intent.scope} · mode: single`,
          intent.areas.length > 0 ? `Areas: ${intent.areas.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    } else {
      plannedNow = true;
      queue = await planProjectTasks(projectId, goal, {
        language: options.language,
        signal,
        intent,
        history: options.history,
        diagnosis: diagnosis ?? undefined,
      });
    }
  }

  if (diagnosis && queue) {
    const stageUsage = queue.stageUsage ?? {};
    queue = {
      ...queue,
      diagnosis,
      diagnosisPath: ".cie/agent/diagnosis.md",
      stageUsage: {
        ...stageUsage,
        diagnosis: diagnosisResult?.tokenUsage
          ? { ...diagnosisResult.tokenUsage, costUsd: diagnosisResult.costUsd }
          : stageUsage.diagnosis,
        costUsd: (stageUsage.costUsd ?? 0) + (diagnosisResult?.costUsd ?? 0),
      },
      updatedAt: nowIso(),
    };
    queue = await saveQueue(analysis.rootPath, queue);
    emit({ type: "task", queue });
  }

  if (
    workspaceMode === "build" &&
    shouldReviewPlan(queue, goal, {
      replan: options.replan === true,
      workspaceMode,
    })
  ) {
    const review = await reviewProjectPlan(goal, queue, {
      projectId,
      signal,
      intent,
      history: options.history,
      provider: options.provider,
      model: options.model,
    }).catch(() => null);
    if (review) {
      const priorStages = queue.stageUsage ?? {};
      queue = {
        ...queue,
        stageUsage: {
          ...priorStages,
          planReview: addUsage(priorStages.planReview ?? emptyUsage(), review.tokenUsage),
          costUsd: (priorStages.costUsd ?? 0) + (review.costUsd ?? 0),
        },
      };
      emit({
        type: "log",
        entry: {
          id: `log-${Date.now()}-plan-review`,
          at: nowIso(),
          level: review.verdict === "ok" ? "info" : "warn",
          label: "Plan reviewed",
          detail: `${review.verdict}${review.missing.length ? ` · missing: ${review.missing.join("; ").slice(0, 240)}` : ""}${
            review.assumptions.length ? ` · assumptions: ${review.assumptions.join("; ").slice(0, 240)}` : ""
          }`,
        },
      });
      const actionableQuestions = review.questions.filter(
        (question) => !isLowImpactPlanQuestion(question.question),
      );
      for (const skipped of review.questions.filter((question) =>
        isLowImpactPlanQuestion(question.question),
      )) {
        emit({
          type: "log",
          entry: {
            id: `log-${Date.now()}-plan-question-skip`,
            at: nowIso(),
            level: "info",
            label: "Plan question auto-resolved",
            detail: `${skipped.question} → using the literal reading and the review assumption.`,
          },
        });
      }
      if (actionableQuestions.length > 0 && options.clarified !== true) {
        queue = {
          ...queue,
          status: "idle",
          planMeta: createPlanMeta(goal, review, (queue.planMeta?.reviewCount ?? 0) + 1),
        };
        queue = await saveQueue(analysis.rootPath, queue);
        emit({ type: "task", queue });
        const question = actionableQuestions[0];
        emit({
          type: "clarify",
          request: {
            question: question.question,
            options: question.options.map((option, index) => ({
              id: `opt-${index + 1}`,
              label: option.label,
              instructionSuffix: option.suffix,
            })),
            original: goal,
          },
        });
        return {
          queue,
          summary: "Plan review needs one product decision before execution.",
          completed: queue.tasks.filter((task) => task.status === "done").length,
          failed: 0,
          stopped: true,
          stages: queue.stageUsage,
        };
      }
      if (review.verdict === "replan") {
        plannedNow = true;
        queue = applyPlanReview(queue, goal, review);
      } else {
        queue = {
          ...queue,
          planMeta: createPlanMeta(goal, review, (queue.planMeta?.reviewCount ?? 0) + 1),
        };
      }
      queue = await saveQueue(analysis.rootPath, queue);
      emit({ type: "task", queue });
    }
  }

  // Phase 1 orchestration: one build session for a small/medium project.
  // The plan tasks become a checklist; they are not separate agent sessions.
  if (
    plannedNow &&
    workspaceMode === "build" &&
    queue &&
    queue.tasks.length > 1 &&
    queue.tasks.every((task) => task.status === "pending") &&
    !queue.tasks.some((task) => (task.changedFiles?.length ?? 0) > 0) &&
    isSmallProjectForBuildSession(analysis)
  ) {
    const before = queue.tasks.length;
    const collapsed = collapseToBuildSession(queue, analysis, goal, intent, verification);
    if (collapsed.tasks.length === 1 && collapsed.tasks[0]?.buildSession) {
      queue = await saveQueue(analysis.rootPath, collapsed);
      emit({
        type: "log",
        entry: {
          id: `log-${Date.now()}-build-session`,
          at: nowIso(),
          level: "info",
          label: "Build session",
          detail: `${before} checklist items → 1 agent session · 20 turns · one end-to-end verify`,
        },
      });
      await appendTaskContext(
        analysis.rootPath,
        "Build session",
        `${before} plan tasks were merged into one build session to avoid one agent session per behavior. Checklist:
${collapsed.tasks[0].checklist
          ?.map((item) => `- ${item.title}`)
          .join("\n")}`,
      );
      emit({ type: "task", queue });
    }
  }

  const readOnlyRequest = workspaceMode === "ask" || workspaceMode === "research";
  const questionGoal =
    intent?.kind === "question" ||
    intent?.kind === "analyze" ||
    /\?|\bnasıl\b|\bneden\b|\bne zaman\b|\bnerede\b/i.test(goal);
  if (readOnlyRequest && !questionGoal && queue.tasks.some((task) => taskLooksLikeWrite(task))) {
    throw new Error(
      "This request needs project file edits, but the current mode is read-only. Switch to Build and run it again. Agent notes under .cie/agent are not project changes. [READ_ONLY_WRITE_BLOCKED]",
    );
  }

  if (options.retryFailed) {
    const stalled = queue.tasks.filter(
      (task) =>
        task.status === "blocked" &&
        /no file change|kept reading|token safety|endless loop/i.test(task.notes ?? ""),
    );
    if (stalled.length > 0 && stalled.length === queue.tasks.length) {
      const split = splitLargeGoal(queue.goal, verification);
      if (split && split.length > 1) {
        queue = {
          ...queue,
          tasks: split,
          status: "idle",
          updatedAt: nowIso(),
        };
        queue = await saveQueue(analysis.rootPath, queue);
        await appendTaskContext(
          analysis.rootPath,
          "Auto-split on retry",
          `The stalled goal was split into ${split.length} smaller tasks so each run has one behavior and one edit target.`,
        );
        emit({ type: "task", queue });
      }
    }
    const exhaustedRetries = queue.tasks.filter(
      (task) =>
        (task.status === "failed" || task.status === "blocked") &&
        retryBudgetExhausted(task),
    );
    if (exhaustedRetries.length > 0) {
      emit({
        type: "log",
        entry: {
          id: `log-${Date.now()}-retry-budget`,
          at: nowIso(),
          level: "warn",
          label: "Retry refused · lifetime budget exhausted",
          detail: exhaustedRetries
            .map(
              (task) =>
                `${task.id}: ${(task.lifetimeTokens ?? 0).toLocaleString()}/${hardTaskTokenCap(task).toLocaleString()} tokens`,
            )
            .join(" · "),
        },
      });
      queue = {
        ...queue,
        status: "failed",
        updatedAt: nowIso(),
        tasks: queue.tasks.map((task) =>
          exhaustedRetries.some((item) => item.id === task.id)
            ? {
                ...task,
                status: "blocked",
                notes: [
                  task.notes,
                  `Retry refused: this task already spent ${(task.lifetimeTokens ?? 0).toLocaleString()} of its ${hardTaskTokenCap(task).toLocaleString()} lifetime token cap. Start a narrower task instead of replaying the same goal.`,
                ]
                  .filter(Boolean)
                  .join("\n"),
                updatedAt: nowIso(),
              }
            : task,
        ),
      };
      queue = await saveQueue(analysis.rootPath, queue);
      emit({ type: "task", queue });
      if (!queue.tasks.some((task) => task.status === "pending" || task.status === "in_progress")) {
        const result = aggregateResult(goal.trim(), queue, [], main.id, main.model);
        emit({ type: "done", result });
        return {
          queue,
          summary: result.summary,
          completed: queue.tasks.filter((task) => task.status === "done").length,
          failed: queue.tasks.filter(
            (task) => task.status === "failed" || task.status === "blocked",
          ).length,
          stopped: true,
          stages: queue.stageUsage,
        };
      }
    }
    const recoveries = new Map<string, RetryRecovery>();
    for (const task of queue.tasks) {
      if (task.status !== "failed" && task.status !== "blocked") continue;
      if (retryBudgetExhausted(task)) continue;
      // eslint-disable-next-line no-await-in-loop
      const recovery = await prepareTaskRetry(analysis, task);
      recoveries.set(task.id, recovery);
      if (recovery.note) {
        emit({
          type: "log",
          entry: {
            id: `log-${Date.now()}-recovery-${task.id}`,
            at: nowIso(),
            level: "warn",
            label: "Retry recovery",
            detail: recovery.note.slice(0, 300),
          },
        });
        // eslint-disable-next-line no-await-in-loop
        await appendTaskContext(analysis.rootPath, `Retry recovery · ${task.id}`, recovery.note);
        await appendLesson(analysis.rootPath, `Retry recovery ${task.id}: ${recovery.note}`);
      }
    }
    const doneForResume = queue.tasks.filter((item) => item.status === "done");
    queue = {
      ...queue,
      tasks: queue.tasks.map((task) => {
        if (task.status !== "failed" && task.status !== "blocked") return task;
        if (retryBudgetExhausted(task)) return task;
        const recovery = recoveries.get(task.id);
        // A manual "Continue" must resume, not restart. Read-loop tasks are
        // narrowed again; completed tasks and changed files are preserved.
        const narrow = isReadLoopFailure(
          `${task.notes ?? ""}\n${task.resultSummary ?? ""}`,
        )
          ? narrowTaskForEditFirst(task, "read loop from an earlier run")
          : null;
        const contract = buildResumeContract(doneForResume, task);
        const envNote = isEnvironmentFailure(
          undefined,
          `${task.notes ?? ""}\n${task.resultSummary ?? ""}`,
        )
          ? environmentRepairNote(`${task.notes ?? ""} ${task.resultSummary ?? ""}`)
          : "";
        const notes = [contract, envNote, recovery?.note, narrow?.notes, task.notes]
          .filter(Boolean)
          .join("\n\n");
        return {
          ...task,
          ...(narrow
            ? {
                detail: narrow.detail,
                acceptance: narrow.acceptance,
                effort: "simple",
                role: "main",
                repairAttempts: narrow.repairAttempts,
              }
            : {}),
          status: "pending",
          attempts: 0,
          // A manual retry starts a fresh recovery budget as well.
          repairAttempts: 0,
          modelOverride: undefined,
          completedAt: undefined,
          // A manual retry is a new budget window. Carrying the previous
          // attempt's usage makes a focused retry stop before its first step.
          tokenUsage: undefined,
          resultSummary: undefined,
          verification: undefined,
          notes: notes || undefined,
          changedFiles: (task.changedFiles ?? []).filter(
            (file) => !recovery?.quarantined.includes(file),
          ),
          updatedAt: nowIso(),
        };
      }),
    };
  }
  const priorStages = queue.stageUsage ?? {};
  queue = {
    ...queue,
    stageUsage: {
      ...priorStages,
      intent: options.intentUsage ?? priorStages.intent,
      costUsd: (priorStages.costUsd ?? 0) + (options.intentCostUsd ?? 0),
    },
  };
  queue = await saveQueue(analysis.rootPath, { ...queue, status: "running" });
  emit({ type: "start", provider: main.id, model: main.model });
  emit({ type: "task", queue });

  const startedAt = Date.now();
  const maxTasks = Math.max(1, Math.min(20, options.maxTasks ?? DEFAULT_MAX_TASKS));
  const maxMs = Math.max(1, options.maxMinutes ?? DEFAULT_MAX_MINUTES) * 60_000;
  const executed: AiAgentResult[] = [];
  const seenTasks = new Set<string>();
  const avoidModels = new Set<string>();
  let executedCount = 0;
  let autoRepairs = 0;
  const maxParallel = Math.max(
    1,
    Math.min(3, options.parallelTasks ?? (workspaceMode === "build" ? 2 : 1)),
  );
  type ResolvedAgentConfig = Awaited<ReturnType<typeof resolveProvider>>;
  interface PreparedTaskRun {
    task: ProjectTask;
    current: ProjectTask;
    taskConfig: ResolvedAgentConfig;
    tokenBudget: number;
    costBudgetUsd: number;
    forceWrite: boolean;
    inspection: boolean;
    microEdit: boolean;
    scenario: TaskScenarioMatch | null;
    runKey: string;
    targets: string[];
    promise: Promise<AiAgentResult | null>;
  }

  async function prepareTaskRun(
    task: ProjectTask,
    targets: string[],
    parallel: boolean,
  ): Promise<PreparedTaskRun> {
    if (!queue) throw new Error("No task queue is available.");
    const runKey = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const budgetEffort = taskBudgetEffort(task);
    const forceWrite = workspaceMode === "build" && taskLooksLikeWrite(task);
    const scenarioMatch = await findTaskScenario(analysis.rootPath, task).catch(() => null);
    // The title alone is not enough: a partial task can mention the scenario
    // name without being responsible for the whole scenario. Require it only
    // when the task detail or acceptance explicitly asks for it.
    const scenarioText = `${task.detail}\n${task.acceptance ?? ""}`.toLowerCase();
    const isFinalTask =
      task.buildSession === true ||
      queue.tasks.length === 1 ||
      queue.tasks[queue.tasks.length - 1]?.id === task.id;
    const requiredScenario =
      (isFinalTask ? diagnosisScenario : null) ??
      (scenarioMatch && scenarioText.includes(scenarioMatch.name.toLowerCase())
        ? scenarioMatch
        : null);
    const microEdit = isMicroEditTask(task);
    const tightReads =
      !microEdit &&
      budgetEffort === "simple" &&
      task.detail.length < 3_500 &&
      taskTargetFiles(analysis, task).length <= 1;
    const defaultBudget = taskBudgetForEffort(budgetEffort);
    const tokenBudget = options.tokenBudget ?? defaultBudget.tokens;
    const costBudgetUsd = options.costBudgetUsd ?? defaultBudget.costUsd;
    queue = markTask(queue, task.id, {
      status: "in_progress",
      startedAt: nowIso(),
      attempts: task.attempts + 1,
      effort: budgetEffort,
      // A write task must not inherit the planner's fast/free worker role.
      role: forceWrite ? "main" : task.role,
      tokenBudget,
      costBudgetUsd,
    });
    const current = queue.tasks.find((item) => item.id === task.id);
    if (!current) throw new Error(`Task ${task.id} disappeared from the queue.`);
    await startAgentRunLive(analysis.rootPath, task.id, current.attempts, runKey).catch(
      () => {},
    );
    emit({ type: "task", queue, task: current });

    let taskConfig: ResolvedAgentConfig = current.modelOverride
      ? await resolveProvider(current.modelOverride.provider, current.modelOverride.model).catch(
          () => main,
        )
      : await resolveAgentRole(current.role === "fast" ? "fast" : "main", {
          provider: options.provider,
          model: options.model,
        }).catch(() => main);
    if (
      !current.modelOverride &&
      budgetEffort === "simple" &&
      current.role !== "fast" &&
      !forceWrite
    ) {
      taskConfig = await resolveAgentRole("fast", {
        provider: options.provider,
        model: options.model,
      }).catch(() => taskConfig);
    }
    if (autoSwitchModels && avoidModels.has(`${taskConfig.id}::${taskConfig.model}`)) {
      const alternate = await pickAlternateAgentModel({
        provider: taskConfig.id,
        model: taskConfig.model,
      }).catch(() => null);
      if (alternate) {
        taskConfig = await resolveProvider(alternate.provider, alternate.model).catch(
          () => taskConfig,
        );
        options.provider = alternate.provider;
        options.model = alternate.model;
      }
    }
    // Flash/fast models are good at locating code but have been unreliable for
    // multi-step writes. When automatic switching is enabled, use the provider's
    // configured non-flash model for write tasks.
    if (autoSwitchModels && forceWrite && /flash|fast/i.test(taskConfig.model)) {
      const providerModel = settings?.providers.find((item) => item.id === taskConfig.id)?.model;
      if (
        providerModel &&
        providerModel !== taskConfig.model &&
        !/flash|fast/i.test(providerModel)
      ) {
        const upgraded = await resolveProvider(
          taskConfig.id as Parameters<typeof resolveProvider>[0],
          providerModel,
        ).catch(() => null);
        if (upgraded) {
          emit({
            type: "log",
            entry: {
              id: `log-${Date.now()}-write-model`,
              at: nowIso(),
              level: "info",
              label: "Write task model",
              detail: `${taskConfig.id}/${taskConfig.model} → ${upgraded.id}/${upgraded.model}`,
            },
          });
          taskConfig = upgraded;
        }
      }
    }

    // Small local models are useful for reading, searching and summarizing, but
    // their JSON edit protocol is not reliable enough to let an auto-assigned
    // fast/reviewer worker rewrite project files. Keep edits on the main model.
    if (taskConfig.id === "local" && forceWrite && current.role !== "main") {
      taskConfig = main;
    }
    queue = markTask(queue, task.id, {
      provider: taskConfig.id,
      model: taskConfig.model,
      notes:
        taskConfig.id === "local" && !forceWrite
          ? "Local worker used for a read-only/simple task."
          : current.notes,
    });
    emit({ type: "task", queue, task: queue.tasks.find((item) => item.id === task.id) });
    const changedSinceGoal = await filesChangedSince(analysis, queue.createdAt);
    const existingCode = featureExistenceHints(analysis, current);
    const inspectionRun = !forceWrite && taskLooksLikeInspection(current);
    const taskBrief = resolveWorkBrief(current.title);
    const extractionTask = taskBrief?.mode === "extract";
    if (changedSinceGoal.length > 0) {
      emit({
        type: "log",
        entry: {
          id: `log-${Date.now()}-changed`,
          at: nowIso(),
          level: "info",
          label: "Interrupted-run files",
          detail: changedSinceGoal.join(", "),
        },
      });
    }
    const parallelNote =
      parallel && forceWrite
        ? targets.length > 0
          ? `Parallel execution: other tasks may run at the same time. Only modify these files: ${targets.join(
              ", ",
            )}. Do not delete or rename unrelated files and do not run project-wide rewrites.`
          : "Parallel execution: other tasks may run at the same time. Do not rewrite unrelated files; this task has no declared file target."
        : "";
    const codeContext = await buildTaskCodeContext(analysis, current, options.activeFile).catch(
      () => "",
    );
    const promise = runAgentTask(
      projectId,
      taskInstruction(
        current,
        queue.tasks.length,
        verification,
        queue.tasks,
        Boolean(continuationFindings(options.history, goal)),
        changedSinceGoal,
        existingCode,
        inspectionRun,
        runPreviewUrl ?? undefined,
        parallelNote,
        queue.goal,
        options.language,
        projectBriefText,
        diagnosisBrief,
      ),
      {
        activeFile: options.activeFile,
        provider: taskConfig.id,
        model: taskConfig.model,
        workspaceMode: inspectionRun ? "ask" : workspaceMode,
        mode: inspectionRun ? "ask" : "auto",
        allowWrite: options.allowWrite === true && !inspectionRun && !extractionTask,
        allowCommands: options.allowCommands === true && !inspectionRun && !extractionTask,
        language: options.language,
        interactive: true,
        forceFast: budgetEffort === "simple",
        forceWrite,
        inspection: inspectionRun,
        maxSteps: microEdit ? 4 : current.stepBudget ?? taskStepBudget(budgetEffort),
        tokenBudget,
        softTokenBudget: current.buildSession
          ? Math.max(
              softTaskTokenBudget(budgetEffort),
              (current.checklist?.length ?? 0) >= 4 ? 300_000 : 240_000,
            )
          : softTaskTokenBudget(budgetEffort),
        costBudgetUsd,
        budgetMode: settings?.taskBudgetMode ?? "off",
        maxOutputTokens: settings?.agentMaxOutputTokens ?? 16_000,
        startingUsage: current.tokenUsage,
        intent: options.intent,
        acceptance: current.acceptance,
        goalText: queue.goal,
        workBriefText: cleanTaskDetail(current.detail) || current.title,
        codeContext,
        history: options.history?.slice(-8),
        liveBrowser: options.liveBrowser === true,
        microEdit,
        tightReads,
        requiredScenario: requiredScenario
          ? {
              name: requiredScenario.name,
              path: requiredScenario.path,
              steps: requiredScenario.steps,
              timeoutMs: requiredScenario.timeoutMs,
            }
          : undefined,
      },
      (event) => {
        if (event.type === "done") return;
        void appendAgentRunEvent(
          analysis.rootPath,
          task.id,
          current.attempts,
          event,
          runKey,
        ).catch(() => {});
        emit(event);
      },
      signal,
    )
      .then((value) => value as AiAgentResult | null)
      .catch((error: unknown) => {
        emit({
          type: "error",
          message: error instanceof Error ? error.message : "Task execution failed.",
        });
        return null;
      });
    return {
      task,
      current: queue.tasks.find((item) => item.id === task.id) ?? current,
      taskConfig,
      tokenBudget,
      costBudgetUsd,
      forceWrite,
      inspection: inspectionRun,
      microEdit,
      scenario: requiredScenario,
      runKey,
      targets,
      promise,
    };
  }

  const activeRuns = new Map<string, PreparedTaskRun>();
  const activeLocks = new Set<string>();
  const doneForScheduling = () =>
    new Set(
      (queue?.tasks ?? [])
        .filter((item) => item.status === "done")
        .map((item) => item.id),
    );

  function nextSchedulableTask(allowNew = true): ProjectTask | undefined {
    const done = doneForScheduling();
    const running = [...activeRuns.values()];
    const activeWrites = running.some(
      (prepared) => prepared.forceWrite && options.allowWrite === true,
    );
    const activeReads = running.some(
      (prepared) =>
        !(prepared.forceWrite && options.allowWrite === true) && prepared.inspection,
    );
    // Tasks that are neither a clear edit nor a clear inspection may still
    // write, so they only run when nothing else is in flight. The same applies
    // to a write task that does not declare which files it will touch.
    const activeExclusive = running.some(
      (prepared) =>
        (prepared.forceWrite &&
          options.allowWrite === true &&
          prepared.targets.length === 0) ||
        (!(prepared.forceWrite && options.allowWrite === true) && !prepared.inspection),
    );
    return queue?.tasks.find((task) => {
      if (task.status !== "pending" || activeRuns.has(task.id)) return false;
      // Repairs of already-started tasks may continue after maxTasks; only new
      // tasks are capped.
      if (!allowNew && !seenTasks.has(task.id)) return false;
      if (!task.dependsOn.every((dependency) => done.has(dependency))) return false;
      if (activeExclusive) return false;
      const wouldWrite =
        workspaceMode === "build" && options.allowWrite === true && taskLooksLikeWrite(task);
      const wouldInspect = !wouldWrite && taskLooksLikeInspection(task);
      if (!wouldWrite && !wouldInspect) return activeRuns.size === 0;
      // Never mix read-only inspection/verification with a running writer:
      // tests would see half-updated files. Writers can run together only when
      // their claimed file targets are disjoint.
      if (!wouldWrite && activeWrites) return false;
      if (wouldWrite && activeReads) return false;
      if (!wouldWrite) return true;
      const targets = taskTargetFiles(analysis, task);
      if (targets.length === 0) return activeRuns.size === 0;
      return !tasksOverlap(targets, activeLocks);
    });
  }

  const pendingRetry = () =>
    Boolean(queue?.tasks.some((task) => task.status === "pending" && seenTasks.has(task.id)));
  while (
    activeRuns.size > 0 ||
    pendingRetry() ||
    (executedCount < maxTasks && Date.now() - startedAt < maxMs)
  ) {
    if (signal?.aborted) {
      queue = await saveQueue(analysis.rootPath, { ...queue, status: "stopped" });
      emit({ type: "task", queue });
      break;
    }

    // Start up to maxParallel independent tasks. Write tasks with known file
    // targets are serialized when their targets overlap; read-only tasks and
    // disjoint files can proceed together.
    if (Date.now() - startedAt < maxMs) {
      while (activeRuns.size < maxParallel && Date.now() - startedAt < maxMs) {
        const allowNew = executedCount < maxTasks;
        if (!allowNew && !pendingRetry()) break;
        let nextTask = nextSchedulableTask(allowNew);
        if (!nextTask) break;
        if (!seenTasks.has(nextTask.id)) {
          seenTasks.add(nextTask.id);
          executedCount += 1;
        }

        // A saved deterministic scenario is stronger than asking the model to
        // choose a verification recipe. For verification-only tasks, run it
        // directly; a pass closes the task without an LLM call.
        const scenarioMatch = await findTaskScenario(analysis.rootPath, nextTask).catch(
          () => null,
        );
        // Only verification-only tasks may be closed by a saved scenario.
        // A write task can share generic words (score/game/feedback) with an
        // existing scenario without covering its new requirements.
        const scenarioEligible = scenarioMatch && isScenarioVerificationTask(nextTask);
        if (scenarioEligible) {
          const match = scenarioMatch;
          if (match) {
            const scenarioTaskId = nextTask.id;
            const check = await runBrowserCheck(analysis.id, analysis.rootPath, {
              path: match.path,
              url: match.url,
              steps: match.steps,
              timeoutMs: match.timeoutMs,
              signal,
            }).catch((error: unknown) => ({
              ok: false,
              summary: error instanceof Error ? error.message : "Scenario failed.",
              steps: [] as { index: number; action: string; ok: boolean; detail: string }[],
            }));
            if (check.ok) {
              const evidence = check.steps
                .map(
                  (step) =>
                    `${step.ok ? "PASS" : "FAIL"} #${step.index} ${step.action}: ${step.detail}`,
                )
                .join("\n");
              queue = markTask(queue, scenarioTaskId, {
                status: "done",
                completedAt: nowIso(),
                resultSummary: `Saved scenario ${match.name} passed without a model edit.\n${check.summary}${evidence ? `\n${evidence}` : ""}`,
                notes: "Deterministic saved scenario verified this task; no model call was needed.",
                toolIssues: undefined,
                changedFiles: [],
                commands: [],
                verification: {
                  command: `scenario:${match.name}`,
                  ok: true,
                  output: check.summary,
                },
              });
              queue = await saveQueue(analysis.rootPath, queue);
              await appendTaskContext(
                analysis.rootPath,
                `Scenario verification · ${scenarioTaskId}`,
                `The saved scenario ${match.name} passed. ${check.summary}`,
              ).catch(() => undefined);
              emit({
                type: "task",
                queue,
                task: queue.tasks.find((item) => item.id === scenarioTaskId),
              });
              continue;
            }
            queue = markTask(queue, scenarioTaskId, {
              notes: [
                nextTask.notes,
                `Saved scenario ${match.name} failed before the run: ${check.summary.slice(0, 700)}`,
              ]
                .filter(Boolean)
                .join("\n"),
            });
            const refreshed = queue.tasks.find((item) => item.id === scenarioTaskId);
            if (refreshed) nextTask = refreshed;
            emit({ type: "task", queue, task: nextTask });
          }
        }

        const wouldWrite =
          workspaceMode === "build" &&
          options.allowWrite === true &&
          taskLooksLikeWrite(nextTask);
        const targets = wouldWrite ? taskTargetFiles(analysis, nextTask) : [];
        if (wouldWrite && targets.length === 0 && activeRuns.size > 0) break;
        let prepared: PreparedTaskRun;
        try {
          prepared = await prepareTaskRun(nextTask, targets, maxParallel > 1);
        } catch (error) {
          queue = markTask(queue, nextTask.id, {
            status: "failed",
            completedAt: nowIso(),
            resultSummary:
              error instanceof Error ? error.message : "Task setup failed before execution.",
          });
          queue = await saveQueue(analysis.rootPath, queue);
          emit({ type: "task", queue, task: queue.tasks.find((item) => item.id === nextTask.id) });
          continue;
        }
        if (wouldWrite) {
          for (const target of targets) activeLocks.add(lockKey(target));
        }
        activeRuns.set(nextTask.id, prepared);
      }
      if (activeRuns.size > 0) {
        queue = await saveQueue(analysis.rootPath, queue);
        emit({ type: "task", queue });
      }
    }
    if (activeRuns.size === 0) break;

    const completed = await Promise.race(
      [...activeRuns.values()].map((prepared) =>
        prepared.promise.then((result) => ({ prepared, result })),
      ),
    );
    activeRuns.delete(completed.prepared.task.id);
    if (completed.prepared.forceWrite && options.allowWrite === true) {
      for (const target of completed.prepared.targets) activeLocks.delete(lockKey(target));
    }
    const {
      task,
      current,
      taskConfig,
      tokenBudget,
      costBudgetUsd,
      forceWrite,
      microEdit,
      scenario: requiredScenario,
      runKey,
    } = completed.prepared;
    const result = completed.result;

    if (!result) {
      queue = markTask(queue, task.id, {
        status: "failed",
        completedAt: nowIso(),
        resultSummary: "Task execution failed before a result was produced.",
      });
      queue = await saveQueue(analysis.rootPath, queue);
      emit({ type: "task", queue, task: queue.tasks.find((item) => item.id === task.id) });
      continue;
    }

    let scenarioRescue: { ok: boolean; name: string; summary: string } | null = null;
    if (requiredScenario && result.stoppedReason === "budget") {
      const check = await runBrowserCheck(analysis.id, analysis.rootPath, {
        path: requiredScenario.path,
        url: requiredScenario.url,
        steps: requiredScenario.steps,
        timeoutMs: requiredScenario.timeoutMs,
        signal,
      }).catch((error: unknown) => ({
        ok: false,
        summary: error instanceof Error ? error.message : "Scenario failed.",
        steps: [] as { index: number; action: string; ok: boolean; detail: string }[],
      }));
      scenarioRescue = {
        ok: check.ok,
        name: requiredScenario.name,
        summary: check.summary,
      };
      result.steps.push({
        index: result.steps.length + 1,
        action: "browser_check",
        args: {
          scenario: requiredScenario.name,
          path: requiredScenario.path,
          url: requiredScenario.url,
          steps: requiredScenario.steps,
        },
        observation: check.ok
          ? `Saved scenario ${requiredScenario.name} passed after the budget stop. ${check.summary}`
          : `Saved scenario ${requiredScenario.name} failed after the budget stop. ${check.summary}`,
        ok: check.ok,
        durationMs: 0,
      });
      if (check.ok) {
        result.stoppedReason = "finished";
        result.error = undefined;
        result.summary = `${result.summary}\n\nSaved scenario ${requiredScenario.name} passed; the task is verified.`;
      }
    }

    executed.push(result);
    const failedToolSteps = result.steps.filter(
      (step) => !step.ok && step.action !== "invalid" && step.action !== "finish",
    );
    const lastFailedTool = [...failedToolSteps].reverse()[0];
    const runLogPath = await saveAgentRun(analysis.rootPath, {
      taskId: task.id,
      attempt: current.attempts,
      runKey,
      goal: queue.goal,
      stoppedReason: result.stoppedReason,
      summary: result.summary,
      changedFiles: result.changedFiles,
      steps: result.steps,
    }).catch(() => null);
    const readBudgetStalled = result.steps.some(
      (step) => !step.ok && /Read budget exhausted/i.test(step.observation),
    );
    const failedToolNote = lastFailedTool
      ? /Read budget exhausted/i.test(lastFailedTool.observation)
        ? "The previous attempt kept reading and was stopped. Do not re-read. Apply the smallest edit now with replace_in_file or write_file, or report the exact blocker. If the task contains several independent changes, split it into smaller tasks."
        : `The previous attempt's ${lastFailedTool.action} call failed: ${lastFailedTool.observation.slice(
            0,
            500,
          )}. Correct the arguments and re-issue the same tool; the file path key is "path" and the text key is "content". Do not stop while a correctable tool call is failing.`
      : "";
    const runLogNote = runLogPath ? ` Full step log: ${runLogPath}` : "";
    const verificationLog = result.logs?.find(
      (entry) => entry.label === "Verification passed" || entry.label === "Verification failed",
    );
    const taskVerification = verificationLog
      ? {
          command: verificationLog.detail,
          ok: verificationLog.label === "Verification passed",
          output: verificationLog.detail,
        }
      : undefined;
    const malformedToolReply = /provider-native tool call omitted|use the JSON action protocol/i.test(
      result.summary,
    );
    const protocolFailure =
      malformedToolReply ||
      /invalid tool protocol|Unknown action|DSML|commentary/i.test(
        `${result.summary ?? ""} ${result.error ?? ""}`,
      );
    const mutatingCommand = result.steps.some(
      (step) =>
        step.action === "run_command" &&
        step.ok &&
        /\b(mkdir|touch|mv|cp|rm|rmdir|ln|install|init|create|generate|write|format|rename)\b/i.test(
          String(step.args.command ?? ""),
        ),
    );
    const inspectionTask =
      !forceWrite &&
      (taskLooksLikeInspection(task) ||
        options.intent?.kind === "question" ||
        options.intent?.kind === "analyze" ||
        options.intent?.kind === "run");
    const inspectionAnswer =
      inspectionTask && isInspectionAnswer(result.summary);
    const projectHasHtml =
      analysis.files.some((file) => /\.html?$/i.test(file.path)) ||
      result.changedFiles.some((file) => /\.html?$/i.test(file));
    const projectHasUi =
      analysis.files.some((file) => /\.(?:html?|jsx|tsx|vue|svelte)$/i.test(file.path)) ||
      result.changedFiles.some((file) => /\.(?:html?|jsx|tsx|vue|svelte)$/i.test(file));
    // "Already present" is only accepted with presence + shape + placement +
    // acceptance evidence, never from a symbol/icon/selector match alone. This
    // also applies when another requirement in the same task did change a file.
    const noChangeClaim =
      summaryClaimsAlreadyPresent(result.summary) ||
      (task.buildSession === true && result.changedFiles.length === 0);
    const scenarioPassed = result.logs?.some((entry) => entry.label === "Required scenario passed") === true;
    const noChangeEvidence = noChangeClaim
      ? noChangeCompletionEvidence(task, result, projectHasUi, scenarioPassed)
      : { ok: true, reason: "" };
    const summaryAllowsCompletion =
      summaryAllowsNoChanges(result.summary) &&
      noChangeEvidence.ok &&
      !summaryReportsBlocker(result.summary);
    const hadPassedRealBrowserCheck = result.steps.some(
      (step) => step.action === "browser_check" && step.ok,
    );
    // A build-session continuation that changed nothing but passed a real
    // end-to-end browser check is complete: the previous attempt already wrote
    // the code. Do not fail it for "no file change" alone.
    const verifiedNoChange =
      task.buildSession === true &&
      result.changedFiles.length === 0 &&
      !mutatingCommand &&
      hadPassedRealBrowserCheck &&
      noChangeEvidence.ok &&
      !summaryReportsBlocker(result.summary);
    const writeWithoutChange =
      !inspectionTask &&
      taskLooksLikeWrite(task) &&
      result.changedFiles.length === 0 &&
      !mutatingCommand &&
      !summaryAllowsCompletion &&
      !verifiedNoChange;
    const verificationBlocker =
      !inspectionTask &&
      taskLooksLikeVerification(task) &&
      !taskLooksLikeWrite(task) &&
      summaryReportsBlocker(result.summary) &&
      !summaryAllowsCompletion &&
      !verifiedNoChange;
    const pendingWork = !inspectionTask && reportsRemainingWork(result.summary);
    const uiFilesChanged = result.changedFiles.some((file) =>
      /\.(?:html?|css|scss|sass|less|jsx|tsx|vue|svelte|mjs|cjs|js)$/i.test(file),
    );
    const hadRealUiCheck = result.steps.some(isInteractiveUiCheck);
    const needsUiVerification =
      !inspectionTask && projectHasHtml && uiFilesChanged && !hadRealUiCheck;
    let uiSmokeSummary = "";
    let uiSmokeOk = false;
    if (needsUiVerification) {
      const smoke = await runUiEntrySmoke(analysis, result.changedFiles).catch(() => null);
      if (smoke) {
        uiSmokeOk = smoke.ok;
        uiSmokeSummary = smoke.ok
          ? `UI smoke passed: ${smoke.summary}`
          : `UI smoke failed: ${smoke.summary}`;
      }
    }
    // A one-line/mechanical edit is verified deterministically by the real-page
    // smoke check. Asking the model for an extra browser turn wastes a turn and
    // often exceeds the four-step micro budget.
    const microVerified =
      microEdit &&
      result.changedFiles.length > 0 &&
      (uiSmokeOk || result.steps.some((step) => step.action === "browser_check" && step.ok));
    if (
      microVerified &&
      (result.stoppedReason === "max_steps" || result.stoppedReason === "budget")
    ) {
      result.stoppedReason = "finished";
      result.error = undefined;
      result.summary = `${result.summary}\n\nThe real-page smoke check passed; the mechanical change is verified.`;
    }
    const microCompleted =
      microVerified &&
      (result.stoppedReason === "finished" ||
        result.stoppedReason === "max_steps" ||
        result.stoppedReason === "budget");
    const missingUiVerification = needsUiVerification && !microVerified;
    const missingVisualVerification =
      !inspectionTask &&
      needsRenderedGeometryEvidence(task, result.steps, projectHasUi);
    const missingSpawnVerification =
      !inspectionTask &&
      taskLooksLikeSpawnPlacement(task) &&
      projectHasUi &&
      !result.steps.some(isSpawnPlacementEvidenceCheck);
    const missingRemovalVerification =
      !inspectionTask &&
      taskLooksLikeRemoval(task) &&
      projectHasUi &&
      !result.steps.some(isRemovalEvidenceCheck);
    const missingRandomVerification =
      !inspectionTask &&
      taskLooksLikeRandomStart(task) &&
      projectHasUi &&
      !result.steps.some(isRandomStartEvidenceCheck);
    const behaviorEvidence = taskBehaviorEvidence(
      task,
      result,
      projectHasUi,
      queue.tasks.length === 1 ? queue.goal : undefined,
    );
    const missingBehaviorVerification =
      !inspectionTask && projectHasUi && !behaviorEvidence.ok;
    const brainForConstraints = await ensureProjectBrain(analysis).catch(() => null);
    const constraintAudit = auditProjectConstraints({
      constraints: brainForConstraints?.constraints ?? [],
      changedFiles: [...(current.changedFiles ?? []), ...result.changedFiles],
      summary: result.summary ?? "",
      goal: queue.goal,
      files: analysis.files.map((file) => file.path),
    });
    if (constraintAudit.warnings.length > 0) {
      emit({
        type: "log",
        entry: {
          id: `log-${Date.now()}-constraint-warning`,
          at: nowIso(),
          level: "info",
          label: "Constraint warning",
          detail: constraintAudit.warnings.join(" ").slice(0, 400),
        },
      });
    }
    let status: ProjectTask["status"] =
      result.stoppedReason === "aborted" || result.stoppedReason === "budget"
        ? "blocked"
        : inspectionAnswer
          ? "done"
          : result.stoppedReason !== "finished" ||
            !noChangeEvidence.ok ||
            !constraintAudit.ok ||
            malformedToolReply ||
            writeWithoutChange ||
            verificationBlocker ||
            pendingWork ||
            missingUiVerification ||
            missingVisualVerification ||
            missingSpawnVerification ||
            missingRemovalVerification ||
            missingRandomVerification ||
            missingBehaviorVerification
          ? "failed"
          : "done";
    if (!constraintAudit.ok) status = "failed";
    const requiredScenarioSatisfied =
      !requiredScenario ||
      Boolean(scenarioRescue?.ok) ||
      result.logs?.some((entry) => entry.label === "Required scenario passed");
    if (
      (scenarioRescue?.ok ||
        (microCompleted &&
          requiredScenarioSatisfied &&
          !missingVisualVerification &&
          !missingSpawnVerification &&
          !missingRemovalVerification &&
          !missingRandomVerification &&
          !missingBehaviorVerification)) &&
      constraintAudit.ok
    ) {
      status = "done";
    }
    const brainEvidence: "verified" | "claimed" =
      status === "done" &&
      !missingUiVerification &&
      !missingVisualVerification &&
      !missingSpawnVerification &&
      !missingRemovalVerification &&
      !missingRandomVerification &&
      !missingBehaviorVerification &&
      result.steps.some(
        (step) =>
          step.ok &&
          ["browser_check", "game_check", "run_test_scenario"].includes(step.action),
      )
        ? "verified"
        : "claimed";
    await updateProjectBrainFromTask(analysis, current, result, status, brainEvidence).catch(() => undefined);
    const unavailableModel = /error 410\b|end of life|no longer available|model_not_found|model .* not found|does not exist/i.test(
      result.summary,
    );
    const modelFailure =
      unavailableModel ||
      malformedToolReply ||
      /request failed|fetch failed|econnreset|timed out|timeout|rate limit|empty response|invalid tool protocol|DSML|503/i.test(
        `${result.summary ?? ""} ${result.error ?? ""}`,
      );
    if (unavailableModel) {
      avoidModels.add(`${taskConfig.id}::${taskConfig.model}`);
      await appendTaskContext(
        analysis.rootPath,
        `Model unavailable · ${task.id}`,
        `${taskConfig.id}/${taskConfig.model} is unavailable. The run will switch to a working model.`,
      );
    }
    const attemptCost = await estimateUsageCost(taskConfig.id, taskConfig.model, result.tokenUsage).catch(
      () => undefined,
    );
    const totalCost =
      attemptCost === undefined
        ? task.costUsd
        : Number(((task.costUsd ?? 0) + attemptCost).toFixed(6));

    let review: ProjectTask["review"] | undefined;
    let reviewUsage: AiTokenUsage | undefined;
    let reviewCost: number | undefined;
    if (
      status === "done" &&
      settings?.reviewEdits !== false &&
      workspaceMode === "build" &&
      current.effort !== "simple" &&
      result.changedFiles.length > 0
    ) {
      const spent = (task.tokenUsage?.totalTokens ?? 0) + (result.tokenUsage?.totalTokens ?? 0);
      if (tokenBudget - spent > 20_000) {
        const reviewer = await resolveAgentRole("reviewer", {
          provider: options.provider,
          model: options.model,
        }).catch(() => taskConfig);
        const reviewConfig = reviewer.id === "local" ? taskConfig : reviewer;
        const files: { path: string; content: string }[] = [];
        let chars = 0;
        for (const filePath of result.changedFiles.slice(0, 4)) {
          // eslint-disable-next-line no-await-in-loop
          const file = await readSourceFile(analysis.rootPath, filePath).catch(() => null);
          if (!file) continue;
          const content = reviewFileExcerpt(file.content);
          files.push({ path: filePath, content });
          chars += content.length;
          if (chars >= 12_000) break;
        }
        if (files.length > 0) {
          try {
            const reviewMessages = [
              {
                role: "system" as const,
                content:
                  'You are a strict senior code reviewer. Review only the changed files shown and the agent\'s evidence. Reply with compact JSON only: {"verdict":"ok"|"issues","issues":["short issue"],"summary":"one sentence"}. Do not rewrite code. File excerpts may end with "… [excerpt truncated; the file continues] …": never report a syntax error, missing closing brace/tag or an incomplete file solely because the excerpt ends there; that is a display cut, not the file. Only flag concrete broken syntax, wrong behavior or missing wiring visible before the marker, or runtime evidence.',
              },
              {
                role: "user" as const,
                content: `Task: ${current.title}\n${current.detail}\n\nAcceptance: ${current.acceptance ?? ""}\n\nAgent result:\n${(result.summary ?? "").slice(0, 2_000)}\n\nVerification: ${
                  taskVerification ? `${taskVerification.command ?? ""} ok=${taskVerification.ok}` : "none"
                }\n\nChanged files:\n${files
                  .map((file) => `--- ${file.path} ---\n${file.content}`)
                  .join("\n\n")}`,
              },
            ];
            const runReview = async (config: typeof reviewConfig) =>
              chat(config, reviewMessages, {
                maxTokens: 700,
                temperature: 0,
                timeoutMs: 60_000,
                onUsage: (usage) => {
                  reviewUsage = usage;
                },
              });
            let completion = "";
            try {
              completion = await runReview(reviewConfig);
              if (!/\{[\s\S]*\}/.test(completion)) throw new Error("Reviewer did not return JSON.");
            } catch {
              // The configured reviewer is often an unavailable free/NIM model.
              // Fall back to the task model once instead of losing the review.
              if (reviewConfig.id !== taskConfig.id || reviewConfig.model !== taskConfig.model) {
                completion = await runReview(taskConfig).catch(() => "");
                if (completion && !/\{[\s\S]*\}/.test(completion)) completion = "";
              } else {
                completion = "";
              }
            }
            if (!completion) throw new Error("Reviewer unavailable.");
            const parsed = parseReviewReply(completion);
            review = {
              ...parsed,
              provider: reviewConfig.id,
              model: reviewConfig.model,
              checkedFiles: files.map((file) => file.path),
              tokenUsage: reviewUsage,
            };
            reviewCost = await estimateUsageCost(
              reviewConfig.id,
              reviewConfig.model,
              reviewUsage,
            ).catch(() => undefined);
            if (reviewUsage) {
              await recordUsage({
                projectId,
                provider: reviewConfig.id,
                model: reviewConfig.model,
                kind: "agent-review",
                inputTokens: reviewUsage.inputTokens,
                outputTokens: reviewUsage.outputTokens,
                totalTokens: reviewUsage.totalTokens,
                costUsd: reviewCost,
              }).catch(() => undefined);
            }
            emit({
              type: "log",
              entry: {
                id: `log-${Date.now()}-review`,
                at: nowIso(),
                level: review.verdict === "ok" ? "success" : "warn",
                label: "Reviewer pass",
                detail: review.summary,
              },
            });
            await appendTaskContext(
              analysis.rootPath,
              `Review · ${task.id}`,
              `${reviewConfig.id}/${reviewConfig.model} · ${review.verdict}\n${review.summary}${
                review.issues.length > 0 ? `\n${review.issues.join("\n")}` : ""
              }`,
            );
          } catch (error) {
            emit({
              type: "log",
              entry: {
                id: `log-${Date.now()}-review-skip`,
                at: nowIso(),
                level: "warn",
                label: "Reviewer pass skipped",
                detail: error instanceof Error ? error.message.slice(0, 200) : "review failed",
              },
            });
          }
        }
      }
    }

    const stageUsage = queue.stageUsage ?? {};
    queue = {
      ...queue,
      stageUsage: {
        ...stageUsage,
        agent: addUsage(stageUsage.agent ?? emptyUsage(), result.tokenUsage),
        reviewer: addUsage(stageUsage.reviewer ?? emptyUsage(), reviewUsage),
        verify: (() => {
          const current = summarizeVerificationSteps(result.steps);
          return {
            checks: (stageUsage.verify?.checks ?? 0) + current.checks,
            durationMs: (stageUsage.verify?.durationMs ?? 0) + current.durationMs,
            tokens: emptyUsage(),
            costUsd: 0,
          };
        })(),
        costUsd:
          (stageUsage.costUsd ?? 0) + (attemptCost ?? 0) + (reviewCost ?? 0),
      },
    };
    const answerNote =
      inspectionAnswer &&
      result.stoppedReason !== "finished" &&
      result.stoppedReason !== "budget"
        ? "Stopped at the step limit; the answer above is the best evidence collected."
        : undefined;
    const toolIssues = summarizeToolIssues(result.steps);
    const lifetimeTokens =
      (task.lifetimeTokens ?? 0) +
      (result.tokenUsage?.totalTokens ?? 0) +
      (reviewUsage?.totalTokens ?? 0);
    const scenarioVerified =
      Boolean(scenarioRescue?.ok) ||
      result.logs?.some((entry) => entry.label === "Required scenario passed");
    const scenarioVerification =
      scenarioRescue?.ok
        ? {
            command: `scenario:${scenarioRescue.name}`,
            ok: true,
            output: scenarioRescue.summary,
          }
        : undefined;
    const microVerification = microCompleted && requiredScenarioSatisfied
      ? uiSmokeOk
        ? {
            command: "ui-smoke",
            ok: true,
            output: uiSmokeSummary,
          }
        : {
            command: "browser-check",
            ok: true,
            output: "Real-page browser check passed.",
          }
      : undefined;
    if (
      review?.verdict === "issues" &&
      status === "done" &&
      !taskVerification?.ok &&
      !scenarioVerified
    ) {
      status = "failed";
    }
    queue = markTask(queue, task.id, {
      status,
      completedAt: nowIso(),
      resultSummary: result.summary,
      notes: answerNote,
      toolIssues: toolIssues.length > 0 ? toolIssues : undefined,
      // Keep edits from earlier attempts in this task's history. A later
      // no-change retry must not erase evidence that the file was written.
      changedFiles: [...new Set([...(current.changedFiles ?? []), ...result.changedFiles])],
      commands: [...new Set([...(current.commands ?? []), ...result.ranCommands])],
      tokenUsage: addUsage(
        addUsage(task.tokenUsage ?? emptyUsage(), result.tokenUsage),
        reviewUsage,
      ),
      lifetimeTokens,
      costUsd:
        reviewCost === undefined ? totalCost : Number(((totalCost ?? 0) + reviewCost).toFixed(6)),
      verification:
        scenarioVerification ??
        microVerification ??
        taskVerification ??
        (verification ? { command: verification } : undefined),
      review,
    });
    if (result.skillsUsed && result.skillsUsed.length > 0) {
      await recordSkillOutcomes(analysis.rootPath, result.skillsUsed, status === "done").catch(
        () => undefined,
      );
    }
    queue = await saveQueue(analysis.rootPath, queue);
    await appendTaskContext(
      analysis.rootPath,
      `Task ${task.id} · ${task.title} · ${status}`,
      [
        `Provider: ${taskConfig.id}/${taskConfig.model}`,
        result.summary,
        result.changedFiles.length > 0 ? `Changed: ${result.changedFiles.join(", ")}` : "",
        result.ranCommands.length > 0 ? `Commands: ${result.ranCommands.join(" | ")}` : "",
        taskVerification ? `Verification ${taskVerification.ok ? "passed" : "failed"}: ${taskVerification.command ?? ""}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    emit({ type: "task", queue, task: queue.tasks.find((item) => item.id === task.id) });

    const changedBefore = (task.changedFiles?.length ?? 0) + result.changedFiles.length;
    const taskSpentTokens = addUsage(
      task.tokenUsage ?? emptyUsage(),
      result.tokenUsage,
    ).totalTokens;
    const taskStartedMs = Date.parse(current.startedAt ?? task.startedAt ?? "");
    const taskDurationMs = Number.isFinite(taskStartedMs) ? Date.now() - taskStartedMs : 0;
    if (taskDurationMs > 20_000 || result.steps.length > 10) {
      emit({
        type: "log",
        entry: {
          id: `log-${Date.now()}-duration-${task.id}`,
          at: nowIso(),
          level: "info",
          label: "Task duration",
          detail: `${task.id} · ${Math.round(taskDurationMs / 1000)}s · ${result.steps.length} steps · ${taskSpentTokens.toLocaleString()} tokens`,
        },
      });
    }
    const noEditTokenBurn = changedBefore === 0 && taskSpentTokens >= 300_000;
    const hardTaskTokens = hardTaskTokenCap(task);
    const failureText = `${result.summary ?? ""}\n${result.steps
      .map((step) => step.observation ?? "")
      .join("\n")}`;
    const envFailure = isEnvironmentFailure(result.steps, failureText);
    const softBudgetHit =
      result.stoppedReason === "budget" && /soft task budget/i.test(result.summary);
    if (
      status !== "done" &&
      result.stoppedReason !== "aborted" &&
      lifetimeTokens >= hardTaskTokens
    ) {
      const preserved = [
        ...new Set([...(task.changedFiles ?? []), ...result.changedFiles]),
      ];
      queue = markTask(queue, task.id, {
        status: "blocked",
        completedAt: nowIso(),
        lifetimeTokens,
        changedFiles: preserved,
        notes: `Blocked to control cost: ${lifetimeTokens.toLocaleString()} tokens spent across attempts (limit ${hardTaskTokens.toLocaleString()}). Preserved files from earlier attempts: ${preserved.join(", ") || "none"}. The last failure was a verification/incomplete-work gate, not a budget error. Split the goal into smaller behaviors or start a narrow verification task.`,
      });
      await appendTaskContext(
        analysis.rootPath,
        `Blocked · ${task.id}`,
        `Hard cost cap reached: ${lifetimeTokens.toLocaleString()} of ${hardTaskTokens.toLocaleString()} tokens. No further retries.`,
      ).catch(() => undefined);
      queue = await saveQueue(analysis.rootPath, queue);
      emit({ type: "task", queue, task: queue.tasks.find((item) => item.id === task.id) });
      continue;
    }
    if (
      status !== "done" &&
      result.stoppedReason !== "aborted" &&
      (readBudgetStalled || noEditTokenBurn || envFailure || softBudgetHit)
    ) {
      const reason =
        softBudgetHit && !readBudgetStalled && !noEditTokenBurn
          ? "reached the soft token budget"
          : envFailure && !readBudgetStalled && !noEditTokenBurn
            ? "hit a broken Python runtime"
            : readBudgetStalled
              ? "kept reading instead of editing"
              : "produced no file change";
      const latestTask = queue.tasks.find((item) => item.id === task.id) ?? task;
      const repairAttempts = latestTask.repairAttempts ?? 0;
      // A soft budget hit after code was written is not a reason to replay the
      // whole task: the files and changed-file evidence are already there. Keep
      // the work, stop the replay, and let a narrow verification/continue run
      // pick it up. Only a zero-change attempt gets one narrowed retry.
      const softBudgetWithWork =
        softBudgetHit &&
        (result.changedFiles.length > 0 || (latestTask.changedFiles?.length ?? 0) > 0);
      const softBudgetRetries = softBudgetHit ? repairAttempts : 0;

      // Recover inside the same run instead of leaving a "Continue" button:
      // narrow the task, keep completed work, and retry with an edit-first
      // budget. Bounded globally so a broken goal cannot loop forever.
      if (
        !softBudgetWithWork &&
        softBudgetRetries < 1 &&
        repairAttempts <
          (latestTask.buildSession || latestTask.patch
            ? 1
            : RECOVERY_POLICY.maxRepairsPerTask) &&
        autoRepairs < RECOVERY_POLICY.maxRepairsPerRun &&
        lifetimeTokens < hardTaskTokens
      ) {
        autoRepairs += 1;
        const repaired =
          softBudgetHit && !readBudgetStalled && !noEditTokenBurn
            ? {
                ...narrowTaskForEditFirst(
                  latestTask,
                  "soft token budget reached without any file change",
                ),
                status: "pending" as const,
                attempts: 0,
                repairAttempts: repairAttempts + 1,
                tokenUsage: undefined,
                resultSummary: undefined,
                verification: undefined,
                stepBudget: 6,
                notes: [
                  latestTask.notes,
                  "Soft token budget reached. This is a narrow retry: use the files already read, make the smallest missing edit, then finish. Do not restart, re-read old ranges or rewrite completed work.",
                ]
                  .filter(Boolean)
                  .join("\n"),
              }
            : envFailure && !readBudgetStalled && !noEditTokenBurn
              ? {
                  ...latestTask,
                  status: "pending" as const,
                  attempts: 0,
                  repairAttempts: repairAttempts + 1,
                  tokenUsage: undefined,
                  resultSummary: undefined,
                  verification: undefined,
                  notes: [
                    latestTask.notes,
                    environmentRepairNote(failureText),
                    "The runtime is repaired. Re-run the verification through the project .venv first; if the existing implementation passes, finish without rewriting it. Fix only real code failures.",
                  ]
                    .filter(Boolean)
                    .join("\n"),
                }
              : narrowTaskForEditFirst(
                  {
                    ...latestTask,
                    notes: [latestTask.notes, envFailure ? environmentRepairNote(failureText) : ""]
                      .filter(Boolean)
                      .join("\n"),
                  },
                  reason,
                );
        queue = markTask(queue, task.id, {
          ...repaired,
          retryContext: compactRetryContext(result),
          status: "pending",
          completedAt: undefined,
          modelOverride: { provider: main.id, model: main.model },
          provider: main.id,
          model: main.model,
          notes: [
            repaired.notes,
            envFailure
              ? "The runtime was repaired. Verify through the project .venv, not the system interpreter."
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
        });
        await appendTaskContext(
          analysis.rootPath,
          `Auto-repair · ${task.id}`,
          `The task ${reason} after ${taskSpentTokens.toLocaleString()} tokens. It was ${softBudgetHit ? "continued with a focused retry" : "narrowed into an edit-first retry"} (#${repaired.repairAttempts}) instead of stopping the whole goal.${envFailure ? " The failure was environmental; the Python venv is used for the retry." : ""}`,
        );
        await appendLesson(
          analysis.rootPath,
          `${task.id} ${reason} after ${taskSpentTokens.toLocaleString()} tokens. Auto-repair ${repaired.repairAttempts}/${RECOVERY_POLICY.maxRepairsPerTask}: preserve completed work, finish the smallest missing behavior, then verify.`,
        ).catch(() => {});
        queue = await saveQueue(analysis.rootPath, queue);
        emit({
          type: "log",
          entry: {
            id: `log-${Date.now()}-auto-repair-${task.id}`,
            at: nowIso(),
            level: "warn",
            label: "Auto-repair started",
            detail: `${task.id}: ${reason}. Retrying with a focused budget (${repaired.repairAttempts}/${RECOVERY_POLICY.maxRepairsPerTask}).`,
          },
        });
        emit({ type: "task", queue, task: queue.tasks.find((item) => item.id === task.id) });
        continue;
      }

      if (softBudgetWithWork) {
        emit({
          type: "log",
          entry: {
            id: `log-${Date.now()}-retry-skipped-${task.id}`,
            at: nowIso(),
            level: "warn",
            label: "Retry skipped",
            detail: `${task.id} hit the soft budget after editing ${latestTask.changedFiles.join(", ")}. The work is preserved; the full task was not replayed.`,
          },
        });
      }
      queue = markTask(queue, task.id, {
        status: "blocked",
        completedAt: nowIso(),
        notes: softBudgetWithWork
          ? `Soft budget reached after editing ${latestTask.changedFiles.join(", ") || "the project"}. Completed work and changed files are preserved; the full task was NOT replayed. Verify the changes or continue with a narrower request.`
          : lifetimeTokens >= hardTaskTokens
            ? `Blocked to control cost: ${lifetimeTokens.toLocaleString()} tokens spent across attempts (limit ${hardTaskTokens.toLocaleString()}). The last attempt ${reason}. Split the goal into smaller single-behavior tasks or retry with a narrower scope and the exact verification recipe.`
            : `Blocked: the previous attempt ${reason} after ${taskSpentTokens.toLocaleString()} tokens. Automatic recovery was tried ${repairAttempts} time(s) and stopped to prevent an endless loop. Split this goal into smaller single-behavior tasks, or retry manually with a narrower scope.`,
      });
      await appendTaskContext(
        analysis.rootPath,
        `Blocked · ${task.id}`,
        `The task ${reason} after ${taskSpentTokens.toLocaleString()} tokens. Automatic recovery was exhausted; split the goal or narrow the scope.`,
      );
      await appendLesson(
        analysis.rootPath,
        `${task.id} ${reason} after ${taskSpentTokens.toLocaleString()} tokens. Automatic recovery exhausted; split multi-feature goals into one behavior per task and do not re-read the same file ranges.`,
      ).catch(() => {});
      queue = await saveQueue(analysis.rootPath, queue);
      emit({ type: "task", queue, task: queue.tasks.find((item) => item.id === task.id) });
      continue;
    }

    if (signal?.aborted) {
      queue = await saveQueue(analysis.rootPath, { ...queue, status: "stopped" });
      emit({ type: "task", queue, task: queue.tasks.find((item) => item.id === task.id) });
      break;
    }

    // Do not start a retry that cannot fit under the lifetime cap. A replay
    // that overshoots the cap wastes a full attempt and then blocks anyway.
    if (
      status !== "done" &&
      result.stoppedReason !== "aborted" &&
      task.attempts === 0 &&
      hardTaskTokens - lifetimeTokens < 40_000
    ) {
      const preserved = [
        ...new Set([...(task.changedFiles ?? []), ...result.changedFiles]),
      ];
      queue = markTask(queue, task.id, {
        status: "blocked",
        completedAt: nowIso(),
        changedFiles: preserved,
        notes: `Stopped before a retry: only ${Math.max(0, hardTaskTokens - lifetimeTokens).toLocaleString()} of the ${hardTaskTokens.toLocaleString()}-token lifetime cap remains. Preserved files from earlier attempts: ${preserved.join(", ") || "none"}. Start a narrow verification task instead of replaying this goal.`,
      });
      await appendTaskContext(
        analysis.rootPath,
        `Blocked before retry · ${task.id}`,
        `Preserved work: ${preserved.join(", ") || "none"}. Not enough lifetime budget remained for another full attempt.`,
      ).catch(() => undefined);
      queue = await saveQueue(analysis.rootPath, queue);
      emit({ type: "task", queue, task: queue.tasks.find((item) => item.id === task.id) });
      continue;
    }

    if (status !== "done" && result.stoppedReason !== "aborted" && task.attempts === 0) {
      const burnedStepsWithoutEdit =
        !inspectionTask &&
        shouldRetryWithEditFirst(result.stoppedReason, result.changedFiles);
      if (result.stoppedReason === "budget") {
        queue = markTask(queue, task.id, {
          status: "blocked",
          notes: `Task budget exceeded (${tokenBudget.toLocaleString()} tokens / $${costBudgetUsd.toFixed(2)}). The task was stopped to prevent further cost.`,
        });
      } else if (inspectionTask) {
        // A read-only inspection task already produced its best evidence. Retrying
        // it with another model usually repeats the same work and can leave the UI
        // in a long "pending" state after a complete answer. Fail once, keep the
        // answer/notes, and let the user rerun with a different model if needed.
        queue = markTask(queue, task.id, {
          status: "failed",
          resultSummary: result.summary,
          notes:
            "Read-only inspection did not finish cleanly. The evidence above is preserved; rerun with another model if it is incomplete.",
        });
      } else if (burnedStepsWithoutEdit) {
        // The failure was exploration, not the model. Retry the same model with
        // the fast profile and an explicit edit-first note instead of paying for
        // an alternate (often more expensive) model.
        queue = markTask(queue, task.id, {
          status: "pending",
          effort: "simple",
          role: "fast",
          modelOverride: undefined,
          resultSummary: undefined,
          verification: undefined,
          changedFiles: [],
          commands: [],
          notes:
            "Previous attempt kept reading without editing. Start with the edit now; read at most 2 files or exact ranges, then make the change.",
        });
        await appendTaskContext(
          analysis.rootPath,
          `Retry · ${task.id}`,
          "Previous attempt ended with no file changes. Retrying with the fast profile and an edit-first instruction.",
        );
      } else if (protocolFailure) {
        // A protocol failure is usually the model's output formatting, not an
        // unavailable provider. Retry the SAME model with a strict JSON note
        // instead of spending the task on an unrelated fallback model.
        queue = markTask(queue, task.id, {
          status: "pending",
          effort: task.effort,
          role: task.role,
          modelOverride: { provider: taskConfig.id, model: taskConfig.model },
          provider: taskConfig.id,
          model: taskConfig.model,
          resultSummary: undefined,
          verification: undefined,
          changedFiles: task.changedFiles ?? [],
          commands: task.commands ?? [],
          notes:
            "Retry the same model: the previous reply was not a valid JSON tool call (provider-native DSML, commentary or malformed JSON). Reply with exactly one complete JSON object using action and args. Do not use <commentary>, <analysis>, <thinking>, DSML or markdown fences.",
        });
        await appendTaskContext(
          analysis.rootPath,
          `Protocol retry · ${task.id}`,
          `Kept ${taskConfig.id}/${taskConfig.model} instead of switching models. The previous reply used an invalid tool protocol.${runLogNote}`,
        );
      } else if (!autoSwitchModels) {
        queue = markTask(queue, task.id, {
          status: "failed",
          notes: `Automatic model switching is disabled. Choose another model or enable it in Settings → General.${
            noChangeEvidence.ok ? "" : ` ${noChangeEvidence.reason}`
          }${constraintAudit.ok ? "" : ` Constraint violation: ${constraintAudit.violations.join(" ")}`}`,
        });
      } else if (!modelFailure) {
        // The provider answered normally; the task itself was incomplete.
        // Do not switch models for task-quality failures.
        const preservedRetryFiles = [
          ...new Set([...(task.changedFiles ?? []), ...result.changedFiles]),
        ];
        const projectNeedsServer =
          preservedRetryFiles.some((file) =>
            /(^|\/)(?:server|app|index|main)\.(?:js|cjs|mjs|ts|py)$/i.test(file),
          ) ||
          preservedRetryFiles.some((file) => /(^|\/)package\.json$/i.test(file));
        queue = markTask(queue, task.id, {
          status: "pending",
          effort: task.effort,
          role: task.role,
          modelOverride: { provider: taskConfig.id, model: taskConfig.model },
          provider: taskConfig.id,
          model: taskConfig.model,
          resultSummary: undefined,
          verification: undefined,
          changedFiles: task.changedFiles ?? [],
          commands: task.commands ?? [],
          retryContext: compactRetryContext(result),
          notes: `Retry the same model: the provider worked, but the task was incomplete. Continue from the current files, complete the missing work and verify it. Do not restart from scratch.${
            noChangeEvidence.ok ? "" : ` ${noChangeEvidence.reason}`
          }${
            constraintAudit.ok
              ? ""
              : ` Constraint violation: ${constraintAudit.violations.join(" ")}`
          }${
            missingVisualVerification
              ? " No rendered-geometry check ran for the requested shape/placement. Add one browser_check step that reads getBoundingClientRect (DOM position) or canvas getImageData (drawn shape) and assert it with expectText/expectValue; a symbol, icon constant, element id or expectVisible is not proof."
              : ""
          }${
            missingSpawnVerification
              ? " No spawn/reachability check ran. Prove at runtime that the item is on a walkable cell reachable from the player start (BFS or equivalent) and that collecting it changes score/inventory; a coordinate edit alone is not proof."
              : ""
          }${
            missingRemovalVerification
              ? " No removal check ran. Assert the removed selector is absent (expectCount 0 or querySelector null) and the replacement behavior still works."
              : ""
          }${
            missingRandomVerification
              ? " No random-start check ran. Start the game several times and assert the observed level set varies; one start does not prove randomness."
              : ""
          }${
            missingBehaviorVerification
              ? ` ${behaviorEvidence.reason}`
              : ""
          }${
            missingUiVerification
              ? ` No interactive real-page check ran after the UI change. Run browser_check or game_check on the actual entry page with a click/fill/press/eval and an assertion; for a canvas game, click a key and check the HUD/status.${uiSmokeSummary ? ` ${uiSmokeSummary}` : ""}`
              : ""
          }${
            preservedRetryFiles.length > 0 &&
            projectNeedsServer &&
            (missingUiVerification || missingBehaviorVerification)
              ? ` The files (${preservedRetryFiles.join(", ")}) are already written; do NOT re-read them or restart. Start the project's own server with run_background (for example "node server.js") and call browser_check on the URL it returns, then assert the real behavior. The static B.A.D IDE preview cannot serve the project's /api routes. Only edit if that check reports a concrete code failure.`
              : ""
          }${failedToolNote ? ` ${failedToolNote}` : ""}${runLogNote}`,
        });
        await appendTaskContext(
          analysis.rootPath,
          `Same-model retry · ${task.id}`,
          `Kept ${taskConfig.id}/${taskConfig.model}; the failure was incomplete work, not a model/provider error.`,
        );
      } else {
        const alternate = await pickAlternateAgentModel({
          provider: taskConfig.id,
          model: taskConfig.model,
        }).catch(() => null);
        if (alternate) {
          const reason = `The task failed with ${taskConfig.id}/${taskConfig.model}; retrying with a working model.`;
          emit({
            type: "model",
            from: { provider: taskConfig.id, model: taskConfig.model },
            to: { provider: alternate.provider, model: alternate.model },
            reason,
          });
          await recordModelFallback({
            fromProvider: taskConfig.id,
            fromModel: taskConfig.model,
            toProvider: alternate.provider,
            toModel: alternate.model,
            reason,
          }).catch(() => undefined);
          options.provider = alternate.provider;
          options.model = alternate.model;
        }
        const preserveEffort = unavailableModel || malformedToolReply;
        queue = markTask(queue, task.id, {
          status: "pending",
          effort: preserveEffort ? task.effort : task.effort === "simple" ? "standard" : task.effort,
          role: preserveEffort ? task.role : "main",
          modelOverride: alternate
            ? { provider: alternate.provider, model: alternate.model }
            : undefined,
          provider: alternate?.provider ?? task.provider,
          model: alternate?.model ?? task.model,
          resultSummary: undefined,
          verification: undefined,
          changedFiles: [...new Set([...(task.changedFiles ?? []), ...result.changedFiles])],
          commands: [...new Set([...(task.commands ?? []), ...result.ranCommands])],
          notes: alternate
            ? `Retrying with ${alternate.provider}/${alternate.model} after the previous attempt failed.`
            : "Retrying after the previous attempt failed.",
        });
      }
      queue = await saveQueue(analysis.rootPath, queue);
      emit({ type: "task", queue, task: queue.tasks.find((item) => item.id === task.id) });
    }
    let finalTask = queue.tasks.find((item) => item.id === task.id);
    if (
      finalTask &&
      finalTask.status === "failed" &&
      (finalTask.repairAttempts ?? 0) <
        (finalTask.buildSession || finalTask.patch ? 0 : 2) &&
      result.stoppedReason !== "aborted" &&
      result.stoppedReason !== "budget" &&
      !protocolFailure &&
      !modelFailure &&
      !readBudgetStalled
    ) {
      const repairInstruction =
        (failedToolNote ? `${failedToolNote} Apply the fix, verify it, then finish.` : "") ||
        actionableRepairInstruction(result.summary) ||
        (result.stoppedReason === "max_steps"
          ? "The step limit was reached before finishing. Continue from the files that already exist instead of restarting: complete the remaining edit, verify it, then finish."
          : null);
      if (repairInstruction) {
        queue = markTask(queue, task.id, {
          status: "pending",
          repairAttempts: (finalTask.repairAttempts ?? 0) + 1,
          provider: taskConfig.id,
          model: taskConfig.model,
          modelOverride: { provider: taskConfig.id, model: taskConfig.model },
          resultSummary: undefined,
          verification: undefined,
          changedFiles: [
            ...new Set([...(finalTask.changedFiles ?? []), ...(result.changedFiles ?? [])]),
          ],
          commands: [
            ...new Set([...(finalTask.commands ?? []), ...(result.ranCommands ?? [])]),
          ],
          retryContext: compactRetryContext(result),
          notes: `Repair pass — the previous attempt identified a concrete remaining fix. Apply only this fix, verify it, then finish: ${repairInstruction}${runLogNote}`,
        });
        await appendTaskContext(
          analysis.rootPath,
          `Repair pass · ${task.id}`,
          `The model found an actionable remaining fix. Re-running the same model in repair mode: ${repairInstruction}`,
        );
        await appendLesson(
          analysis.rootPath,
          `${task.id} repair pass: ${repairInstruction.slice(0, 500)}`,
        );
        queue = await saveQueue(analysis.rootPath, queue);
        emit({ type: "task", queue, task: queue.tasks.find((item) => item.id === task.id) });
        continue;
      }
    }
    if (finalTask && (finalTask.status === "failed" || finalTask.status === "blocked")) {
      if (!finalTask.notes?.trim()) {
        const reason =
          result.error?.trim() ||
          result.summary?.trim() ||
          (result.stoppedReason === "max_steps"
            ? "The step limit was reached before the task could finish."
            : `Stopped (${result.stoppedReason}).`);
        queue = markTask(queue, task.id, {
          notes: reason.slice(0, 800),
        });
        finalTask = queue.tasks.find((item) => item.id === task.id);
      }
      if (
        finalTask &&
        finalTask.status === "failed" &&
        result.stoppedReason === "error" &&
        finalTask.attempts > 1 &&
        finalTask.changedFiles.length > 0
      ) {
        // A transient provider failure must not erase work that was already
        // written in an earlier attempt. If the current files still parse, keep
        // the task as done with an explicit verification note.
        const syntax = await Promise.all(
          finalTask.changedFiles.slice(0, 8).map(async (filePath) => {
            const checked = await checkFileSyntax(analysis, filePath).catch(() => null);
            return checked;
          }),
        );
        const failures = syntax.filter((item) => item && item.supported && !item.ok);
        if (failures.length === 0) {
          queue = markTask(queue, task.id, {
            status: "done",
            completedAt: nowIso(),
            notes:
              "Work was written in an earlier attempt. A later model request failed, so the task was auto-completed after syntax checks passed. Run the project verification command before shipping.",
          });
          finalTask = queue.tasks.find((item) => item.id === task.id);
          await appendTaskContext(
            analysis.rootPath,
            `Auto-completed · ${task.id}`,
            "The agent wrote the files, then a later model request failed. Syntax checks pass; verification is still recommended.",
          );
        }
      }
      if (finalTask) {
        await appendLesson(
          analysis.rootPath,
          `${finalTask.id} ${finalTask.title}: ${(finalTask.notes || result.summary || result.stoppedReason || "failed").slice(0, 600)}`,
        );
        queue = blockDependentsOf(queue, finalTask.id);
      }
      queue = await saveQueue(analysis.rootPath, queue);
      emit({ type: "task", queue });
    }
    if (result.stoppedReason === "aborted") break;
  }

  if (activeRuns.size > 0) {
    await Promise.allSettled([...activeRuns.values()].map((prepared) => prepared.promise));
  }

  const unresolved = queue.tasks.some((task) => task.status === "pending" || task.status === "in_progress");
  const failed = queue.tasks.some((task) => task.status === "failed" || task.status === "blocked");
  const finalStatus =
    signal?.aborted
      ? "stopped"
      : unresolved || failed
        ? "failed"
        : "completed";
  queue = await saveQueue(analysis.rootPath, { ...queue, status: finalStatus });
  emit({ type: "task", queue });
  const stages = queue.stageUsage;
  if (stages) {
    const tokens = (usage: { totalTokens: number } | undefined) => usage?.totalTokens ?? 0;
    emit({
      type: "log",
      entry: {
        id: `log-${Date.now()}-stage-cost`,
        at: nowIso(),
        level: "info",
        label: "Stage cost",
        detail: `intent ${tokens(stages.intent)} · planner ${tokens(stages.planner)} · planReview ${tokens(stages.planReview)} · agent ${tokens(stages.agent)} · reviewer ${tokens(stages.reviewer)} tokens · verify ${stages.verify?.checks ?? 0} checks/${stages.verify?.durationMs ?? 0}ms${
          stages.costUsd ? ` · ${formatUsd(stages.costUsd)}` : ""
        }`,
      },
    });
  }
  const result = aggregateResult(goal.trim(), queue, executed, main.id, main.model);
  emit({ type: "done", result });
  return {
    queue,
    summary: result.summary,
    completed: queue.tasks.filter((task) => task.status === "done").length,
    failed: queue.tasks.filter((task) => task.status === "failed" || task.status === "blocked").length,
    stopped: finalStatus === "stopped",
    stages,
  };
}

export async function getProjectTaskQueue(projectId: string): Promise<ProjectTaskQueue | null> {
  const analysis = await loadAnalysis(projectId);
  return loadQueue(analysis.rootPath, projectId);
}
