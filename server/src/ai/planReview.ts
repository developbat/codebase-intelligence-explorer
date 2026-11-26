import crypto from "node:crypto";
import type { AiTokenUsage } from "../../../shared/ai";
import type {
  IntentAnalysis,
  IntentBehaviorAction,
  IntentBehaviorSurface,
} from "../../../shared/intent";
import type { ProjectTask, ProjectTaskEffort, ProjectTaskQueue } from "../../../shared/tasks";
import { chat } from "./providers";
import { resolveAgentRole } from "./settings";
import { recordUsage } from "./usage";
import { estimateUsageCost } from "./pricing";

export const PLAN_VERSION = 2;

const PLAN_REVIEW_SYSTEM = `You are a strict plan reviewer for a coding agent. Compare the user goal, the existing task queue, the changed files and the last failure. Return JSON only.

Schema:
{"verdict":"ok"|"replan","requirements":["one per independent behavior"],"missing":["requirement not covered by the current tasks"],"assumptions":["safe assumption used instead of asking"],"questions":[{"question":"one product decision","options":[{"label":"short option","suffix":"text appended to the user's request if chosen"}]}],"tasks":[{"title":"imperative","detail":"exact work, files if known","acceptance":"how to verify","effort":"simple|standard|hard","action":"create|update|remove|move|verify|run|document|other","surface":"ui|api|data|config|docs|game|other"}]}

Rules:
- Return "ok" when the existing tasks still cover every required behavior and a retry of the failed/blocked task is the right next step.
- Return "replan" when the tasks are stale, merged, missing a behavior, or produced by an older planner. Provide 2-6 tasks, one behavior each, with acceptance criteria.
- Never split a single behavior into busywork. Never create verification-only or cleanup-only tasks.
- Preserve completed work and changed files. A new task must inspect the current files, not undo working changes.
- Always include action and surface on every task; never omit them.
- Ask at most ONE question, and only when a wrong guess would implement the wrong product behavior. Provide 2-3 concrete product options with a suffix. Otherwise return an empty questions array and use a safe assumption.
- Do not ask which files to inspect or where the code lives; the executor handles that.
- Keep the user's exact qualifiers (only, never, smaller/larger, do not change X).
- Write titles, details and acceptance in English. Keep quoted user text and identifiers unchanged.`;

export interface PlanReviewQuestion {
  question: string;
  options: Array<{ label: string; suffix: string }>;
}

export interface PlanReviewResult {
  verdict: "ok" | "replan";
  requirements: string[];
  missing: string[];
  assumptions: string[];
  questions: PlanReviewQuestion[];
  tasks: Array<
    Pick<ProjectTask, "title" | "detail" | "acceptance" | "effort" | "action" | "surface">
  >;
  tokenUsage?: AiTokenUsage;
  costUsd?: number;
  source: "model" | "fallback";
}

export interface PlanReviewOptions {
  projectId?: string;
  signal?: AbortSignal;
  intent?: IntentAnalysis;
  history?: { role: "user" | "assistant"; content: string }[];
  provider?: string;
  model?: string;
}

export function goalHash(goal: string): string {
  return crypto.createHash("sha256").update(goal.trim()).digest("hex").slice(0, 16);
}

export function createPlanMeta(
  goal: string,
  review?: Pick<PlanReviewResult, "requirements" | "missing" | "assumptions">,
  reviewCount = 0,
  requirements?: string[],
): NonNullable<ProjectTaskQueue["planMeta"]> {
  return {
    version: PLAN_VERSION,
    goalHash: goalHash(goal),
    reviewedAt: new Date().toISOString(),
    verdict: "ok",
    requirements: review?.requirements?.length
      ? review.requirements
      : requirements?.length
        ? requirements
        : [goal.trim()],
    missing: review?.missing ?? [],
    assumptions: review?.assumptions ?? [],
    reviewCount,
  };
}

