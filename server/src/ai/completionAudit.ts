import fs from "node:fs/promises";
import path from "node:path";
import type { AnalysisResult } from "../../../shared/types";
import type { ProjectTask, ProjectTaskQueue } from "../../../shared/tasks";
import type { AiAgentStep } from "../../../shared/ai";

const NO_CHANGE =
  /(?:no files? (?:was|is|were|are) changed|no (?:further )?(?:code )?changes? (?:needed|required)|nothing (?:was|is) (?:changed|rewritten)|already (?:meets|satisfies|matches|present|exists|implemented|applied|complete)|zaten (?:var|mevcut|uyguluyor|uygulanmış|yapılmış)|hiçbir dosya değiştirilmedi|dosya değiştirilmedi|değişiklik (?:gerekmiyor|yapılmadı))/i;

interface RunRecord {
  taskId?: string;
  changedFiles?: unknown;
  summary?: unknown;
  steps?: unknown;
}

function normalize(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function parseArgs(step: AiAgentStep): Record<string, unknown> {
  const raw = step.args as unknown;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

function rawArgs(step: AiAgentStep): string {
  const raw = step.args as unknown;
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw ?? {});
  } catch {
    return "";
  }
}

function hasAssertion(step: AiAgentStep): boolean {
  if (!step.ok) return false;
  if (step.action === "run_test_scenario") return true;
  if (step.action !== "browser_check" && step.action !== "game_check") return false;

  const raw = rawArgs(step);
  const args = parseArgs(step);
  const steps = Array.isArray(args.steps)
    ? args.steps.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object",
      )
    : [];

  if (steps.length > 0) {
    const interaction = steps.some((item) =>
      ["click", "fill", "press", "pressKeys", "eval"].includes(
        String(item.action ?? ""),
      ),
    );
    const assertion = steps.some(
      (item) =>
        ["expectText", "expectValue", "expectCount", "expectStable", "waitForText"].includes(
          String(item.action ?? ""),
        ) ||
        (String(item.action ?? "") === "eval" && typeof item.expectText === "string"),
    );
    if (interaction && assertion) return true;
  }

  // The run journal stores at most 600 chars of args, so a long browser_check
  // is usually cut off before its expectText. The step is still `ok: true`,
  // which means every assertion inside it passed. Use the retained prefix to
  // confirm it was a real interaction plus assertion, not an empty smoke call.
  const interaction = /"action"\s*:\s*"(?:click|fill|press|pressKeys|eval)"/.test(raw);
  const assertion =
    /"action"\s*:\s*"(?:expectText|expectValue|expectCount|expectStable|waitForText)"/.test(raw) ||
    /"expectText"\s*:/.test(raw);
  return interaction && assertion;
}

function hasRuntimeEvidence(steps: AiAgentStep[] | undefined): boolean {
  return Boolean(steps?.some(hasAssertion));
}

function runChangedFiles(run: RunRecord): string[] {
  return Array.isArray(run.changedFiles)
    ? run.changedFiles.filter((file): file is string => typeof file === "string")
    : [];
}

async function recentRuns(
  rootPath: string,
  taskId: string,
  limit = 5,
): Promise<RunRecord[]> {
  const directory = path.join(rootPath, ".cie", "agent", "runs");
  let entries: string[] = [];
  try {
    entries = (await fs.readdir(directory)).filter(
      (name) => name.startsWith(`${taskId}-`) && name.endsWith(".json"),
    );
  } catch {
    return [];
  }
  const candidates: { file: string; time: number }[] = [];
  for (const entry of entries) {
    const stat = await fs.stat(path.join(directory, entry)).catch(() => null);
    if (stat) candidates.push({ file: path.join(directory, entry), time: stat.mtimeMs });
  }
  candidates.sort((a, b) => b.time - a.time);
  const runs: RunRecord[] = [];
  for (const candidate of candidates.slice(0, limit)) {
    try {
      const parsed = JSON.parse(await fs.readFile(candidate.file, "utf8")) as RunRecord;
      if (parsed && typeof parsed === "object") runs.push(parsed);
    } catch {
      // Ignore an incomplete journal and try the previous run.
    }
  }
  return runs;
}

export interface ContinuationAuditResult {
  completed: boolean;
  queue: ProjectTaskQueue;
  task?: ProjectTask;
  reason: string;
}

/**
 * Before a manual "Continue" re-runs the same failed/blocked build session,
 * check whether a recent attempt already proved the work complete:
 * no changed files + a no-change summary + a passing real-page assertion.
 * This makes Continue idempotent and prevents repeating a 200k+ token audit.
 */
export async function auditCompletedWork(
  analysis: AnalysisResult,
  queue: ProjectTaskQueue,
): Promise<ContinuationAuditResult> {
  if (queue.status === "completed") {
    return { completed: false, queue, reason: "Queue is already completed." };
  }
  for (const task of queue.tasks) {
    if (task.status !== "failed" && task.status !== "blocked") continue;
    if ((task.changedFiles?.length ?? 0) > 0) continue;
    const runs = await recentRuns(analysis.rootPath, task.id);
    if (runs.length === 0) continue;
    // A newer run that changed a file means the working tree moved on; the
    // earlier no-change evidence is stale.
    if (runChangedFiles(runs[0]).length > 0) continue;
    for (const run of runs) {
      if (runChangedFiles(run).length > 0) break;
      const steps = Array.isArray(run.steps) ? (run.steps as AiAgentStep[]) : [];
      if (!hasRuntimeEvidence(steps)) continue;
      const runSummary = normalize(run.summary);
      const taskSummary = normalize(task.resultSummary);
      if (!NO_CHANGE.test(runSummary) && !NO_CHANGE.test(taskSummary)) continue;
      const completedTask: ProjectTask = {
        ...task,
        status: "done",
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        notes: [
          task.notes,
          "Continuation audit: the latest attempt changed no files, reported no further change, and passed a real-page interaction + assertion. The task is already complete; no model replay was needed.",
        ]
          .filter(Boolean)
          .join("\n"),
      };
      const nextQueue: ProjectTaskQueue = {
        ...queue,
        status: "completed",
        updatedAt: new Date().toISOString(),
        tasks: queue.tasks.map((item) =>
          item.id === task.id ? completedTask : item,
        ),
      };
      return {
        completed: true,
        queue: nextQueue,
        task: completedTask,
        reason: "No files changed + passing real-page check in a recent run.",
      };
    }
  }
  return {
    completed: false,
    queue,
    reason:
      "No failed/blocked task has both zero changes and a passing real-page check.",
  };
}
