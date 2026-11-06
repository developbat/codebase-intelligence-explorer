import { useEffect, useState } from "react";
import {
  AlertTriangle,
  BrainCircuit,
  CheckCircle2,
  FileCode2,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  X,
} from "lucide-react";
import type { AiReviewResult, AiSettingsPublic } from "../../../shared/ai";
import type { ChangeReport } from "../../../shared/types";
import { api } from "../api";
import { useI18n } from "../i18n";
import { activeProvider } from "../lib/ai";

interface AiReviewDialogProps {
  open: boolean;
  projectId: string;
  changeReport: ChangeReport | null;
  settings: AiSettingsPublic | null;
  onClose: () => void;
  onOpenSettings: () => void;
  onOpenFile: (filePath: string) => void;
}

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 } as const;

export function AiReviewDialog({
  open,
  projectId,
  changeReport,
  settings,
  onClose,
  onOpenSettings,
  onOpenFile,
}: AiReviewDialogProps) {
  const { t, tn, locale } = useI18n();
  const [result, setResult] = useState<AiReviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setResult(null);
    setError(null);
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const active = activeProvider(settings);
  const configured = Boolean(active);

  async function run(force = false) {
    if (!active) return;
    setLoading(true);
    setError(null);
    try {
      const review = await api.ai.review(
        projectId,
        active.provider,
        active.model,
        force,
        changeReport?.files.map((file) => file.path),
        changeReport?.git.analysisHead,
        locale,
      );
      setResult(review);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("AI review failed."));
    } finally {
      setLoading(false);
    }
  }

  const findings = [...(result?.findings ?? [])].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="ai-modal ai-review-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="modal-eyebrow">{t("Changes since analysis")}</div>
            <h2>
              <BrainCircuit size={18} /> {t("AI code review")}
            </h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label={t("Close")}>
            <X size={16} />
          </button>
        </div>

        {!configured ? (
          <div className="ai-setup-callout large">
            <Sparkles size={18} />
            <div>
              <strong>{t("Connect a model to review changes.")}</strong>
              <p>
                {t(
                  "The reviewer reads the actual Git diff and project graph, then reports concrete risks with file and line references.",
                )}
              </p>
              <button className="action-button primary" onClick={onOpenSettings}>
                {t("Configure AI")}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="review-toolbar">
              <div className="review-change-summary">
                <span>{tn(changeReport?.summary.changedFiles ?? 0, "{count} changed file", "{count} changed files")}</span>
                <span>{tn(changeReport?.summary.changedSymbols ?? 0, "{count} changed symbol", "{count} changed symbols")}</span>
                <span>{tn(changeReport?.summary.impactNodes ?? 0, "{count} impacted node", "{count} impacted nodes")}</span>
              </div>
              <button className="primary-button" onClick={() => run(Boolean(result))} disabled={loading}>
                {loading ? <Loader2 size={13} className="spin" /> : result ? <RefreshCw size={13} /> : <Sparkles size={13} />}
                {loading ? t("Reviewing diff…") : result ? t("Run review again") : t("Review pending changes")}
              </button>
            </div>

            {error ? (
              <div className="source-error">
                <AlertTriangle size={13} /> {error}
              </div>
            ) : null}

            {result ? (
              <div className="review-result">
                <div className="review-headline">
                  <span className={`risk-badge risk-${result.riskLevel}`}>
                    <ShieldAlert size={12} /> {t("Risk")}: {t(result.riskLevel)}
                  </span>
                  <span className="ai-model-badge">
                    {result.provider} · {result.model}
                  </span>
                  {result.cached ? <span className="ai-cache-badge">{t("cached")}</span> : null}
                  <span className="review-file-count">
                    {tn(result.filesReviewed.length, "{count} file reviewed", "{count} files reviewed")}
                    {result.usage ? ` · ${result.usage.estimatedTokens} ${t("tokens")}` : ""}
                  </span>
                </div>
                <p className="review-summary">{result.summary}</p>

                {findings.length === 0 ? (
                  <div className="review-clean">
                    <CheckCircle2 size={18} />
                    <span>{t("No material issues were found in the provided diff.")}</span>
                  </div>
                ) : (
                  <div className="finding-list">
                    {findings.map((finding, index) => (
                      <div key={index} className={`finding finding-${finding.severity}`}>
                        <div className="finding-head">
                          <span className={`severity-badge severity-${finding.severity}`}>
                            {t(finding.severity)}
                          </span>
                          <span className="finding-category">{finding.category}</span>
                          <button className="finding-file" onClick={() => onOpenFile(finding.file)}>
                            <FileCode2 size={10} />
                            {finding.file}
                            {finding.line ? `:${finding.line}` : ""}
                          </button>
                        </div>
                        <div className="finding-title">{finding.title}</div>
                        <p className="finding-description">{finding.description}</p>
                        {finding.suggestion ? (
                          <p className="finding-suggestion">
                            <strong>{t("Suggestion")}:</strong> {finding.suggestion}
                          </p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}

                <div className="ai-disclaimer">
                  <CheckCircle2 size={11} />
                  {t("AI review is advisory. Verify findings against the diff and tests.")}
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
