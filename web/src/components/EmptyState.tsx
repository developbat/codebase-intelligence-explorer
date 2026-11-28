import { useEffect, useState } from "react";
import {
  ArrowRight,
  Boxes,
  Braces,
  Code2,
  CheckCircle2,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  GitCommitHorizontal,
  Loader2,
  Lock,
  MessageSquare,
  Network,
  Play,
  ShieldCheck,
  Sparkles,
  Workflow,
  X,
} from "lucide-react";
import type { ProjectTemplate, ProjectTemplateId } from "../../../shared/types";
import { api } from "../api";
import { useI18n } from "../i18n";
import { FolderBrowserDialog } from "./FolderBrowserDialog";

interface EmptyStateProps {
  onAnalyze: (path: string) => void;
  busy: boolean;
  error: string | null;
  onStartChat: () => void;
  onOpenDialog: (mode: "open" | "create") => void;
  aiConfigured: boolean;
  onOpenAiSettings: () => void;
}

export function EmptyState({
  onAnalyze,
  busy,
  error,
  onStartChat,
  onOpenDialog,
  aiConfigured,
  onOpenAiSettings,
}: EmptyStateProps) {
  const { t } = useI18n();
  const [startOpen, setStartOpen] = useState(false);

  return (
    <div className="empty-state home-state">
      <div className="empty-glow" />
      <div className="home-hero">
        <img className="home-hero-logo" src="/cbe.png" alt="" />
        <div className="home-hero-brand">B.A.D IDE</div>
        <h1>
          {t("Understand your code.")}
          <br />
          <span>{t("Build it in Code Studio.")}</span>
        </h1>
        <p className="home-hero-lede">
          {t(
            "Start with chat, create a project, or open a folder. Your saved projects stay on the left.",
          )}
        </p>

        {!aiConfigured ? (
          <button className="home-provider-cta" onClick={onOpenAiSettings}>
            <Sparkles size={14} />
            {t("Add an AI provider token to start")}
          </button>
        ) : null}

        <button
          className="home-start-button"
          onClick={() => setStartOpen((value) => !value)}
          disabled={busy}
        >
          <Play size={17} /> {t("Start")}
          <ArrowRight size={16} />
        </button>

        {startOpen ? (
          <div className="home-start-menu">
            <button onClick={onStartChat}>
              <MessageSquare size={18} />
              <span>
                <strong>{t("Start chatting")}</strong>
                <small>
                  {aiConfigured
                    ? t("A quick project is created automatically.")
                    : t("Add a provider token first.")}
                </small>
              </span>
            </button>
            <button
              onClick={() => {
                setStartOpen(false);
                onOpenDialog("create");
              }}
            >
              <FolderPlus size={18} />
              <span>
                <strong>{t("Create a project")}</strong>
                <small>{t("Choose a location and template.")}</small>
              </span>
            </button>
            <button
              onClick={() => {
                setStartOpen(false);
                onOpenDialog("open");
              }}
            >
              <FolderOpen size={18} />
              <span>
                <strong>{t("Open existing")}</strong>
                <small>{t("Import a folder and analyze it.")}</small>
              </span>
            </button>
            <button
              onClick={() => {
                setStartOpen(false);
                onAnalyze("fixtures/sample-app");
              }}
            >
              <Network size={18} />
              <span>
                <strong>{t("Open sample project")}</strong>
                <small>acme-orders</small>
              </span>
            </button>
          </div>
        ) : null}

        {error ? (
          <div className="form-error home-error">
            <Lock size={13} /> {error}
          </div>
        ) : null}

        <div className="home-trust">
          <span>
            <ShieldCheck size={12} /> {t("Local analysis · code never leaves your machine")}
          </span>
          <span>
            <CheckCircle2 size={12} /> {t("Chat · Code Studio · tools · verification")}
          </span>
        </div>
      </div>
    </div>
  );
}

interface OpenProjectDialogProps {
  open: boolean;
  initialMode?: "open" | "create";
  busy: boolean;
  error: string | null;
  lastPath: string;
  onClose: () => void;
  onAnalyze: (path: string) => void;
  onCreate: (input: {
    parentPath: string;
    name: string;
    template: ProjectTemplateId;
    brief: string;
    autoRun: boolean;
    workspace: "studio" | "chat";
  }) => void;
}

function autoProjectName(useCase: "coding" | "daily"): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 12);
  const suffix = Math.random().toString(36).slice(2, 5);
  return `${useCase === "daily" ? "bad-note" : "bad-project"}-${stamp}-${suffix}`;
}

