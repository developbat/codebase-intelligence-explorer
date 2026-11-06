import { useEffect, useState } from "react";
import {
  AlertTriangle,
  BrainCircuit,
  CheckCircle2,
  FileCode2,
  Loader2,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import type { AnalysisResult } from "../../../shared/types";
import type { AiBusinessFlowsResult, AiSettingsPublic } from "../../../shared/ai";
import { api } from "../api";
import { useI18n } from "../i18n";
import { activeProvider } from "../lib/ai";

interface AiFlowsDialogProps {
  open: boolean;
  projectId: string;
  analysis: AnalysisResult;
  settings: AiSettingsPublic | null;
  onClose: () => void;
  onOpenSettings: () => void;
  onOpenFile: (filePath: string) => void;
}

export function AiFlowsDialog({
  open,
  projectId,
  analysis,
  settings,
  onClose,
  onOpenSettings,
  onOpenFile,
}: AiFlowsDialogProps) {
  const { t, locale } = useI18n();
  const active = activeProvider(settings);
  const [result, setResult] = useState<AiBusinessFlowsResult | null>(null);
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

  async function run(force = false) {
    if (!active) return;
    setLoading(true);
    setError(null);
    try {
      const flows = await api.ai.flows(projectId, active.provider, active.model, force, locale);
      setResult(flows);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("Flow discovery failed."));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="ai-modal ai-flows-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="modal-eyebrow">{t("Architecture")}</div>
            <h2>
              <BrainCircuit size={18} /> {t("AI business flows")}
            </h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label={t("Close")}>
            <X size={16} />
          </button>
        </div>

        {!active ? (
          <div className="ai-setup-callout large">
            <Sparkles size={18} />
            <div>
              <strong>{t("Discover end-to-end business flows.")}</strong>
              <p>
                {t(
                  "The model follows routes, controllers, services, database access, and events, then turns them into concrete business flows with source evidence.",
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
                <span>{t("{count} routes", { count: analysis.stats.routes })}</span>
                <span>{t("{count} events", { count: analysis.stats.events })}</span>
                <span>{t("{count} database objects", { count: analysis.stats.databases })}</span>
              </div>
              <button className="primary-button" onClick={() => run(Boolean(result))} disabled={loading}>
                {loading ? <Loader2 size={13} className="spin" /> : result ? <RefreshCw size={13} /> : <Sparkles size={13} />}
                {loading ? t("Tracing flows…") : result ? t("Discover again") : t("Discover business flows")}
              </button>
            </div>

            {error ? (
              <div className="source-error">
                <AlertTriangle size={13} /> {error}
              </div>
            ) : null}

            {result ? (
              <div className="flows-result">
                <div className="review-headline">
                  <span className="ai-model-badge">
                    {result.provider} · {result.model}
                  </span>
                  {result.cached ? <span className="ai-cache-badge">{t("cached")}</span> : null}
                  {result.usage ? (
                    <span className="review-file-count">
                      {result.usage.estimatedTokens} {t("tokens")}
                    </span>
                  ) : null}
                </div>
                {result.flows.length === 0 ? (
                  <div className="review-clean">
                    <CheckCircle2 size={18} />
                    <span>{t("No business flows were detected.")}</span>
                  </div>
                ) : (
                  <div className="flow-list">
                    {result.flows.map((flow, flowIndex) => (
                      <div key={flowIndex} className="flow-card">
                        <div className="flow-head">
                          <span className="flow-index">{flowIndex + 1}</span>
                          <div>
                            <div className="flow-name">{flow.name}</div>
                            <div className="flow-description">{flow.description}</div>
                          </div>
                          <span className={`risk-badge risk-${flow.confidence}`}>
                            {t("confidence")}: {t(flow.confidence)}
                          </span>
                        </div>
                        <ol className="flow-steps">
                          {flow.steps.map((step, stepIndex) => (
                            <li key={stepIndex}>
                              <span className="flow-step-index">{stepIndex + 1}</span>
                              <span className="flow-step-main">
                                <span className="flow-step-label">{step.label}</span>
                                {step.description ? (
                                  <span className="flow-step-description">{step.description}</span>
                                ) : null}
                                {step.file ? (
                                  <button className="flow-step-file" onClick={() => onOpenFile(step.file!)}>
                                    <FileCode2 size={9} />
                                    {step.file}
                                    {step.startLine ? `:${step.startLine}` : ""}
                                  </button>
                                ) : null}
                              </span>
                            </li>
                          ))}
                        </ol>
                        {flow.entities.length > 0 ? (
                          <div className="ai-chips">
                            {flow.entities.map((entity) => (
                              <code key={entity}>{entity}</code>
                            ))}
                          </div>
                        ) : null}
                        {flow.risks.length > 0 ? (
                          <ul className="ai-risk-list">
                            {flow.risks.map((risk, riskIndex) => (
                              <li key={riskIndex}>
                                <AlertTriangle size={10} /> {risk}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
                <div className="ai-disclaimer">
                  <CheckCircle2 size={11} />
                  {t("Flows are inferred from the graph and source. Incomplete chains are marked by lower confidence.")}
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
