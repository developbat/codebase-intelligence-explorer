import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  BrainCircuit,
  ChevronRight,
  FolderOpen,
  FolderTree,
  GitBranch,
  GitCommitHorizontal,
  GitCompareArrows,
  Loader2,
  Lock,
  MessageSquare,
  Network,
  PanelRight,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  X,
} from "lucide-react";
import { api, type AnalysisResult, type ChangeReport, type GitStatus, type RecentProject } from "./api";
import { EmptyState, OpenProjectDialog } from "./components/EmptyState";
import { GraphCanvas } from "./components/GraphCanvas";
import { Inspector } from "./components/Inspector";
import { Sidebar } from "./components/Sidebar";
import { AiSettingsDialog } from "./components/AiSettingsDialog";
import { AiChatDrawer } from "./components/AiChatDrawer";
import { AiReviewDialog } from "./components/AiReviewDialog";
import { AiFlowsDialog } from "./components/AiFlowsDialog";
import { GitSummary } from "./components/GitSummary";
import { GitHistory } from "./components/GitHistory";
import { GitCommitDialog } from "./components/GitCommitDialog";
import { TourButton } from "./components/TourButton";
import type { AiSettingsPublic } from "../../shared/ai";
import { buildViewGraph, type CommitHighlight, type ViewMode } from "./lib/viewGraph";
import { build3DGraph } from "./lib/threeGraph";
import { formatNumber } from "./lib/constants";
import { useI18n } from "./i18n";
import { activeProvider } from "./lib/ai";
import type { GitChangedFile, GitCommit, GraphNode } from "../../shared/types";

const LAST_PROJECT_KEY = "cie:last-project";
const LAST_PATH_KEY = "cie:last-path";
const Universe3D = lazy(() => import("./components/Universe3D"));

const MODE_LABEL: Record<ViewMode, string> = {
  universe: "Project Universe",
  files: "File Map",
  functions: "Call Graph",
  architecture: "Architecture",
  changes: "Changes since analysis",
  "3d": "3D Explorer",
};

const ANALYSIS_STEP_KEYS = [
  "Scanning file tree",
  "Parsing TypeScript AST",
  "Resolving symbols and calls",
  "Building knowledge graph",
];

function toRecent(result: AnalysisResult): RecentProject {
  return {
    id: result.id,
    projectName: result.projectName,
    rootPath: result.rootPath,
    createdAt: result.createdAt,
    lastOpenedAt: new Date().toISOString(),
    stats: result.stats,
    warnings: result.warnings,
    languages: result.languages,
    frameworks: result.frameworks,
    git: result.git,
  };
}

function folderOf(filePath: string): string | null {
  return filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : null;
}

