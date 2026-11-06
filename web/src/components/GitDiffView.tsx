import { useEffect, useMemo, useState } from "react";
import { FileDiff, Loader2, TriangleAlert } from "lucide-react";
import { api, type GitDiffResult } from "../api";
import { useI18n } from "../i18n";

interface GitDiffViewProps {
  analysisId: string;
  filePath: string;
  base?: string;
  commitHash?: string;
}

export function GitDiffView({ analysisId, filePath, base, commitHash }: GitDiffViewProps) {
  const { t } = useI18n();
  const [diff, setDiff] = useState<GitDiffResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const request = commitHash
      ? api.gitCommitDiff(analysisId, commitHash, filePath)
      : api.gitDiff(analysisId, filePath, base);
    request
      .then((result) => {
        if (!cancelled) setDiff(result);
      })
      .catch((requestError: unknown) => {
        if (!cancelled) setError(requestError instanceof Error ? requestError.message : t("Could not load the diff"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [analysisId, filePath, base, commitHash, t]);

  const lines = useMemo(() => {
    if (!diff?.diff) return [];
    return diff.diff.split("\n").map((line, index) => {
      let type: "add" | "remove" | "hunk" | "meta" | "context" = "context";
      if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git") || line.startsWith("index ")) {
        type = "meta";
      } else if (line.startsWith("@@")) type = "hunk";
      else if (line.startsWith("+")) type = "add";
      else if (line.startsWith("-")) type = "remove";
      return { line, type, key: index };
    });
  }, [diff]);

  return (
    <div className="git-diff">
      <div className="git-diff-header">
        <span className="git-diff-title">
          <FileDiff size={12} /> {filePath.split("/").pop()}
        </span>
        <span className="git-diff-base">{(commitHash ?? base)?.slice(0, 8) ?? "HEAD"}</span>
      </div>
      {loading ? (
        <div className="source-loading">
          <Loader2 size={13} className="spin" /> {t("Loading diff…")}
        </div>
      ) : null}
      {error ? (
        <div className="source-error">
          <TriangleAlert size={13} /> {error}
        </div>
      ) : null}
      {!loading && !error && lines.length === 0 ? (
        <div className="git-diff-empty">{t("No diff against this base.")}</div>
      ) : null}
      {lines.length > 0 ? (
        <div className="git-diff-scroll">
          <pre className="diff-block">
            {lines.map((item) => (
              <div key={item.key} className={`diff-line diff-${item.type}`}>
                {item.line || " "}
              </div>
            ))}
          </pre>
        </div>
      ) : null}
      {diff?.truncated ? <div className="git-diff-note">{t("Diff truncated for display.")}</div> : null}
    </div>
  );
}
