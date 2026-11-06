import { useEffect, useState } from "react";
import {
  AlertTriangle,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileCode2,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import type { AnalysisResult } from "../../../shared/types";
import type { AiSettingsPublic, AiSymbolAnalysis } from "../../../shared/ai";
import { api } from "../api";
import { useI18n } from "../i18n";
import { activeProvider } from "../lib/ai";

interface AiSymbolPanelProps {
  analysis: AnalysisResult;
  nodeId: string;
  symbolKind: string;
  settings: AiSettingsPublic | null;
  onOpenSettings: () => void;
  onOpenFile: (filePath: string) => void;
}

export function AiSymbolPanel({
  analysis,
  nodeId,
  symbolKind,
  settings,
  onOpenSettings,
  onOpenFile,
}: AiSymbolPanelProps) {
  const { t, locale } = useI18n();
  const [result, setResult] = useState<AiSymbolAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showContext, setShowContext] = useState(false);

  useEffect(() => {
    setResult(null);
    setError(null);
    setShowContext(false);
  }, [nodeId, analysis.id, locale]);

  const active = activeProvider(settings);
  const configured = Boolean(active);

  async function run(force = false) {
    if (!active) return;
    setLoading(true);
    setError(null);
    try {
      const analysisResult = await api.ai.symbol(
        analysis.id,
        nodeId,
        active.provider,
        active.model,
        force,
        locale,
      );
      setResult(analysisResult);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("AI analysis failed."));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="inspector-section ai-section">
      <div className="inspector-section-title">
        <BrainCircuit size={12} /> {t("AI analysis")}
        <span className="ai-interpretation-badge">{t("interpretation")}</span>
        {result ? (
          <button
            className="icon-button subtle"
            title={t("Re-analyze")}
            onClick={() => run(true)}
            disabled={loading}
          >
            <RefreshCw size={11} />
          </button>
        ) : null}
      </div>

      {!configured ? (
        <div className="ai-setup-callout">
          <Sparkles size={14} />
          <div>
            <strong>{t("Connect a model to explain real code.")}</strong>
            <p>
              {t(
                "Add an OpenAI, Claude, DeepSeek, OpenRouter, Gemini, or NVIDIA key. The analysis engine stays useful without it; AI is an optional layer.",
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
              <span>
                {loading
                  ? t("Reading the real implementation…")
                  : symbolKind === "class"
                    ? t("Explain this class")
                    : t("Explain this function")}
              </span>
            </button>
          ) : null}
          {loading && result ? (
            <div className="ai-loading-line">
              <Loader2 size={12} className="spin" /> {t("Refreshing analysis…")}
            </div>
          ) : null}
          {error ? (
            <div className="source-error">
              <AlertTriangle size={13} /> {error}
            </div>
          ) : null}
          {result ? (
            <div className="ai-result">
              <div className="ai-result-meta">
                <span className="ai-model-badge">
                  {result.provider} · {result.model}
                </span>
                {result.cached ? <span className="ai-cache-badge">{t("cached")}</span> : null}
              </div>
              <p className="ai-purpose">{result.purpose}</p>

              {result.businessSteps.length > 0 ? (
                <div className="ai-block">
                  <div className="ai-block-title">{t("Business steps")}</div>
                  <ol className="ai-steps">
                    {result.businessSteps.map((step, index) => (
                      <li key={index}>{step}</li>
                    ))}
                  </ol>
                </div>
              ) : null}

              <div className="ai-chip-grid">
                {result.inputs.length > 0 ? (
                  <div>
                    <div className="ai-block-title">{t("Inputs")}</div>
                    <div className="ai-chips">
                      {result.inputs.map((input) => (
                        <code key={input}>{input}</code>
                      ))}
                    </div>
                  </div>
                ) : null}
                {result.outputs.length > 0 ? (
                  <div>
                    <div className="ai-block-title">{t("Outputs")}</div>
                    <div className="ai-chips">
                      {result.outputs.map((output) => (
                        <code key={output}>{output}</code>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>

              {result.sideEffects.length > 0 ? (
                <div className="ai-block">
                  <div className="ai-block-title">{t("Side effects")}</div>
                  <div className="ai-chips">
                    {result.sideEffects.map((effect) => (
                      <code key={effect} className="effect-chip">
                        {effect}
                      </code>
                    ))}
                  </div>
                </div>
              ) : null}

              {result.risks.length > 0 ? (
                <div className="ai-block">
                  <div className="ai-block-title">{t("Risks")}</div>
                  <ul className="ai-risk-list">
                    {result.risks.map((risk, index) => (
                      <li key={index}>
                        <AlertTriangle size={10} /> {risk}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {result.uncertainties.length > 0 ? (
                <div className="ai-block">
                  <div className="ai-block-title">{t("Uncertainties")}</div>
                  <ul className="ai-uncertainty-list">
                    {result.uncertainties.map((uncertainty, index) => (
                      <li key={index}>{uncertainty}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {result.evidence.length > 0 ? (
                <div className="ai-block">
                  <div className="ai-block-title">{t("Evidence")}</div>
                  {result.evidence.slice(0, 6).map((item, index) => (
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
                      {item.startLine ? `:${item.startLine}${item.endLine ? `–${item.endLine}` : ""}` : ""}
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="ai-disclaimer">
                <CheckCircle2 size={11} />
                {t("AI output is an interpretation, not static proof. Verify it against the source.")}
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