function parentOf(folderPath: string): string {
  if (!folderPath) return "";
  const trimmed = folderPath.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index > 0 ? trimmed.slice(0, index) : "/";
}

export function OpenProjectDialog({
  open,
  initialMode = "open",
  busy,
  error,
  lastPath,
  onClose,
  onAnalyze,
  onCreate,
}: OpenProjectDialogProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"open" | "create">(initialMode);
  const [path, setPath] = useState(lastPath);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserTarget, setBrowserTarget] = useState<"path" | "parent">("path");
  const [parentPath, setParentPath] = useState(() => parentOf(lastPath) || "~");
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<ProjectTemplateId>("blank");
  const [brief, setBrief] = useState("");
  const [useCase, setUseCase] = useState<"coding" | "daily">("coding");
  const [templates, setTemplates] = useState<ProjectTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError, setTemplatesError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setMode(initialMode);
      setPath(lastPath);
      setParentPath((current) => current || parentOf(lastPath) || "~");
    }
  }, [open, initialMode, lastPath]);

  useEffect(() => {
    if (!open || mode !== "create" || templates.length > 0) return;
    let cancelled = false;
    setTemplatesLoading(true);
    setTemplatesError(null);
    api
      .projectTemplates()
      .then((result) => {
        if (cancelled) return;
        setTemplates(result.templates);
        if (result.templates.length > 0 && !result.templates.some((item) => item.id === template)) {
          setTemplate(result.templates[0].id);
        }
      })
      .catch((requestError: unknown) => {
        if (!cancelled) {
          setTemplatesError(
            requestError instanceof Error ? requestError.message : t("Could not load project templates."),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setTemplatesLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, templates.length]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const selectedTemplate = templates.find((item) => item.id === template) ?? null;
  const canCreate = Boolean(parentPath.trim() && !busy);
  const destinationName =
    name.trim() || (useCase === "daily" ? "bad-note-…" : "bad-project-…");
  const destinationPath = `${parentPath.trim().replace(/[\\/]+$/, "")}/${destinationName}`;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className={`modal ${mode === "create" ? "create-project-modal" : ""}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <div className="modal-eyebrow">{mode === "create" ? t("New project") : t("New analysis")}</div>
            <h2>{mode === "create" ? t("Create a project from scratch") : t("Select a project folder")}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label={t("Close")}>
            <X size={16} />
          </button>
        </div>

        <div className="create-mode-tabs">
          <button className={mode === "open" ? "is-active" : ""} onClick={() => setMode("open")}>
            <FolderOpen size={12} /> {t("Open existing")}
          </button>
          <button className={mode === "create" ? "is-active" : ""} onClick={() => setMode("create")}>
            <FolderPlus size={12} /> {t("Create new")}
          </button>
        </div>

        {mode === "open" ? (
          <>
            <p className="modal-text">
              {t("Enter the full path of the folder to analyze. It opens in the workspace, where you can explore, edit, run and test the same project.")}
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
                  onClick={() => {
                    setBrowserTarget("path");
                    setBrowserOpen(true);
                  }}
                >
                  <FolderSearch size={13} /> {t("Browse…")}
                </button>
              </div>
              {error ? <div className="form-error">{error}</div> : null}
              <div className="modal-actions">
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => onAnalyze("fixtures/sample-app")}
                  disabled={busy}
                >
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
          </>
        ) : (
          <form
            className="create-project-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!canCreate) return;
              const daily = useCase === "daily";
              onCreate({
                parentPath: parentPath.trim(),
                name: name.trim() || autoProjectName(useCase),
                template: daily ? "blank" : template,
                brief: brief.trim(),
                autoRun: Boolean(brief.trim()),
                workspace: daily ? "chat" : "studio",
              });
            }}
          >
            <p className="modal-text">
              {t("Pick how you want to start. Coding projects get a runnable skeleton in Code Studio; everyday use creates a blank project and opens Chat Studio automatically.")}
            </p>

            <div className="create-usecase-grid">
              <button
                type="button"
                className={`create-usecase-card ${useCase === "coding" ? "is-selected" : ""}`}
                onClick={() => setUseCase("coding")}
              >
                <Code2 size={18} />
                <strong>{t("Coding project")}</strong>
                <span>{t("Templates, Code Studio, agent tools and verification.")}</span>
              </button>
              <button
                type="button"
                className={`create-usecase-card ${useCase === "daily" ? "is-selected" : ""}`}
                onClick={() => setUseCase("daily")}
              >
                <MessageSquare size={18} />
                <strong>{t("Everyday use")}</strong>
                <span>{t("Automatic project name and Chat Studio for research, writing and planning.")}</span>
              </button>
            </div>

            <label className="create-field">
              <span>{t("Project location (parent folder)")}</span>
              <div className="modal-input-row">
                <FolderOpen size={15} />
                <input
                  value={parentPath}
                  onChange={(event) => setParentPath(event.target.value)}
                  placeholder="/Users/you/projects"
                  spellCheck={false}
                  autoFocus
                />
                <button
                  type="button"
                  className="ghost-button browse-inline"
                  onClick={() => {
                    setBrowserTarget("parent");
                    setBrowserOpen(true);
                  }}
                >
                  <FolderSearch size={13} /> {t("Browse…")}
                </button>
              </div>
            </label>

            <label className="create-field">
              <span>{t("Project name")}</span>
              <input
                className="text-input mono"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="my-app"
                spellCheck={false}
              />
              <small>{t("Letters, numbers, dots, dashes and underscores only. Leave blank for an automatic name.")}</small>
            </label>

            <div className="create-destination">
              <FolderPlus size={14} />
              <span>
                {t("Project will be created at")}{" "}
                <code>{destinationPath}</code>
              </span>
            </div>

            <label className="create-field">
              <span>{useCase === "daily" ? t("What do you want to do?") : t("What do you want to build?")}</span>
              <textarea
                value={brief}
                onChange={(event) => setBrief(event.target.value)}
                rows={3}
                placeholder={
                  useCase === "daily"
                    ? t("Example: summarize this report, draft a reply, or plan my week.")
                    : t("Example: a task board with projects, tasks, filters and localStorage.")
                }
              />
              <small>
                {brief.trim()
                  ? t("This prompt will run automatically after the project opens.")
                  : t("Optional. You can write it later in the studio.")}
              </small>
            </label>

            {useCase === "daily" ? (
              <div className="create-daily-note">
                <MessageSquare size={13} />
                <span>
                  {t("A blank project is created with an automatic name and Chat Studio opens with this prompt.")}
                </span>
              </div>
            ) : null}

            {useCase === "coding" ? (
            <div className="create-field">
              <span>{t("Project skeleton")}</span>
              {templatesLoading ? (
                <div className="template-loading">
                  <Loader2 size={13} className="spin" /> {t("Loading templates…")}
                </div>
              ) : null}
              {templatesError ? <div className="form-error">{templatesError}</div> : null}
              <div className="template-grid">
                {templates.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`template-card ${template === item.id ? "is-selected" : ""}`}
                    onClick={() => setTemplate(item.id)}
                  >
                    <strong>{t(item.name)}</strong>
                    <span>{t(item.description)}</span>
                    <small>
                      {t(item.language)}
                      {item.framework ? ` · ${t(item.framework)}` : ""}
                    </small>
                    <em>{t("{count} files", { count: item.files.length })}</em>
                  </button>
                ))}
              </div>
              {selectedTemplate ? (
                <div className="template-preview">
                  {selectedTemplate.files.slice(0, 8).map((file) => (
                    <code key={file}>{file}</code>
                  ))}
                  {selectedTemplate.files.length > 8 ? <small>+{selectedTemplate.files.length - 8}</small> : null}
                </div>
              ) : null}
            </div>

            ) : null}

            {error ? <div className="form-error">{error}</div> : null}
            <div className="modal-actions">
              <span className="modal-spacer" />
              <button type="button" className="ghost-button" onClick={onClose} disabled={busy}>
                {t("Cancel")}
              </button>
              <button type="submit" className="primary-button" disabled={!canCreate}>
                {busy ? <Loader2 size={15} className="spin" /> : <FolderPlus size={14} />}
                {busy
                  ? t("Creating…")
                  : useCase === "daily"
                    ? t("Create and open Chat")
                    : t("Create and open Studio")}
              </button>
            </div>
          </form>
        )}
      </div>

      <FolderBrowserDialog
        open={browserOpen}
        initialPath={browserTarget === "parent" ? parentPath || lastPath : path || lastPath}
        onClose={() => setBrowserOpen(false)}
        onSelect={(selected) => {
          if (browserTarget === "parent") setParentPath(selected);
          else setPath(selected);
          setBrowserOpen(false);
        }}
      />
    </div>
  );
}
