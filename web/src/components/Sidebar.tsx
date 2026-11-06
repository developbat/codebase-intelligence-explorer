import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  Folder,
  FolderOpen,
  FolderTree,
  GitBranch,
  Globe2,
  Lock,
  Network,
  Orbit,
  Plus,
  Search,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import type { AnalysisResult, CodeSearchResponse, GraphNode, RecentProject } from "../../../shared/types";
import { api } from "../api";
import { KIND_COLOR, KIND_LABEL, truncate } from "../lib/constants";
import { buildTree, collectFolderPaths, type TreeNode } from "../lib/tree";
import type { ViewMode } from "../lib/viewGraph";
import { useI18n } from "../i18n";

interface SidebarProps {
  analysis: AnalysisResult | null;
  recent: RecentProject[];
  mode: ViewMode;
  selectedFolder: string | null;
  selectedFile: string | null;
  onModeChange: (mode: ViewMode) => void;
  onOpenFolder: (path: string) => void;
  onOpenFile: (path: string) => void;
  onRevealNode: (node: GraphNode) => void;
  onOpenDialog: () => void;
  onLoadRecent: (project: RecentProject) => void;
  onRemoveRecent: (id: string) => void;
}

function TreeRow({
  node,
  depth,
  expanded,
  selectedFolder,
  selectedFile,
  onToggle,
  onOpenFolder,
  onOpenFile,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  selectedFolder: string | null;
  selectedFile: string | null;
  onToggle: (path: string) => void;
  onOpenFolder: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const { t } = useI18n();
  const isFolder = node.type === "folder";
  const isExpanded = expanded.has(node.path);
  const isSelected = isFolder ? selectedFolder === node.path : selectedFile === node.path;
  const language = node.file?.language;

  return (
    <>
      <div
        className={`tree-row ${isFolder ? "is-folder" : "is-file"} ${isSelected ? "is-selected" : ""}`}
        style={{ paddingLeft: 10 + depth * 13 }}
        role="treeitem"
        aria-expanded={isFolder ? isExpanded : undefined}
        onClick={() => (isFolder ? onOpenFolder(node.path) : onOpenFile(node.path))}
      >
        {isFolder ? (
          <button
            className="tree-chevron"
            onClick={(event) => {
              event.stopPropagation();
              onToggle(node.path);
            }}
            aria-label={isExpanded ? t("Close folder") : t("Open folder")}
          >
            {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        ) : (
          <span className="tree-chevron-spacer" />
        )}
        {isFolder ? (
          isExpanded ? (
            <FolderOpen size={14} className="tree-icon folder-icon" />
          ) : (
            <Folder size={14} className="tree-icon folder-icon" />
          )
        ) : (
          <FileCode2 size={14} className={`tree-icon file-icon lang-${language}`} />
        )}
        <span className="tree-label" title={node.path}>
          {node.name}
        </span>
        {isFolder && node.children.length > 0 ? <span className="tree-count">{node.children.length}</span> : null}
      </div>
      {isFolder && isExpanded
        ? node.children.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              selectedFolder={selectedFolder}
              selectedFile={selectedFile}
              onToggle={onToggle}
              onOpenFolder={onOpenFolder}
              onOpenFile={onOpenFile}
            />
          ))
        : null}
    </>
  );
}