export function shouldReviewPlan(
  queue: ProjectTaskQueue,
  goal: string,
  options: { replan?: boolean; workspaceMode?: string } = {},
): boolean {
  if (options.workspaceMode !== undefined && options.workspaceMode !== "build") return false;
  if (options.replan === true) return true;
  const failed = queue.tasks.some((task) => task.status === "failed" || task.status === "blocked");
  const singleMulti =
    queue.tasks.length <= 1 && (queue.planMeta?.requirements.length ?? 0) > 1;
  // A fresh, large build plan gets one coverage review before any tokens are
  // spent on execution. This catches plans that silently omit goal behaviors
  // (movement, key/win flow, restart, ...).
  const largeGoal = goal.trim().length >= 800 || queue.tasks.length >= 3;
  const freshLargePlan = largeGoal && (queue.planMeta?.reviewCount ?? 0) === 0;
  if (freshLargePlan) return true;
  if (!queue.planMeta) return failed || singleMulti;
  if (queue.planMeta.version !== PLAN_VERSION) return true;
  if (queue.planMeta.goalHash !== goalHash(goal)) return true;
  if (failed && (queue.planMeta.reviewCount ?? 0) < 1) return true;
  return singleMulti;
}

function cleanJson(value: string): string {
  const trimmed = value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Plan reviewer did not return JSON.");
  return trimmed.slice(start, end + 1);
}

function stringList(value: unknown, limit = 8): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim().slice(0, 500))
        .slice(0, limit)
    : [];
}

function reviewQuestions(value: unknown): PlanReviewQuestion[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      question:
        typeof item.question === "string" && item.question.trim()
          ? item.question.trim().slice(0, 300)
          : "",
      options: Array.isArray(item.options)
        ? item.options
            .filter(
              (option): option is Record<string, unknown> =>
                Boolean(option) && typeof option === "object",
            )
            .map((option) => ({
              label:
                typeof option.label === "string" && option.label.trim()
                  ? option.label.trim().slice(0, 80)
                  : "",
              suffix:
                typeof option.suffix === "string" && option.suffix.trim()
                  ? option.suffix.trim().slice(0, 400)
                  : "",
            }))
            .filter((option) => option.label && option.suffix)
            .slice(0, 3)
        : [],
    }))
    .filter((question) => question.question && question.options.length >= 2)
    .slice(0, 1);
}

const TASK_ACTIONS = new Set<IntentBehaviorAction>([
  "create",
  "update",
  "remove",
  "move",
  "verify",
  "run",
  "document",
  "other",
]);
const TASK_SURFACES = new Set<IntentBehaviorSurface>([
  "ui",
  "api",
  "data",
  "config",
  "docs",
  "game",
  "other",
]);

function reviewTasks(value: unknown): PlanReviewResult["tasks"] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map(
      (
        item,
      ): Pick<ProjectTask, "title" | "detail" | "acceptance" | "effort" | "action" | "surface"> => ({
        title:
          typeof item.title === "string" && item.title.trim()
            ? item.title.trim().slice(0, 140)
            : "",
        detail:
          typeof item.detail === "string" && item.detail.trim()
            ? item.detail.trim().slice(0, 3_000)
            : "",
        acceptance:
          typeof item.acceptance === "string" && item.acceptance.trim()
            ? item.acceptance.trim().slice(0, 800)
            : "The behavior works and is verified on the real page.",
        effort: (item.effort === "simple" || item.effort === "hard"
          ? item.effort
          : "standard") as ProjectTaskEffort,
        action:
          typeof item.action === "string" &&
          TASK_ACTIONS.has(item.action as IntentBehaviorAction)
            ? (item.action as IntentBehaviorAction)
            : undefined,
        surface:
          typeof item.surface === "string" &&
          TASK_SURFACES.has(item.surface as IntentBehaviorSurface)
            ? (item.surface as IntentBehaviorSurface)
            : undefined,
      }),
    )
    .filter((item) => item.title && item.detail)
    .slice(0, 6);
}

function fallbackReview(
  goal: string,
  queue: ProjectTaskQueue,
  intent?: IntentAnalysis,
): PlanReviewResult {
  const requirements = intent?.behaviors?.length
    ? intent.behaviors.map((behavior) => `${behavior.target}${behavior.details ? `: ${behavior.details}` : ""}`)
    : queue.planMeta?.requirements.length
      ? queue.planMeta.requirements
      : [goal.trim()];
  if (queue.tasks.length <= 1 && requirements.length >= 2) {
    return {
      verdict: "replan",
      requirements,
      missing: requirements,
      assumptions: ["The goal contains independent behaviors that need separate tasks."],
      questions: [],
      tasks: [],
      source: "fallback",
    };
  }
  return {
    verdict: "ok",
    requirements,
    missing: [],
    assumptions: [],
    questions: [],
    tasks: [],
    source: "fallback",
  };
}

