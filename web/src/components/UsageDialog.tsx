import { useEffect, useState } from "react";
import { BarChart3, Loader2, X } from "lucide-react";
import type { AiUsageReport, AiTokenUsage } from "../../../shared/ai";
import { api } from "../api";
import { useI18n } from "../i18n";

export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(value));
}

function UsageCard({ label, usage }: { label: string; usage: AiTokenUsage }) {
  return (
    <div className="usage-card">
      <span>{label}</span>
      <strong>{formatTokens(usage.totalTokens)}</strong>
      <small>
        in {formatTokens(usage.inputTokens)} · out {formatTokens(usage.outputTokens)}
      </small>
    </div>
  );
}

export function UsageDialog({
  open,
  projectId,
  projectName,
  embedded = false,
  onClose,
}: {
  open: boolean;
  projectId: string;
  projectName: string;
  embedded?: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [report, setReport] = useState<AiUsageReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setBusy(true);
    setError(null);
    api
      .usage(projectId)
      .then((value) => {
        if (!cancelled) setReport(value);
      })
      .catch((requestError) => {
        if (!cancelled) {
          setError(requestError instanceof Error ? requestError.message : t("Could not load usage."));
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId, t]);

  if (!open) return null;

  return (
    <div
      className={embedded ? "settings-embedded-backdrop" : "modal-backdrop"}
      onMouseDown={embedded ? undefined : onClose}
    >
      <div
        className={embedded ? "settings-embedded-panel" : "ai-modal usage-modal"}
        onMouseDown={embedded ? undefined : (event) => event.stopPropagation()}
      >
        {embedded ? null : (
          <div className="modal-header">
            <div>
              <div className="modal-eyebrow">{t("Token budget")}</div>
              <h2>
                <BarChart3 size={16} /> {projectName}
              </h2>
            </div>
            <button className="icon-button" onClick={onClose} aria-label={t("Close")}>
              <X size={16} />
            </button>
          </div>
        )}
        <p className="modal-text">
          {t(
            "Usage is recorded locally for every AI request in this project, grouped by model and day.",
          )}
        </p>

        {busy ? (
          <div className="usage-loading">
            <Loader2 size={16} className="spin" /> {t("Loading usage…")}
          </div>
        ) : error ? (
          <div className="ai-test-result is-error">{error}</div>
        ) : report ? (
          <div className="usage-body">
            <div className="usage-cards">
              <UsageCard label={t("Today")} usage={report.today} />
              <UsageCard label={t("Last 7 days")} usage={report.last7Days} />
              <UsageCard label={t("All time")} usage={report.total} />
            </div>

            <div className="usage-section">
              <strong>{t("By model")}</strong>
              {report.byModel.length === 0 ? (
                <div className="usage-empty">{t("No AI usage recorded for this project yet.")}</div>
              ) : (
                <table className="usage-table">
                  <thead>
                    <tr>
                      <th>{t("Provider")}</th>
                      <th>{t("Model")}</th>
                      <th>{t("Requests")}</th>
                      <th>{t("Input")}</th>
                      <th>{t("Output")}</th>
                      <th>{t("Total")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.byModel.map((bucket) => (
                      <tr key={`${bucket.provider}-${bucket.model}`}>
                        <td>{bucket.provider}</td>
                        <td className="mono">{bucket.model}</td>
                        <td>{bucket.requests}</td>
                        <td>{formatTokens(bucket.inputTokens)}</td>
                        <td>{formatTokens(bucket.outputTokens)}</td>
                        <td className="strong">{formatTokens(bucket.totalTokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="usage-section">
              <strong>{t("Daily")}</strong>
              {report.byDay.length === 0 ? (
                <div className="usage-empty">{t("No daily usage yet.")}</div>
              ) : (
                <table className="usage-table">
                  <thead>
                    <tr>
                      <th>{t("Day")}</th>
                      <th>{t("Requests")}</th>
                      <th>{t("Input")}</th>
                      <th>{t("Output")}</th>
                      <th>{t("Total")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.byDay.map((day) => (
                      <tr key={day.day}>
                        <td className="mono">{day.day}</td>
                        <td>{day.requests}</td>
                        <td>{formatTokens(day.inputTokens)}</td>
                        <td>{formatTokens(day.outputTokens)}</td>
                        <td className="strong">{formatTokens(day.totalTokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="usage-section">
              <strong>{t("Recent requests")}</strong>
              {report.recent.length === 0 ? (
                <div className="usage-empty">{t("No requests yet.")}</div>
              ) : (
                <div className="usage-recent">
                  {report.recent.map((entry) => (
                    <div key={entry.id}>
                      <span className="mono">{new Date(entry.createdAt).toLocaleString()}</span>
                      <span>{entry.kind}</span>
                      <span className="mono">{entry.model}</span>
                      <strong>{formatTokens(entry.totalTokens)}</strong>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
