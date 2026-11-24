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
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir, loadAnalysis } from "../store";
import { readSourceFile } from "../editor";
import { checkFileSyntax } from "../syntax";
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
  healthKey,
  modelHealthByProviderModel,
  recordModelFallback,
} from "./modelStats";
import { estimateUsageCost } from "./pricing";
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
{"tasks":[{"title":"short imperative title","detail":"exact work, files/areas if known","acceptance":"how to verify this task","effort":"simple|standard|hard"}]}
Rules:
- 2-8 tasks. Each task must be independently verifiable.
- Split multi-feature goals: if the goal asks for several independent changes (add X, replace Y, change Z, check W), return one task per feature. Never put the whole goal in one task.
- Each task must describe one behavior change with its own acceptance check. A task that says "and" for two unrelated features must be split.
- Do not create tasks that only edit tests, scenarios, test hooks or verification scripts. Fold that work into the behavior task it verifies. A task must change runtime behavior or fix a bug.
- Order tasks by dependency and value: correctness and item effects first, then spawn frequency, then visual/feedback polish.
- Never create a task only to deduplicate or normalize existing definitions. Put the "do not re-add existing items" constraint in the relevant behavior task's acceptance instead.
- Small mechanical edits are "simple"; normal implementation is "standard"; broad refactors/debugging are "hard".
- Fold verification into the last behavior task. Do not create a separate verification-only task; the executor runs the project's verification command itself.
- Do not invent files that do not exist; inspect is allowed later by the executor.
- Use the project map and goal-relevant symbols to name the correct file/function. If a symbol hint points to a file, use that file as the primary edit target. Prefer files loaded by the HTML entry or imported by it. Do not add runtime behavior to a file that is not loaded; verify an import before using an unreferenced file.
- Do not invent cleanup/dedup tasks unless the project map or a concrete duplicate shows it is needed. Verify first.
- The context notes in .cie/agent/context.md and .cie/agent/TASKS.md are for continuity; you may mention them.
- Write task titles, details and acceptance in English. Keep quoted user text, file paths, function names and code identifiers unchanged.
- Never return placeholder tasks such as "...", "TODO", "TBD" or "fill me". Every task must contain a real title, detail and acceptance.
- Work in any programming language.`;

export function splitLargeGoal(goal: string, verification?: string): ProjectTask[] | null {
  if (goal.length < 160) return null;
  if (/```|\{\s*"|https?:\/\//.test(goal)) return null;
  // Goals that contain constraints, verification or "do not re-add" rules are
  // one instruction, not a list of independent features. Splitting them
  // produces fragments like "zaten var olan itemleri yeniden ekleme" as tasks.
  if (
    /(?:yeniden ekleme|ekleme\b|bozma|kanıtla|doğrula|raporla|göster|listele|kullanılmıyorsa|zaten var|mevcut .{0,30}koru|sadece .{0,30}bakma)/i.test(
      goal,
    )
  ) {
    return null;
  }
  const sentences = goal
    .split(/(?:[.!?;]+|\n+)\s*/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 12 && sentence.split(/\s+/).length >= 4);
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

function isVerificationOnlyTask(task: ProjectTask): boolean {
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
    /\b(verify|verification|validate|runtime check|test the|run the test|doğrula|kontrol et|test et|çalışma zamanı)/i.test(
      text,
    );
  const write =
    /\b(add|fix|update|change|implement|create|remove|delete|rename|refactor|move|write|repair|wire|restore|ensure|enable|tune|adjust|enforce|report|expose|register|route|convert|support|extend|validate|return|reject|handle|respond)\b|düzelt|ekle|güncelle|değiştir|kaldır|sil|taşı|yaz|onar|bağla/i.test(
      text,
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
    /** Build a queue for inspection without writing it to the project. */
    dryRun?: boolean;
  } = {},
): Promise<ProjectTaskQueue> {
  const analysis = await loadAnalysis(projectId);
  const verification = preferredVerificationCommand(analysis.tooling);
  const config = await resolveAgentRole("planner");
  const projectMap = await ensureProjectMap(analysis).catch(() => "");
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
        `Project files (all): ${allFiles}`,
        goalFiles.length > 0 ? `Goal-relevant files: ${goalFiles.join(", ")}` : "",
        goalHints.length > 0
          ? `Goal-relevant existing symbols (use these files as primary edit targets): ${goalHints.join(
              "; ",
            )}`
          : "",
        projectMap ? `Project map (use it for file and symbol ownership):\n${projectMap.slice(0, 14_000)}` : "",
        "Write task titles, details and acceptance in English. Keep quoted user text, file paths and code identifiers unchanged.",
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
    const split = splitLargeGoal(goal, verification);
    if (split) {
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
    };
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

const TASK_WRITE_VERBS =
  /\b(add|create|implement|update|change|edit|write|refactor|fix|remove|delete|rename|move|append|replace|insert|build|generate|repair|wire|restore|ensure|enable|tune|adjust|enforce|expose|register|convert|support|extend|validate|improve|optimize|enhance)\b|oluştur|ekle|güncelle|değiştir|düzelt|sil|taşı|yaz|kaldır|onar|bağla|kaydet|düzenle|iyileştir|optimize et/i;
const TASK_INSPECTION_VERBS =
  /\b(inspect|read|review|verify|check|analy[sz]e|research|understand|plan|list|show|explain|find|enumerate|count)\b|incele|oku|gözden geçir|doğrula|kontrol et|araştır|listele|listeler|listeleme|liste|göster|açıkla|say/i;

export function taskLooksLikeWrite(task: ProjectTask): boolean {
  const title = task.title;
  const titleWrite = TASK_WRITE_VERBS.test(title);
  // The title is the user's actual goal. The detail is model-generated planning
  // text and often says "create a list", "report" or "build an inventory" even
  // for a read-only question. Never let that wording turn a list/question into
  // a project edit.
  if (TASK_INSPECTION_VERBS.test(title) && !titleWrite) return false;
  if (titleWrite) return true;
  return TASK_WRITE_VERBS.test(task.detail);
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
    /\b(inspect|read|review|analy[sz]e|research|understand|explore|audit|list|enumerate|count)\b|incele|oku|gözden geçir|araştır|analiz et|listele|listeler|listeleme|liste|kaç|kontrol et|kontrol/i;
  const write = /\b(fix|update|add|create|write|implement|change|remove|delete|rename|move|refactor|repair|wire|restore|ensure|enable|tune|adjust|enforce|report|expose|register|route)\b|düzelt|ekle|oluştur|yaz|güncelle|değiştir|sil|taşı|onar|bağla/i;
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
): string {
  const brief = resolveWorkBrief(task.title);
  const extractionTask = brief?.mode === "extract";
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
    extractionTask
      ? "This is a read-only complete-list task. Do not read .cie/agent context files, do not run grep/shell commands, do not use list_items or browser_check. Call extract_entities with the matching kind once, then finish with every item in the user's language."
      : continuation
        ? "This is a continuation of your previous answer. Its findings are authoritative. Do not rescan or re-read the project; read only the exact lines you will edit, then apply the change and verify it on the real app."
        : "Read .cie/agent/context-digest.md first for compact prior context. Read .cie/agent/context.md only when the digest and summaries are insufficient; if it is large, search it with find_in_file or read only the relevant tail. Append useful durable context if you learn something new.",
    extractionTask
      ? "Do not edit files and do not add runtime checks; the extraction table is the evidence."
      : inspection
        ? "This is a read-only inspection/diagnosis task. Do not edit files. Collect the minimum evidence, then finish with a compact diagnosis: root cause, file:line evidence, runtime proof, and the exact fix that would be needed. Do not keep reading after you have evidence."
        : "Before editing, check whether the requested behavior already exists. If it does, verify it and finish with evidence instead of adding a duplicate implementation.",
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
        )}. They may contain partial work from an interrupted run. Inspect them first. If the requested behavior already exists, verify it and finish with evidence; do not rewrite or duplicate it.`
      : "",
    extractionTask ? "" : "Do not re-read files already fully read by a previous task unless the current task needs exact content after a change.",
    extractionTask ? "" : "Batch up to 4 independent read-only calls in one reply (read_file, find_in_file, search_code, list_files). One context round-trip per batch instead of one per read.",
    extractionTask ? "" : "Read the smallest range you need. Do not read a whole large file before planning; read the relevant functions, then edit. If you have read the same file twice without editing, stop reading and make the smallest change.",
    "Stay scoped to this task. Do not do later tasks. Do not revert earlier work.",
    verification && !extractionTask ? `Verification command: ${verification}` : "",
    extractionTask
      ? "Finish only after the extraction tool returned the complete list; do not summarize or omit items."
      : "Run tests/typecheck/build when relevant. If the task includes validation, permissions, errors or limits, verify both the accepted and rejected path. Finish only when this task is complete, or report the exact blocker.",
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
          : readOnly
            ? "The question is answered with code-referenced evidence; no project files are changed."
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
    const recoveries = new Map<string, RetryRecovery>();
    for (const task of queue.tasks) {
      if (task.status !== "failed" && task.status !== "blocked") continue;
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
    queue = {
      ...queue,
      tasks: queue.tasks.map((task) => {
        if (task.status !== "failed" && task.status !== "blocked") return task;
        const recovery = recoveries.get(task.id);
        const notes = [recovery?.note, task.notes].filter(Boolean).join("\n\n");
        return {
          ...task,
          status: "pending",
          attempts: 0,
          repairAttempts: 0,
          modelOverride: undefined,
          completedAt: undefined,
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
    await startAgentRunLive(analysis.rootPath, task.id, current.attempts).catch(() => {});
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
    let result: AiAgentResult | null = null;
    try {
      result = await runAgentTask(
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
          forceFast: current.effort === "simple",
          forceWrite,
          tokenBudget,
          costBudgetUsd,
          budgetMode: settings?.taskBudgetMode ?? "off",
          maxOutputTokens: settings?.agentMaxOutputTokens ?? 16_000,
          startingUsage: current.tokenUsage,
          intent: options.intent,
          workBriefText: current.title,
          history: options.history?.slice(-8),
          liveBrowser: options.liveBrowser === true,
        },
        (event) => {
          if (event.type === "done") {
            result = event.result;
            return;
          }
          void appendAgentRunEvent(analysis.rootPath, task.id, current.attempts, event).catch(
            () => {},
          );
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
    const failedToolSteps = result.steps.filter(
      (step) => !step.ok && step.action !== "invalid" && step.action !== "finish",
    );
    const lastFailedTool = [...failedToolSteps].reverse()[0];
    const runLogPath = await saveAgentRun(analysis.rootPath, {
      taskId: task.id,
      attempt: current.attempts,
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

    const changedBefore = (task.changedFiles?.length ?? 0) + result.changedFiles.length;
    const taskSpentTokens = addUsage(
      task.tokenUsage ?? emptyUsage(),
      result.tokenUsage,
    ).totalTokens;
    const noEditTokenBurn = changedBefore === 0 && taskSpentTokens >= 300_000;
    if (
      status !== "done" &&
      result.stoppedReason !== "aborted" &&
      (readBudgetStalled || noEditTokenBurn)
    ) {
      const reason = readBudgetStalled
        ? "kept reading instead of editing"
        : "produced no file change";
      queue = markTask(queue, task.id, {
        status: "blocked",
        completedAt: nowIso(),
        notes: `Blocked: the previous attempt ${reason} after ${taskSpentTokens.toLocaleString()} tokens. Automatic retry was stopped to prevent an endless loop. Split this goal into smaller single-behavior tasks, or retry manually with a narrower scope.`,
      });
      await appendTaskContext(
        analysis.rootPath,
        `Blocked · ${task.id}`,
        `The task ${reason} after ${taskSpentTokens.toLocaleString()} tokens. Automatic retry stopped; split the goal or narrow the scope.`,
      );
      await appendLesson(
        analysis.rootPath,
        `${task.id} ${reason} after ${taskSpentTokens.toLocaleString()} tokens. Split multi-feature goals into one behavior per task; do not re-read the same file ranges.`,
      ).catch(() => {});
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
          notes:
            "Automatic model switching is disabled. Choose another model or enable it in Settings → General.",
        });
      } else if (!modelFailure) {
        // The provider answered normally; the task itself was incomplete.
        // Do not switch models for task-quality failures.
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
          notes: `Retry the same model: the provider worked, but the task was incomplete. Continue from the current files, complete the missing work and verify it. Do not restart from scratch.${
            failedToolNote ? ` ${failedToolNote}` : ""
          }${runLogNote}`,
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
      (finalTask.repairAttempts ?? 0) < 2 &&
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
          changedFiles: task.changedFiles ?? [],
          commands: task.commands ?? [],
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
