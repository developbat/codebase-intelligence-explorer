import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Save,
  Sparkles,
  Zap,
} from "lucide-react";
import type { ModelHealth } from "../../../shared/modelHealth";
import type {
  AiAgentAutoResult,
  AiAgentRole,
  AiAgentRoleConfig,
  AiProviderId,
  AiSettingsPublic,
} from "../../../shared/ai";
import { api } from "../api";
import { useI18n } from "../i18n";
import { readCache, writeCache } from "../lib/resourceCache";

interface AgentSettingsPanelProps {
  settings: AiSettingsPublic | null;
  onSaved: (settings: AiSettingsPublic) => void;
}

const ROLE_ORDER: AiAgentRole[] = ["main", "planner", "fast", "reviewer"];

const ROLE_META: Record<AiAgentRole, { title: string; description: string; icon: typeof Bot }> = {
  main: {
    title: "Main coding model",
    description: "Implements normal and hard tasks, edits files, and runs verification.",
    icon: Bot,
  },
  planner: {
    title: "Task planner",
    description: "Breaks a goal into an ordered task queue and keeps task context.",
    icon: Sparkles,
  },
  fast: {
    title: "Fast / economy model",
    description: "Handles small mechanical edits and short checks. Falls back to main if unavailable.",
    icon: Zap,
  },
  reviewer: {
    title: "Reviewer",
    description: "Reserved for review/verification passes in the task loop.",
    icon: CheckCircle2,
  },
};

