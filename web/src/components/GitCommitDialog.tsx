import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronRight,
  FileCode2,
  FileDiff,
  Folder,
  GitCommitHorizontal,
  GitMerge,
  Loader2,
  Map as MapIcon,
  X,
} from "lucide-react";
import type { AnalysisResult, GitChangedFile, GitCommit, GitCommitDetail } from "../../../shared/types";
import { api } from "../api";
import { useI18n } from "../i18n";
import { GitDiffView } from "./GitDiffView";

interface GitCommitDialogProps {
  open: boolean;
  analysis: AnalysisResult;
  commitHash: string | null;
  onClose: () => void;
  onShowOnMap: (files: GitChangedFile[], commit: GitCommit) => void;
}

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  file?: GitChangedFile;
}

interface TreeRow {
  type: "folder" | "file";
  name: string;
  path: string;
  depth: number;
  file?: GitChangedFile;
}

function buildTreeRows(files: GitChangedFile[]): TreeRow[] {
  const root: TreeNode = { name: "", path: "", children: new Map() };
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let node = root;
    parts.forEach((part, index) => {
      const isLeaf = index === parts.length - 1;
      const nextPath = node.path ? `${node.path}/${part}` : part;
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path: nextPath, children: new Map() };
        node.children.set(part, child);
      }
      if (isLeaf) child.file = file;
      node = child;
    });
  }

  const rows: TreeRow[] = [];
  function walk(children: Map<string, TreeNode>, depth: number) {
    const nodes = [...children.values()].sort((a, b) => {
      const aFolder = a.children.size > 0 ? 0 : 1;
      const bFolder = b.children.size > 0 ? 0 : 1;
      return aFolder - bFolder || a.name.localeCompare(b.name);
    });
    for (const child of nodes) {
      if (child.children.size > 0) {
        rows.push({ type: "folder", name: child.name, path: child.path, depth });
        walk(child.children, depth + 1);
      }
      if (child.file) {
        rows.push({ type: "file", name: child.name, path: child.path, depth, file: child.file });
      }
    }
  }
  walk(root.children, 0);
  return rows;
}

const STATUS_LABEL: Record<GitChangedFile["status"], string> = {
  added: "A",
  deleted: "D",
  renamed: "R",
  modified: "M",
  untracked: "U",
  conflicted: "!",
};

