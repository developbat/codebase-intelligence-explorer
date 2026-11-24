import type { AiAgentStep } from "../../../shared/ai";
import type { ProjectTask } from "../../../shared/tasks";

/**
 * Global recovery policy for every agent task, in every project.
 *
 * The editor must recover from a bad run by itself: a failure caused by the
 * runtime, a read-only loop or a changed file must be diagnosed, repaired and
 * retried without asking the user to start the task again.
 */
export const RECOVERY_POLICY = {
  /** How often one task may be narrowed and retried before it is blocked. */
  maxRepairsPerTask: 2,
  /** Hard cap for automatic repairs in a single task-loop call. */
  maxRepairsPerRun: 3,
  /** Files a narrowed retry may inspect before it must edit. */
  maxFilesForNarrowRetry: 2,
} as const;

const ENVIRONMENT_PATTERN =
  /segmentation fault|sigsegv|exit 139|fatal python error|externally-managed-environment|no module named|modulenotfounderror|python.*not found|pandas.*crash/i;

const READ_LOOP_PATTERN =
  /kept reading|read budget exhausted|no file change|read-only loop|kept trying to read/i;

export function isEnvironmentFailure(steps: AiAgentStep[] | undefined, text = ""): boolean {
  if (ENVIRONMENT_PATTERN.test(text)) return true;
  return (steps ?? []).some((step) => ENVIRONMENT_PATTERN.test(step.observation ?? ""));
}

export function isReadLoopFailure(text: string): boolean {
  return READ_LOOP_PATTERN.test(text);
}

export function environmentRepairNote(detail = ""): string {
  return [
    "Environment repair: the previous attempt failed because of the Python runtime, not the task logic.",
    "The app now creates the project .venv with a stable Python (3.12/3.13) and puts .venv/bin first on PATH.",
    "Run Python through ./.venv/bin/python (or plain python3, which resolves inside the venv). Never use pip install --break-system-packages.",
    detail ? `Observed failure: ${detail.slice(0, 300)}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function targetFiles(task: ProjectTask): string[] {
  const text = `${task.title}\n${task.detail}\n${task.changedFiles.join("\n")}`;
  const matches =
    text.match(
      /(?:^|[\s`"'(])([A-Za-z0-9_@./-]+\.(?:js|mjs|cjs|jsx|ts|tsx|css|html?|py|php|go|rs|java|kt|swift|dart|rb|lua|json|md))(?=$|[\s`"'),:])/gm,
    ) ?? [];
  return [...new Set(matches.map((match) => match.trim().replace(/^\.\//, "")))].slice(0, 4);
}

/**
 * Turn a task that burned its budget by reading into one small, edit-first
 * task. It keeps the original id and changed files so dependent tasks and
 * completed work are preserved.
 */
export function narrowTaskForEditFirst(
  task: ProjectTask,
  reason: string,
): ProjectTask {
  const files = targetFiles(task);
  const repairs = (task.repairAttempts ?? 0) + 1;
  const fileHint =
    files.length > 0
      ? `Target file(s): ${files.join(", ")}.`
      : "Use the file names already mentioned in the task and in the changed-file list.";
  return {
    ...task,
    status: "pending",
    effort: "simple",
    role: "main",
    attempts: 0,
    repairAttempts: repairs,
    tokenUsage: undefined,
    resultSummary: undefined,
    verification: undefined,
    detail: [
      task.detail,
      "",
      `Narrow auto-repair #${repairs}: ${reason}.`,
      fileHint,
      `Read at most ${RECOVERY_POLICY.maxFilesForNarrowRetry} files (or read no file at all if the content is already in context), then apply the smallest edit with replace_in_file or write_file.`,
      "Do not re-read a file or range you already saw. Do not restart the task, do not recreate existing files and do not revert completed work.",
      "If the requested behavior already exists, verify it and finish with evidence instead of rewriting it.",
    ].join("\n"),
    acceptance: `${task.acceptance ?? task.title} Only the missing change is required; existing work must remain intact.`,
    notes: [task.notes, "Narrow edit-first retry: read little, edit now, verify."]
      .filter(Boolean)
      .join("\n"),
    updatedAt: new Date().toISOString(),
  };
}

/** A resume must continue from the current project, never replay done tasks. */
export function buildResumeContract(
  doneTasks: ProjectTask[],
  current: ProjectTask,
): string {
  const done = doneTasks
    .filter((task) => task.id !== current.id && task.status === "done")
    .slice(-8)
    .map(
      (task) =>
        `- ${task.id} ${task.title}${task.changedFiles.length > 0 ? ` (files: ${task.changedFiles.join(", ")})` : ""}`,
    );
  const changed = [...new Set(current.changedFiles)].filter((file) => !file.startsWith(".cie/"));
  return [
    "Resume contract — this is a continuation, not a restart.",
    done.length > 0
      ? `Completed tasks stay done; do not redo them:\n${done.join("\n")}`
      : "No earlier task is complete; continue from the current files.",
    changed.length > 0
      ? `Files already changed for this task: ${changed.join(", ")}. Inspect them before editing and preserve working code.`
      : "Check the target file before writing; do not recreate or overwrite working files blindly.",
    "Only implement the missing part of the current task, then verify it.",
  ].join("\n");
}
