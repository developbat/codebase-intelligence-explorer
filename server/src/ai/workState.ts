import type { ProjectTaskHistoryEntry, ProjectTaskQueue } from "../../../shared/tasks";

function short(value: string | undefined, max: number): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Compact, authoritative record of the latest work. Chat uses this when the
 * user asks what was done; it separates loop status from evidence.
 */
export function summarizeWorkState(
  queue: ProjectTaskQueue | null,
  history: ProjectTaskHistoryEntry[] = [],
): string {
  const lines: string[] = [
    "Recent work (authoritative for what was done; use it when the user asks what you did):",
  ];
  if (!queue) {
    lines.push("No task queue recorded yet.");
  } else {
    lines.push(`Goal: ${short(queue.goal, 300)}`);
    lines.push(`Queue status: ${queue.status}`);
    const done = queue.tasks.filter((task) => task.status === "done").length;
    lines.push(`Tasks: ${done}/${queue.tasks.length} done`);
    for (const task of queue.tasks) {
      lines.push(`- ${task.id} ${task.status}: ${short(task.title, 140)}`);
      if (task.changedFiles.length > 0) {
        lines.push(`  changed: ${task.changedFiles.join(", ")}`);
      }
      if (task.verification?.command) {
        lines.push(
          `  verification: ${task.verification.command} ${task.verification.ok ? "passed" : "failed"}`,
        );
      }
      if (task.resultSummary) {
        lines.push(`  result: ${short(task.resultSummary, 700)}`);
      }
      if (task.notes) {
        lines.push(`  notes: ${short(task.notes, 300)}`);
      }
    }
    lines.push(
      "Status is the loop state, not the product truth: if a task is failed/blocked but its result or verification shows the work was implemented and passed, say that clearly and mention the loop status separately. Do not claim completion without evidence.",
    );
  }
  if (history.length > 0) {
    lines.push("Earlier goals:");
    for (const entry of history.slice(0, 3)) {
      const done = entry.tasks.filter((task) => task.status === "done").length;
      lines.push(
        `- ${short(entry.goal, 160)} · ${entry.status} · ${done}/${entry.tasks.length} done`,
      );
    }
  }
  return lines.join("\n").slice(0, 5_000);
}
