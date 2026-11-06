import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, FolderClock, Search, Trash2, X } from "lucide-react";
import type { AnalysisResult, RecentProject } from "../../../shared/types";
import { truncate } from "../lib/constants";
import { useI18n } from "../i18n";
import { ProjectIcon } from "./ProjectIcon";

interface ProjectSwitcherProps {
  analysis: AnalysisResult;
  recent: RecentProject[];
  onLoadRecent: (project: RecentProject) => void;
  onRemoveRecent: (id: string) => void;
}

export function ProjectSwitcher({
  analysis,
  recent,
  onLoadRecent,
  onRemoveRecent,
}: ProjectSwitcherProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setOpen(false);
    setQuery("");
  }, [analysis.id]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return recent;
    return recent.filter((project) =>
      `${project.projectName} ${project.rootPath}`.toLocaleLowerCase().includes(needle),
    );
  }, [query, recent]);

  function select(project: RecentProject) {
    if (project.id !== analysis.id) onLoadRecent(project);
    setOpen(false);
  }

  return (
    <div className="project-switcher" ref={wrapperRef}>
      <button
        type="button"
        className={`project-switcher-trigger ${open ? "is-open" : ""}`}
        data-tour="project-switcher"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="listbox"
        title={analysis.rootPath}
      >
        <ProjectIcon
          id={analysis.id}
          name={analysis.projectName}
          version={analysis.createdAt}
          languages={analysis.languages}
          frameworks={analysis.frameworks}
          size="lg"
        />
        <span className="project-switcher-main">
          <span className="project-switcher-eyebrow">{t("Active project")}</span>
          <span className="project-switcher-name">{truncate(analysis.projectName, 24)}</span>
          <span className="project-switcher-path">{truncate(analysis.rootPath, 34)}</span>
        </span>
        <span className="project-switcher-chevron" aria-hidden="true">
          <ChevronDown size={14} />
        </span>
      </button>

      {open ? (
        <div className="project-switcher-menu" role="dialog" aria-label={t("Switch project")}>
          <div className="project-switcher-menu-head">
            <span className="project-switcher-menu-title">
              <FolderClock size={12} /> {t("Switch project")}
            </span>
            <span className="project-switcher-menu-count">{recent.length}</span>
            <button
              className="icon-button subtle"
              onClick={() => setOpen(false)}
              aria-label={t("Close")}
            >
              <X size={12} />
            </button>
          </div>

          <div className="project-switcher-search">
            <Search size={12} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("Filter projects…")}
              autoFocus
              spellCheck={false}
            />
          </div>

          <div className="project-switcher-list" role="listbox">
            {filtered.length === 0 ? (
              <div className="project-switcher-empty">{t("No projects match this filter.")}</div>
            ) : (
              filtered.map((project) => {
                const active = project.id === analysis.id;
                return (
                  <div
                    key={project.id}
                    className={`project-switcher-item ${active ? "is-active" : ""}`}
                    role="option"
                    aria-selected={active}
                    tabIndex={0}
                    onClick={() => select(project)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") select(project);
                    }}
                  >
                    <ProjectIcon
                      id={project.id}
                      name={project.projectName}
                      version={project.createdAt}
                      languages={project.languages}
                      frameworks={project.frameworks}
                      size="sm"
                    />
                    <span className="project-switcher-item-main">
                      <span className="project-switcher-item-name">
                        {truncate(project.projectName, 26)}
                        {active ? <Check size={11} className="project-switcher-check" /> : null}
                      </span>
                      <span className="project-switcher-item-path" title={project.rootPath}>
                        {truncate(project.rootPath, 32)}
                      </span>
                      <span className="project-switcher-item-stats">
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
                      className="icon-button subtle project-switcher-remove"
                      title={t("Remove from history")}
                      onClick={(event) => {
                        event.stopPropagation();
                        onRemoveRecent(project.id);
                      }}
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                );
              })
            )}
          </div>

          <div className="project-switcher-note">
            {t("Switching opens the saved analysis. Use Rescan only when you want a fresh analysis.")}
          </div>
        </div>
      ) : null}
    </div>
  );
}
