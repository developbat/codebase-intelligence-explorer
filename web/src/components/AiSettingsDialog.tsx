import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Cpu,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  PlugZap,
  RefreshCw,
  ShieldCheck,
  X,
  XCircle,
} from "lucide-react";
import type { AiProviderId, AiSettingsPublic } from "../../../shared/ai";
import { AI_PROVIDERS, providerInfo } from "../../../shared/ai";
import { api } from "../api";
import { useI18n } from "../i18n";

interface AiSettingsDialogProps {
  open: boolean;
  settings: AiSettingsPublic | null;
  onClose: () => void;
  onSaved: (settings: AiSettingsPublic) => void;
}

export function AiSettingsDialog({ open, settings, onClose, onSaved }: AiSettingsDialogProps) {
  const { t } = useI18n();
  const [provider, setProvider] = useState<AiProviderId>(settings?.defaultProvider ?? "openai");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [clearKey, setClearKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [makeDefault, setMakeDefault] = useState(false);
  const [busy, setBusy] = useState<"save" | "test" | "models" | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [models, setModels] = useState<string[]>([]);

  useEffect(() => {
    if (!open || !settings) return;
    const state = settings.providers.find((item) => item.id === provider);
    setBaseUrl(state?.baseUrl ?? providerInfo(provider).baseUrl);
    setModel(state?.model ?? providerInfo(provider).models[0] ?? "");
    setApiKey("");
    setClearKey(false);
    setShowKey(false);
    setModels(providerInfo(provider).models);
  }, [open, provider, settings]);

  useEffect(() => {
    setMessage(null);
    setMakeDefault(false);
  }, [provider]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const state = settings?.providers.find((item) => item.id === provider);
  const info = providerInfo(provider);

  async function persist(): Promise<AiSettingsPublic> {
    const next = await api.ai.updateSettings({
      provider,
      apiKey: apiKey.trim() || undefined,
      clearKey,
      baseUrl,
      model,
      ...(makeDefault ? { defaultProvider: provider, defaultModel: model } : {}),
    });
    onSaved(next);
    setApiKey("");
    setClearKey(false);
    return next;
  }

  async function save() {
    setBusy("save");
    setMessage(null);
    try {
      await persist();
      setMessage({ ok: true, text: t("Settings saved.") });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : t("Could not save settings.") });
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy("test");
    setMessage(null);
    try {
      await persist();
      const result = await api.ai.test(provider, model);
      setMessage({
        ok: result.ok,
        text: result.ok
          ? t("Connection OK · {model} · {latency} ms", { model: result.model, latency: result.latencyMs })
          : result.message,
      });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : t("Connection test failed.") });
    } finally {
      setBusy(null);
    }
  }

  async function fetchModels() {
    setBusy("models");
    setMessage(null);
    try {
      await persist();
      const result = await api.ai.models(provider);
      setModels(result.models.length > 0 ? result.models : info.models);
      setMessage({ ok: true, text: t("{count} models loaded.", { count: result.models.length }) });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : t("Could not load models.") });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="ai-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="modal-eyebrow">{t("Optional semantic layer")}</div>
            <h2>{t("AI models & providers")}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label={t("Close")}>
            <X size={16} />
          </button>
        </div>
        <p className="modal-text">
          {t(
            "Connect one or more providers. Keys stay on this machine, are stored in a 0600 file, and are sent only to the provider you select. Source snippets are sent only when you request an analysis.",
          )}
        </p>

        <div className="ai-settings-layout">
          <div className="ai-provider-list">
            {AI_PROVIDERS.map((item) => {
              const itemState = settings?.providers.find((candidate) => candidate.id === item.id);
              return (
                <button
                  key={item.id}
                  className={`ai-provider ${provider === item.id ? "is-active" : ""}`}
                  onClick={() => setProvider(item.id)}
                >
                  <span className="ai-provider-icon">
                    <Cpu size={14} />
                  </span>
                  <span className="ai-provider-main">
                    <span className="ai-provider-name">{item.name}</span>
                    <span className={`ai-provider-state ${itemState?.hasKey ? "is-ready" : ""}`}>
                      {itemState?.keyHint ?? t("Not configured")}
                    </span>
                  </span>
                  {settings?.defaultProvider === item.id ? (
                    <span className="ai-default-badge">{t("Default")}</span>
                  ) : null}
                </button>
              );
            })}
          </div>

          <div className="ai-provider-form">
            <div className="ai-form-heading">
              <span>{info.name}</span>
              {info.docsUrl ? (
                <a href={info.docsUrl} target="_blank" rel="noreferrer">
                  {t("Get an API key")} <ExternalLink size={10} />
                </a>
              ) : null}
            </div>

            <label className="field-label">
              <KeyRound size={12} /> {t("API key")}
              {state?.hasKey ? <span className="field-hint">{state.keyHint}</span> : null}
            </label>
            <div className="secret-input">
              <input
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={state?.hasKey ? t("Leave blank to keep the saved key") : info.keyPlaceholder}
                spellCheck={false}
                autoComplete="off"
              />
              <button className="icon-button subtle" onClick={() => setShowKey((value) => !value)} title={t("Show/hide key")}>
                {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>
            {state?.hasKey ? (
              <label className="checkbox-row">
                <input type="checkbox" checked={clearKey} onChange={(event) => setClearKey(event.target.checked)} />
                {t("Remove the saved key")}
              </label>
            ) : null}

            <label className="field-label">{t("Base URL")}</label>
            <input
              className="text-input"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              spellCheck={false}
            />

            <label className="field-label">
              {t("Model")}
              <button
                className="inline-action"
                onClick={fetchModels}
                disabled={busy !== null}
                title={t("Load model list from provider")}
              >
                {busy === "models" ? <Loader2 size={11} className="spin" /> : <RefreshCw size={11} />}
                {t("Fetch models")}
              </button>
            </label>
            <input
              className="text-input mono"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              list={`models-${provider}`}
              spellCheck={false}
            />
            <datalist id={`models-${provider}`}>
              {models.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>

            <label className="checkbox-row">
              <input type="checkbox" checked={makeDefault} onChange={(event) => setMakeDefault(event.target.checked)} />
              {t("Use this provider and model as default")}
            </label>

            {settings?.defaultProvider !== provider || settings?.defaultModel !== model ? (
              <div className="ai-default-hint">
                {t("Current default: {provider} · {model}", {
                  provider: providerInfo(settings?.defaultProvider ?? "openai").name,
                  model: settings?.defaultModel ?? "—",
                })}
              </div>
            ) : null}

            {message ? (
              <div className={`ai-test-result ${message.ok ? "is-ok" : "is-error"}`}>
                {message.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                {message.text}
              </div>
            ) : null}

            <div className="ai-form-actions">
              <button className="ghost-button" onClick={test} disabled={busy !== null}>
                {busy === "test" ? <Loader2 size={13} className="spin" /> : <PlugZap size={13} />}
                {t("Test connection")}
              </button>
              <span className="modal-spacer" />
              <button className="primary-button" onClick={save} disabled={busy !== null}>
                {busy === "save" ? <Loader2 size={13} className="spin" /> : <CheckCircle2 size={13} />}
                {t("Save settings")}
              </button>
            </div>

            <div className="ai-privacy-note">
              <ShieldCheck size={12} />
              {t(
                "Only the code excerpts shown in an AI result request are sent. Keys are never exposed back to the browser.",
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
