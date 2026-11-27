import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  Bot,
  CheckCircle2,
  Code2,
  Cpu,
  Download,
  FileText,
  Globe2,
  Library,
  Loader2,
  RefreshCw,
  Smartphone,
  ScrollText,
  Settings2,
  ShieldCheck,
  Trash2,
  Wrench,
  Sparkles,
  X,
} from "lucide-react";
import type { AiSettingsPublic } from "../../../shared/ai";
import { useI18n } from "../i18n";
import { api } from "../api";
import { desktopUpdates, type DesktopUpdateState } from "../desktopUpdates";
import { AiSettingsDialog } from "./AiSettingsDialog";
import { UsageDialog } from "./UsageDialog";
import { ReportsPanel } from "./ReportsPanel";
import { PromptManagerDialog } from "./PromptManagerDialog";
import { SkillsPanel } from "./SkillsPanel";
import { AgentSettingsPanel } from "./AgentSettingsPanel";
import { ModelCatalogPanel } from "./ModelCatalogPanel";
import { ModelPickerPanel } from "./ModelPickerPanel";
import { MobileDevicesPanel } from "./MobileDevicesPanel";
import { ToolchainsPanel } from "./ToolchainsPanel";
import { ToolsPanel } from "./ToolsPanel";

export type SettingsTab =
  | "general"
  | "models"
  | "model-picker"
  | "agents"
  | "catalog"
  | "devices"
  | "editor"
  | "usage"
  | "reports"
  | "prompts"
  | "skills"
  | "tools";

interface SettingsScreenProps {
  open: boolean;
  initialTab?: SettingsTab;
  focusSection?: "updates" | null;
  modelsAddMode?: boolean;
  projectId?: string;
  projectName?: string;
  projectRoot?: string;
  aiSettings: AiSettingsPublic | null;
  onSettingsSaved: (settings: AiSettingsPublic) => void;
  agentAllowWrite: boolean;
  onAgentAllowWriteChange: (value: boolean) => void;
  agentAllowCommands: boolean;
  onAgentAllowCommandsChange: (value: boolean) => void;
  autoFormat: boolean;
  onAutoFormatChange: (value: boolean) => void;
  autoSyntax: boolean;
  onAutoSyntaxChange: (value: boolean) => void;
  autoCheck: boolean;
  onAutoCheckChange: (value: boolean) => void;
  testTimeout: number;
  onTestTimeoutChange: (value: number) => void;
  onRescan?: () => void;
  onClearRecent?: () => Promise<number | void>;
  onClose: () => void;
}

const TABS: { id: SettingsTab; label: string; icon: typeof Settings2 }[] = [
  { id: "general", label: "General", icon: Globe2 },
  { id: "models", label: "Model providers", icon: Cpu },
  { id: "model-picker", label: "Model selection", icon: Sparkles },
  { id: "agents", label: "Agent workers", icon: Bot },
  { id: "catalog", label: "Model catalog", icon: Library },
  { id: "devices", label: "Devices", icon: Smartphone },
  { id: "editor", label: "Editor & tests", icon: Code2 },
  { id: "usage", label: "Usage", icon: BarChart3 },
  { id: "reports", label: "Reports", icon: ScrollText },
  { id: "prompts", label: "Prompts", icon: FileText },
  { id: "skills", label: "Skills", icon: Sparkles },
  { id: "tools", label: "Tools", icon: Wrench },
];

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function SettingsToggle({
  checked,
  onChange,
  title,
  description,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  title: string;
  description: string;
}) {
  return (
    <label className="settings-toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <i className={checked ? "is-on" : ""} aria-hidden="true" />
    </label>
  );
}

