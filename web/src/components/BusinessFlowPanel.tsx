import { useEffect, useState } from "react";
import {
  AlertTriangle,
  BrainCircuit,
  CheckCircle2,
  FileCode2,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import type { AnalysisResult } from "../../../shared/types";
import type { AiBusinessFlowsResult, AiSettingsPublic } from "../../../shared/ai";
import { api } from "../api";
import { activeProvider } from "../lib/ai";
import { useI18n } from "../i18n";

interface BusinessFlowPanelProps {
  analysis: AnalysisResult;
  settings: AiSettingsPublic | null;
  onOpenSettings: () => void;
  onOpenFile: (filePath: string) => void;
}

export function BusinessFlowPanel({
  analysis,
  settings,
  onOpenSettings,
  onOpenFile,
}: BusinessFlowPanelProps) {
  const { t, locale } = useI18n();
  const active = activeProvider(settings);
  const [result, setResult] = useState<AiBusinessFlowsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setResult(null);
    setError(null);
  }, [analysis.id]);

  async function run(force = false) {
    if (!active) return;
    setLoading(true);
    setError(null);
    try {
      const flows = await api.ai.flows(analysis.id, active.provider, active.model, force, locale);
      setResult(flows);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("Flow discovery failed."));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="business-flow-panel">
      <div className="business-flow-panel-head">
        <div className="flow-panel-eyebrow">
          <BrainCircuit size={12} /> {t("Flows")}
        </div>
        <h2>{t("Business flow explorer")}</h2>
        <p>
          {t(
            "AI interpretation grounded in routes, calls, database access, and events. Every step links back to source evidence.",
          )}
        </p>
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
          <div className="business-flow-toolbar">
            <div className="review-change-summary">
              <span>{t("{count} routes", { count: analysis.stats.routes })}</span>
              <span>{t("{count} events", { count: analysis.stats.events })}</span>
              <span>{t("{count} database objects", { count: analysis.stats.databases })}</span>
            </div>
            <button className="primary-button" onClick={() => run(Boolean(result))} disabled={loading}>
              {loading ? (
                <Loader2 size={13} className="spin" />
              ) : result ? (
                <RefreshCw size={13} />
              ) : (
                <Sparkles size={13} />
              )}
              {loading
                ? t("Tracing flows…")
                : result
                  ? t("Discover again")
                  : t("Discover business flows")}
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
                <span className="business-flow-disclaimer">
                  {t("AI interpretation — verify against source evidence.")}
                </span>
              </div>
              {result.flows.length === 0 ? (
                <div className="review-clean">
                  <CheckCircle2 size={18} />
                  <span>{t("No business flows were detected.")}</span>
                </div>
              ) : (
                <div className="flow-list">
                  {result.flows.map((flow, flowIndex) => (
                    <div key={`${flow.name}-${flowIndex}`} className="flow-card">
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
                          <li key={`${step.label}-${stepIndex}`}>
                            <span className="flow-step-index">{stepIndex + 1}</span>
                            <span className="flow-step-main">
                              <span className="flow-step-label">{step.label}</span>
                              {step.description ? (
                                <span className="flow-step-description">{step.description}</span>
                              ) : null}
                              {step.file ? (
                                <button
                                  className="flow-step-file"
                                  onClick={() => onOpenFile(step.file!)}
                                >
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
                            <li key={`${risk}-${riskIndex}`}>
                              <AlertTriangle size={11} /> {risk}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="business-flow-empty">
              <BrainCircuit size={22} />
              <strong>{t("No business flows discovered yet.")}</strong>
              <span>
                {t("Run discovery to let the model read the project’s real routes, calls, data access, and events.")}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
