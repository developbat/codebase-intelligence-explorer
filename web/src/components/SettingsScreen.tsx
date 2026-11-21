import { useEffect, useRef, useState } from "react";
import {
  BarChart3,
  Bot,
  Code2,
  Cpu,
  FileText,
  Globe2,
  Library,
  RefreshCw,
  Smartphone,
  Settings2,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import type { AiSettingsPublic } from "../../../shared/ai";
import { useI18n } from "../i18n";
import { api } from "../api";
import { AiSettingsDialog } from "./AiSettingsDialog";
import { UsageDialog } from "./UsageDialog";
import { PromptManagerDialog } from "./PromptManagerDialog";
import { SkillsPanel } from "./SkillsPanel";
import { AgentSettingsPanel } from "./AgentSettingsPanel";
import { ModelCatalogPanel } from "./ModelCatalogPanel";
import { MobileDevicesPanel } from "./MobileDevicesPanel";
import { ToolchainsPanel } from "./ToolchainsPanel";

export type SettingsTab =
  | "general"
  | "models"
  | "agents"
  | "catalog"
  | "devices"
  | "editor"
  | "usage"
  | "prompts"
  | "skills";

interface SettingsScreenProps {
  open: boolean;
  initialTab?: SettingsTab;
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
  onClose: () => void;
}

const TABS: { id: SettingsTab; label: string; icon: typeof Settings2 }[] = [
  { id: "general", label: "General", icon: Globe2 },
  { id: "models", label: "Models", icon: Cpu },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "catalog", label: "Model catalog", icon: Library },
  { id: "devices", label: "Devices", icon: Smartphone },
  { id: "editor", label: "Editor & tests", icon: Code2 },
  { id: "usage", label: "Usage", icon: BarChart3 },
  { id: "prompts", label: "Prompts", icon: FileText },
  { id: "skills", label: "Skills", icon: Sparkles },
];

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
  onClose,
}: SettingsScreenProps) {
  const { t, locale, locales, setLocale } = useI18n();
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [autoSwitchBusy, setAutoSwitchBusy] = useState(false);
  const screenRef = useRef<HTMLDivElement | null>(null);

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
    if (open) screenRef.current?.focus();
  }, [open]);

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

                <ToolchainsPanel />

                <section className="settings-section">
                  <h3>{t("General approvals")}</h3>
                  <p>
                    {t(
                      "These are pre-approvals. When off, the agent pauses and asks Allow once / Always allow / Deny before the action.",
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

                <section className="settings-section">
                  <h3>{t("Local data")}</h3>
                  <p>
                    {t(
                      "Providers, keys, usage, prompts, backups and the project index are stored on this machine. Keys are never returned to the browser.",
                    )}
                  </p>
                </section>
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
          </div>
        </section>
      </div>
    </div>
  );
}
