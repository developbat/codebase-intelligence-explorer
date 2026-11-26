import crypto from "node:crypto";
import type { AiTokenUsage } from "../../../shared/ai";
import type { IntentAnalysis } from "../../../shared/intent";
import type { ProjectTask, ProjectTaskEffort, ProjectTaskQueue } from "../../../shared/tasks";
import { chat } from "./providers";
import { resolveAgentRole } from "./settings";
import { recordUsage } from "./usage";
import { estimateUsageCost } from "./pricing";

export const PLAN_VERSION = 2;

const PLAN_REVIEW_SYSTEM = `You are a strict plan reviewer for a coding agent. Compare the user goal, the existing task queue, the changed files and the last failure. Return JSON only.

Schema:
{"verdict":"ok"|"replan","requirements":["one per independent behavior"],"missing":["requirement not covered by the current tasks"],"assumptions":["safe assumption used instead of asking"],"tasks":[{"title":"imperative","detail":"exact work, files if known","acceptance":"how to verify","effort":"simple|standard|hard"}]}

Rules:
- Return "ok" when the existing tasks still cover every required behavior and a retry of the failed/blocked task is the right next step.
- Return "replan" when the tasks are stale, merged, missing a behavior, or produced by an older planner. Provide 2-6 tasks, one behavior each, with acceptance criteria.
- Never split a single behavior into busywork. Never create verification-only or cleanup-only tasks.
- Preserve completed work and changed files. A new task must inspect the current files, not undo working changes.
- Ask no questions. Use the smallest safe assumption and list it. Only list an assumption when a wrong guess would change the product behavior.
- Keep the user's exact qualifiers (only, never, smaller/larger, do not change X).
- Write titles, details and acceptance in English. Keep quoted user text and identifiers unchanged.`;

export interface PlanReviewResult {
  verdict: "ok" | "replan";
  requirements: string[];
  missing: string[];
  assumptions: string[];
  tasks: Array<Pick<ProjectTask, "title" | "detail" | "acceptance" | "effort">>;
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

export function behaviorKeys(goal: string): string[] {
  const cleaned = goal.trim();
  if (!cleaned) return [];
  const parts = cleaned
    .split(/\s+(?:ve|and|ayrıca|ayrica|;)\s+/i)
    .map((part) => part.trim().replace(/[.,;]+$/, ""))
    .filter((part) => part.split(/\s+/).filter(Boolean).length >= 2);
  return parts.length >= 2 ? parts.slice(0, 6) : [cleaned];
}

export function goalHash(goal: string): string {
  return crypto.createHash("sha256").update(goal.trim()).digest("hex").slice(0, 16);
}

export function createPlanMeta(
  goal: string,
  review?: Pick<PlanReviewResult, "requirements" | "missing" | "assumptions">,
  reviewCount = 0,
): NonNullable<ProjectTaskQueue["planMeta"]> {
  return {
    version: PLAN_VERSION,
    goalHash: goalHash(goal),
    reviewedAt: new Date().toISOString(),
    verdict: "ok",
    requirements: review?.requirements?.length ? review.requirements : behaviorKeys(goal),
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
  const singleMulti = queue.tasks.length <= 1 && behaviorKeys(goal).length >= 2;
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

function reviewTasks(value: unknown): PlanReviewResult["tasks"] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item): Pick<ProjectTask, "title" | "detail" | "acceptance" | "effort"> => ({
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
    }))
    .filter((item) => item.title && item.detail)
    .slice(0, 6);
}

function fallbackReview(goal: string, queue: ProjectTaskQueue): PlanReviewResult {
  const requirements = behaviorKeys(goal);
  if (queue.tasks.length <= 1 && requirements.length >= 2) {
    return {
      verdict: "replan",
      requirements,
      missing: requirements,
      assumptions: ["The goal contains independent behaviors that need separate tasks."],
      tasks: [],
      source: "fallback",
    };
  }
  return {
    verdict: "ok",
    requirements,
    missing: [],
    assumptions: [],
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
  if (!config) return fallbackReview(goal, queue);
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
          ? `Intent: ${options.intent.kind} · ${options.intent.scope} · ${options.intent.mode}\n${options.intent.understanding}`
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
    return { ...fallbackReview(goal, queue), tokenUsage };
  }
}
