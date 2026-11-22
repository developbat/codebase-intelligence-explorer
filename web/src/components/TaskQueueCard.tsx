import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  ListChecks,
  Loader2,
  MinusCircle,
} from "lucide-react";
import type { ProjectTask, ProjectTaskQueue } from "../../../shared/tasks";
import { formatUsd } from "../../../shared/pricing";
import { useI18n } from "../i18n";

interface TaskQueueCardProps {
  queue: ProjectTaskQueue;
  defaultOpen?: boolean;
  onRetryFailed?: () => void;
  onOpenFile?: (path: string) => void;
}

function tokenLabel(tokens?: number): string {
  if (!tokens) return "";
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

function statusIcon(status: ProjectTask["status"]) {
  if (status === "done") return <CheckCircle2 size={11} />;
  if (status === "in_progress") return <Loader2 size={11} className="spin" />;
  if (status === "failed" || status === "blocked") return <AlertTriangle size={11} />;
  return <Circle size={11} />;
}

export function TaskQueueCard({
  queue,
  defaultOpen = false,
  onRetryFailed,
  onOpenFile,
}: TaskQueueCardProps) {
  const { t } = useI18n();
  const done = queue.tasks.filter((task) => task.status === "done").length;
  const failed = queue.tasks.filter((task) => task.status === "failed" || task.status === "blocked").length;
  const current =
    queue.tasks.find((task) => task.status === "in_progress") ??
    queue.tasks.find((task) => task.status === "failed" || task.status === "blocked") ??
    queue.tasks.find((task) => task.status === "pending");
  const percent = queue.tasks.length > 0 ? Math.round((done / queue.tasks.length) * 100) : 0;
  const totalTokens = queue.tasks.reduce((sum, task) => sum + (task.tokenUsage?.totalTokens ?? 0), 0);
  const totalCost = queue.tasks.reduce((sum, task) => sum + (task.costUsd ?? 0), 0);
  return (
    <details className={`task-queue-card is-${queue.status}`} open={defaultOpen ? true : undefined}>
      <summary>
        <span className="task-queue-icon">
          <ListChecks size={13} />
        </span>
        <span className="task-queue-title">
          <strong>{t("Task queue")}</strong>
          <small>
            {done}/{queue.tasks.length} {t("done")}
            {failed > 0 ? ` · ${failed} ${t("failed")}` : ""} · {t(queue.status)}
            {totalTokens > 0 ? ` · ${tokenLabel(totalTokens)} ${t("tokens")}` : ""}
            {totalCost > 0 ? ` · ${formatUsd(totalCost)}` : ""}
          </small>
        </span>
        <span className="task-queue-progress" aria-hidden="true">
          <i style={{ width: `${percent}%` }} />
        </span>
        <span className="task-queue-goal">
          {current ? `${t(current.status)} · ${current.title}` : queue.goal}
        </span>
      </summary>
      <div className="task-queue-list">
        {queue.tasks.map((task) => (
          <div
            key={task.id}
            className={`task-queue-item is-${task.status} ${
              current?.id === task.id ? "is-current" : ""
            }`}
          >
            <span className="task-queue-status">{statusIcon(task.status)}</span>
            <div className="task-queue-item-main">
              <div>
                <code>{task.id}</code>
                <strong>{task.title}</strong>
              </div>
              <small>
                {t(task.status)} · {t(task.effort)} · {t(task.role)}
                {task.provider ? ` · ${task.provider}/${task.model ?? ""}` : ""}
                {task.attempts > 1 ? ` · ${task.attempts} ${t("attempts")}` : ""}
                {task.tokenUsage?.totalTokens ? ` · ${tokenLabel(task.tokenUsage.totalTokens)} ${t("tokens")}` : ""}
                {task.costUsd ? ` · ${formatUsd(task.costUsd)}` : ""}
              </small>
              {task.notes ? <p className="task-queue-note">{task.notes}</p> : null}
              {task.resultSummary ? <p>{task.resultSummary}</p> : null}
              {task.verification?.command ? (
                <span className={`task-queue-verify ${task.verification.ok ? "is-ok" : "is-failed"}`}>
                  {task.verification.ok ? <CheckCircle2 size={9} /> : <MinusCircle size={9} />}
                  {task.verification.command}
                </span>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      <div className="task-queue-foot">
        <button
          className="task-queue-file-link"
          onClick={() => onOpenFile?.(queue.digestPath)}
          disabled={!onOpenFile}
          title={queue.digestPath}
        >
          {t("Digest")}: <code>{queue.digestPath.split("/").pop()}</code>
        </button>
        <button
          className="task-queue-file-link"
          onClick={() => onOpenFile?.(queue.planPath)}
          disabled={!onOpenFile}
          title={queue.planPath}
        >
          {t("Plan")}: <code>{queue.planPath.split("/").pop()}</code>
        </button>
        <button
          className="task-queue-file-link"
          onClick={() => onOpenFile?.(queue.contextPath)}
          disabled={!onOpenFile}
          title={queue.contextPath}
        >
          {t("Context notes")}: <code>{queue.contextPath.split("/").pop()}</code>
        </button>
        {failed > 0 && onRetryFailed ? (
          <button
            className="task-queue-retry"
            onClick={(event) => {
              event.preventDefault();
              onRetryFailed();
            }}
            disabled={queue.status === "running"}
          >
            {t(queue.status === "stopped" ? "Continue remaining tasks" : "Retry failed tasks")}
          </button>
        ) : null}
      </div>
    </details>
  );
}