export default function App() {
  const { t, tn, locale, localeInfo, locales, setLocale } = useI18n();
  const analysisSteps = ANALYSIS_STEP_KEYS.map((key) => t(key));
  const [logoVersion] = useState(() => Date.now().toString(36));

  useEffect(() => {
    for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="icon"], link[rel="apple-touch-icon"]')) {
      link.href = `/cbe.png?v=${logoVersion}`;
    }
  }, [logoVersion]);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [mode, setMode] = useState<ViewMode>("universe");
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>("project");
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [depth, setDepth] = useState(1);
  const [inspectorOpen, setInspectorOpen] = useState(() => window.innerWidth > 1120);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [changeReport, setChangeReport] = useState<ChangeReport | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [changeBusy, setChangeBusy] = useState(false);
  const [commitDialog, setCommitDialog] = useState<{ hash: string; subject: string } | null>(null);
  const [commitHighlight, setCommitHighlight] = useState<CommitHighlight | null>(null);
  const [aiSettings, setAiSettings] = useState<AiSettingsPublic | null>(null);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [flowsOpen, setFlowsOpen] = useState(false);
  const [clusterFunctions, setClusterFunctions] = useState(false);
  const [fullTree, setFullTree] = useState(true);
  const [workspaceUpdate, setWorkspaceUpdate] = useState<{
    createdAt: string;
    changedPaths: string[];
    stats?: AnalysisResult["stats"];
  } | null>(null);
  const [busy, setBusy] = useState<null | "analyze" | "load" | "rescan">(null);
  const [bootLoading, setBootLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [lastPath, setLastPath] = useState(() => localStorage.getItem(LAST_PATH_KEY) ?? "");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { projects } = await api.recent();
        if (cancelled) return;
        setRecent(projects);
        const lastId = localStorage.getItem(LAST_PROJECT_KEY);
        if (lastId && projects.some((project) => project.id === lastId)) {
          try {
            const result = await api.project(lastId);
            if (!cancelled) applyAnalysis(result);
          } catch {
            localStorage.removeItem(LAST_PROJECT_KEY);
          }
        }
      } catch (requestError) {
        if (!cancelled) setError(requestError instanceof Error ? requestError.message : t("Could not connect to the server"));
      } finally {
        if (!cancelled) setBootLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!busy) {
      setStep(0);
      return;
    }
    const timer = window.setInterval(() => {
      setStep((current) => Math.min(current + 1, analysisSteps.length - 1));
    }, 800);
    return () => window.clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    if (!analysis) return;
    const source = new EventSource(`/api/projects/${analysis.id}/events`);
    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as {
          type: string;
          changedPaths?: string[];
          summary?: { createdAt: string; stats: AnalysisResult["stats"] };
          message?: string;
        };
        if (payload.type === "updated" && payload.summary) {
          setWorkspaceUpdate({
            createdAt: payload.summary.createdAt,
            changedPaths: payload.changedPaths ?? [],
            stats: payload.summary.stats,
          });
        } else if (payload.type === "error" && payload.message) {
          setError(payload.message);
        }
      } catch {
        // ignore malformed events
      }
    };
    return () => source.close();
  }, [analysis?.id]);

  useEffect(() => {
    api.ai
      .settings()
      .then(setAiSettings)
      .catch(() => {
        // AI is optional; the static map remains fully usable.
      });
  }, []);

  useEffect(() => {
    if (!analysis || mode !== "changes" || gitStatus) return;
    let cancelled = false;
    setGitLoading(true);
    api
      .gitStatus(analysis.id)
      .then((status) => {
        if (!cancelled) setGitStatus(status);
      })
      .catch((requestError: unknown) => {
        if (!cancelled) setError(requestError instanceof Error ? requestError.message : t("Could not load Git status"));
      })
      .finally(() => {
        if (!cancelled) setGitLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis?.id, mode, gitStatus]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        const input = document.querySelector<HTMLInputElement>(".search-box input");
        input?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  function applyAnalysis(result: AnalysisResult, reset = true) {
    setAnalysis(result);
    setGitStatus(null);
    setChangeReport(null);
    setCommitDialog(null);
    setCommitHighlight(null);
    localStorage.setItem(LAST_PROJECT_KEY, result.id);
    setRecent((current) => [toRecent(result), ...current.filter((project) => project.id !== result.id)].slice(0, 20));

    if (reset) {
      setMode("universe");
      setSelectedFolder(null);
      setSelectedFile(null);
      setFocusNodeId(null);
      setSelectedNodeId("project");
      setSelectedEdgeId(null);
      setDepth(1);
    } else {
      if (selectedFolder && !result.nodes.some((node) => node.kind === "folder" && node.filePath === selectedFolder)) {
        setSelectedFolder(null);
      }
      if (selectedFile && !result.files.some((file) => file.path === selectedFile)) {
        setSelectedFile(null);
        setFocusNodeId(null);
        setMode("universe");
        setSelectedNodeId("project");
      } else if (selectedNodeId && !result.nodes.some((node) => node.id === selectedNodeId)) {
        setSelectedNodeId("project");
      }
      setSelectedEdgeId(null);
    }
  }

  async function analyze(path: string) {
    if (busy) return;
    setBusy("analyze");
    setError(null);
    try {
      const result = await api.analyze(path);
      applyAnalysis(result);
      localStorage.setItem(LAST_PATH_KEY, path);
      setLastPath(path);
      setDialogOpen(false);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("Analysis failed"));
    } finally {
      setBusy(null);
    }
  }

  async function loadRecent(project: RecentProject) {
    if (busy) return;
    setBusy("load");
    setError(null);
    try {
      const result = await api.project(project.id);
      applyAnalysis(result);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("Project could not be loaded"));
    } finally {
      setBusy(null);
    }
  }

  async function rescan() {
    if (!analysis || busy) return;
    setBusy("rescan");
    setError(null);
    try {
      const result = await api.rescan(analysis.id);
      applyAnalysis(result, false);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("Rescan failed"));
    } finally {
      setBusy(null);
    }
  }

  async function reloadUpdatedAnalysis() {
    if (!analysis) return;
    setError(null);
    try {
      const result = await api.project(analysis.id);
      setAnalysis(result);
      setChangeReport(null);
      setGitStatus(null);
      setCommitDialog(null);
      setCommitHighlight(null);
      setWorkspaceUpdate(null);
      setRecent((current) => [toRecent(result), ...current.filter((project) => project.id !== result.id)].slice(0, 20));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("Project could not be loaded"));
    }
  }

  async function analyzeChanges() {
    if (!analysis || changeBusy) return;
    setChangeBusy(true);
    setError(null);
    try {
      const { report, analysis: next } = await api.changes(analysis.id);
      setChangeReport(report);
      setGitStatus(report.git);
      setAnalysis(next);
      localStorage.setItem(LAST_PROJECT_KEY, next.id);
      setRecent((current) => [toRecent(next), ...current.filter((project) => project.id !== next.id)].slice(0, 20));
      setMode("changes");
      setSelectedEdgeId(null);
      const first = report.files[0];
      if (first) {
        setSelectedFile(first.path);
        setSelectedFolder(folderOf(first.path));
        setSelectedNodeId(`file:${first.path}`);
        setInspectorOpen(true);
      } else {
        setSelectedNodeId(null);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("Change analysis failed"));
    } finally {
      setChangeBusy(false);
    }
  }

  async function removeRecent(id: string) {
    try {
      await api.remove(id);
      setRecent((current) => current.filter((project) => project.id !== id));
      if (analysis?.id === id) {
        setAnalysis(null);
        localStorage.removeItem(LAST_PROJECT_KEY);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("Project could not be removed"));
    }
  }

  function selectGraphNode(id: string | null) {
    setSelectedNodeId(id);
    setSelectedEdgeId(null);
    if (!id) return;
    setInspectorOpen(true);
    // In 3D, a single click only inspects the node. Drilling into a folder or
    // file happens on double-click so the current 3D neighborhood stays intact.
    if (mode === "3d") return;
    const node = analysis?.nodes.find((item) => item.id === id);
    if (node?.kind === "file" && node.filePath) {
      setSelectedFile(node.filePath);
      setSelectedFolder(folderOf(node.filePath));
    } else if (node?.kind === "folder" && node.filePath) {
      setSelectedFolder(node.filePath);
    }
  }

  function openFolder(path: string) {
    const normalized = path || null;
    setMode("files");
    setSelectedFolder(normalized);
    setSelectedFile(null);
    setFocusNodeId(null);
    setSelectedEdgeId(null);
    setSelectedNodeId(normalized ? `folder:${normalized}` : "project");
  }

  function openFile(filePath: string) {
    setSelectedFolder(folderOf(filePath));
    setSelectedFile(filePath);
    setMode("functions");
    setFocusNodeId(null);
    setSelectedEdgeId(null);
    setSelectedNodeId(`file:${filePath}`);
  }

  function revealNode(node: GraphNode) {
    if (node.kind === "folder" && node.filePath) {
      openFolder(node.filePath);
      return;
    }
    if (node.kind === "file" && node.filePath) {
      openFile(node.filePath);
      return;
    }
    if (node.filePath) {
      setSelectedFolder(folderOf(node.filePath));
      setSelectedFile(node.filePath);
      setMode("functions");
      setFocusNodeId(null);
      setSelectedEdgeId(null);
      setSelectedNodeId(node.id);
      setInspectorOpen(true);
      return;
    }
    setMode("functions");
    setFocusNodeId(null);
    setSelectedEdgeId(null);
    setSelectedNodeId(node.id);
    setInspectorOpen(true);
  }

  function focusNode(id: string) {
    const node = analysis?.nodes.find((item) => item.id === id);
    if (node?.filePath) {
      setSelectedFolder(folderOf(node.filePath));
      setSelectedFile(node.filePath);
    }
    setMode("functions");
    setFocusNodeId(id);
    setSelectedEdgeId(null);
    setSelectedNodeId(id);
    setInspectorOpen(true);
  }

  function changeMode(next: ViewMode) {
    setMode(next);
    setSelectedEdgeId(null);
    setFocusNodeId(null);
    if (next === "universe") {
      setSelectedNodeId("project");
    } else if (next === "files") {
      setSelectedNodeId(selectedFolder ? `folder:${selectedFolder}` : "project");
    } else if (next === "architecture") {
      setSelectedNodeId(null);
    } else if (next === "changes") {
      setSelectedNodeId(null);
    } else if (next === "3d") {
      setSelectedNodeId(
        selectedFile ? `file:${selectedFile}` : selectedFolder ? `folder:${selectedFolder}` : "project",
      );
    } else {
      setSelectedNodeId(selectedFile ? `file:${selectedFile}` : null);
    }
  }

  function showCommitOnMap(files: GitChangedFile[], commit: GitCommit) {
    setCommitHighlight({ hash: commit.hash, subject: commit.subject, files });
    setCommitDialog(null);
    setMode("files");
    setSelectedFolder(null);
    setSelectedFile(null);
    setFocusNodeId(null);
    setSelectedEdgeId(null);
    setFullTree(true);
    const first = files[0];
    setSelectedNodeId(first ? `file:${first.path}` : "project");
    setInspectorOpen(true);
  }

  const view = useMemo(() => {
    if (!analysis) return null;
    return buildViewGraph({
      mode,
      analysis,
      selectedFolder,
      selectedFile,
      focusNodeId,
      depth,
      changeReport,
      gitStatus,
      commitHighlight,
      clusterFunctions,
      fullTree,
      t,
      tn,
    });
  }, [analysis, mode, selectedFolder, selectedFile, focusNodeId, depth, changeReport, gitStatus, commitHighlight, clusterFunctions, fullTree, t, tn]);

  const viewKey = `${analysis?.id ?? "none"}|${mode}|${selectedFolder ?? ""}|${selectedFile ?? ""}|${focusNodeId ?? ""}|${depth}|${changeReport?.generatedAt ?? gitStatus?.head ?? ""}|${clusterFunctions ? "cluster" : "flat"}|${fullTree ? "full" : "direct"}|${commitHighlight?.hash ?? ""}`;

  const threeGraph = useMemo(
    () => (analysis ? build3DGraph(analysis) : null),
    [analysis],
  );

  const displayTitle = mode === "3d" && analysis ? analysis.projectName : view?.title;
  const displaySubtitle =
    mode === "3d" && analysis && threeGraph
      ? t("{count} nodes · {symbols} symbols across the full project", {
          count: threeGraph.nodes.length,
          symbols: analysis.stats.symbols,
        })
      : view?.subtitle;
  const displayNodeCount = mode === "3d" && threeGraph ? threeGraph.nodes.length : view?.nodes.length ?? 0;

  const breadcrumbs = useMemo(() => {
    const parts: { label: string; path?: string }[] = [];
    if (!analysis) return parts;
    parts.push({ label: analysis.projectName, path: "" });
    const sourcePath = selectedFolder ?? (selectedFile ? folderOf(selectedFile) : null);
    if (sourcePath && (mode === "files" || mode === "functions")) {
      const segments = sourcePath.split("/").filter(Boolean);
      let accumulated = "";
      for (const segment of segments) {
        accumulated = accumulated ? `${accumulated}/${segment}` : segment;
        parts.push({ label: segment, path: accumulated });
      }
    }
    if (mode === "functions" && selectedFile) {
      parts.push({ label: selectedFile.split("/").pop() ?? selectedFile });
    }
    return parts;
  }, [analysis, mode, selectedFolder, selectedFile]);

  const confirmedPercent =
    analysis && analysis.stats.edges > 0
      ? Math.round((analysis.stats.confirmedEdges / analysis.stats.edges) * 100)
      : 0;

  const changeFiles = (changeReport?.files ?? gitStatus?.files ?? []).filter(
    (file) => file.sinceAnalysis !== false,
  );
  const aiConfigured = Boolean(activeProvider(aiSettings));

  return (
    <div className={`app ${analysis ? "" : "no-analysis"} ${analysis && !inspectorOpen ? "inspector-closed" : ""}`}>
      <header className="topbar">
        <div className="brand">
          <img className="brand-logo" src={`/cbe.png?v=${logoVersion}`} alt="" width={31} height={31} />
          <div className="brand-text">
            <span className="brand-title">Codebase Explorer</span>
            <span className="brand-sub">{t("Static code intelligence")}</span>
          </div>
        </div>

        <div className="breadcrumbs">
          {analysis
            ? breadcrumbs.map((part, index) => {
                const isLast = index === breadcrumbs.length - 1;
                return (
                  <span key={`${part.label}-${index}`} className="breadcrumb-item">
                    {index > 0 ? <ChevronRight size={12} className="breadcrumb-sep" /> : null}
                    {part.path !== undefined && !isLast ? (
                      <button onClick={() => openFolder(part.path ?? "")}>{part.label}</button>
                    ) : (
                      <span className="is-current">{part.label}</span>
                    )}
                  </span>
                );
              })
            : null}
        </div>

        <div className="topbar-actions">
          <TourButton />
          <button
            className={`icon-button topbar-icon ${aiConfigured ? "is-active" : ""}`}
            onClick={() => setAiSettingsOpen(true)}
            title={t("AI models & providers")}
            aria-label={t("AI models & providers")}
          >
            <Sparkles size={15} />
          </button>
          <select
            className="lang-select"
            value={locale}
            onChange={(event) => setLocale(event.target.value as typeof locale)}
            title={t("Language")}
            aria-label={t("Language")}
          >
            {locales.map((item) => (
              <option key={item.id} value={item.id}>
                {item.nativeLabel}
              </option>
            ))}
          </select>
          {analysis ? (
            <span className="readonly-pill" title={t("Read-only — source files are never modified")}>
              <Lock size={11} /> {t("Read-only")}
            </span>
          ) : null}
          {analysis ? (
            <button
              className={`icon-button topbar-icon ${inspectorOpen ? "is-active" : ""}`}
              onClick={() => setInspectorOpen((value) => !value)}
              title={inspectorOpen ? t("Close inspector") : t("Open inspector")}
              aria-label={inspectorOpen ? t("Close inspector") : t("Open inspector")}
            >
              <PanelRight size={15} />
            </button>
          ) : null}
          {analysis ? (
            <button className="ghost-button" onClick={rescan} disabled={busy !== null}>
              <RefreshCw size={14} className={busy === "rescan" ? "spin" : ""} /> {t("Rescan")}
            </button>
          ) : null}
          <button className="primary-button" onClick={() => setDialogOpen(true)}>
            <FolderOpen size={14} /> {t("New project")}
          </button>
        </div>
      </header>

      <div className="workspace">
        <Sidebar
          analysis={analysis}
          recent={recent}
          mode={mode}
          selectedFolder={selectedFolder}
          selectedFile={selectedFile}
          onModeChange={changeMode}
          onOpenFolder={openFolder}
          onOpenFile={openFile}
          onRevealNode={revealNode}
          onOpenDialog={() => setDialogOpen(true)}
          onLoadRecent={loadRecent}
          onRemoveRecent={removeRecent}
        />

        <main className="main" data-tour="canvas">
          {analysis && view ? (
            <>
              {workspaceUpdate ? (
                <div className="workspace-update">
                  <RefreshCw size={13} />
                  <span>
                    {t("Workspace changed on disk. A fresh analysis is ready.")}
                    {workspaceUpdate.changedPaths.length > 0
                      ? ` (${t("{count} files", { count: workspaceUpdate.changedPaths.length })})`
                      : ""}
                  </span>
                  <button className="workspace-update-button" onClick={reloadUpdatedAnalysis}>
                    {t("Reload analysis")}
                  </button>
                  <button
                    className="icon-button subtle"
                    onClick={() => setWorkspaceUpdate(null)}
                    aria-label={t("Dismiss")}
                  >
                    <X size={12} />
                  </button>
                </div>
              ) : null}
              <div className="canvas-toolbar">
                <div className="view-title">
                  <span className="view-eyebrow">{t(MODE_LABEL[mode])}</span>
                  <h1>{displayTitle}</h1>
                  <p>{displaySubtitle}</p>
                </div>
                <div className="canvas-toolbar-actions">
                  {mode === "3d" ? (
                    <button
                      className="ghost-button toolbar-action"
                      onClick={() =>
                        changeMode(selectedFile ? "functions" : selectedFolder ? "files" : "universe")
                      }
                    >
                      <Network size={13} /> {t("Back to 2D")}
                    </button>
                  ) : null}
                  {analysis.git?.available ? (
                    <button
                      className="canvas-stat git-stat"
                      onClick={() => changeMode("changes")}
                      title={analysis.git.headSubject ?? t("Git changes")}
                    >
                      <GitBranch size={12} /> {analysis.git.branch}
                      {analysis.git.dirty ? ` · ${t("dirty")}` : ` · ${t("clean")}`}
                    </button>
                  ) : null}
                  <span className="canvas-stat">
                    <Network size={12} /> {t("{count} nodes", { count: displayNodeCount })}
                  </span>
                  {mode === "architecture" ? (
                    <button className="ghost-button toolbar-action" onClick={() => setFlowsOpen(true)}>
                      <BrainCircuit size={13} /> {t("Business flows")}
                    </button>
                  ) : null}
                  {mode === "files" ? (
                    <button
                      className={`ghost-button toolbar-action ${fullTree ? "is-active" : ""}`}
                      onClick={() => setFullTree((value) => !value)}
                      title={t("Toggle full tree")}
                    >
                      <FolderTree size={13} /> {fullTree ? t("Direct children") : t("Full tree")}
                    </button>
                  ) : null}
                  {mode === "functions" && !selectedFile && !focusNodeId ? (
                    <button
                      className={`ghost-button toolbar-action ${clusterFunctions ? "is-active" : ""}`}
                      onClick={() => setClusterFunctions((value) => !value)}
                    >
                      <GitBranch size={13} /> {t("Cluster by file")}
                    </button>
                  ) : null}
                  <button
                    className="canvas-stat"
                    data-tour="ai-setup"
                    onClick={() => setAiSettingsOpen(true)}
                    title={t("AI models & providers")}
                  >
                    <Sparkles size={12} /> {aiConfigured ? t("AI ready") : t("AI setup")}
                  </button>
                  {aiConfigured ? (
                    <button
                      className="icon-button topbar-icon"
                      onClick={() => setChatOpen(true)}
                      title={t("Ask the codebase")}
                      aria-label={t("Ask the codebase")}
                    >
                      <MessageSquare size={14} />
                    </button>
                  ) : null}
                </div>
              </div>
              {commitHighlight ? (
                <div className="commit-highlight-bar">
                  <GitCommitHorizontal size={12} />
                  <span>
                    {t("Commit {hash} highlighted on the map", {
                      hash: commitHighlight.hash.slice(0, 8),
                    })}
                  </span>
                  <span className="commit-highlight-count">
                    {t("{count} changed files", { count: commitHighlight.files.length })}
                  </span>
                  <button
                    className="icon-button subtle"
                    onClick={() => setCommitHighlight(null)}
                    title={t("Clear commit highlight")}
                    aria-label={t("Clear commit highlight")}
                  >
                    <X size={12} />
                  </button>
                </div>
              ) : null}
              {mode === "changes" && gitStatus ? (
                <>
                  <GitSummary status={gitStatus} />
                  {gitStatus.available ? (
                    <GitHistory
                      projectId={analysis.id}
                      head={gitStatus.head}
                      branch={gitStatus.branch}
                      onSelectCommit={(commit) => setCommitDialog({ hash: commit.hash, subject: commit.subject })}
                    />
                  ) : null}
                </>
              ) : null}
              {mode === "changes" ? (
                <div className="change-strip">
                  <button className="change-action primary" onClick={analyzeChanges} disabled={changeBusy}>
                    <GitCompareArrows size={12} className={changeBusy ? "spin" : ""} />
                    {changeBusy ? t("Analyzing changes…") : t("Analyze changes")}
                  </button>
                  {changeReport || changeFiles.length > 0 ? (
                    <button className="change-action" onClick={() => setReviewOpen(true)}>
                      <BrainCircuit size={12} /> {t("AI review")}
                    </button>
                  ) : null}
                  <span className="change-strip-sep" />
                  {changeFiles.map((file) => (
                    <button
                      key={file.path}
                      className={`change-chip ${selectedFile === file.path ? "is-active" : ""} status-${file.status}`}
                      onClick={() => {
                        setSelectedFile(file.path);
                        setSelectedFolder(folderOf(file.path));
                        setSelectedNodeId(`file:${file.path}`);
                        setSelectedEdgeId(null);
                        setInspectorOpen(true);
                      }}
                      title={file.path}
                    >
                      <span className="change-status">{file.status.slice(0, 1).toUpperCase()}</span>
                      <span className="change-path">{file.path}</span>
                      {file.additions !== undefined || file.deletions !== undefined ? (
                        <span className="change-numbers">
                          {file.additions !== undefined ? `+${file.additions}` : ""}
                          {file.deletions !== undefined ? ` −${file.deletions}` : ""}
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              ) : null}
              {mode === "3d" ? (
                <Suspense
                  fallback={
                    <div className="app-loading">
                      <Loader2 size={20} className="spin" />
                      <span>{t("Preparing 3D scene…")}</span>
                    </div>
                  }
                >
                  <Universe3D
                    key={analysis.id}
                    nodes={threeGraph?.nodes ?? view.nodes}
                    edges={threeGraph?.edges ?? view.edges}
                    truncated={threeGraph?.truncated}
                    selectedNodeId={selectedNodeId}
                    onSelectNode={selectGraphNode}
                    onOpenFile={openFile}
                    onOpenFolder={openFolder}
                  />
                </Suspense>
              ) : (
                <GraphCanvas
                  view={view}
                  viewMode={mode}
                  viewKey={viewKey}
                  selectedNodeId={selectedNodeId}
                  selectedEdgeId={selectedEdgeId}
                  onSelectNode={selectGraphNode}
                  onSelectEdge={(id) => {
                    setSelectedEdgeId(id);
                    setSelectedNodeId(null);
                    if (id) setInspectorOpen(true);
                  }}
                  onOpenFile={openFile}
                  onOpenFolder={openFolder}
                  onFocusNode={focusNode}
                />
              )}
            </>
          ) : bootLoading ? (
            <div className="app-loading">
              <Loader2 size={22} className="spin" />
              <span>{t("Loading project")}…</span>
            </div>
          ) : (
            <EmptyState onAnalyze={analyze} busy={busy !== null} error={error} lastPath={lastPath} />
          )}
        </main>

        {analysis && inspectorOpen ? (
          <Inspector
            analysis={analysis}
            selectedNodeId={selectedNodeId}
            selectedEdgeId={selectedEdgeId}
            depth={depth}
            changeReport={changeReport}
            gitStatus={gitStatus}
            aiSettings={aiSettings}
            onOpenAiSettings={() => setAiSettingsOpen(true)}
            onDepthChange={setDepth}
            onSelectNode={(id) => {
              setSelectedNodeId(id);
              setSelectedEdgeId(null);
            }}
            onOpenFile={openFile}
            onOpenFolder={openFolder}
            onFocusNode={focusNode}
            onClose={() => setInspectorOpen(false)}
          />
        ) : null}
      </div>

      <footer className="statusbar">
        <span className="status-left">
          {analysis ? (
            <>
              <span className="status-dot" />
              {t("Analysis ready")}
              <span className="status-sep" />
              <span className="status-muted">
                {new Date(analysis.createdAt).toLocaleString(localeInfo.dateLocale)}
              </span>
            </>
          ) : (
            <>
              <span className="status-dot idle" />
              {t("Waiting for project")}
            </>
          )}
        </span>
        <span className="status-center">
          {analysis ? (
            <>
              {t("{count} files", { count: formatNumber(analysis.stats.files, localeInfo.dateLocale) })}
              <span className="status-sep" />
              {t("{count} symbols", { count: formatNumber(analysis.stats.symbols, localeInfo.dateLocale) })}
              <span className="status-sep" />
              {t("{count} relationships", { count: formatNumber(analysis.stats.edges, localeInfo.dateLocale) })}
              <span className="status-sep" />
              {t("{percent}% verified", { percent: confirmedPercent })}
            </>
          ) : (
            t("Source code is never modified or executed.")
          )}
        </span>
        <span className="status-right">
          {analysis ? (
            <>
              <span className="status-muted">{analysis.stats.durationMs} ms</span>
              <span className="status-sep" />
              <Lock size={11} /> {t("local")}
            </>
          ) : (
            <>
              <ShieldCheck size={12} /> {t("read-only")}
            </>
          )}
        </span>
      </footer>

      {busy ? (
        <div className="busy-overlay">
          <div className="busy-card">
            <div className="busy-orbit">
              <Loader2 size={24} className="spin" />
            </div>
            <h3>
              {busy === "analyze"
                ? t("Analyzing codebase")
                : busy === "rescan"
                  ? t("Rescanning project")
                  : t("Loading project")}
            </h3>
            <p className="busy-sub">
              {busy === "load" ? t("Opening the saved knowledge graph…") : t("Reading source in read-only mode.")}
            </p>
            {busy !== "load" ? (
              <div className="step-list">
                {analysisSteps.map((label, index) => (
                  <div key={label} className={`step ${index < step ? "is-done" : ""} ${index === step ? "is-current" : ""}`}>
                    <span className="step-marker">{index < step ? "✓" : index + 1}</span>
                    <span>{label}</span>
                    {index === step ? <span className="step-pulse" /> : null}
                  </div>
                ))}
              </div>
            ) : null}
            <div className="busy-note">
              <Lock size={12} /> {t("Source files are never modified, executed, or sent anywhere.")}
            </div>
          </div>
        </div>
      ) : null}

      <OpenProjectDialog
        open={dialogOpen}
        busy={busy === "analyze"}
        error={error}
        lastPath={lastPath}
        onClose={() => setDialogOpen(false)}
        onAnalyze={analyze}
      />

      <AiSettingsDialog
        open={aiSettingsOpen}
        settings={aiSettings}
        onClose={() => setAiSettingsOpen(false)}
        onSaved={setAiSettings}
      />

      {analysis ? (
        <AiChatDrawer
          open={chatOpen}
          analysis={analysis}
          settings={aiSettings}
          onClose={() => setChatOpen(false)}
          onOpenSettings={() => {
            setChatOpen(false);
            setAiSettingsOpen(true);
          }}
          onOpenFile={openFile}
        />
      ) : null}

      {analysis ? (
        <AiFlowsDialog
          open={flowsOpen}
          projectId={analysis.id}
          analysis={analysis}
          settings={aiSettings}
          onClose={() => setFlowsOpen(false)}
          onOpenSettings={() => {
            setFlowsOpen(false);
            setAiSettingsOpen(true);
          }}
          onOpenFile={openFile}
        />
      ) : null}

      {analysis ? (
        <AiReviewDialog
          open={reviewOpen}
          projectId={analysis.id}
          changeReport={changeReport}
          settings={aiSettings}
          onClose={() => setReviewOpen(false)}
          onOpenSettings={() => {
            setReviewOpen(false);
            setAiSettingsOpen(true);
          }}
          onOpenFile={openFile}
        />
      ) : null}

      {analysis ? (
        <GitCommitDialog
          open={commitDialog !== null}
          analysis={analysis}
          commitHash={commitDialog?.hash ?? null}
          onClose={() => setCommitDialog(null)}
          onShowOnMap={showCommitOnMap}
        />
      ) : null}

      {error && analysis && !dialogOpen ? (
        <div className="error-toast">
          <TriangleAlert size={15} />
          <span>{error}</span>
          <button className="icon-button" onClick={() => setError(null)} aria-label={t("Dismiss error")}>
            <X size={13} />
          </button>
        </div>
      ) : null}

    </div>
  );
}
