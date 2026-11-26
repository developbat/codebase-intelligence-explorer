import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  ListChecks,
  Loader2,
  MinusCircle,
  Pencil,
  Save,
  Trash2,
  X,
} from "lucide-react";
import type { ProjectTask, ProjectTaskQueue } from "../../../shared/tasks";
import { formatUsd } from "../../../shared/pricing";
import { useI18n } from "../i18n";

interface TaskQueueCardProps {
  queue: ProjectTaskQueue;
  defaultOpen?: boolean;
  onRetryFailed?: () => void;
  onOpenFile?: (path: string) => void;
  onUpdateTask?: (taskId: string, patch: Partial<ProjectTask>) => void | Promise<void>;
  onDeleteTask?: (taskId: string) => void | Promise<void>;
  onMoveTask?: (taskId: string, direction: "up" | "down") => void | Promise<void>;
  liveStepCount?: number;
  /** Render the task list without the outer collapsible card. */
  flat?: boolean;
}

function tokenLabel(tokens?: number): string {
  if (!tokens) return "";
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

function formatDuration(start?: string, end?: string): string {
  if (!start || !end) return "";
  const seconds = Math.round((Date.parse(end) - Date.parse(start)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
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
  onUpdateTask,
  onDeleteTask,
  onMoveTask,
  liveStepCount = 0,
  flat = false,
}: TaskQueueCardProps) {
  const { t } = useI18n();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    title: "",
    detail: "",
    tokenBudget: "",
    costBudgetUsd: "",
  });
  const editable =
    queue.status !== "running" && Boolean(onUpdateTask || onDeleteTask || onMoveTask);
  const beginEdit = (task: ProjectTask) => {
    setEditingId(task.id);
    setDraft({
      title: task.title,
      detail: task.detail,
      tokenBudget: task.tokenBudget ? String(task.tokenBudget) : "",
      costBudgetUsd: task.costBudgetUsd ? String(task.costBudgetUsd) : "",
    });
  };
  const saveEdit = async (task: ProjectTask) => {
    await onUpdateTask?.(task.id, {
      title: draft.title.trim() || task.title,
      detail: draft.detail,
      tokenBudget: Number(draft.tokenBudget) > 0 ? Number(draft.tokenBudget) : undefined,
      costBudgetUsd:
        Number(draft.costBudgetUsd) > 0 ? Number(draft.costBudgetUsd) : undefined,
    });
    setEditingId(null);
  };
  const done = queue.tasks.filter((task) => task.status === "done").length;
  const failed = queue.tasks.filter((task) => task.status === "failed" || task.status === "blocked").length;
  const current =
    queue.tasks.find((task) => task.status === "in_progress") ??
    queue.tasks.find((task) => task.status === "failed" || task.status === "blocked") ??
    queue.tasks.find((task) => task.status === "pending");
  const totalTokens = queue.tasks.reduce((sum, task) => sum + (task.tokenUsage?.totalTokens ?? 0), 0);
  const totalCost = queue.tasks.reduce((sum, task) => sum + (task.costUsd ?? 0), 0);
  const content = (
    <>
      <div className="task-queue-list">
        {queue.tasks.map((task, taskIndex) => (
          <div
            key={task.id}
            className={`task-queue-item is-${task.status} ${
              current?.id === task.id ? "is-current" : ""
            }`}
          >
            <span className="task-queue-status">{statusIcon(task.status)}</span>
            <div className="task-queue-item-main">
              {editingId === task.id ? (
                <div className="task-queue-edit">
                  <input
                    value={draft.title}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, title: event.target.value }))
                    }
                    aria-label={t("Task title")}
                  />
                  <textarea
                    value={draft.detail}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, detail: event.target.value }))
                    }
                    rows={3}
                    aria-label={t("Task detail")}
                  />
                  <div className="task-queue-edit-budget">
                    <label>
                      {t("Token budget")}
                      <input
                        type="number"
                        min="0"
                        step="1000"
                        value={draft.tokenBudget}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            tokenBudget: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label>
                      {t("Cost budget")}
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={draft.costBudgetUsd}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            costBudgetUsd: event.target.value,
                          }))
                        }
                      />
                    </label>
                  </div>
                  <div className="task-queue-edit-actions">
                    <button onClick={() => void saveEdit(task)}>
                      <Save size={11} /> {t("Save")}
                    </button>
                    <button onClick={() => setEditingId(null)}>
                      <X size={11} /> {t("Cancel")}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div>
                    <code>{task.id}</code>
                    <strong>{task.title}</strong>
                  </div>
                  <details
                    className="task-queue-understanding"
                    open={current?.id === task.id && task.status === "in_progress"}
                  >
                    <summary>{t("What the agent understood")}</summary>
                    <p>{task.detail || task.title}</p>
                    {task.acceptance ? (
                      <small>
                        <b>{t("Acceptance")}:</b> {task.acceptance}
                      </small>
                    ) : null}
                  </details>
                  <small>
                    {t(task.status)} · {t(task.effort)} · {t(task.role)}
                    {task.provider ? ` · ${task.provider}/${task.model ?? ""}` : ""}
                    {task.attempts > 1 ? ` · ${task.attempts} ${t("attempts")}` : ""}
                    {task.tokenUsage?.totalTokens ? ` · ${tokenLabel(task.tokenUsage.totalTokens)} ${t("tokens")}` : ""}
                    {task.startedAt && task.completedAt
                      ? ` · ${formatDuration(task.startedAt, task.completedAt)}`
                      : ""}
                    {task.costUsd ? ` · ${formatUsd(task.costUsd)}` : ""}
                    {task.tokenBudget
                      ? ` · ${t("budget")} ${tokenLabel(task.tokenBudget)}${
                          task.costBudgetUsd ? ` / ${formatUsd(task.costBudgetUsd)}` : ""
                        }`
                      : ""}
                  </small>
                  {task.notes ? <p className="task-queue-note">{task.notes}</p> : null}
                  {task.toolIssues && task.toolIssues.length > 0 ? (
                    <details className="task-queue-tool-issues">
                      <summary>
                        <AlertTriangle size={9} />
                        {t("Tool issues")}
                        <span>{task.toolIssues.length}</span>
                      </summary>
                      <ul>
                        {task.toolIssues.map((issue, issueIndex) => (
                          <li
                            key={issueIndex}
                            className={issue.startsWith("recovered ") ? "is-recovered" : undefined}
                          >
                            {issue}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                  {task.review ? (
                    <div className={`task-queue-review is-${task.review.verdict}`}>
                      <strong>
                        {task.review.verdict === "ok"
                          ? t("Reviewer: no blocking issues")
                          : t("Reviewer found issues")}
                        <span>
                          {task.review.provider}/{task.review.model}
                        </span>
                      </strong>
                      <span>{task.review.summary}</span>
                      {task.review.issues.length > 0 ? (
                        <ul>
                          {task.review.issues.slice(0, 4).map((issue) => (
                            <li key={issue}>{issue}</li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ) : null}
                  {task.resultSummary ? <p>{task.resultSummary}</p> : null}
                  {task.verification?.command ? (
                    <span className={`task-queue-verify ${task.verification.ok ? "is-ok" : "is-failed"}`}>
                      {task.verification.ok ? <CheckCircle2 size={9} /> : <MinusCircle size={9} />}
                      {task.verification.command}
                    </span>
                  ) : null}
                  {editable ? (
                    <div className="task-queue-controls">
                      <button
                        onClick={() => void onMoveTask?.(task.id, "up")}
                        disabled={taskIndex === 0}
                        title={t("Move up")}
                      >
                        <ChevronUp size={11} />
                      </button>
                      <button
                        onClick={() => void onMoveTask?.(task.id, "down")}
                        disabled={taskIndex === queue.tasks.length - 1}
                        title={t("Move down")}
                      >
                        <ChevronDown size={11} />
                      </button>
                      {task.status === "failed" || task.status === "blocked" ? (
                        <button
                          onClick={() =>
                            void onUpdateTask?.(task.id, {
                              status: "done",
                              notes: t("Marked complete manually."),
                            })
                          }
                          title={t("Mark done")}
                        >
                          <CheckCircle2 size={11} />
                        </button>
                      ) : null}
                      <button onClick={() => beginEdit(task)} title={t("Edit task")}>
                        <Pencil size={11} />
                      </button>
                      <button
                        onClick={() => {
                          if (window.confirm(t("Delete this task?"))) {
                            void onDeleteTask?.(task.id);
                          }
                        }}
                        title={t("Delete task")}
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  ) : null}
                </>
              )}
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
    </>
  );
  if (flat) {
    return (
      <div className={`task-queue-card is-flat is-${queue.status}`}>{content}</div>
    );
  }
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
            {liveStepCount > 0 ? ` · ${liveStepCount} ${t("steps")}` : ""}
          </small>
        </span>
        <span className="task-queue-goal">
          {current ? `${t(current.status)} · ${current.title}` : queue.goal}
        </span>
      </summary>
      {content}
    </details>
  );
}
