import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Loader2, Plus, Save, Trash2 } from "lucide-react";
import type { AiModelRef, AiSettingsPublic } from "../../../shared/ai";
import { api } from "../api";
import { useI18n } from "../i18n";

interface FallbackSettingsPanelProps {
  settings: AiSettingsPublic | null;
  onSaved: (settings: AiSettingsPublic) => void;
}

export function FallbackSettingsPanel({ settings, onSaved }: FallbackSettingsPanelProps) {
  const { t } = useI18n();
  const [autoSwitch, setAutoSwitch] = useState(true);
  const [chain, setChain] = useState<AiModelRef[]>([]);
  const [maxInput, setMaxInput] = useState("");
  const [maxOutput, setMaxOutput] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!settings) return;
    setAutoSwitch(settings.autoSwitchModels);
    setChain(settings.fallback?.chain ?? []);
    setMaxInput(
      settings.fallback?.maxInputPricePerMillion
        ? String(settings.fallback.maxInputPricePerMillion)
        : "",
    );
    setMaxOutput(
      settings.fallback?.maxOutputPricePerMillion
        ? String(settings.fallback.maxOutputPricePerMillion)
        : "",
    );
  }, [settings]);

  const providers = (settings?.providers ?? []).filter(
    (item) => item.hasKey || item.custom,
  );
  const selectedProvider = providers.find((item) => item.id === provider) ?? providers[0];
  const models = selectedProvider?.models ?? [];

  function addModel() {
    const providerId = selectedProvider?.id ?? "";
    const modelId = (model || models[0] || "").trim();
    if (!providerId || !modelId) return;
    if (chain.some((item) => item.provider === providerId && item.model === modelId)) return;
    setChain((current) => [...current, { provider: providerId, model: modelId }]);
    setModel("");
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= chain.length) return;
    setChain((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const next = await api.ai.updateSettings({
        autoSwitchModels: autoSwitch,
        fallback: {
          chain,
          maxInputPricePerMillion: Number(maxInput) > 0 ? Number(maxInput) : undefined,
          maxOutputPricePerMillion: Number(maxOutput) > 0 ? Number(maxOutput) : undefined,
        },
      });
      onSaved(next);
      setMessage(t("Fallback settings saved."));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("Could not save fallback settings."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section fallback-settings">
      <div className="toolchains-head">
        <div>
          <h3>{t("Model fallback chain")}</h3>
          <p>
            {t(
              "When the selected model is unavailable or fails, try these models in order. Empty means use the automatic heuristic.",
            )}
          </p>
        </div>
        <button className="primary-button" onClick={() => void save()} disabled={busy}>
          {busy ? <Loader2 size={12} className="spin" /> : <Save size={12} />}
          {t("Save")}
        </button>
      </div>

      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={autoSwitch}
          onChange={(event) => setAutoSwitch(event.target.checked)}
        />
        <span>
          <strong>{t("Automatic model switching")}</strong>
          <small>{t("Detect an unavailable model and continue with the next allowed model.")}</small>
        </span>
      </label>

      <div className="fallback-price-row">
        <label>
          {t("Max input price ($ / 1M)")}
          <input
            type="number"
            min="0"
            step="0.01"
            value={maxInput}
            onChange={(event) => setMaxInput(event.target.value)}
            placeholder={t("no limit")}
          />
        </label>
        <label>
          {t("Max output price ($ / 1M)")}
          <input
            type="number"
            min="0"
            step="0.01"
            value={maxOutput}
            onChange={(event) => setMaxOutput(event.target.value)}
            placeholder={t("no limit")}
          />
        </label>
      </div>

      <div className="fallback-add-row">
        <select
          value={selectedProvider?.id ?? ""}
          onChange={(event) => {
            setProvider(event.target.value);
            setModel("");
          }}
        >
          {providers.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        {models.length > 0 ? (
          <select value={model} onChange={(event) => setModel(event.target.value)}>
            <option value="">{t("Select a model")}</option>
            {models.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        ) : (
          <input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder={t("model id")}
          />
        )}
        <button className="ghost-button" onClick={addModel} disabled={!selectedProvider}>
          <Plus size={11} /> {t("Add to chain")}
        </button>
      </div>

      {chain.length === 0 ? (
        <p className="fallback-empty">{t("No explicit chain. Automatic heuristic is used.")}</p>
      ) : (
        <div className="fallback-chain">
          {chain.map((item, index) => (
            <div key={`${item.provider}::${item.model}`} className="fallback-chain-row">
              <span className="fallback-chain-index">{index + 1}</span>
              <div>
                <strong>{item.provider}</strong>
                <code>{item.model}</code>
              </div>
              <div className="fallback-chain-actions">
                <button onClick={() => move(index, -1)} disabled={index === 0} title={t("Move up")}>
                  <ArrowUp size={11} />
                </button>
                <button
                  onClick={() => move(index, 1)}
                  disabled={index === chain.length - 1}
                  title={t("Move down")}
                >
                  <ArrowDown size={11} />
                </button>
                <button
                  onClick={() => setChain((current) => current.filter((_, i) => i !== index))}
                  title={t("Remove")}
                >
                  <Trash2 size={11} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {message ? <div className="ai-test-result is-ok">{message}</div> : null}
    </section>
  );
}