export function SettingsScreen({
  open,
  initialTab = "general",
  focusSection = null,
  modelsAddMode = false,
  projectId,
  projectName,
  projectRoot,
  aiSettings,
  onSettingsSaved,
  agentAllowWrite,
  onAgentAllowWriteChange,
  agentAllowCommands,
  onAgentAllowCommandsChange,
  autoFormat,
  onAutoFormatChange,
  autoSyntax,
  onAutoSyntaxChange,
  autoCheck,
  onAutoCheckChange,
  testTimeout,
  onTestTimeoutChange,
  onRescan,
  onClearRecent,
  onClose,
}: SettingsScreenProps) {
  const { t, locale, locales, setLocale } = useI18n();
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [autoSwitchBusy, setAutoSwitchBusy] = useState(false);
  const [appInfo, setAppInfo] = useState<Awaited<ReturnType<typeof api.appVersion>> | null>(null);
  const [updateInfo, setUpdateInfo] = useState<Awaited<ReturnType<typeof api.checkUpdate>> | null>(null);
  const [desktopUpdate, setDesktopUpdate] = useState<DesktopUpdateState | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateActionBusy, setUpdateActionBusy] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);
  const [clearRecentBusy, setClearRecentBusy] = useState(false);
  const screenRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open || tab !== "general") return;
    let active = true;
    void api.appVersion()
      .then((info) => {
        if (active) setAppInfo(info);
      })
      .catch(() => undefined);
    const bridge = desktopUpdates();
    if (!bridge) {
      return () => {
        active = false;
      };
    }
    void bridge.getState()
      .then((state) => {
        if (active) setDesktopUpdate(state);
      })
      .catch(() => undefined);
    const off = bridge.onState((state) => setDesktopUpdate(state));
    return () => {
      active = false;
      off();
    };
  }, [open, tab]);

  async function checkForUpdates() {
    if (updateBusy) return;
    const bridge = desktopUpdates();
    if (bridge) {
      const started = Date.now();
      setUpdateBusy(true);
      setDesktopUpdate((previous) =>
        previous
          ? {
              ...previous,
              status: "checking",
              progress: null,
              message: t("Checking for updates…"),
            }
          : previous,
      );
      try {
        const state = await withTimeout(
          bridge.check(),
          30_000,
          t("Update check timed out. Check your network and try again."),
        );
        await new Promise((resolve) =>
          window.setTimeout(resolve, Math.max(0, 600 - (Date.now() - started))),
        );
        setDesktopUpdate(state);
      } catch (error) {
        setDesktopUpdate((previous) =>
          previous
            ? {
                ...previous,
                status: "error",
                progress: null,
                message:
                  error instanceof Error
                    ? error.message
                    : t("Update check failed. Check your network and try again."),
              }
            : previous,
        );
      } finally {
        setLastCheckedAt(new Date());
        setUpdateBusy(false);
      }
      return;
    }

    setUpdateBusy(true);
    try {
      const info = await withTimeout(
        api.checkUpdate(),
        20_000,
        t("Update check timed out. Check your network and try again."),
      );
      setUpdateInfo(info);
    } catch {
      setUpdateInfo({
        current: appInfo?.version ?? "0.0.0",
        latest: null,
        updateAvailable: false,
        source: "unavailable",
        releaseUrl: appInfo?.releaseUrl ?? null,
        note: t("Update check failed. Check your network or Git remote."),
      });
    } finally {
      setLastCheckedAt(new Date());
      setUpdateBusy(false);
    }
  }

  const checkForUpdatesRef = useRef(checkForUpdates);
  checkForUpdatesRef.current = checkForUpdates;

  useEffect(() => {
    if (!open || focusSection !== "updates") return;
    const timer = window.setTimeout(() => {
      void checkForUpdatesRef.current();
    }, 250);
    return () => window.clearTimeout(timer);
  }, [open, focusSection]);

  async function downloadUpdate() {
    const bridge = desktopUpdates();
    if (!bridge || updateActionBusy) return;
    setUpdateActionBusy(true);
    try {
      setDesktopUpdate(await bridge.download());
    } finally {
      setUpdateActionBusy(false);
    }
  }

  async function installUpdate() {
    const bridge = desktopUpdates();
    if (!bridge || updateActionBusy) return;
    setUpdateActionBusy(true);
    try {
      await bridge.install();
    } catch {
      setUpdateActionBusy(false);
    }
  }

  function updateStatusText(state: DesktopUpdateState): string {
    switch (state.status) {
      case "checking":
        return t("Checking for updates…");
      case "available":
        return `${t("Update available")}: ${state.latestVersion ?? "—"}`;
      case "not-available":
        return t("You are on the latest version.");
      case "downloading":
        return `${t("Downloading update…")} ${state.progress ?? 0}%`;
      case "downloaded":
        return t("Update downloaded. Restart to finish installing.");
      case "error":
        if (/No published versions/i.test(state.message)) {
          return t(
            "No published release yet. Publish a GitHub release to enable updates.",
          );
        }
        return `${t("Update failed")}: ${state.message}`;
      default:
        return state.message || t("Check for updates to see if a new version is available.");
    }
  }

  async function clearRecentHistory(): Promise<void> {
    if (!onClearRecent || clearRecentBusy) return;
    if (
      !window.confirm(
        t("Clear the recent project list? Project files and analyses are not deleted."),
      )
    ) {
      return;
    }
    setClearRecentBusy(true);
    try {
      await onClearRecent();
    } finally {
      setClearRecentBusy(false);
    }
  }

  async function saveAutoSwitch(value: boolean) {
    if (!aiSettings || autoSwitchBusy) return;
    setAutoSwitchBusy(true);
    try {
      const next = await api.ai.updateSettings({ autoSwitchModels: value });
      onSettingsSaved(next);
    } finally {
      setAutoSwitchBusy(false);
    }
  }

  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  useEffect(() => {
    localStorage.setItem("cie:settings-tab", tab);
  }, [tab]);

  useEffect(() => {
    if (open) screenRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open || focusSection !== "updates") return;
    const timer = window.setTimeout(() => {
      document
        .getElementById("settings-updates")
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [open, focusSection]);

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
    <div className="modal-backdrop settings-backdrop" onMouseDown={onClose}>
      <div
        className="settings-screen"
        ref={screenRef}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <aside className="settings-sidebar">
          <div className="settings-brand">
            <span className="settings-brand-icon">
              <Settings2 size={16} />
            </span>
            <div>
              <strong>{t("Settings")}</strong>
              <small>{projectName ?? t("Project")}</small>
            </div>
          </div>
          <nav className="settings-tabs">
            {TABS.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  className={tab === item.id ? "is-active" : ""}
                  onClick={() => setTab(item.id)}
                >
                  <Icon size={13} />
                  {t(item.label)}
                </button>
              );
            })}
          </nav>
          <div className="settings-side-footer">
            <span>{t("Stored locally")}</span>
            <span>{projectRoot ? projectRoot.split("/").pop() : t("No project")}</span>
          </div>
        </aside>

        <section className="settings-main">
          <header className="settings-header">
            <div>
              <div className="modal-eyebrow">{t("Workspace settings")}</div>
              <h2>{t(TABS.find((item) => item.id === tab)?.label ?? "Settings")}</h2>
            </div>
            <button className="icon-button" onClick={onClose} aria-label={t("Close")}>
              <X size={16} />
            </button>
          </header>

          <div className="settings-content">
            {tab === "general" ? (
              <div className="settings-stack">
                <section className="settings-section">
                  <h3>{t("Language")}</h3>
                  <p>{t("UI language for menus, panels and AI answers.")}</p>
                  <select
                    className="settings-select"
                    value={locale}
                    onChange={(event) => setLocale(event.target.value as typeof locale)}
                  >
                    {locales.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.nativeLabel}
                      </option>
                    ))}
                  </select>
                </section>

                <section className="settings-section">
                  <h3>{t("Project")}</h3>
                  <div className="settings-project-card">
                    <div>
                      <strong>{projectName ?? t("No project open")}</strong>
                      <code>{projectRoot ?? "—"}</code>
                    </div>
                    {onRescan ? (
                      <button className="ghost-button" onClick={onRescan}>
                        <RefreshCw size={12} /> {t("Rescan project")}
                      </button>
                    ) : null}
                  </div>
                </section>

                <ToolchainsPanel projectId={projectId} />

                <section className="settings-section">
                  <h3>{t("General approvals")}</h3>
                  <p>
                    {t(
                      "Defaults for projects without their own override. When off, the agent pauses and asks Allow once / Always allow / Deny before the action. Code Studio can override these per project.",
                    )}
                  </p>
                  <div className="settings-toggle-list">
                    <SettingsToggle
                      checked={agentAllowWrite}
                      onChange={onAgentAllowWriteChange}
                      title={t("Pre-approve file writes")}
                      description={t("Writes still create a timestamped local backup.")}
                    />
                    <SettingsToggle
                      checked={agentAllowCommands}
                      onChange={onAgentAllowCommandsChange}
                      title={t("Pre-approve commands")}
                      description={t("Build, test and typecheck commands can run without an extra prompt.")}
                    />
                  </div>
                </section>

                <section className="settings-section settings-note">
                  <ShieldCheck size={14} />
                  <p>
                    {t(
                      "Delete and rename always require a fresh confirmation. Dangerous commands such as sudo, git push, git reset --hard and curl | sh remain blocked.",
                    )}
                  </p>
                </section>

                <section className="settings-section">
                  <h3>{t("Model behavior")}</h3>
                  <div className="settings-toggle-list">
                    <SettingsToggle
                      checked={aiSettings?.autoSwitchModels !== false}
                      onChange={(value) => void saveAutoSwitch(value)}
                      title={t("Automatic model switching")}
                      description={t(
                        "When the selected model is unavailable or fails, switch to a working model and show which model was selected. When off, the run stops and asks you to choose a model.",
                      )}
                    />
                  </div>
                </section>

                <section className="settings-section" id="settings-updates">
                  <h3>{t("App & updates")}</h3>
                  <div className="settings-project-card">
                    <div>
                      <strong>
                        B.A.D IDE {desktopUpdate?.currentVersion ?? appInfo?.version ?? "…"}
                      </strong>
                      <code>
                        {appInfo?.commit?.slice(0, 7) ?? "—"} · {appInfo?.branch ?? "—"} ·{" "}
                        {appInfo?.platform ?? "—"}/{appInfo?.arch ?? "—"}
                      </code>
                    </div>
                    <button
                      className="ghost-button"
                      onClick={() => void checkForUpdates()}
                      disabled={updateBusy || updateActionBusy}
                    >
                      <RefreshCw size={12} className={updateBusy ? "spin" : ""} />{" "}
                      {t("Check for updates")}
                    </button>
                  </div>

                  {desktopUpdate ? (
                    <div className="update-panel">
                      <div
                        className={`update-status is-${desktopUpdate.status}`}
                        role="status"
                        aria-live="polite"
                      >
                        {desktopUpdate.status === "checking" ? (
                          <Loader2 size={13} className="spin" />
                        ) : desktopUpdate.status === "error" ? (
                          <AlertTriangle size={13} />
                        ) : desktopUpdate.status === "downloaded" ? (
                          <CheckCircle2 size={13} />
                        ) : desktopUpdate.status === "available" ? (
                          <Download size={13} />
                        ) : (
                          <RefreshCw size={13} />
                        )}
                        <span>{updateStatusText(desktopUpdate)}</span>
                      </div>
                      {lastCheckedAt ? (
                        <small className="update-last-checked">
                          {t("Last checked")}: {lastCheckedAt.toLocaleTimeString()}
                        </small>
                      ) : null}
                      {desktopUpdate.status === "downloading" ? (
                        <div className="update-progress" aria-hidden="true">
                          <span style={{ width: `${desktopUpdate.progress ?? 0}%` }} />
                        </div>
                      ) : null}
                      <div className="update-actions">
                        {desktopUpdate.status === "available" ? (
                          <button
                            className="primary-button"
                            onClick={() => void downloadUpdate()}
                            disabled={updateActionBusy}
                          >
                            {t("Download update")} {desktopUpdate.latestVersion ?? ""}
                          </button>
                        ) : null}
                        {desktopUpdate.status === "downloaded" ? (
                          <button
                            className="primary-button"
                            onClick={() => void installUpdate()}
                            disabled={updateActionBusy}
                          >
                            {t("Restart to update")}
                          </button>
                        ) : null}
                        {desktopUpdate.releaseUrl ? (
                          <a
                            className="update-link"
                            href={desktopUpdate.releaseUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {t("Release notes")}
                          </a>
                        ) : null}
                      </div>
                      {!desktopUpdate.supported ? (
                        <p>
                          {t(
                            "Update checks run in the packaged desktop app. This window is a development build.",
                          )}
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <>
                      <div
                        className={`update-status ${
                          updateBusy
                            ? "is-checking"
                            : updateInfo?.updateAvailable
                              ? "is-available"
                              : "is-idle"
                        }`}
                        role="status"
                        aria-live="polite"
                      >
                        {updateBusy ? (
                          <Loader2 size={13} className="spin" />
                        ) : updateInfo?.updateAvailable ? (
                          <Download size={13} />
                        ) : (
                          <RefreshCw size={13} />
                        )}
                        <span>
                          {updateBusy
                            ? t("Checking for updates…")
                            : updateInfo?.note ??
                              t(
                                "Source checkouts can check Git release tags. Packaged builds update from signed Electron releases, never by pulling arbitrary files.",
                              )}
                        </span>
                      </div>
                      {lastCheckedAt ? (
                        <small className="update-last-checked">
                          {t("Last checked")}: {lastCheckedAt.toLocaleTimeString()}
                        </small>
                      ) : null}
                      {updateInfo?.latest ? (
                        <p>
                          {t("Latest")}: <code>{updateInfo.latest}</code>
                          {updateInfo.updateAvailable ? ` · ${t("Update available")}` : ""}
                        </p>
                      ) : null}
                    </>
                  )}
                </section>

                <section className="settings-section">
                  <h3>{t("Local data")}</h3>
                  <p>
                    {t(
                      "Providers, keys, usage, prompts, backups and the project index are stored on this machine. Keys are never returned to the browser.",
                    )}
                  </p>
                </section>
                {onClearRecent ? (
                  <section className="settings-section">
                    <h3>{t("Recent projects")}</h3>
                    <p>
                      {t(
                        "Clear the saved project history without deleting project files or analyses.",
                      )}
                    </p>
                    <button
                      className="ghost-button"
                      onClick={() => void clearRecentHistory()}
                      disabled={clearRecentBusy}
                    >
                      {clearRecentBusy ? (
                        <Loader2 size={12} className="spin" />
                      ) : (
                        <Trash2 size={12} />
                      )}{" "}
                      {t("Clear recent projects")}
                    </button>
                  </section>
                ) : null}
              </div>
            ) : null}

            {tab === "models" ? (
              <AiSettingsDialog
                open={tab === "models"}
                embedded
                settings={aiSettings}
                startInAddMode={modelsAddMode}
                onClose={onClose}
                onSaved={onSettingsSaved}
              />
            ) : null}

            {tab === "model-picker" ? (
              <ModelPickerPanel settings={aiSettings} onSettingsSaved={onSettingsSaved} />
            ) : null}

            {tab === "agents" ? (
              <AgentSettingsPanel settings={aiSettings} onSaved={onSettingsSaved} />
            ) : null}

            {tab === "catalog" ? <ModelCatalogPanel /> : null}

            {tab === "devices" ? (
              <div className="settings-stack">
                <MobileDevicesPanel projectId={projectId} />
              </div>
            ) : null}

            {tab === "editor" ? (
              <div className="settings-stack">
                <section className="settings-section">
                  <h3>{t("After save")}</h3>
                  <p>{t("Choose which checks run automatically when you save a file.")}</p>
                  <div className="settings-toggle-list">
                    <SettingsToggle
                      checked={autoFormat}
                      onChange={onAutoFormatChange}
                      title={t("Format file on save")}
                      description={t("Run the detected formatter and reload the formatted content.")}
                    />
                    <SettingsToggle
                      checked={autoSyntax}
                      onChange={onAutoSyntaxChange}
                      title={t("Run syntax check after save")}
                      description={t("Per-file syntax check; failures open the Checks panel.")}
                    />
                    <SettingsToggle
                      checked={autoCheck}
                      onChange={onAutoCheckChange}
                      title={t("Run typecheck after save")}
                      description={t("Run the project typecheck command after each save.")}
                    />
                  </div>
                </section>
                <section className="settings-section">
                  <h3>{t("Tests")}</h3>
                  <label className="settings-field">
                    <span>{t("Test timeout")}</span>
                    <select
                      className="settings-select"
                      value={testTimeout}
                      onChange={(event) => onTestTimeoutChange(Number(event.target.value))}
                    >
                      <option value={120}>{t("2 min")}</option>
                      <option value={300}>{t("5 min")}</option>
                      <option value={600}>{t("10 min")}</option>
                      <option value={1200}>{t("20 min")}</option>
                    </select>
                  </label>
                  <p>{t("Long suites can run up to 20 minutes; Stop remains available in the Tests panel.")}</p>
                </section>
              </div>
            ) : null}

            {tab === "usage" ? (
              projectId ? (
                <UsageDialog
                  open={tab === "usage"}
                  embedded
                  projectId={projectId}
                  projectName={projectName ?? t("Project")}
                  onClose={onClose}
                />
              ) : (
                <div className="settings-empty">{t("Open a project to see usage.")}</div>
              )
            ) : null}

            {tab === "reports" ? (
              projectId ? (
                <ReportsPanel projectId={projectId} />
              ) : (
                <div className="settings-empty">{t("Open a project to see reports.")}</div>
              )
            ) : null}

            {tab === "prompts" ? (
              projectId ? (
                <PromptManagerDialog
                  open={tab === "prompts"}
                  embedded
                  projectId={projectId}
                  onClose={onClose}
                />
              ) : (
                <div className="settings-empty">{t("Open a project to edit prompts.")}</div>
              )
            ) : null}

            {tab === "skills" ? (
              projectId ? (
                <SkillsPanel projectId={projectId} />
              ) : (
                <div className="settings-empty">{t("Open a project to manage skills.")}</div>
              )
            ) : null}

            {tab === "tools" ? <ToolsPanel projectId={projectId} /> : null}
          </div>
        </section>
      </div>
    </div>
  );
}
