import { useEffect, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileCode2,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import type { AnalysisResult } from "../../../shared/types";
import type { AiProjectSummary, AiSettingsPublic } from "../../../shared/ai";
import { api } from "../api";
import { useI18n } from "../i18n";
import { activeProvider } from "../lib/ai";

interface AiProjectSummaryProps {
  analysis: AnalysisResult;
  settings: AiSettingsPublic | null;
  onOpenSettings: () => void;
  onOpenFile: (filePath: string) => void;
}

export function AiProjectSummaryPanel({
  analysis,
  settings,
  onOpenSettings,
  onOpenFile,
}: AiProjectSummaryProps) {
  const { t, locale } = useI18n();
  const active = activeProvider(settings);
  const [result, setResult] = useState<AiProjectSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showContext, setShowContext] = useState(false);

  useEffect(() => {
    setResult(null);
    setError(null);
    setShowContext(false);
  }, [analysis.id, locale]);

  async function run(force = false) {
    if (!active) return;
    setLoading(true);
    setError(null);
    try {
      const summary = await api.ai.summary(analysis.id, active.provider, active.model, force, locale);
      setResult(summary);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("Project summary failed."));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="inspector-section ai-section ai-project-section">
      <div className="inspector-section-title">
        <BookOpen size={12} /> {t("AI project summary")}
        <span className="ai-interpretation-badge">{t("interpretation")}</span>
        {result ? (
          <button
            className="icon-button subtle"
            title={t("Regenerate")}
            onClick={() => run(true)}
            disabled={loading}
          >
            <RefreshCw size={11} />
          </button>
        ) : null}
      </div>

      {!active ? (
        <div className="ai-setup-callout">
          <Sparkles size={14} />
          <div>
            <strong>{t("Get a plain-language architecture overview.")}</strong>
            <p>
              {t(
                "The model reads the project graph, routes, database objects, events, and key implementations, then explains the architecture and main flows.",
              )}
            </p>
            <button className="action-button primary" onClick={onOpenSettings}>
              {t("Configure AI")}
            </button>
          </div>
        </div>
      ) : (
        <>
          {!result ? (
            <button className="ai-run-button" onClick={() => run(false)} disabled={loading}>
              {loading ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
              {loading ? t("Reading the project…") : t("Explain this project")}
            </button>
          ) : null}
          {error ? (
            <div className="source-error">
              <AlertTriangle size={13} /> {error}
            </div>
          ) : null}
          {result ? (
            <div className="ai-result ai-project-result">
              <div className="ai-result-meta">
                <span className="ai-model-badge">
                  {result.provider} · {result.model}
                </span>
                {result.cached ? <span className="ai-cache-badge">{t("cached")}</span> : null}
              </div>
              <p className="ai-purpose">{result.summary}</p>
              {result.architecture ? (
                <div className="ai-narrative">
                  <div className="ai-block-title">{t("Architecture")}</div>
                  <p>{result.architecture}</p>
                </div>
              ) : null}
              {result.keyFlows.length > 0 ? (
                <div className="ai-block">
                  <div className="ai-block-title">{t("Key flows")}</div>
                  <ol className="ai-steps">
                    {result.keyFlows.map((flow, index) => (
                      <li key={index}>{flow}</li>
                    ))}
                  </ol>
                </div>
              ) : null}
              {result.entryPoints.length > 0 ? (
                <div className="ai-block">
                  <div className="ai-block-title">{t("Entry points")}</div>
                  <div className="ai-chips">
                    {result.entryPoints.map((entry) => (
                      <code key={entry}>{entry}</code>
                    ))}
                  </div>
                </div>
              ) : null}
              {result.risks.length > 0 ? (
                <div className="ai-block">
                  <div className="ai-block-title">{t("Architectural risks")}</div>
                  <ul className="ai-risk-list">
                    {result.risks.map((risk, index) => (
                      <li key={index}>
                        <AlertTriangle size={10} /> {risk}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {result.evidence.length > 0 ? (
                <div className="ai-block">
                  <div className="ai-block-title">{t("Evidence")}</div>
                  {result.evidence.slice(0, 8).map((item, index) => (
                    <button key={index} className="ai-evidence" onClick={() => onOpenFile(item.path)}>
                      <FileCode2 size={11} />
                      <span>{item.path}</span>
                      {item.startLine ? (
                        <span className="ai-evidence-line">
                          {item.startLine}
                          {item.endLine ? `–${item.endLine}` : ""}
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              ) : null}
              <button className="ai-context-toggle" onClick={() => setShowContext((value) => !value)}>
                {showContext ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                {t("Context sent to the model")}
                {result.usage ? (
                  <span>
                    {t("{count} characters", { count: result.usage.inputChars })} · {result.usage.estimatedTokens}{" "}
                    {t("tokens")}
                  </span>
                ) : null}
              </button>
              {showContext ? (
                <div className="ai-context">
                  {(result.usage?.contextFiles ?? result.evidence).map((item, index) => (
                    <div key={index} className="ai-context-file">
                      <FileCode2 size={10} /> {item.path}
                      {item.startLine ? `:${item.startLine}` : ""}
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="ai-disclaimer">
                <CheckCircle2 size={11} />
                {t("This is an AI narrative, not static proof. Verify architectural claims in source.")}
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