export function AgentSettingsPanel({ settings, onSaved }: AgentSettingsPanelProps) {
  const { t } = useI18n();
  const [roles, setRoles] = useState<Partial<Record<AiAgentRole, AiAgentRoleConfig>>>({});
  const [busy, setBusy] = useState<"save" | "auto" | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [autoResult, setAutoResult] = useState<AiAgentAutoResult | null>(null);
  const [health, setHealth] = useState<ModelHealth[]>([]);
  const [healthBusy, setHealthBusy] = useState(false);
  const [healthSettings, setHealthSettings] = useState({
    protocolFailureLimit: 2,
    emptyFailureLimit: 2,
    penaltyPerFailure: 10,
  });

  async function loadHealth() {
    setHealthBusy(true);
    try {
      const response = await api.ai.modelHealth();
      setHealth(response.models);
      writeCache("model-health", response.models);
    } catch {
      setHealth([]);
    } finally {
      setHealthBusy(false);
    }
  }

  useEffect(() => {
    const cached = readCache<ModelHealth[]>("model-health", 30_000);
    if (cached?.value && !cached.stale) {
      setHealth(cached.value);
      return;
    }
    void loadHealth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!settings) return;
    const next: Partial<Record<AiAgentRole, AiAgentRoleConfig>> = {};
    for (const role of ROLE_ORDER) {
      const configured = settings.agentRoles.find((item) => item.role === role);
      if (configured) next[role] = { provider: configured.provider, model: configured.model };
    }
    setRoles(next);
    setHealthSettings(settings.modelHealth);
  }, [settings]);

  const providers = useMemo(
    () =>
      (settings?.providers ?? []).filter(
        (provider) => provider.hasKey || provider.custom || provider.id === settings?.defaultProvider,
      ),
    [settings],
  );

  const modelOptions = (role: AiAgentRole, providerId: AiProviderId): string[] => {
    const configured = settings?.agentRoles.find((item) => item.role === role);
    const provider =
      settings?.providers.find((item) => item.id === providerId) ??
      settings?.providers.find((item) => item.id === configured?.provider);
    return provider?.models ?? [];
  };

  function updateRole(role: AiAgentRole, patch: Partial<AiAgentRoleConfig>) {
    setRoles((current) => {
      const previous = current[role] ?? {
        provider: settings?.defaultProvider ?? "openai",
        model: settings?.defaultModel ?? "",
      };
      return { ...current, [role]: { ...previous, ...patch } };
    });
  }

  async function save() {
    setBusy("save");
    setMessage(null);
    try {
      const next = await api.ai.updateSettings({ agentRoles: roles });
      onSaved(next);
      setMessage({ ok: true, text: t("Agent roles saved.") });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : t("Could not save agent roles.") });
    } finally {
      setBusy(null);
    }
  }

  async function saveHealthSettings() {
    setHealthBusy(true);
    setMessage(null);
    try {
      const next = await api.ai.updateSettings({ modelHealth: healthSettings });
      onSaved(next);
      setMessage({ ok: true, text: t("Model health thresholds saved.") });
    } catch (error) {
      setMessage({
        ok: false,
        text: error instanceof Error ? error.message : t("Could not save model health thresholds."),
      });
    } finally {
      setHealthBusy(false);
    }
  }

  async function autoPick() {
    setBusy("auto");
    setMessage(null);
    setAutoResult(null);
    try {
      const result = await api.ai.autoConfigureAgents();
      onSaved(result.settings);
      setAutoResult(result);
      setMessage({
        ok: true,
        text: t("Agent roles auto-configured from the saved model lists."),
      });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : t("Could not auto-configure agents.") });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="agent-settings-panel">
      <div className="agent-settings-head">
        <div>
          <strong>
            <Bot size={14} /> {t("Agent roles")}
          </strong>
          <span>
            {t(
              "The task loop splits work between these roles. Each role can use a different provider and model.",
            )}
          </span>
        </div>
        <button className="ghost-button" onClick={() => void autoPick()} disabled={busy !== null}>
          {busy === "auto" ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
          {t("Auto-pick models")}
        </button>
      </div>

      <div className="agent-settings-note">
        <Sparkles size={12} />
        <span>
          {t(
            "Auto-pick uses cached model lists and the imported JSON catalog when available. It does not fetch providers on every run; use Update model list in Models to refresh.",
          )}
        </span>
      </div>

      <div className="agent-role-grid">
        {ROLE_ORDER.map((role) => {
          const meta = ROLE_META[role];
          const Icon = meta.icon;
          const configured = roles[role] ?? {
            provider: settings?.defaultProvider ?? "openai",
            model: settings?.defaultModel ?? "",
          };
          const provider = settings?.providers.find((item) => item.id === configured.provider);
          const models = modelOptions(role, configured.provider);
          return (
            <section key={role} className={`agent-role-card is-${role}`}>
              <div className="agent-role-title">
                <span>
                  <Icon size={14} />
                </span>
                <div>
                  <strong>{t(meta.title)}</strong>
                  <small>{t(meta.description)}</small>
                </div>
              </div>
              <label className="agent-role-field">
                <span>{t("Provider")}</span>
                <select
                  className="settings-select"
                  value={configured.provider}
                  onChange={(event) => {
                    const providerId = event.target.value;
                    const nextProvider = settings?.providers.find((item) => item.id === providerId);
                    updateRole(role, {
                      provider: providerId,
                      model: nextProvider?.models.includes(configured.model)
                        ? configured.model
                        : nextProvider?.models[0] ?? nextProvider?.model ?? "",
                    });
                  }}
                >
                  {providers.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                  {providers.every((item) => item.id !== configured.provider) ? (
                    <option value={configured.provider}>{configured.provider}</option>
                  ) : null}
                </select>
              </label>
              <label className="agent-role-field">
                <span>{t("Model")}</span>
                <input
                  className="text-input mono"
                  value={configured.model}
                  onChange={(event) => updateRole(role, { model: event.target.value })}
                  list={`agent-models-${role}`}
                  spellCheck={false}
                  placeholder={provider?.model || "model-id"}
                />
                <datalist id={`agent-models-${role}`}>
                  {models.map((model) => (
                    <option key={model} value={model} />
                  ))}
                </datalist>
                <small>
                  {models.length} {t("models ready")}
                  {provider?.modelsUpdatedAt
                    ? ` · ${t("updated {time}", {
                        time: new Date(provider.modelsUpdatedAt).toLocaleString(),
                      })}`
                    : ""}
                </small>
                {(() => {
                  const healthEntry = health.find(
                    (item) =>
                      item.provider === configured.provider && item.model === configured.model,
                  );
                  if (!healthEntry) return <small>{t("No agent history yet")}</small>;
                  return (
                    <small
                      className={
                        healthEntry.protocolFailures >= 2 ? "agent-health-bad" : "agent-health-good"
                      }
                    >
                      {healthEntry.successCount}✓ · {healthEntry.protocolFailures} {t("protocol failures")} ·{" "}
                      {healthEntry.emptyFailures} {t("empty responses")}
                    </small>
                  );
                })()}
              </label>
            </section>
          );
        })}
      </div>

      {message ? (
        <div className={`ai-test-result ${message.ok ? "is-ok" : "is-error"}`}>
          {message.ok ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
          {message.text}
        </div>
      ) : null}

      {autoResult ? (
        <div className="agent-auto-result">
          {autoResult.picks.map((pick) => (
            <div key={pick.role}>
              <span>{t(pick.role)}</span>
              <code>
                {pick.provider} · {pick.model}
              </code>
              <small>{pick.reason}</small>
            </div>
          ))}
          {autoResult.warnings.map((warning) => (
            <p key={warning}>
              <AlertTriangle size={10} /> {warning}
            </p>
          ))}
        </div>
      ) : null}

      <div className="agent-health-panel">
        <div className="agent-health-head">
          <strong>{t("Model health")}</strong>
          <button className="ghost-button" onClick={() => void loadHealth()} disabled={healthBusy}>
            {healthBusy ? <Loader2 size={11} className="spin" /> : <RefreshCw size={11} />}
            {t("Refresh")}
          </button>
        </div>
        <div className="agent-health-thresholds">
          <label>
            {t("Protocol failure limit")}
            <input
              type="number"
              min={1}
              max={10}
              value={healthSettings.protocolFailureLimit}
              onChange={(event) =>
                setHealthSettings((current) => ({
                  ...current,
                  protocolFailureLimit: Number(event.target.value) || 1,
                }))
              }
            />
          </label>
          <label>
            {t("Empty response limit")}
            <input
              type="number"
              min={1}
              max={10}
              value={healthSettings.emptyFailureLimit}
              onChange={(event) =>
                setHealthSettings((current) => ({
                  ...current,
                  emptyFailureLimit: Number(event.target.value) || 1,
                }))
              }
            />
          </label>
          <label>
            {t("Penalty per failure")}
            <input
              type="number"
              min={1}
              max={100}
              value={healthSettings.penaltyPerFailure}
              onChange={(event) =>
                setHealthSettings((current) => ({
                  ...current,
                  penaltyPerFailure: Number(event.target.value) || 1,
                }))
              }
            />
          </label>
          <button className="ghost-button" onClick={() => void saveHealthSettings()} disabled={healthBusy}>
            {t("Save thresholds")}
          </button>
        </div>
        {health.length === 0 ? (
          <p>{t("No model runs recorded yet.")}</p>
        ) : (
          <div className="agent-health-list">
            {health.slice(0, 12).map((item) => (
              <div
                key={`${item.provider}::${item.model}`}
                className={item.protocolFailures >= 2 ? "is-bad" : ""}
              >
                <code>{item.provider}</code>
                <span>{item.model}</span>
                <small>
                  {item.successCount}✓ · {item.protocolFailures} {t("protocol")} · {item.emptyFailures}{" "}
                  {t("empty")}
                </small>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="agent-settings-actions">
        <span>
          {t(
            "Task loop starts with a planner pass, then runs tasks sequentially until the queue is done or you press Stop.",
          )}
        </span>
        <button className="primary-button" onClick={() => void save()} disabled={busy !== null}>
          {busy === "save" ? <Loader2 size={13} className="spin" /> : <Save size={13} />}
          {t("Save agent roles")}
        </button>
      </div>
    </div>
  );
}
