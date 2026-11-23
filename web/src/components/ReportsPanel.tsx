import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ClipboardList, Loader2, RefreshCw } from "lucide-react";
import type { AiUsageReport } from "../../../shared/ai";
import type { ModelHealthReport } from "../../../shared/modelHealth";
import type { ProjectTaskQueue } from "../../../shared/tasks";
import { formatUsd } from "../../../shared/pricing";
import { api } from "../api";
import { useI18n } from "../i18n";

function tokens(value?: number): string {
  if (!value) return "0";
  return value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(2)}M`
    : value >= 1_000
      ? `${(value / 1_000).toFixed(1)}k`
      : String(value);
}

export function ReportsPanel({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const [usage, setUsage] = useState<AiUsageReport | null>(null);
  const [queue, setQueue] = useState<ProjectTaskQueue | null>(null);
  const [health, setHealth] = useState<ModelHealthReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setBusy(true);
    setError(null);
    const [usageResult, queueResult, healthResult] = await Promise.allSettled([
      api.usage(projectId),
      api.tasks.get(projectId),
      api.ai.modelHealth(),
    ]);
    if (usageResult.status === "fulfilled") setUsage(usageResult.value);
    if (queueResult.status === "fulfilled") setQueue(queueResult.value.queue);
    if (healthResult.status === "fulfilled") setHealth(healthResult.value);
    const failed = [usageResult, queueResult, healthResult].find(
      (result) => result.status === "rejected",
    );
    if (failed?.status === "rejected") {
      setError(
        failed.reason instanceof Error ? failed.reason.message : t("Some report data could not be loaded."),
      );
    }
    setBusy(false);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const byKind = useMemo(() => {
    const groups = new Map<string, { tokens: number; input: number; output: number; requests: number; cost: number }>();
    for (const entry of usage?.recent ?? []) {
      const key = entry.kind || "other";
      const group = groups.get(key) ?? { tokens: 0, input: 0, output: 0, requests: 0, cost: 0 };
      group.tokens += entry.totalTokens;
      group.input += entry.inputTokens;
      group.output += entry.outputTokens;
      group.requests += 1;
      group.cost += entry.costUsd ?? 0;
      groups.set(key, group);
    }
    return [...groups.entries()]
      .map(([kind, value]) => ({ kind, ...value }))
      .sort((a, b) => b.tokens - a.tokens);
  }, [usage]);

  const totalStepTokens = useMemo(
    () =>
      (queue?.tasks ?? []).reduce(
        (sum, task) => sum + (task.tokenUsage?.totalTokens ?? 0),
        0,
      ),
    [queue],
  );
  const executedSteps = useMemo(
    () => (queue?.tasks ?? []).reduce((sum, task) => sum + task.attempts, 0),
    [queue],
  );

  return (
    <div className="reports-panel">
      <div className="reports-head">
        <div>
          <h3>
            <ClipboardList size={14} /> {t("Reports")}
          </h3>
          <p>
            {t(
              "Task outcomes, stop reasons, token/cost breakdown and model fallbacks for this project.",
            )}
          </p>
        </div>
        <button className="ghost-button" onClick={() => void load()} disabled={busy}>
          {busy ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
          {t("Refresh")}
        </button>
      </div>

      {error ? (
        <div className="reports-error">
          <AlertTriangle size={12} /> {error}
        </div>
      ) : null}

      <div className="reports-cards">
        <div>
          <span>{t("Total tokens")}</span>
          <strong>{tokens(usage?.total.totalTokens)}</strong>
          <small>{t("Last 7 days")}: {tokens(usage?.last7Days.totalTokens)}</small>
        </div>
        <div>
          <span>{t("Cost")}</span>
          <strong>{formatUsd(usage?.totalCostUsd)}</strong>
          <small>{t("Last 7 days")}: {formatUsd(usage?.last7DaysCostUsd)}</small>
        </div>
        <div>
          <span>{t("Task tokens")}</span>
          <strong>{tokens(totalStepTokens)}</strong>
          <small>
            {queue?.tasks.length ?? 0} {t("tasks")} · {executedSteps} {t("attempts")}
          </small>
        </div>
        <div>
          <span>{t("Model fallbacks")}</span>
          <strong>{health?.fallbacks?.length ?? 0}</strong>
          <small>{t("Recent automatic switches")}</small>
        </div>
      </div>

      <section className="reports-section">
        <div className="reports-section-head">
          <h4>{t("Current task run")}</h4>
          {queue ? <span className={`reports-status is-${queue.status}`}>{t(queue.status)}</span> : null}
        </div>
        {!queue ? (
          <p className="reports-empty">{t("No task queue has been recorded for this project.")}</p>
        ) : (
          <>
            <p className="reports-goal">{queue.goal}</p>
            <div className="reports-task-list">
              {queue.tasks.map((task) => (
                <div key={task.id} className={`reports-task is-${task.status}`}>
                  <div className="reports-task-title">
                    <code>{task.id}</code>
                    <strong>{task.title}</strong>
                    <span>{t(task.status)}</span>
                  </div>
                  <div className="reports-task-meta">
                    <span>{t(task.effort)} · {t(task.role)}</span>
                    <span>{task.provider ?? "—"}/{task.model ?? "—"}</span>
                    <span>
                      {tokens(task.tokenUsage?.totalTokens)} {t("tokens")}
                      {task.costUsd ? ` · ${formatUsd(task.costUsd)}` : ""}
                    </span>
                    <span>
                      {task.tokenUsage
                        ? `${tokens(task.tokenUsage.inputTokens)} in / ${tokens(task.tokenUsage.outputTokens)} out`
                        : t("No usage recorded")}
                    </span>
                    <span>{task.attempts} {t("attempts")}</span>
                  </div>
                  {task.notes ? <p className="reports-note">{task.notes}</p> : null}
                  {task.verification?.command ? (
                    <p className={`reports-verify ${task.verification.ok ? "is-ok" : "is-fail"}`}>
                      {t("Verification")}: {task.verification.command} ·{" "}
                      {task.verification.ok ? t("passed") : t("failed")}
                    </p>
                  ) : null}
                  {task.review ? (
                    <p className={`reports-review ${task.review.verdict === "ok" ? "is-ok" : "is-fail"}`}>
                      {t("Reviewer")}: {task.review.summary}
                      {task.review.issues.length > 0 ? ` · ${task.review.issues.join("; ")}` : ""}
                    </p>
                  ) : null}
                  {task.changedFiles.length > 0 ? (
                    <div className="reports-files">
                      {task.changedFiles.map((file) => (
                        <code key={file}>{file}</code>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
            <div className="reports-paths">
              <span>{t("Plan")}: <code>{queue.planPath.split("/").pop()}</code></span>
              <span>{t("Context notes")}: <code>{queue.contextPath.split("/").pop()}</code></span>
              <span>{t("Digest")}: <code>{queue.digestPath.split("/").pop()}</code></span>
            </div>
          </>
        )}
      </section>

      <section className="reports-section">
        <div className="reports-section-head">
          <h4>{t("Token breakdown by phase")}</h4>
          <span>{t("Recent requests")}</span>
        </div>
        {byKind.length === 0 ? (
          <p className="reports-empty">{t("No usage entries yet.")}</p>
        ) : (
          <div className="reports-table">
            {byKind.map((row) => (
              <div key={row.kind}>
                <code>{row.kind}</code>
                <span>{row.requests} {t("requests")}</span>
                <span>{tokens(row.input)} in</span>
                <span>{tokens(row.output)} out</span>
                <strong>{tokens(row.tokens)}</strong>
                <span>{formatUsd(row.cost)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="reports-section">
        <div className="reports-section-head">
          <h4>{t("Model fallbacks")}</h4>
          <span>{health?.models?.length ?? 0} {t("models tracked")}</span>
        </div>
        {(health?.fallbacks ?? []).length === 0 ? (
          <p className="reports-empty">{t("No automatic model switches recorded.")}</p>
        ) : (
          <div className="reports-table">
            {(health?.fallbacks ?? []).slice(0, 20).map((event, index) => (
              <div key={`${event.at}-${index}`}>
                <code>{event.fromProvider}/{event.fromModel}</code>
                <span>→</span>
                <code>{event.toProvider}/{event.toModel}</code>
                <span>{event.reason}</span>
                <small>{new Date(event.at).toLocaleString()}</small>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
