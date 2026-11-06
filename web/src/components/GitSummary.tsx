import { GitBranch, GitCommitHorizontal, Info } from "lucide-react";
import type { GitStatus } from "../../../shared/types";
import { useI18n } from "../i18n";

interface GitSummaryProps {
  status: GitStatus;
}

export function GitSummary({ status }: GitSummaryProps) {
  const { t, localeInfo } = useI18n();

  if (!status.available) {
    return (
      <div className="git-summary git-summary-unavailable">
        <Info size={14} />
        <div>
          <strong>{t("Git repository not detected")}</strong>
          <span>
            {status.message ??
              t("The analyzer can still diff file hashes, but commit history and Git review require a Git repository.")}
          </span>
        </div>
      </div>
    );
  }

  const recentCommits = status.recentCommits ?? [];
  const last = recentCommits[0];
  const head = status.head ? status.head.slice(0, 8) : "—";
  const date = last?.date ? new Date(last.date).toLocaleString(localeInfo.dateLocale) : "";

  return (
    <div className="git-summary">
      <div className="git-summary-row">
        <span className="git-summary-branch">
          <GitBranch size={12} />
          <strong>{status.branch ?? "HEAD"}</strong>
          <code>{head}</code>
        </span>
        <span className={`git-state ${status.clean ? "is-clean" : "is-dirty"}`}>
          <span />
          {status.clean ? t("clean") : t("dirty")}
        </span>
        {typeof status.ahead === "number" && status.ahead > 0 ? (
          <span className="git-ahead">{status.ahead} {t("ahead")}</span>
        ) : null}
        {typeof status.behind === "number" && status.behind > 0 ? (
          <span className="git-behind">{status.behind} {t("behind")}</span>
        ) : null}
        {status.analysisHead ? (
          <span className="git-since">
            {status.commitsSinceAnalysisCount} {t("commits since analysis")}
          </span>
        ) : null}
      </div>

      <div className="git-last">
        <GitCommitHorizontal size={12} />
        <span className="git-last-label">{t("Last commit")}</span>
        <strong>{last?.subject ?? status.headSubject ?? t("No commits yet")}</strong>
        {last ? (
          <span className="git-last-meta">
            {last.shortHash} · {last.author} · {date}
          </span>
        ) : null}
      </div>

      {recentCommits.length > 1 ? (
        <details className="git-history">
          <summary>{t("Recent commits")}</summary>
          <ol>
            {recentCommits.slice(0, 6).map((commit) => (
              <li key={commit.hash}>
                <code>{commit.shortHash}</code>
                <span>{commit.subject}</span>
                <small>
                  {commit.author} · {new Date(commit.date).toLocaleDateString(localeInfo.dateLocale)}
                </small>
              </li>
            ))}
          </ol>
        </details>
      ) : null}

      {status.clean && status.files.length === 0 ? (
        <div className="git-clean-note">
          {t("Working tree is clean. There are no uncommitted changes to review.")}
        </div>
      ) : null}

      {status.commitsSinceAnalysisCount > 0 ? (
        <div className="git-clean-note">
          {t("The repository has new commits since this analysis snapshot.")}
        </div>
      ) : null}

      {status.analysisHead && status.commitsSinceAnalysisCount === 0 && !status.clean ? (
        <div className="git-clean-note">
          {t("Uncommitted changes exist. Run Analyze changes to inspect their structural impact.")}
        </div>
      ) : null}

      {status.analysisHead ? (
        <div className="git-analysis-head">
          {t("Analysis snapshot")}: <code>{status.analysisHead.slice(0, 8)}</code>
        </div>
      ) : null}
    </div>
  );
}
