import { useEffect, useState } from "react";
import { ChevronDown, GitCommitHorizontal, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import type { GitCommit, GitGraphRow } from "../../../shared/types";
import { api } from "../api";
import { useI18n } from "../i18n";

interface GitHistoryProps {
  projectId: string;
  head?: string;
  branch?: string;
  onSelectCommit: (commit: GitCommit) => void;
}

const PAGE_SIZE = 20;

export function GitHistory({ projectId, head, branch, onSelectCommit }: GitHistoryProps) {
  const { t, localeInfo } = useI18n();
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [rows, setRows] = useState<GitGraphRow[]>([]);
  const [skip, setSkip] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setCommits([]);
    setRows([]);
    setSkip(0);
    api
      .gitCommits(projectId, PAGE_SIZE, 0)
      .then((result) => {
        if (cancelled) return;
        setCommits(result.commits);
        setRows(result.rows ?? result.commits.map((commit) => ({ graph: commit.graph ?? "*", commit })));
        setHasMore(result.hasMore);
        setSkip(result.nextSkip);
        if (result.message) setError(result.message);
      })
      .catch((requestError: unknown) => {
        if (!cancelled) setError(requestError instanceof Error ? requestError.message : t("Could not load commit history"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, head, reloadToken, t]);

  async function loadOlder() {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const result = await api.gitCommits(projectId, PAGE_SIZE, skip);
      setCommits((current) => {
        const known = new Set(current.map((commit) => commit.hash));
        return [...current, ...result.commits.filter((commit) => !known.has(commit.hash))];
      });
      setRows((current) => {
        const known = new Set(current.map((row) => row.commit?.hash).filter(Boolean));
        const incoming = result.rows ?? result.commits.map((commit) => ({ graph: commit.graph ?? "*", commit }));
        return [...current, ...incoming.filter((row) => !row.commit || !known.has(row.commit.hash))];
      });
      setHasMore(result.hasMore);
      setSkip(result.nextSkip);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("Could not load older commits"));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section className="git-history-panel" aria-label={t("Commit history")}>
      <div className="git-history-panel-head">
        <span className="git-history-panel-title">
          <GitCommitHorizontal size={12} /> {t("Commit history")}
        </span>
        <span className="git-history-panel-meta">
          {branch ? <code>{branch}</code> : null}
          {commits.length > 0
            ? ` · ${t("{count} commits loaded", { count: commits.length })}`
            : null}
        </span>
        <button
          className="icon-button subtle"
          onClick={() => setReloadToken((value) => value + 1)}
          title={t("Reload commit history")}
          aria-label={t("Reload commit history")}
        >
          <RefreshCw size={11} />
        </button>
      </div>

      {loading ? (
        <div className="git-history-loading">
          <Loader2 size={13} className="spin" /> {t("Reading commit graph…")}
        </div>
      ) : null}

      {error ? (
        <div className="git-history-error">
          <TriangleAlert size={12} /> {error}
        </div>
      ) : null}

      {!loading && commits.length === 0 && !error ? (
        <div className="git-history-empty">{t("No commits were found in this repository.")}</div>
      ) : null}

      {commits.length > 0 ? (
        <div className="git-commit-list" role="list">
          {rows.map((row, index) =>
            row.commit ? (
              <button
                key={row.commit.hash}
                className="git-commit-row"
                onClick={() => onSelectCommit(row.commit!)}
                title={`${row.commit.shortHash} · ${row.commit.subject}`}
                role="listitem"
              >
                <span className="git-commit-graph" aria-hidden="true">
                  {row.graph || "*"}
                </span>
                <span className="git-commit-main">
                  <span className="git-commit-subject">{row.commit.subject}</span>
                  <span className="git-commit-meta">
                    <code>{row.commit.shortHash}</code>
                    <span>·</span>
                    <span>{row.commit.author}</span>
                    <span>·</span>
                    <span>{new Date(row.commit.date).toLocaleString(localeInfo.dateLocale)}</span>
                    {row.commit.refs ? (
                      <span className="git-commit-refs">
                        {row.commit.refs
                          .split(",")
                          .map((ref) => ref.trim())
                          .filter(Boolean)
                          .slice(0, 3)
                          .join(" · ")}
                      </span>
                    ) : null}
                  </span>
                </span>
              </button>
            ) : (
              <div key={`graph-${index}`} className="git-commit-row git-commit-continuation" aria-hidden="true">
                <span className="git-commit-graph">{row.graph || "|"}</span>
              </div>
            ),
          )}
        </div>
      ) : null}

      {hasMore ? (
        <button className="git-history-more" onClick={loadOlder} disabled={loadingMore}>
          {loadingMore ? <Loader2 size={12} className="spin" /> : <ChevronDown size={12} />}
          {t("Load older commits")}
        </button>
      ) : null}
    </section>
  );
}