export function Sidebar({
  analysis,
  recent,
  mode,
  selectedFolder,
  selectedFile,
  onModeChange,
  onOpenFolder,
  onOpenFile,
  onRevealNode,
  onOpenDialog,
  onLoadRecent,
  onRemoveRecent,
}: SidebarProps) {
  const { t, tn } = useI18n();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [semantic, setSemantic] = useState<CodeSearchResponse | null>(null);
  const [semanticLoading, setSemanticLoading] = useState(false);

  const tree = useMemo(() => (analysis ? buildTree(analysis.files) : []), [analysis]);

  useEffect(() => {
    if (!analysis) return;
    setExpanded(new Set(collectFolderPaths(tree, 2)));
  }, [analysis?.id, tree, analysis]);

  const results = useMemo(() => {
    if (!analysis || query.trim().length < 2) return [];
    const needle = query.trim().toLocaleLowerCase("tr");
    return analysis.nodes
      .filter((node) => node.kind !== "project")
      .filter((node) => {
        const haystack = `${node.label} ${node.metadata?.qualifiedName ?? ""} ${node.filePath ?? ""}`.toLocaleLowerCase("tr");
        return haystack.includes(needle);
      })
      .sort((a, b) => {
        const aStarts = a.label.toLocaleLowerCase("tr").startsWith(needle) ? 0 : 1;
        const bStarts = b.label.toLocaleLowerCase("tr").startsWith(needle) ? 0 : 1;
        return aStarts - bStarts || a.label.localeCompare(b.label);
      })
      .slice(0, 30);
  }, [analysis, query]);

  useEffect(() => {
    if (!analysis || query.trim().length < 3) {
      setSemantic(null);
      setSemanticLoading(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSemanticLoading(true);
      api
        .search(analysis.id, query.trim(), 12)
        .then((response) => {
          if (!cancelled) setSemantic(response);
        })
        .catch(() => {
          if (!cancelled) setSemantic(null);
        })
        .finally(() => {
          if (!cancelled) setSemanticLoading(false);
        });
    }, 320);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [analysis, query]);

  function toggleFolder(path: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  const folderCount = analysis?.stats.folders ?? 0;
  const fileCount = analysis?.stats.files ?? 0;
  const functionCount = analysis?.stats.functions ?? 0;
  const backTo2dMode: ViewMode = selectedFile ? "functions" : selectedFolder ? "files" : "universe";

  return (
    <aside className="sidebar">
      <div className="sidebar-section">
        <button className="open-project-button" onClick={onOpenDialog}>
          <Plus size={16} />
          {t("Open Project")}
        </button>

        {analysis ? (
          <>
            <div className="search-box">
              <Search size={14} className="search-icon" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("Search symbols, files, or paths…")}
                spellCheck={false}
              />
              {query ? (
                <button className="search-clear" onClick={() => setQuery("")} aria-label={t("Clear search")}>
                  <X size={13} />
                </button>
              ) : (
                <kbd>⌘K</kbd>
              )}
            </div>

            {results.length > 0 ? (
              <div className="search-results">
                {results.map((node) => (
                  <button
                    key={node.id}
                    className="search-result"
                    onClick={() => {
                      onRevealNode(node);
                      setQuery("");
                    }}
                  >
                    <span className="result-dot" style={{ background: KIND_COLOR[node.kind] }} />
                    <span className="result-main">
                      <span className="result-label">{truncate(node.label, 28)}</span>
                      <span className="result-sub">
                        {t(KIND_LABEL[node.kind])}
                        {node.filePath ? ` · ${truncate(node.filePath, 34)}` : ""}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            ) : query.trim().length >= 2 ? (
              <div className="search-empty">{t("No matching nodes found.")}</div>
            ) : null}

            {semanticLoading ? (
              <div className="semantic-loading">
                <span className="spinner" /> {t("Searching the vector index…")}
              </div>
            ) : null}

            {semantic && semantic.results.length > 0 ? (
              <div className="semantic-results">
                <div className="semantic-heading">
                  <span>{t("Semantic matches")}</span>
                  <span className="semantic-meta">
                    {semantic.indexSize} {t("indexed items")} · {semantic.tookMs} ms
                  </span>
                </div>
                {semantic.results.map((result) => {
                  const node = analysis?.nodes.find((candidate) => candidate.id === result.nodeId);
                  if (!node) return null;
                  return (
                    <button
                      key={result.nodeId}
                      className="semantic-result"
                      onClick={() => {
                        onRevealNode(node);
                        setQuery("");
                      }}
                    >
                      <span className="result-dot" style={{ background: KIND_COLOR[result.kind] }} />
                      <span className="semantic-main">
                        <span className="semantic-label">{truncate(result.label, 34)}</span>
                        <span className="semantic-snippet">
                          {result.snippet || result.filePath || t(KIND_LABEL[result.kind])}
                        </span>
                      </span>
                      <span className="semantic-score">{result.score.toFixed(2)}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}

            <nav className="view-tabs" aria-label={t("View selection")}>
              <button
                className={mode === "universe" ? "is-active" : ""}
                onClick={() => onModeChange("universe")}
                title={t("Project universe")}
              >
                <Globe2 size={15} />
                <span>{t("Universe")}</span>
              </button>
              <button
                className={mode === "files" ? "is-active" : ""}
                onClick={() => onModeChange("files")}
                title={t("File map")}
              >
                <FolderTree size={15} />
                <span>{t("Files")}</span>
              </button>
              <button
                className={mode === "functions" ? "is-active" : ""}
                onClick={() => onModeChange("functions")}
                title={t("Call graph")}
              >
                <Workflow size={15} />
                <span>{t("Calls")}</span>
              </button>
              <button
                className={mode === "architecture" ? "is-active" : ""}
                onClick={() => onModeChange("architecture")}
                title={t("Architecture map")}
              >
                <Network size={15} />
                <span>{t("Architecture")}</span>
              </button>
              <button
                className={mode === "changes" ? "is-active" : ""}
                onClick={() => onModeChange("changes")}
                title={t("Changes since analysis")}
              >
                <GitBranch size={15} />
                <span>{t("Changes")}</span>
              </button>
              {mode === "3d" ? (
                <button
                  className="is-active view-toggle-back"
                  onClick={() => onModeChange(backTo2dMode)}
                  title={t("Back to 2D")}
                >
                  <Network size={15} />
                  <span>{t("2D")}</span>
                </button>
              ) : (
                <button
                  onClick={() => onModeChange("3d")}
                  title={t("3D Explorer")}
                >
                  <Orbit size={15} />
                  <span>{t("3D")}</span>
                </button>
              )}
            </nav>
          </>
        ) : null}
      </div>

      <div className="sidebar-scroll">
        {analysis ? (
          <div className="sidebar-section tree-section">
            <div className="section-heading">
              <span>{t("Project tree")}</span>
              <span className="section-meta">
                {t("{fileCount} files · {folderCount} folders", { fileCount, folderCount })}
              </span>
            </div>
            <div className="project-root" onClick={() => onOpenFolder("")} role="treeitem">
              <Globe2 size={14} className="tree-icon project-icon" />
              <span>{analysis.projectName}</span>
              <span className="tree-count">{fileCount}</span>
            </div>
            <div className="tree" role="tree">
              {tree.map((node) => (
                <TreeRow
                  key={node.path}
                  node={node}
                  depth={0}
                  expanded={expanded}
                  selectedFolder={selectedFolder}
                  selectedFile={selectedFile}
                  onToggle={toggleFolder}
                  onOpenFolder={onOpenFolder}
                  onOpenFile={onOpenFile}
                />
              ))}
            </div>
          </div>
        ) : null}

        <div className="sidebar-section">
          <div className="section-heading">
            <span>{t("Recent projects")}</span>
            <span className="section-meta">{recent.length}</span>
          </div>
          {recent.length === 0 ? (
            <div className="recent-empty">{t("No analyzed projects yet.")}</div>
          ) : (
            <div className="recent-list">
              {recent.map((project) => (
                <div
                  key={project.id}
                  className={`recent-item ${analysis?.id === project.id ? "is-active" : ""}`}
                  onClick={() => onLoadRecent(project)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") onLoadRecent(project);
                  }}
                >
                  <span className="recent-main">
                    <span className="recent-name">{truncate(project.projectName, 22)}</span>
                    <span className="recent-path" title={project.rootPath}>
                      {truncate(project.rootPath, 34)}
                    </span>
                    <span className="recent-stats">
                      {t("{fileCount} files · {symbolCount} symbols", {
                        fileCount: project.stats.files,
                        symbolCount: project.stats.symbols,
                      })}
                    </span>
                  </span>
                  <button
                    className="icon-button subtle"
                    title={t("Remove from history")}
                    onClick={(event) => {
                      event.stopPropagation();
                      onRemoveRecent(project.id);
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="sidebar-footer">
        <span className="readonly-badge">
          <Lock size={12} /> {t("Read-only")}
        </span>
        <span className="footer-meta">{t("{count} functions", { count: functionCount })}</span>
      </div>
    </aside>
  );
}
