import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Cpu, Loader2, Search, Star } from "lucide-react";
import type { AiProviderId, AiSettingsPublic } from "../../../shared/ai";
import type { PricingReport } from "../../../shared/pricing";
import { findModelPrice, formatUsd } from "../../../shared/pricing";
import { api } from "../api";
import { useI18n } from "../i18n";
import { useCachedResource } from "../lib/resourceCache";

interface ModelRow {
  provider: string;
  providerName: string;
  model: string;
}

export function ModelPickerPanel({
  settings,
  onSettingsSaved,
}: {
  settings: AiSettingsPublic | null;
  onSettingsSaved: (settings: AiSettingsPublic) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const localScanRef = useRef(false);

  const { data: pricing } = useCachedResource<PricingReport>(
    "model-pricing",
    () => api.ai.pricing(),
    { maxAgeMs: 300_000, errorMessage: t("Could not load model prices.") },
  );

  const rows = useMemo(() => {
    if (!settings) return [] as ModelRow[];
    const list: ModelRow[] = [];
    for (const provider of settings.providers) {
      const models =
        provider.models.length > 0 ? provider.models : provider.model ? [provider.model] : [];
      for (const model of models) {
        if (!model) continue;
        list.push({ provider: provider.id, providerName: provider.name, model });
      }
    }
    const needle = query.trim().toLowerCase();
    return list
      .filter((row) => providerFilter === "all" || row.provider === providerFilter)
      .filter(
        (row) =>
          !needle ||
          `${row.provider} ${row.providerName} ${row.model}`.toLowerCase().includes(needle),
      )
      .sort(
        (a, b) =>
          a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
      );
  }, [settings, query, providerFilter]);

  useEffect(() => {
    const local = settings?.providers.find((provider) => provider.id === "local");
    if (!local || local.models.length > 0 || localScanRef.current) return;
    localScanRef.current = true;
    void api.ai
      .models("local", true)
      .then(async (result) => {
        if (result.models.length === 0) return;
        onSettingsSaved(await api.ai.settings());
      })
      .catch(() => undefined);
  }, [settings, onSettingsSaved]);

  if (!settings) {
    return <div className="settings-empty">{t("Add a provider before choosing a model.")}</div>;
  }

  const defaultProvider = settings.defaultProvider;
  const defaultModel = settings.defaultModel;

  async function setDefault(row: ModelRow) {
    const key = `${row.provider}::${row.model}`;
    setBusyKey(key);
    setMessage(null);
    try {
      const next = await api.ai.updateSettings({
        defaultProvider: row.provider as AiProviderId,
        defaultModel: row.model,
      });
      onSettingsSaved(next);
      setMessage(t("Default model: {model}", { model: row.model }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("Could not set the default model."));
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="model-picker-panel">
      <div className="model-picker-head">
        <div>
          <h3>
            <Cpu size={14} /> {t("Model picker")}
          </h3>
          <p>
            {t(
              "Choose the default provider and model. Prices are USD per 1M tokens; “—” means no tariff was found.",
            )}
          </p>
        </div>
        <span className="model-picker-count">
          {rows.length} {t("models")}
        </span>
      </div>

      <div className="model-picker-toolbar">
        <div className="search-box">
          <Search size={12} className="search-icon" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("Search models…")}
            spellCheck={false}
          />
        </div>
        <select
          className="settings-select"
          value={providerFilter}
          onChange={(event) => setProviderFilter(event.target.value)}
        >
          <option value="all">{t("All providers")}</option>
          {settings.providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name}
            </option>
          ))}
        </select>
      </div>

      {message ? <div className="model-picker-message">{message}</div> : null}

      <div className="model-picker-list">
        {rows.length === 0 ? (
          <div className="settings-empty">{t("No models match this filter.")}</div>
        ) : (
          rows.map((row) => {
            const price = pricing ? findModelPrice(pricing.prices, row.provider, row.model) : undefined;
            const active = row.provider === defaultProvider && row.model === defaultModel;
            const key = `${row.provider}::${row.model}`;
            return (
              <div key={key} className={`model-picker-row ${active ? "is-active" : ""}`}>
                <div className="model-picker-main">
                  <div>
                    <strong>{row.model}</strong>
                    {active ? (
                      <span className="model-picker-default">
                        <Star size={9} /> {t("Default")}
                      </span>
                    ) : null}
                  </div>
                  <small>{row.providerName}</small>
                </div>
                <div className="model-picker-price">
                  <span>
                    <em>{t("Input / 1M")}</em>
                    {formatUsd(price?.inputPerMillion)}
                  </span>
                  <span>
                    <em>{t("Output / 1M")}</em>
                    {formatUsd(price?.outputPerMillion)}
                  </span>
                </div>
                <button
                  className="ghost-button"
                  onClick={() => void setDefault(row)}
                  disabled={busyKey !== null || active}
                  title={t("Set as default")}
                >
                  {busyKey === key ? (
                    <Loader2 size={11} className="spin" />
                  ) : active ? (
                    <Check size={11} />
                  ) : (
                    <Star size={11} />
                  )}
                  {active ? t("Default") : t("Set default")}
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
