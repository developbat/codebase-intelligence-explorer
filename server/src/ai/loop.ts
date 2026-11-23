import type { AnalysisResult } from "../../../shared/types";
import type {
  AiAgentEvent,
  AiAgentResult,
  AiTokenUsage,
  AiWorkspaceMode,
} from "../../../shared/ai";
import type { IntentAnalysis } from "../../../shared/intent";
import type {
  ProjectTask,
  ProjectTaskEffort,
  ProjectTaskLoopOptions,
  ProjectTaskLoopResult,
  ProjectTaskQueue,
  ProjectTaskRole,
} from "../../../shared/tasks";
import { loadAnalysis } from "../store";
import { readSourceFile } from "../editor";
import {
  appendTaskContext,
  createQueue,
  loadQueue,
  markTask,
  nextPendingTask,
  saveQueue,
} from "../tasks";
import { chat, type ChatMessage } from "./providers";
import { recordUsage } from "./usage";
import { getPublicSettings, resolveAgentRole, resolveProvider } from "./settings";
import { pickAlternateAgentModel } from "./agents";
import {
  healthKey,
  modelHealthByProviderModel,
  recordModelFallback,
} from "./modelStats";
import { estimateUsageCost } from "./pricing";
import { formatUsd } from "../../../shared/pricing";
import {
  looksLikePlanningText,
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
{"tasks":[{"title":"short imperative title","detail":"exact work, files/areas if known","acceptance":"how to verify this task","effort":"simple|standard|hard"}]}
Rules:
- 2-8 tasks. Each task must be independently verifiable.
- Order tasks so later tasks depend on earlier ones.
- Small mechanical edits are "simple"; normal implementation is "standard"; broad refactors/debugging are "hard".
- Include a final verification task when tests, typecheck or build commands exist.
- Do not invent files that do not exist; inspect is allowed later by the executor.
- The context notes in .cie/agent/context.md and .cie/agent/TASKS.md are for continuity; you may mention them.
- Work in any programming language.`;

function fallbackTasks(goal: string, verification?: string): ProjectTask[] {
  const at = nowIso();
  const first: ProjectTask = {
    id: "task-1",
    title: goal.length > 90 ? `${goal.slice(0, 87)}…` : goal,
    detail: goal,
    acceptance: "The requested work is implemented and the relevant files are updated.",
    status: "pending",
    effort: "standard",
    role: "main",
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
  const hasVerification = tasks.some((task) =>
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
  } = {},
): Promise<ProjectTaskQueue> {
  const analysis = await loadAnalysis(projectId);
  const verification = preferredVerificationCommand(analysis.tooling);
  const config = await resolveAgentRole("planner");
  const messages: ChatMessage[] = [
    { role: "system", content: PLANNER_SYSTEM },
    {
      role: "user",
      content: [
        projectFacts(analysis),
        `Verification command: ${verification ?? "none detected"}`,
        options.intent
          ? [
              "Intent analyst:",
              `Understanding: ${options.intent.understanding}`,
              `Scope: ${options.intent.scope} · mode: ${options.intent.mode}`,
              options.intent.approach ? `Approach: ${options.intent.approach}` : "",
              options.intent.needsExhaustiveEvidence ? "This answer must be exhaustive; collect every item and verify the total." : "",
              options.intent.areas.length > 0
                ? `Likely areas: ${options.intent.areas.join(", ")}`
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
  try {
    const text = await chat(config, messages, {
      maxTokens: 2200,
      temperature: 0.1,
      timeoutMs: 120_000,
      signal: options.signal,
      onUsage: (usage) => {
        tokenUsage = usage;
      },
    });
    const inputChars = messages.reduce((sum, message) => sum + message.content.length, 0);
    tokenUsage = tokenUsage ?? {
      inputTokens: Math.ceil(inputChars / 4),
      outputTokens: Math.ceil(text.length / 4),
      totalTokens: Math.ceil(inputChars / 4) + Math.ceil(text.length / 4),
    };
    await recordUsage({
      projectId,
      provider: config.id,
      model: config.model,
      kind: "tasks.plan",
      inputTokens: tokenUsage.inputTokens,
      outputTokens: tokenUsage.outputTokens,
      totalTokens: tokenUsage.totalTokens,
    });
    tasks = normalizeTasks(extractJson(text), goal, verification);
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
  } catch {
    tasks = fallbackTasks(goal, verification);
  }

  const queue = await createQueue(analysis.rootPath, projectId, goal.trim(), tasks);
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
  const text = `${task.title} ${task.detail}`;
  if (
    /\b(inspect|read|review|verify|check|analy[sz]e|research|understand|plan)\b|incele|oku|gözden geçir|doğrula|kontrol et|araştır/i.test(
      task.title,
    ) &&
    !/\b(fix|update|add|create|write|implement|change|remove)\b|düzelt|ekle|oluştur|yaz|güncelle/i.test(task.title)
  ) {
    return false;
  }
  return /\b(add|create|implement|update|change|edit|write|refactor|fix|remove|delete|rename|move|append|replace|insert|build|generate)\b|oluştur|ekle|güncelle|değiştir|düzelt|sil|taşı|yaz|kaldır/i.test(
    text,
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
  const title = task.title;
  const inspection =
    /\b(inspect|read|review|analy[sz]e|research|understand|explore|audit|list|enumerate|count)\b|incele|oku|gözden geçir|araştır|analiz et|listele|listeler|listeleme|liste|kaç/i;
  const write = /\b(fix|update|add|create|write|implement|change|remove|delete|rename|move|refactor)\b|düzelt|ekle|oluştur|yaz|güncelle|değiştir|sil|taşı/i;
  return inspection.test(title) && !write.test(title);
}

export function taskLooksLikeVerification(task: ProjectTask): boolean {
  return /\b(verify|verification|check|test|validate|confirm|review)\b|doğrula|kontrol|test et/i.test(
    task.title,
  );
}

export function summaryAllowsNoChanges(summary: string): boolean {
  if (/\b(not complete|incomplete|not done|failed|missing|tamamlanmadı|yapılmadı|eksik)\b/i.test(summary)) {
    return false;
  }
  return /already (?:present|exists|implemented|applied|there|complete|complete and|satisf(?:y|ies|ied)|fits|matches)|no changes? (?:are )?(?:needed|required)|nothing to change|none needed|task[\s-]*\d*\s*(?:is\s*)?complete|görev[\s-]*\d*\s*tamamlandı|created and verified|verified|confirmed|nothing (?:was|is) (?:changed|rewritten)|no (?:changes|modifications) (?:made|required)|zaten (?:var|mevcut|tamam|tam|işlevsel|karşılan|uyumlu)|değişiklik gerekmiyor|gerek yok/i.test(
    summary,
  );
}

function summaryReportsBlocker(summary: string): boolean {
  return /\b(blocker|blocked|cannot|can't|unable to|not present|does not appear|missing|failed to|verification failed|could not)\b|yapılamadı|başarısız|engellendi|eksik|bulunamadı/i.test(
    summary,
  );
}

function taskInstruction(
  task: ProjectTask,
  total: number,
  verification?: string,
  priorTasks: ProjectTask[] = [],
): string {
  const prior = priorTasks
    .filter((item) => item.status === "done" && item.resultSummary)
    .slice(-8)
    .map(
      (item) =>
        `- ${item.id} ${item.title}: ${(item.resultSummary ?? "").replace(/\n+/g, " ").slice(0, 260)}`,
    )
    .join("\n");
  return [
    `You are executing task ${task.id} of ${total} in a persistent project task loop.`,
    `Task: ${task.title}`,
    task.detail,
    task.acceptance ? `Acceptance: ${task.acceptance}` : "",
    task.notes ? `Retry note: ${task.notes}` : "",
    prior ? `Previous task summaries (use this before reading context.md):\n${prior}` : "",
    "Read .cie/agent/context-digest.md first for compact prior context. Read .cie/agent/context.md only when the digest and summaries are insufficient; if it is large, search it with find_in_file or read only the relevant tail. Append useful durable context if you learn something new.",
    "For a field/control change, wire all layers: data model, creation form/markup, rendering and persistence. A selector referenced in JS but absent from the markup is incomplete; run browser_check when the change is visual and available.",
    "Do not re-read files already fully read by a previous task unless the current task needs exact content after a change.",
    "Stay scoped to this task. Do not do later tasks. Do not revert earlier work.",
    verification ? `Verification command: ${verification}` : "",
    "Run tests/typecheck/build when relevant. If the task includes validation, permissions, errors or limits, verify both the accepted and rejected path. Finish only when this task is complete, or report the exact blocker.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function taskBudgetForEffort(effort: ProjectTaskEffort): {
  tokens: number;
  costUsd: number;
} {
  if (effort === "simple") return { tokens: 80_000, costUsd: 0.05 };
  if (effort === "hard") return { tokens: 320_000, costUsd: 0.25 };
  return { tokens: 160_000, costUsd: 0.12 };
}

export function shouldRetryWithEditFirst(
  stoppedReason: string,
  changedFiles: string[],
): boolean {
  return stoppedReason === "max_steps" && changedFiles.length === 0;
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
    provider,
    model,
    createdAt: new Date().toISOString(),
    tokenUsage,
    costUsd: costUsd > 0 ? Number(costUsd.toFixed(6)) : undefined,
    planPath,
    taskQueue: queue,
  };
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
  const effort =
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
  return {
    id: "task-1",
    title: goal.length > 90 ? `${goal.slice(0, 87)}…` : goal,
    detail: [
      intent.understanding,
      intent.approach ? `Approach: ${intent.approach}` : "",
      intent.areas.length > 0 ? `Likely areas: ${intent.areas.join(", ")}` : "",
      intent.assumptions.length > 0 ? `Assumptions: ${intent.assumptions.join("; ")}` : goal,
    ]
      .filter(Boolean)
      .join("\n"),
    acceptance:
      workspaceMode === "plan"
        ? "A concrete plan with ordered tasks, acceptance criteria and verification is saved."
        : workspaceMode === "research"
          ? "The answer cites the evidence and states open questions."
          : "The requested change is implemented and verified.",
    status: "pending",
    effort,
    role:
      workspaceMode === "ask" || workspaceMode !== "build" || effort !== "simple"
        ? "main"
        : "fast",
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
  const workspaceMode: AiWorkspaceMode = options.workspaceMode ?? "build";
  let queue = await loadQueue(analysis.rootPath, projectId);
  const sameGoal = queue?.goal.trim() === goal.trim();
  const intent = options.intent;
  const intentSingle = workspaceMode !== "build" || intent?.mode === "single";
  if (
    !queue ||
    options.replan ||
    queue.tasks.length === 0 ||
    !sameGoal ||
    queue.status === "completed" ||
    (intentSingle && queue.status === "failed" && !options.retryFailed)
  ) {
    if (intent && intentSingle) {
      queue = await createQueue(analysis.rootPath, projectId, goal.trim(), [
        intentTask(goal, intent, verification, workspaceMode),
      ]);
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
      queue = await planProjectTasks(projectId, goal, {
        language: options.language,
        signal,
        intent,
        history: options.history,
      });
    }
  }

  if (options.retryFailed) {
    queue = {
      ...queue,
      tasks: queue.tasks.map((task) =>
        task.status === "failed" || task.status === "blocked"
          ? {
              ...task,
              status: "pending",
              attempts: 0,
              modelOverride: undefined,
              completedAt: undefined,
              resultSummary: undefined,
              verification: undefined,
              updatedAt: nowIso(),
            }
          : task,
      ),
    };
  }
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

  while (executedCount < maxTasks && Date.now() - startedAt < maxMs) {
    if (signal?.aborted) {
      queue = await saveQueue(analysis.rootPath, { ...queue, status: "stopped" });
      emit({ type: "task", queue });
      break;
    }
    const task = nextPendingTask(queue);
    if (!task) break;
    if (!seenTasks.has(task.id)) {
      seenTasks.add(task.id);
      executedCount += 1;
    }
    const defaultBudget = taskBudgetForEffort(task.effort);
    const tokenBudget = options.tokenBudget ?? task.tokenBudget ?? defaultBudget.tokens;
    const costBudgetUsd =
      options.costBudgetUsd ?? task.costBudgetUsd ?? defaultBudget.costUsd;
    queue = markTask(queue, task.id, {
      status: "in_progress",
      startedAt: nowIso(),
      attempts: task.attempts + 1,
      tokenBudget,
      costBudgetUsd,
    });
    const current = queue.tasks.find((item) => item.id === task.id);
    if (!current) break;
    emit({ type: "task", queue, task: current });

    let taskConfig = current.modelOverride
      ? await resolveProvider(current.modelOverride.provider, current.modelOverride.model).catch(
          () => main,
        )
      : await resolveAgentRole(current.role === "fast" ? "fast" : "main", {
          provider: options.provider,
          model: options.model,
        }).catch(() => main);
    if (!current.modelOverride && current.effort === "simple" && current.role !== "fast") {
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
    const forceWrite = workspaceMode === "build" && taskLooksLikeWrite(task);
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
    let result: AiAgentResult | null = null;
    try {
      result = await runAgentTask(
        projectId,
        taskInstruction(current, queue.tasks.length, verification, queue.tasks),
        {
          activeFile: options.activeFile,
          provider: taskConfig.id,
          model: taskConfig.model,
          allowWrite: options.allowWrite === true,
          allowCommands: options.allowCommands === true,
          language: options.language,
          maxSteps:
            workspaceMode === "plan"
              ? 8
              : workspaceMode === "research"
                ? 12
                : workspaceMode === "ask"
                  ? 6
                  : taskLooksLikeInspection(current)
                  ? 5
                  : current.effort === "simple"
                    ? 6
                    : current.effort === "hard"
                      ? 16
                      : 10,
          mode: "auto",
          workspaceMode,
          interactive: true,
          forceFast: current.effort === "simple",
          forceWrite,
          tokenBudget,
          costBudgetUsd,
          startingUsage: current.tokenUsage,
          intent: options.intent,
          history: options.history?.slice(-8),
        },
        (event) => {
          if (event.type === "done") {
            result = event.result;
            return;
          }
          emit(event);
        },
        signal,
      );
    } catch (error) {
      result = null;
      emit({
        type: "error",
        message: error instanceof Error ? error.message : "Task execution failed.",
      });
    }

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

    executed.push(result);
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
    const writeWithoutChange =
      !inspectionTask &&
      taskLooksLikeWrite(task) &&
      result.changedFiles.length === 0 &&
      !mutatingCommand &&
      !summaryAllowsNoChanges(result.summary);
    const verificationBlocker =
      !inspectionTask &&
      taskLooksLikeVerification(task) &&
      !taskLooksLikeWrite(task) &&
      summaryReportsBlocker(result.summary) &&
      !summaryAllowsNoChanges(result.summary);
    const pendingWork = !inspectionTask && reportsRemainingWork(result.summary);
    const status =
      result.stoppedReason === "aborted" || result.stoppedReason === "budget"
        ? "blocked"
        : inspectionAnswer
          ? "done"
          : result.stoppedReason !== "finished" ||
            malformedToolReply ||
            writeWithoutChange ||
            verificationBlocker ||
            pendingWork
          ? "failed"
          : "done";
    if (status === "failed" && (malformedToolReply || /invalid tool protocol/i.test(result.summary))) {
      avoidModels.add(`${taskConfig.id}::${taskConfig.model}`);
    }
    const unavailableModel = /error 410\b|end of life|no longer available|model_not_found|model .* not found|does not exist/i.test(
      result.summary,
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
          const content = file.content.slice(0, 3_000);
          files.push({ path: filePath, content });
          chars += content.length;
          if (chars >= 12_000) break;
        }
        if (files.length > 0) {
          try {
            const completion = await chat(
              reviewConfig,
              [
                {
                  role: "system",
                  content:
                    'You are a strict senior code reviewer. Review only the changed files shown. Reply with compact JSON only: {"verdict":"ok"|"issues","issues":["short issue"],"summary":"one sentence"}. Do not rewrite code. Flag broken syntax, missing UI wiring, or clearly wrong behavior; otherwise return ok.',
                },
                {
                  role: "user",
                  content: `Task: ${current.title}\n${current.detail}\n\nChanged files:\n${files
                    .map((file) => `--- ${file.path} ---\n${file.content}`)
                    .join("\n\n")}`,
                },
              ],
              {
                maxTokens: 700,
                temperature: 0,
                timeoutMs: 60_000,
                onUsage: (usage) => {
                  reviewUsage = usage;
                },
              },
            );
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

    const answerNote =
      inspectionAnswer &&
      result.stoppedReason !== "finished" &&
      result.stoppedReason !== "budget"
        ? "Stopped at the step limit; the answer above is the best evidence collected."
        : undefined;
    queue = markTask(queue, task.id, {
      status,
      completedAt: nowIso(),
      resultSummary: result.summary,
      notes: answerNote,
      changedFiles: result.changedFiles,
      commands: result.ranCommands,
      tokenUsage: addUsage(
        addUsage(task.tokenUsage ?? emptyUsage(), result.tokenUsage),
        reviewUsage,
      ),
      costUsd:
        reviewCost === undefined ? totalCost : Number(((totalCost ?? 0) + reviewCost).toFixed(6)),
      verification: taskVerification ?? (verification ? { command: verification } : undefined),
      review,
    });
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
            "Previous attempt used its whole step budget without editing. Start with the edit now; read at most 2 files or exact ranges, then make the change.",
        });
        await appendTaskContext(
          analysis.rootPath,
          `Retry · ${task.id}`,
          "Previous attempt hit the step limit with no file changes. Retrying with the fast profile and an edit-first instruction.",
        );
      } else if (!autoSwitchModels) {
        queue = markTask(queue, task.id, {
          status: "failed",
          notes:
            "Automatic model switching is disabled. Choose another model or enable it in Settings → General.",
        });
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
          changedFiles: [],
          commands: [],
          notes: alternate
            ? `Retrying with ${alternate.provider}/${alternate.model} after the previous attempt failed.`
            : "Retrying after the previous attempt failed.",
        });
      }
      queue = await saveQueue(analysis.rootPath, queue);
      emit({ type: "task", queue, task: queue.tasks.find((item) => item.id === task.id) });
    }
    const finalTask = queue.tasks.find((item) => item.id === task.id);
    if (finalTask && (finalTask.status === "failed" || finalTask.status === "blocked")) {
      queue = blockDependentsOf(queue, finalTask.id);
      queue = await saveQueue(analysis.rootPath, queue);
      emit({ type: "task", queue });
    }
    if (result.stoppedReason === "aborted") break;
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
  const result = aggregateResult(goal.trim(), queue, executed, main.id, main.model);
  emit({ type: "done", result });
  return {
    queue,
    summary: result.summary,
    completed: queue.tasks.filter((task) => task.status === "done").length,
    failed: queue.tasks.filter((task) => task.status === "failed" || task.status === "blocked").length,
    stopped: finalStatus === "stopped",
  };
}

export async function getProjectTaskQueue(projectId: string): Promise<ProjectTaskQueue | null> {
  const analysis = await loadAnalysis(projectId);
  return loadQueue(analysis.rootPath, projectId);
}
