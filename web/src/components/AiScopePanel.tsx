import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FileCode2,
  FolderTree,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import type { AnalysisResult } from "../../../shared/types";
import type { AiScopeSummary, AiSettingsPublic } from "../../../shared/ai";
import { api } from "../api";
import { useI18n } from "../i18n";
import { activeProvider } from "../lib/ai";

interface AiScopePanelProps {
  analysis: AnalysisResult;
  nodeId: string;
  nodeKind: "file" | "folder" | "module";
  settings: AiSettingsPublic | null;
  onOpenSettings: () => void;
  onOpenFile: (filePath: string) => void;
}

export function AiScopePanel({
  analysis,
  nodeId,
  nodeKind,
  settings,
  onOpenSettings,
  onOpenFile,
}: AiScopePanelProps) {
  const { t, locale } = useI18n();
  const active = activeProvider(settings);
  const [result, setResult] = useState<AiScopeSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showContext, setShowContext] = useState(false);

  useEffect(() => {
    setResult(null);
    setError(null);
    setShowContext(false);
  }, [nodeId, analysis.id, locale]);

  async function run(force = false) {
    if (!active) return;
    setLoading(true);
    setError(null);
    try {
      const summary = await api.ai.scope(analysis.id, nodeId, active.provider, active.model, force, locale);
      setResult(summary);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("Scope summary failed."));
    } finally {
      setLoading(false);
    }
  }

  const label =
    nodeKind === "file"
      ? t("Explain this file")
      : nodeKind === "folder"
        ? t("Explain this folder")
        : t("Explain this package");

  return (
    <div className="inspector-section ai-section ai-scope-section">
      <div className="inspector-section-title">
        <FolderTree size={12} /> {t("AI scope summary")}
        <span className="ai-interpretation-badge">{t("interpretation")}</span>
        {result ? (
          <button className="icon-button subtle" onClick={() => run(true)} disabled={loading} title={t("Regenerate")}>
            <RefreshCw size={11} />
          </button>
        ) : null}
      </div>
      {!active ? (
        <div className="ai-setup-callout">
          <Sparkles size={14} />
          <div>
            <strong>{t("Summarize this scope with AI.")}</strong>
            <p>
              {t(
                "The model reads the symbols, imports, routes, database objects, events, and key implementations in this scope.",
              )}
            </p>
            <button className="action-button primary" onClick={onOpenSettings}>
              {t("Configure AI")}
            </button>
          </div>
        </div>
      ) : !result ? (
        <button className="ai-run-button" onClick={() => run(false)} disabled={loading}>
          {loading ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
          {loading ? t("Reading the scope…") : label}
        </button>
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
          <p className="ai-purpose">{result.summary}</p>
          {result.responsibilities.length > 0 ? (
            <div className="ai-block">
              <div className="ai-block-title">{t("Responsibilities")}</div>
              <ol className="ai-steps">
                {result.responsibilities.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ol>
            </div>
          ) : null}
          {result.dependencies.length > 0 ? (
            <div className="ai-block">
              <div className="ai-block-title">{t("Dependencies")}</div>
              <div className="ai-chips">
                {result.dependencies.map((dependency) => (
                  <code key={dependency}>{dependency}</code>
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
          {result.evidence.length > 0 ? (
            <div className="ai-block">
              <div className="ai-block-title">{t("Evidence")}</div>
              {result.evidence.slice(0, 8).map((item, index) => (
                <button key={index} className="ai-evidence" onClick={() => onOpenFile(item.path)}>
                  <FileCode2 size={11} />
                  <span>{item.path}</span>
                  {item.startLine ? <span className="ai-evidence-line">{item.startLine}</span> : null}
                </button>
              ))}
            </div>
          ) : null}
          <button className="ai-context-toggle" onClick={() => setShowContext((value) => !value)}>
            {showContext ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            {t("Context sent to the model")}
            {result.usage ? (
              <span>
                {result.usage.estimatedTokens} {t("tokens")}
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
            {t("AI summary is an interpretation. Verify responsibilities against source.")}
          </div>
        </div>
      ) : null}
    </div>
  );
}
