import { useState } from "react";
import type { AnalysisResult, RecentProject } from "../api";
import type { StudioKind, StudioSession } from "../lib/studioSessions";
import { ProjectSwitcher } from "./ProjectSwitcher";
import {
  Folder,
  FolderOpen,
  Info,
  ListChecks,
  MessageSquare,
  Plus,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { useI18n } from "../i18n";

type Tab = "chat" | "details" | "files" | "tools";

export function StudioLeftPanel({
  analysis,
  recent,
  sessions,
  activeId,
  kind,
  onLoadRecent,
  onRemoveRecent,
  onOpenProject,
  onOpenCodeStudio,
  onOpenSettings,
  onOpenReports,
  onOpenLibrary,
  onSelect,
  onCreate,
  onDelete,
}: {
  analysis: AnalysisResult | null;
  recent: RecentProject[];
  sessions: StudioSession[];
  activeId: string;
  kind: StudioKind;
  onLoadRecent: (project: RecentProject) => void;
  onRemoveRecent: (id: string) => void;
  onOpenProject: () => void;
  onOpenCodeStudio?: () => void;
  onOpenSettings?: () => void;
  onOpenReports?: () => void;
  onOpenLibrary?: () => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("chat");

  return (
    <aside className="studio-left-panel">
      <div className="studio-left-head">
        <span className="studio-left-brand">
          {kind === "image" ? t("Image Studio") : kind === "video" ? t("Video Studio") : t("Chat Studio")}
        </span>
      </div>
      {analysis ? (
        <div className="studio-project-switch">
          <ProjectSwitcher
            analysis={analysis}
            recent={recent}
            onLoadRecent={onLoadRecent}
            onRemoveRecent={onRemoveRecent}
          />
        </div>
      ) : null}
      <button className="studio-open-project" onClick={onOpenProject}>
        <FolderOpen size={12} /> {t("Open or create project")}
      </button>

      <div className="studio-side-tabs">
        <button className={tab === "chat" ? "is-active" : ""} onClick={() => setTab("chat")}>
          <MessageSquare size={12} /> {t("Chats")}
        </button>
        <button className={tab === "details" ? "is-active" : ""} onClick={() => setTab("details")}>
          <Info size={12} /> {t("Details")}
        </button>
        <button className={tab === "files" ? "is-active" : ""} onClick={() => setTab("files")}>
          <Folder size={12} /> {t("Files")}
        </button>
        <button className={tab === "tools" ? "is-active" : ""} onClick={() => setTab("tools")}>
          <ListChecks size={12} /> {t("Tools")}
        </button>
      </div>

      {tab === "chat" ? (
        <div className="studio-side-chat">
          <div className="studio-side-chat-head">
            <strong>{t("Conversations")}</strong>
            <button onClick={onCreate} title={t("New chat")} aria-label={t("New chat")}>
              <Plus size={10} />
            </button>
          </div>
          <div className="studio-side-chat-list">
            {sessions.length === 0 ? (
              <span className="studio-session-empty">{t("No conversations yet.")}</span>
            ) : (
              sessions.map((session) => (
                <div
                  key={session.id}
                  className={`studio-side-chat-item ${session.id === activeId ? "is-active" : ""}`}
                >
                  <button onClick={() => onSelect(session.id)} title={session.title}>
                    <MessageSquare size={9} />
                    <span>
                      {session.title}
                      <small>{new Date(session.updatedAt).toLocaleString()}</small>
                    </span>
                  </button>
                  <button
                    onClick={() => onDelete(session.id)}
                    aria-label={t("Delete conversation")}
                    title={t("Delete conversation")}
                  >
                    <X size={8} />
                  </button>
                </div>
              ))
            )}
          </div>
          <button className="studio-side-chat-new" onClick={onCreate}>
            <Plus size={11} /> {t("New chat")}
          </button>
        </div>
      ) : null}

      {tab === "details" ? (
        <div className="studio-left-body">
          <strong>{analysis?.projectName ?? t("No project")}</strong>
          <small>{analysis?.rootPath ?? t("Open a project to keep chats and assets together.")}</small>
          {analysis ? (
            <div className="studio-left-stats">
              <span>{analysis.stats.files} {t("files")}</span>
              <span>{analysis.stats.symbols} {t("symbols")}</span>
            </div>
          ) : null}
          <button className="ghost-button" onClick={onOpenCodeStudio} disabled={!onOpenCodeStudio}>
            <ListChecks size={11} /> {t("Open Code Studio")}
          </button>
        </div>
      ) : null}

      {tab === "files" ? (
        <div className="studio-left-body">
          <strong>{t("Files")}</strong>
          <small>
            {t("File editing lives in Code Studio. This studio keeps the conversation and generated assets.")}
          </small>
          <button className="ghost-button" onClick={onOpenCodeStudio} disabled={!onOpenCodeStudio}>
            <Folder size={11} /> {t("Open Code Studio files")}
          </button>
        </div>
      ) : null}

      {tab === "tools" ? (
        <div className="studio-left-body">
          <strong>{t("Tools")}</strong>
          <button className="ghost-button" onClick={onOpenLibrary} disabled={!onOpenLibrary}>
            <Folder size={11} /> {t("Asset library")}
          </button>
          <button className="ghost-button" onClick={onOpenReports} disabled={!onOpenReports}>
            <ListChecks size={11} /> {t("Reports")}
          </button>
          <button className="ghost-button" onClick={onOpenSettings} disabled={!onOpenSettings}>
            <Settings2 size={11} /> {t("Settings")}
          </button>
        </div>
      ) : null}

      <div className="studio-side-foot">
        <span>{analysis?.projectName ?? t("No project")}</span>
        <span>{sessions.length} {t("chats")}</span>
      </div>
    </aside>
  );
}
