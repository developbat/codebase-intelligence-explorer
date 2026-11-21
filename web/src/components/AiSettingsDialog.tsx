import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Cpu,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  PlugZap,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import type { AiProviderId, AiSettingsPublic } from "../../../shared/ai";
import { providerInfo } from "../../../shared/ai";
import { api } from "../api";
import { useI18n } from "../i18n";

interface AiSettingsDialogProps {
  open: boolean;
  settings: AiSettingsPublic | null;
  startInAddMode?: boolean;
  embedded?: boolean;
  onClose: () => void;
  onSaved: (settings: AiSettingsPublic) => void;
}

export function AiSettingsDialog({
  open,
  settings,
  startInAddMode = false,
  embedded = false,
  onClose,
  onSaved,
}: AiSettingsDialogProps) {
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

  const [adding, setAdding] = useState(false);
  const [editingCustomId, setEditingCustomId] = useState<string | null>(null);
  const [customName, setCustomName] = useState("");
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [customKey, setCustomKey] = useState("");
  const [customModelListUrl, setCustomModelListUrl] = useState("");
  const [customModels, setCustomModels] = useState("");
  const [customBusy, setCustomBusy] = useState<"save" | "test" | "delete" | "models" | null>(null);

  const providerList = settings?.providers ?? [];
  const state = useMemo(
    () => providerList.find((item) => item.id === provider),
    [providerList, provider],
  );
  const info = state ?? providerInfo(provider);
  const isCustomSelected = Boolean(state?.custom);
  const showingCustomForm = adding || Boolean(editingCustomId) || isCustomSelected;

  useEffect(() => {
    if (!open) return;
    if (startInAddMode) {
      startAdd();
      return;
    }
    const next = settings?.defaultProvider ?? "openai";
    setProvider(next);
    if (settings?.providers.find((item) => item.id === next)?.custom) {
      editCustom(next);
    } else {
      setAdding(false);
      setEditingCustomId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, startInAddMode]);

  useEffect(() => {
    if (!open || !settings) return;
    if (adding || editingCustomId) return;
    const current = settings.providers.find((item) => item.id === provider);
    setBaseUrl(current?.baseUrl ?? providerInfo(provider).baseUrl);
    setModel(current?.model ?? current?.models[0] ?? providerInfo(provider).models[0] ?? "");
    setApiKey("");
    setClearKey(false);
    setShowKey(false);
    setModels(current?.models ?? providerInfo(provider).models);
  }, [open, provider, settings, adding, editingCustomId]);

  useEffect(() => {
    setMessage(null);
    setMakeDefault(false);
  }, [provider, adding, editingCustomId]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  function startAdd() {
    setAdding(true);
    setEditingCustomId(null);
    setCustomName("");
    setCustomBaseUrl("");
    setCustomKey("");
    setCustomModelListUrl("");
    setCustomModels("");
    setMessage(null);
  }

  function editCustom(id: string) {
    const target = settings?.providers.find((item) => item.id === id);
    if (!target) return;
    setAdding(false);
    setEditingCustomId(id);
    setProvider(id);
    setCustomName(target.name);
    setCustomBaseUrl(target.baseUrl);
    setCustomKey("");
    setCustomModelListUrl(target.modelListUrl ?? "");
    setCustomModels(target.models.join("\n"));
    setMessage(null);
  }

  function cancelCustom() {
    setAdding(false);
    setEditingCustomId(null);
    setProvider(settings?.defaultProvider ?? "openai");
  }

  async function persistBuiltIn(): Promise<AiSettingsPublic> {
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
      await persistBuiltIn();
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
      await persistBuiltIn();
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
      await persistBuiltIn();
      const result = await api.ai.models(provider, true);
      setModels(result.models.length > 0 ? result.models : info.models);
      onSaved(await api.ai.settings());
      setMessage({
        ok: true,
        text: t("Model list updated · {count} models.", { count: result.models.length }),
      });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : t("Could not load models.") });
    } finally {
      setBusy(null);
    }
  }

  async function saveCustom() {
    setCustomBusy("save");
    setMessage(null);
    try {
      const modelList = customModels
        .split(/[\n,]/)
        .map((value) => value.trim())
        .filter(Boolean);
      if (!customName.trim()) throw new Error(t("A provider name is required."));
      if (!customBaseUrl.trim()) throw new Error(t("A base URL is required."));
      if (modelList.length === 0) throw new Error(t("Add at least one model id."));
      const next = await api.ai.updateSettings({
        customProvider: {
          id: editingCustomId ?? undefined,
          name: customName.trim(),
          baseUrl: customBaseUrl.trim(),
          apiKey: customKey.trim() || undefined,
          models: modelList,
          modelListUrl: customModelListUrl.trim() || undefined,
        },
      });
      onSaved(next);
      const target =
        (editingCustomId ? next.providers.find((item) => item.id === editingCustomId) : undefined) ??
        [...next.providers].reverse().find((item) => item.custom && item.name === customName.trim());
      setAdding(false);
      setEditingCustomId(target?.id ?? null);
      if (target) setProvider(target.id);
      setCustomKey("");
      setMessage({ ok: true, text: t("Provider saved.") });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : t("Could not save provider.") });
    } finally {
      setCustomBusy(null);
    }
  }

  async function testCustom() {
    if (!editingCustomId) {
      setMessage({ ok: false, text: t("Save the provider first, then test the connection.") });
      return;
    }
    setCustomBusy("test");
    setMessage(null);
    try {
      const result = await api.ai.test(editingCustomId, modelListFirst());
      setMessage({
        ok: result.ok,
        text: result.ok
          ? t("Connection OK · {model} · {latency} ms", { model: result.model, latency: result.latencyMs })
          : result.message,
      });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : t("Connection test failed.") });
    } finally {
      setCustomBusy(null);
    }
  }

  async function refreshCustomModels() {
    if (!editingCustomId) {
      setMessage({ ok: false, text: t("Save the provider first, then update its model list.") });
      return;
    }
    setCustomBusy("models");
    setMessage(null);
    try {
      const result = await api.ai.models(editingCustomId, true);
      setCustomModels(result.models.join("\n"));
      const next = await api.ai.settings();
      onSaved(next);
      setMessage({
        ok: true,
        text: t("Model list updated · {count} models.", { count: result.models.length }),
      });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : t("Could not update models.") });
    } finally {
      setCustomBusy(null);
    }
  }

  async function deleteCustom() {
    if (!editingCustomId) return;
    setCustomBusy("delete");
    setMessage(null);
    try {
      const next = await api.ai.updateSettings({ removeProviderId: editingCustomId });
      onSaved(next);
      setEditingCustomId(null);
      setAdding(false);
      setProvider(next.defaultProvider);
      setMessage({ ok: true, text: t("Provider removed.") });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : t("Could not remove provider.") });
    } finally {
      setCustomBusy(null);
    }
  }

  function modelListFirst(): string {
    return customModels
      .split(/[\n,]/)
      .map((value) => value.trim())
      .filter(Boolean)[0] ?? "";
  }

  return (
    <div
      className={embedded ? "settings-embedded-backdrop" : "modal-backdrop"}
      onMouseDown={embedded ? undefined : onClose}
    >
      <div
        className={embedded ? "settings-embedded-panel" : "ai-modal"}
        onMouseDown={embedded ? undefined : (event) => event.stopPropagation()}
      >
        {embedded ? null : (
          <div className="modal-header">
            <div>
              <div className="modal-eyebrow">{t("Optional semantic layer")}</div>
              <h2>{t("AI models & providers")}</h2>
            </div>
            <button className="icon-button" onClick={onClose} aria-label={t("Close")}>
              <X size={16} />
            </button>
          </div>
        )}
        <p className="modal-text">
          {t(
            "Connect built-in providers or add your own OpenAI-compatible endpoint. Keys stay on this machine, are stored in a 0600 file, and are sent only to the provider you select.",
          )}
        </p>

        <div className="ai-settings-layout">
          <div className="ai-provider-list">
            <button className="ai-provider ai-provider-add" onClick={startAdd}>
              <span className="ai-provider-icon">
                <Plus size={14} />
              </span>
              <span className="ai-provider-main">
                <span className="ai-provider-name">{t("Add provider")}</span>
                <span className="ai-provider-state">{t("Custom OpenAI-compatible endpoint")}</span>
              </span>
            </button>

            {providerList.map((item) => (
              <button
                key={item.id}
                className={`ai-provider ${
                  (item.custom ? editingCustomId === item.id : provider === item.id) ? "is-active" : ""
                }`}
                onClick={() => {
                  if (item.custom) {
                    editCustom(item.id);
                  } else {
                    setAdding(false);
                    setEditingCustomId(null);
                    setProvider(item.id);
                  }
                }}
              >
                <span className="ai-provider-icon">
                  {item.custom ? <Server size={14} /> : <Cpu size={14} />}
                </span>
                <span className="ai-provider-main">
                  <span className="ai-provider-name">{item.name}</span>
                  <span className={`ai-provider-state ${item.hasKey || item.custom ? "is-ready" : ""}`}>
                    {item.keyHint ?? (item.custom ? t("No key (optional)") : t("Not configured"))}
                  </span>
                </span>
                {settings?.defaultProvider === item.id ? (
                  <span className="ai-default-badge">{t("Default")}</span>
                ) : null}
              </button>
            ))}

            <button className="ai-provider ai-provider-add is-bottom" onClick={startAdd}>
              <span className="ai-provider-icon">
                <Plus size={14} />
              </span>
              <span className="ai-provider-main">
                <span className="ai-provider-name">{t("Add provider")}</span>
                <span className="ai-provider-state">{t("Name, URL, key and models")}</span>
              </span>
            </button>
          </div>

          <div className="ai-provider-form">
            {showingCustomForm ? (
              <>
                <div className="ai-form-heading">
                  <span>{adding ? t("New provider") : t("Edit provider")}</span>
                  <span className="ai-custom-badge">{t("OpenAI-compatible")}</span>
                </div>

                <label className="field-label">{t("Provider name")}</label>
                <input
                  className="text-input"
                  value={customName}
                  onChange={(event) => setCustomName(event.target.value)}
                  placeholder={t("My provider")}
                  spellCheck={false}
                />

                <label className="field-label">{t("Base URL or full chat URL")}</label>
                <input
                  className="text-input mono"
                  value={customBaseUrl}
                  onChange={(event) => setCustomBaseUrl(event.target.value)}
                  placeholder="https://your-endpoint.example/v1"
                  spellCheck={false}
                />
                <div className="ai-field-note">
                  {t(
                    "You can paste the full /chat/completions URL; it is normalized automatically.",
                  )}
                </div>

                <label className="field-label">
                  <KeyRound size={12} /> {t("API key")}
                  {editingCustomId ? (
                    <span className="field-hint">
                      {settings?.providers.find((item) => item.id === editingCustomId)?.keyHint}
                    </span>
                  ) : null}
                </label>
                <div className="secret-input">
                  <input
                    type={showKey ? "text" : "password"}
                    value={customKey}
                    onChange={(event) => setCustomKey(event.target.value)}
                    placeholder={
                      editingCustomId
                        ? t("Leave blank to keep the saved key")
                        : providerInfo(provider).keyPlaceholder
                    }
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <button
                    className="icon-button subtle"
                    onClick={() => setShowKey((value) => !value)}
                    title={t("Show/hide key")}
                  >
                    {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                </div>

                <label className="field-label">{t("Model list URL (optional)")}</label>
                <input
                  className="text-input mono"
                  value={customModelListUrl}
                  onChange={(event) => setCustomModelListUrl(event.target.value)}
                  placeholder={t("Defaults to {url}/models", { url: customBaseUrl || "BASE_URL" })}
                  spellCheck={false}
                />

                <label className="field-label">{t("Model ids (one per line or comma separated)")}</label>
                <textarea
                  className="text-input mono ai-model-textarea"
                  value={customModels}
                  onChange={(event) => setCustomModels(event.target.value)}
                  placeholder={"deepseek-v4.1-flash\nqwen3-coder"}
                  spellCheck={false}
                  rows={4}
                />

                {message ? (
                  <div className={`ai-test-result ${message.ok ? "is-ok" : "is-error"}`}>
                    {message.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                    {message.text}
                  </div>
                ) : null}

                <div className="ai-form-actions">
                  {editingCustomId ? (
                    <button
                      className="ghost-button is-danger"
                      onClick={deleteCustom}
                      disabled={customBusy !== null}
                    >
                      {customBusy === "delete" ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />}
                      {t("Remove")}
                    </button>
                  ) : null}
                  <button className="ghost-button" onClick={cancelCustom} disabled={customBusy !== null}>
                    {t("Cancel")}
                  </button>
                  <span className="modal-spacer" />
                  {editingCustomId ? (
                    <button className="ghost-button" onClick={refreshCustomModels} disabled={customBusy !== null}>
                      {customBusy === "models" ? (
                        <Loader2 size={13} className="spin" />
                      ) : (
                        <RefreshCw size={13} />
                      )}
                      {t("Update model list")}
                    </button>
                  ) : null}
                  {editingCustomId ? (
                    <button className="ghost-button" onClick={testCustom} disabled={customBusy !== null}>
                      {customBusy === "test" ? (
                        <Loader2 size={13} className="spin" />
                      ) : (
                        <PlugZap size={13} />
                      )}
                      {t("Test connection")}
                    </button>
                  ) : null}
                  <button className="primary-button" onClick={saveCustom} disabled={customBusy !== null}>
                    {customBusy === "save" ? (
                      <Loader2 size={13} className="spin" />
                    ) : (
                      <CheckCircle2 size={13} />
                    )}
                    {adding ? t("Create provider") : t("Save provider")}
                  </button>
                </div>

                <div className="ai-privacy-note">
                  <ShieldCheck size={12} />
                  {t(
                    "The key is stored locally in a 0600 file and sent only to this endpoint.",
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="ai-form-heading">
                  <span>{info.name}</span>
                  {providerInfo(provider).docsUrl ? (
                    <a href={providerInfo(provider).docsUrl} target="_blank" rel="noreferrer">
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
                    placeholder={
                      state?.hasKey
                        ? t("Leave blank to keep the saved key")
                        : providerInfo(provider).keyPlaceholder
                    }
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <button
                    className="icon-button subtle"
                    onClick={() => setShowKey((value) => !value)}
                    title={t("Show/hide key")}
                  >
                    {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                </div>
                {state?.hasKey ? (
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={clearKey}
                      onChange={(event) => setClearKey(event.target.checked)}
                    />
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
                    {t("Update model list")}
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
                <div className="ai-field-note">
                  {t("{count} models ready", { count: models.length })}
                  {state?.modelsUpdatedAt
                    ? ` · ${t("updated {time}", {
                        time: new Date(state.modelsUpdatedAt).toLocaleString(),
                      })}`
                    : ` · ${t("saved/default list")}`}
                </div>

                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={makeDefault}
                    onChange={(event) => setMakeDefault(event.target.checked)}
                  />
                  {t("Use this provider and model as default")}
                </label>

                {settings?.defaultProvider !== provider || settings?.defaultModel !== model ? (
                  <div className="ai-default-hint">
                    {t("Current default: {provider} · {model}", {
                      provider:
                        settings?.providers.find((item) => item.id === settings.defaultProvider)?.name ??
                        settings?.defaultProvider ??
                        "—",
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
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