export async function reviewProjectPlan(
  goal: string,
  queue: ProjectTaskQueue,
  options: PlanReviewOptions = {},
): Promise<PlanReviewResult> {
  const config = await resolveAgentRole("planner", {
    provider: options.provider,
    model: options.model,
  }).catch(() => null);
  if (!config) return fallbackReview(goal, queue, options.intent);
  const tasks = queue.tasks
    .map(
      (task) =>
        `- ${task.status} · ${task.title}\n  ${task.detail.slice(0, 700)}${
          task.acceptance ? `\n  Acceptance: ${task.acceptance.slice(0, 300)}` : ""
        }${task.changedFiles.length ? `\n  Changed: ${task.changedFiles.join(", ")}` : ""}${
          task.resultSummary ? `\n  Last result: ${task.resultSummary.slice(0, 400)}` : ""
        }`,
    )
    .join("\n");
  const changed = [...new Set(queue.tasks.flatMap((task) => task.changedFiles))];
  const messages = [
    { role: "system" as const, content: PLAN_REVIEW_SYSTEM },
    {
      role: "user" as const,
      content: [
        `User goal:\n${goal.trim()}`,
        options.intent
          ? `Intent: ${options.intent.kind} · ${options.intent.scope} · ${options.intent.mode}\n${options.intent.understanding}${
              options.intent.normalizedRequest
                ? `\nNormalized: ${options.intent.normalizedRequest}`
                : ""
            }${
              options.intent.behaviors?.length
                ? `\nBehaviors: ${JSON.stringify(options.intent.behaviors).slice(0, 2_000)}`
                : ""
            }${
              options.intent.constraints?.length
                ? `\nConstraints: ${options.intent.constraints.join("; ")}`
                : ""
            }${
              options.intent.confidence !== undefined
                ? `\nConfidence: ${options.intent.confidence}`
                : ""
            }`
          : "",
        options.intent?.skills?.length ? `Intent-selected skills: ${options.intent.skills.join(", ")}` : "",
        changed.length > 0 ? `Already changed files: ${changed.join(", ")}` : "",
        `Current queue (${queue.tasks.length} tasks, plan version ${queue.planMeta?.version ?? "none"}):\n${tasks}`,
        options.history?.length
          ? `Recent conversation:\n${options.history
              .slice(-6)
              .map((message) => `${message.role}: ${message.content.slice(0, 500)}`)
              .join("\n")}`
          : "",
        "Return the JSON object only.",
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];
  let tokenUsage: AiTokenUsage | undefined;
  try {
    const text = await chat(config, messages, {
      maxTokens: 2_500,
      temperature: 0.1,
      timeoutMs: 90_000,
      signal: options.signal,
      onUsage: (usage) => {
        tokenUsage = usage;
      },
    });
    if (!tokenUsage) {
      tokenUsage = {
        inputTokens: Math.ceil(messages.reduce((sum, message) => sum + message.content.length, 0) / 4),
        outputTokens: Math.ceil(text.length / 4),
        totalTokens:
          Math.ceil(messages.reduce((sum, message) => sum + message.content.length, 0) / 4) +
          Math.ceil(text.length / 4),
      };
    }
    const parsed = JSON.parse(cleanJson(text)) as Record<string, unknown>;
    const verdict = parsed.verdict === "replan" ? "replan" : "ok";
    const result: PlanReviewResult = {
      verdict,
      requirements: stringList(parsed.requirements, 10),
      missing: stringList(parsed.missing, 10),
      assumptions: stringList(parsed.assumptions, 8),
      questions: reviewQuestions(parsed.questions),
      tasks: reviewTasks(parsed.tasks),
      tokenUsage,
      source: "model",
    };
    const costUsd = await estimateUsageCost(config.id, config.model, tokenUsage).catch(() => undefined);
    result.costUsd = costUsd;
    if (options.projectId) {
      await recordUsage({
        projectId: options.projectId,
        provider: config.id,
        model: config.model,
        kind: "plan.review",
        inputTokens: tokenUsage.inputTokens,
        outputTokens: tokenUsage.outputTokens,
        totalTokens: tokenUsage.totalTokens,
      }).catch(() => undefined);
    }
    return result;
  } catch {
    return { ...fallbackReview(goal, queue, options.intent), tokenUsage };
  }
}
