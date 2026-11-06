import { useEffect, useState } from "react";
import {
  ArrowRight,
  Boxes,
  Braces,
  CheckCircle2,
  FolderOpen,
  FolderSearch,
  FolderClock,
  GitCommitHorizontal,
  Loader2,
  Lock,
  Network,
  Play,
  ShieldCheck,
  Sparkles,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import type { RecentProject } from "../../../shared/types";
import { useI18n } from "../i18n";
import { truncate } from "../lib/constants";
import { FolderBrowserDialog } from "./FolderBrowserDialog";
import { ProjectIcon } from "./ProjectIcon";

interface EmptyStateProps {
  onAnalyze: (path: string) => void;
  busy: boolean;
  error: string | null;
  lastPath: string;
  recent: RecentProject[];
  onLoadRecent: (project: RecentProject) => void;
  onRemoveRecent: (id: string) => void;
}

const FEATURES = [
  {
    icon: FolderOpen,
    title: "Read-only scanning",
    text: "Folder trees, manifests, and source files are read without changing anything.",
  },
  {
    icon: Braces,
    title: "Multi-language symbols",
    text: "TypeScript/JavaScript, PHP, and Python symbols, imports, calls, and framework routes. More languages appear at file level.",
  },
  {
    icon: Workflow,
    title: "Knowledge graph + evidence",
    text: "Files, folders, classes, functions, routes, database objects, events, and every relationship with certainty.",
  },
  {
    icon: GitCommitHorizontal,
    title: "Git change intelligence",
    text: "Branch, last commit, paginated commit graph, commit detail, diffs, structural impact, and map highlighting.",
  },
  {
    icon: Boxes,
    title: "2D + 3D architecture",
    text: "React Flow maps and a Three.js 3D explorer with hybrid, hierarchical, clustered, and force layouts.",
  },
  {
    icon: FolderSearch,
    title: "Saved project memory",
    text: "Each project keeps its own analysis. Switch instantly without rescanning; local project icons are discovered automatically.",
  },
];

export function EmptyState({
  onAnalyze,
  busy,
  error,
  lastPath,
  recent,
  onLoadRecent,
  onRemoveRecent,
}: EmptyStateProps) {
  const { t } = useI18n();
  const [path, setPath] = useState(lastPath);
  const [browserOpen, setBrowserOpen] = useState(false);

  useEffect(() => {
    setPath(lastPath);
  }, [lastPath]);

  return (
    <div className="empty-state">
      <div className="empty-glow" />
      <div className="empty-content">
        <div className="empty-badge">
          <Sparkles size={13} /> {t("AI-free static code intelligence")}
        </div>
        <h1>
          {t("Explore your codebase")}
          <br />
          <span>{t("spatially.")}</span>
        </h1>
        <p className="empty-lede">
          {t(
            "Pick a TypeScript/JavaScript, PHP, or Python project folder. We will read its files, symbols, imports, calls, and routes and turn them into a navigable knowledge graph. Source code is never modified or executed.",
          )}
        </p>

        <form
          className="path-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (path.trim() && !busy) onAnalyze(path.trim());
          }}
        >
          <FolderOpen size={16} className="path-icon" />
          <input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="/Users/you/projects/app"
            spellCheck={false}
            aria-label={t("Project folder path")}
            autoFocus
          />
          <button type="button" className="ghost-button browse-button" onClick={() => setBrowserOpen(true)}>
            <FolderSearch size={14} /> {t("Browse…")}
          </button>
          <button type="submit" className="primary-button" disabled={busy || !path.trim()}>
            {busy ? <Loader2 size={15} className="spin" /> : <Play size={14} />}
            {t("Analyze")}
          </button>
        </form>

        <button className="sample-button" onClick={() => onAnalyze("fixtures/sample-app")} disabled={busy}>
          <Network size={14} /> {t("Open sample project")}
          <span className="sample-tag">acme-orders</span>
          <ArrowRight size={13} />
        </button>

        {recent.length > 0 ? (
          <div className="home-recent">
            <div className="home-recent-head">
              <span>
                <FolderClock size={12} /> {t("Saved projects")}
              </span>
              <small>{t("Continue where you left off")}</small>
            </div>
            <div className="home-recent-list">
              {recent.map((project) => (
                <div
                  key={project.id}
                  className="home-recent-card"
                  role="button"
                  tabIndex={0}
                  onClick={() => onLoadRecent(project)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") onLoadRecent(project);
                  }}
                  title={project.rootPath}
                >
                  <ProjectIcon
                    id={project.id}
                    name={project.projectName}
                    version={project.createdAt}
                    languages={project.languages}
                    frameworks={project.frameworks}
                    size="md"
                  />
                  <span className="home-recent-main">
                    <span className="home-recent-name">{truncate(project.projectName, 30)}</span>
                    <span className="home-recent-path">{truncate(project.rootPath, 46)}</span>
                    <span className="home-recent-stats">
                      {t("{fileCount} files · {symbolCount} symbols", {
                        fileCount: project.stats.files,
                        symbolCount: project.stats.symbols,
                      })}
                      {project.frameworks && project.frameworks.length > 0
                        ? ` · ${project.frameworks[0]}`
                        : ""}
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
          </div>
        ) : null}

        {error ? (
          <div className="form-error">
            <Lock size={13} /> {error}
          </div>
        ) : null}

        <div className="feature-grid">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="feature-card">
              <feature.icon size={17} />
              <div>
                <h3>{t(feature.title)}</h3>
                <p>{t(feature.text)}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="empty-footer">
          <span>
            <ShieldCheck size={13} /> {t("Local analysis · code never leaves your machine")}
          </span>
          <span>
            <CheckCircle2 size={13} /> {t("TS/JS · PHP · Python · file-level multi-language")}
          </span>
          <span>
            <Lock size={13} /> {t("Read-only")}
          </span>
        </div>
      </div>

      <FolderBrowserDialog
        open={browserOpen}
        initialPath={path || lastPath}
        onClose={() => setBrowserOpen(false)}
        onSelect={(selected) => {
          setPath(selected);
          setBrowserOpen(false);
        }}
      />
    </div>
  );
}

interface OpenProjectDialogProps {
  open: boolean;
  busy: boolean;
  error: string | null;
  lastPath: string;
  onClose: () => void;
  onAnalyze: (path: string) => void;
}

export function OpenProjectDialog({ open, busy, error, lastPath, onClose, onAnalyze }: OpenProjectDialogProps) {
  const { t } = useI18n();
  const [path, setPath] = useState(lastPath);
  const [browserOpen, setBrowserOpen] = useState(false);

  useEffect(() => {
    if (open) setPath(lastPath);
  }, [open, lastPath]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="modal-eyebrow">{t("New analysis")}</div>
            <h2>{t("Select a project folder")}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label={t("Close")}>
            <X size={16} />
          </button>
        </div>
        <p className="modal-text">
          {t("Enter the full path of the folder to analyze. It is opened read-only; no files are changed.")}
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (path.trim() && !busy) onAnalyze(path.trim());
          }}
        >
          <div className="modal-input-row">
            <FolderOpen size={16} />
            <input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="/Users/you/projects/app"
              spellCheck={false}
              autoFocus
            />
            <button
              type="button"
              className="ghost-button browse-inline"
              onClick={() => setBrowserOpen(true)}
            >
              <FolderSearch size={13} /> {t("Browse…")}
            </button>
          </div>
          {error ? <div className="form-error">{error}</div> : null}
          <div className="modal-actions">
            <button type="button" className="ghost-button" onClick={() => onAnalyze("fixtures/sample-app")} disabled={busy}>
              {t("Example project")}
            </button>
            <span className="modal-spacer" />
            <button type="button" className="ghost-button" onClick={onClose} disabled={busy}>
              {t("Cancel")}
            </button>
            <button type="submit" className="primary-button" disabled={busy || !path.trim()}>
              {busy ? <Loader2 size={15} className="spin" /> : <Play size={14} />}
              {t("Analyze")}
            </button>
          </div>
        </form>
      </div>

      <FolderBrowserDialog
        open={browserOpen}
        initialPath={path || lastPath}
        onClose={() => setBrowserOpen(false)}
        onSelect={(selected) => {
          setPath(selected);
          setBrowserOpen(false);
        }}
      />
    </div>
  );
}
