import type { ProjectTaskHistoryEntry, ProjectTaskQueue } from "../../../shared/tasks";
import type { IntentAnalysis } from "../../../shared/intent";

const RECENT_WORK_QUESTION =
  /\b(?:son ne yaptık|ne yaptık|son değişiklik(?:ler)?|neler değişti|son durum|son görev|son iş|what did we do|what have we done|what changed|last changes?|recent work|last work|summary of (?:the )?(?:last|recent) work)\b/i;

/**
 * A question about the latest work must be answered from task records, not
 * turned into another agent task. This is the cheap path for "son ne yaptık?".
 */
export function isRecentWorkQuestion(
  instruction: string,
  intent?: Pick<IntentAnalysis, "normalizedRequest" | "behaviors">,
): boolean {
  const text = [
    instruction,
    intent?.normalizedRequest,
    ...(intent?.behaviors ?? []).flatMap((behavior) => [
      behavior.target,
      behavior.details,
      behavior.acceptance,
    ]),
  ]
    .filter(Boolean)
    .join("\n");
  return RECENT_WORK_QUESTION.test(text);
}

/**
 * A short question that only asks for a work summary. It must not contain a
 * concrete action; otherwise the request is a task and needs the normal path.
 */
export function isPureRecentWorkQuestion(instruction: string): boolean {
  const text = instruction.trim();
  if (text.length === 0 || text.length > 140) return false;
  if (
    /\b(?:ekle|ekley|düzelt|duzelt|değiştir|degistir|kaldır|kaldir|oluştur|olustur|güncelle|guncelle|taşı|tasi|sil|add|fix|change|remove|create|build|implement|update|move|delete)\b/i.test(
      text,
    )
  ) {
    return false;
  }
  return isRecentWorkQuestion(text);
}

function cleanWorkText(value: string | undefined, max: number): string {
  const sentences = (value ?? "")
    .replace(/\s+/g, " ")
    .split(/(?<=\.)\s+/)
    .map((sentence) => sentence.trim())
    .filter(
      (sentence) =>
        sentence.length > 0 &&
        !/^(?:do not request|reuse the earlier|switch model|reply with|work completed|last successful tool|the model repeatedly)/i.test(
          sentence,
        ),
    );
  return short(sentences.join(" "), max);
}

export function renderRecentWorkAnswer(
  queue: ProjectTaskQueue | null,
  history: ProjectTaskHistoryEntry[] = [],
  language = "en",
): string {
  const tr = /^tr/i.test(language);
  const lines: string[] = [];
  const latest = history[0];
  if (latest) {
    lines.push(tr ? `**Son görev:** ${latest.goal}` : `**Last goal:** ${latest.goal}`);
    lines.push(`${tr ? "Durum" : "Status"}: ${latest.status}`);
    for (const task of latest.tasks.slice(0, 3)) {
      const parts = [
        `- ${task.status}: ${short(task.title, 180)}`,
        task.changedFiles.length > 0
          ? `${tr ? "değişen" : "changed"}: ${task.changedFiles.join(", ")}`
          : "",
        task.resultSummary ? cleanWorkText(task.resultSummary, 400) : "",
        task.notes ? cleanWorkText(task.notes, 300) : "",
      ].filter(Boolean);
      lines.push(parts.join(" · "));
    }
    if (latest.tasks.some((task) => task.changedFiles.length > 0)) {
      lines.push(
        tr
          ? "Not: Görev blocked olsa da değişen dosyalar korunur; kod doğrulaması ayrıca yapılmalıdır."
          : "Note: changed files are kept even when the task is blocked; verify the code separately.",
      );
    }
  } else if (queue) {
    lines.push(tr ? `**Son görev:** ${queue.goal}` : `**Last goal:** ${queue.goal}`);
    lines.push(`${tr ? "Durum" : "Status"}: ${queue.status}`);
    for (const task of queue.tasks.slice(0, 3)) {
      lines.push(`- ${task.status}: ${short(task.title, 180)}`);
    }
  }
  const earlier = latest ? history.slice(1, 4) : history.slice(0, 3);
  if (earlier.length > 0) {
    lines.push(tr ? "**Önceki görevler:**" : "**Earlier goals:**");
    for (const entry of earlier) {
      const done = entry.tasks.filter((task) => task.status === "done").length;
      lines.push(
        `- ${short(entry.goal, 180)} · ${entry.status} · ${done}/${entry.tasks.length} done`,
      );
    }
  }
  return lines.length > 0
    ? lines.join("\n\n").slice(0, 4_000)
    : tr
      ? "Kayıtlı bir görev yok."
      : "No recorded work yet.";
}

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
    "When asked what was done last, start with the most recent previous goal and include failed/blocked attempts. Do not report only completed tasks.",
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
    const [latest, ...earlier] = history;
    lines.push("Most recent previous goal (report this first when asked what was done last, even if failed/blocked):");
    lines.push(`- ${short(latest.goal, 240)} · ${latest.status}`);
    for (const task of latest.tasks.slice(0, 3)) {
      lines.push(`  - ${task.status}: ${short(task.title, 140)}`);
      if (task.changedFiles.length > 0) {
        lines.push(`    changed: ${task.changedFiles.join(", ")}`);
      }
      if (task.resultSummary) {
        lines.push(`    result: ${short(task.resultSummary, 600)}`);
      }
      if (task.notes) {
        lines.push(`    notes: ${short(task.notes, 300)}`);
      }
    }
    if (earlier.length > 0) {
      lines.push("Earlier goals:");
      for (const entry of earlier.slice(0, 3)) {
        const done = entry.tasks.filter((task) => task.status === "done").length;
        lines.push(
          `- ${short(entry.goal, 160)} · ${entry.status} · ${done}/${entry.tasks.length} done`,
        );
      }
    }
  }
  return lines.join("\n").slice(0, 5_000);
}
