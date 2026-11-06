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
import type { AiSettingsPublic, AiUnresolvedAnalysis } from "../../../shared/ai";
import { api } from "../api";
import { useI18n } from "../i18n";
import { activeProvider } from "../lib/ai";

interface AiUnresolvedInvestigationProps {
  analysis: AnalysisResult;
  nodeId: string;
  settings: AiSettingsPublic | null;
  onOpenSettings: () => void;
  onOpenFile: (filePath: string) => void;
}

const CLASSIFICATION_LABEL: Record<AiUnresolvedAnalysis["classification"], string> = {
  builtin: "JS/TS builtin",
  "external-package": "External package",
  "dynamic-dispatch": "Dynamic dispatch",
  callback: "Callback",
  "string-based": "String-based registration",
  "missed-local": "Missed local function",
  unknown: "Unknown",
};

export function AiUnresolvedInvestigation({
  analysis,
  nodeId,
  settings,
  onOpenSettings,
  onOpenFile,
}: AiUnresolvedInvestigationProps) {
  const { t, locale } = useI18n();
  const active = activeProvider(settings);
  const [result, setResult] = useState<AiUnresolvedAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setResult(null);
    setError(null);
  }, [nodeId, analysis.id, locale]);

  async function run(force = false) {
    if (!active) return;
    setLoading(true);
    setError(null);
    try {
      const investigation = await api.ai.unresolved(
        analysis.id,
        nodeId,
        active.provider,
        active.model,
        force,
        locale,
      );
      setResult(investigation);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("AI investigation failed."));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="unresolved-ai">
      {!active ? (
        <button className="unresolved-ai-link" onClick={onOpenSettings}>
          <Sparkles size={12} /> {t("Use AI to classify this unresolved target")}
        </button>
      ) : !result ? (
        <button className="unresolved-ai-link" onClick={() => run(false)} disabled={loading}>
          {loading ? <Loader2 size={12} className="spin" /> : <BrainCircuit size={12} />}
          {loading ? t("Inspecting call sites…") : t("Use AI to classify this unresolved target")}
        </button>
      ) : null}

      {error ? (
        <div className="source-error">
          <AlertTriangle size={12} /> {error}
        </div>
      ) : null}

      {result ? (
        <div className="unresolved-ai-result">
          <div className="ai-result-meta">
            <span className={`unresolved-class unresolved-${result.classification}`}>
              {t(CLASSIFICATION_LABEL[result.classification])}
            </span>
            <span className="certainty-badge">
              {t("confidence")}: {t(result.confidence)}
            </span>
            <span className="ai-model-badge">
              {result.provider} · {result.model}
            </span>
            {result.cached ? <span className="ai-cache-badge">{t("cached")}</span> : null}
            <button className="icon-button subtle" onClick={() => run(true)} disabled={loading} title={t("Re-analyze")}>
              <RefreshCw size={11} />
            </button>
          </div>
          <p className="unresolved-explanation">{result.explanation}</p>
          <p className="unresolved-recommendation">
            <strong>{t("Recommendation")}:</strong> {result.recommendation}
          </p>
          {result.callSites.length > 0 ? (
            <div className="ai-chips">
              {result.callSites.slice(0, 6).map((site, index) => (
                <button key={index} className="ai-evidence" onClick={() => onOpenFile(site.path)}>
                  <FileCode2 size={10} />
                  {site.path.split("/").pop()}
                  {site.startLine ? `:${site.startLine}` : ""}
                </button>
              ))}
            </div>
          ) : null}
          <div className="ai-disclaimer">
            <CheckCircle2 size={11} />
            {t("AI classification is advisory. The call sites and source remain the authority.")}
          </div>
        </div>
      ) : null}
    </div>
  );
}