export function GitCommitDialog({
  open,
  analysis,
  commitHash,
  onClose,
  onShowOnMap,
}: GitCommitDialogProps) {
  const { t, localeInfo } = useI18n();
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  useEffect(() => {
    if (!open || !commitHash) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDetail(null);
    setSelectedPath(null);
    api
      .gitCommit(analysis.id, commitHash)
      .then((result) => {
        if (cancelled) return;
        setDetail(result);
        setSelectedPath(result.files[0]?.path ?? null);
      })
      .catch((requestError: unknown) => {
        if (!cancelled) setError(requestError instanceof Error ? requestError.message : t("Commit could not be loaded"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, commitHash, analysis.id, t]);

  const rows = useMemo(() => buildTreeRows(detail?.files ?? []), [detail]);
  const selectedFile = detail?.files.find((file) => file.path === selectedPath) ?? null;
  const highImpact = detail?.files.filter((file) => file.impactLevel === "high").length ?? 0;
  const selectedAffected = selectedFile?.affectedNodes ?? [];

  if (!open) return null;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="ai-modal git-commit-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="modal-eyebrow">{t("Git history")}</div>
            <h2>
              <GitCommitHorizontal size={18} />
              {detail ? detail.commit.subject : t("Commit details")}
            </h2>
            {detail ? (
              <p className="modal-text git-commit-byline">
                <code>{detail.commit.shortHash}</code>
                {detail.commit.refs ? <span className="git-commit-dialog-refs">{detail.commit.refs}</span> : null}
                <span>{detail.commit.author}</span>
                <span>{new Date(detail.commit.date).toLocaleString(localeInfo.dateLocale)}</span>
                {detail.merge ? (
                  <span className="git-merge-badge">
                    <GitMerge size={11} /> {t("merge")}
                  </span>
                ) : null}
              </p>
            ) : null}
          </div>
          <button className="icon-button" onClick={onClose} aria-label={t("Close")}>
            <X size={15} />
          </button>
        </div>

        {loading ? (
          <div className="git-commit-loading">
            <Loader2 size={16} className="spin" /> {t("Reading commit changes…")}
          </div>
        ) : null}

        {error ? (
          <div className="git-commit-error">
            <AlertTriangle size={14} /> {error}
          </div>
        ) : null}

        {detail ? (
          <>
            <div className="git-commit-stats">
              <span>
                <strong>{detail.stats.files}</strong> {t("changed files")}
              </span>
              <span className="git-additions">+{detail.stats.additions}</span>
              <span className="git-deletions">−{detail.stats.deletions}</span>
              <span>
                <strong>{highImpact}</strong> {t("high-impact files")}
              </span>
              <span className="git-commit-impact-note">{t("Impact is measured against the current analyzed graph.")}</span>
            </div>

            {detail.files.length === 0 ? (
              <div className="git-commit-empty">{t("This commit does not change any files in the analyzed project.")}</div>
            ) : (
              <div className="git-commit-layout">
                <div className="git-commit-tree" aria-label={t("Changed files")}>
                  <div className="git-commit-tree-head">
                    <span>{t("Changed files")}</span>
                    <span>{detail.files.length}</span>
                  </div>
                  <div className="git-commit-tree-rows">
                    {rows.map((row) =>
                      row.type === "folder" ? (
                        <div
                          key={`folder:${row.path}`}
                          className="git-tree-folder"
                          style={{ paddingLeft: `${6 + row.depth * 12}px` }}
                        >
                          <Folder size={11} />
                          <span>{row.name}</span>
                        </div>
                      ) : (
                        <button
                          key={`file:${row.path}`}
                          className={`git-tree-file ${selectedPath === row.path ? "is-active" : ""}`}
                          style={{ paddingLeft: `${6 + row.depth * 12}px` }}
                          onClick={() => setSelectedPath(row.path)}
                          title={row.path}
                        >
                          <FileCode2 size={11} />
                          <span className="git-tree-file-name">{row.name}</span>
                          {row.file?.additions !== undefined || row.file?.deletions !== undefined ? (
                            <span className="git-tree-numbers">
                              {row.file?.additions !== undefined ? `+${row.file.additions}` : ""}
                              {row.file?.deletions !== undefined ? ` −${row.file.deletions}` : ""}
                            </span>
                          ) : null}
                          <span className={`git-tree-status status-${row.file?.status ?? "modified"}`}>
                            {STATUS_LABEL[row.file?.status ?? "modified"]}
                          </span>
                        </button>
                      ),
                    )}
                  </div>
                </div>

                <div className="git-commit-detail">
                  {selectedFile ? (
                    <>
                      <div className="git-commit-file-head">
                        <span className="git-commit-file-title">
                          <FileDiff size={12} /> {selectedFile.path}
                        </span>
                        <span className="git-commit-file-numbers">
                          {selectedFile.additions !== undefined ? `+${selectedFile.additions}` : ""}
                          {selectedFile.deletions !== undefined ? ` −${selectedFile.deletions}` : ""}
                        </span>
                        {selectedFile.impactLevel ? (
                          <span className={`impact-badge impact-${selectedFile.impactLevel}`}>
                            {t(selectedFile.impactLevel)} {t("impact")}
                          </span>
                        ) : null}
                        <button
                          className="ghost-button git-commit-map-button"
                          onClick={() => onShowOnMap([selectedFile], detail.commit)}
                        >
                          <MapIcon size={12} /> {t("Show on map")}
                        </button>
                      </div>

                      {selectedAffected.length > 0 ? (
                        <div className="git-commit-impact">
                          <span className="git-commit-impact-title">{t("Affected in the current graph")}</span>
                          <div className="git-commit-impact-list">
                            {selectedAffected.slice(0, 8).map((node) => (
                              <span key={node.id} className={`git-commit-impact-node kind-${node.kind}`}>
                                {node.label}
                              </span>
                            ))}
                            {selectedAffected.length > 8 ? (
                              <span className="git-commit-impact-more">
                                {t("+{count} more", { count: selectedAffected.length - 8 })}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      ) : null}

                      <GitDiffView analysisId={analysis.id} filePath={selectedFile.path} commitHash={detail.commit.hash} />
                    </>
                  ) : (
                    <div className="git-commit-empty">{t("Select a changed file to inspect its diff.")}</div>
                  )}
                </div>
              </div>
            )}

            <div className="git-commit-actions">
              <button
                className="primary-button"
                onClick={() => onShowOnMap(detail.files, detail.commit)}
                disabled={detail.files.length === 0}
              >
                <MapIcon size={14} /> {t("Show all changed files on map")}
              </button>
              <button className="ghost-button" onClick={onClose}>
                <ChevronRight size={13} /> {t("Close")}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
