import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  ListChecks,
  Loader2,
  MinusCircle,
} from "lucide-react";
import type { ProjectTask, ProjectTaskQueue } from "../../../shared/tasks";
import { useI18n } from "../i18n";

interface TaskQueueCardProps {
  queue: ProjectTaskQueue;
  defaultOpen?: boolean;
  onRetryFailed?: () => void;
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
}: TaskQueueCardProps) {
  const { t } = useI18n();
  const done = queue.tasks.filter((task) => task.status === "done").length;
  const failed = queue.tasks.filter((task) => task.status === "failed" || task.status === "blocked").length;
  const current =
    queue.tasks.find((task) => task.status === "in_progress") ??
    queue.tasks.find((task) => task.status === "failed" || task.status === "blocked") ??
    queue.tasks.find((task) => task.status === "pending");
  const percent = queue.tasks.length > 0 ? Math.round((done / queue.tasks.length) * 100) : 0;
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
              </small>
              {task.resultSummary ? <p>{task.resultSummary.slice(0, 360)}</p> : null}
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
        <span>
          {t("Context notes")}: <code>{queue.contextPath}</code>
        </span>
        <span>
          {t("Plan")}: <code>{queue.planPath}</code>
        </span>
        <span>
          {t("Digest")}: <code>{queue.digestPath}</code>
        </span>
        {failed > 0 && onRetryFailed ? (
          <button
            className="task-queue-retry"
            onClick={(event) => {
              event.preventDefault();
              onRetryFailed();
            }}
            disabled={queue.status === "running"}
          >
            {t("Retry failed tasks")}
          </button>
        ) : null}
      </div>
    </details>
  );
}
