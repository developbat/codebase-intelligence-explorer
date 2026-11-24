import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, Cpu, Loader2, Search, Star, X } from "lucide-react";
import type { AiProviderId, AiSettingsPublic } from "../../../shared/ai";
import type { PricingReport } from "../../../shared/pricing";
import { findModelPrice, formatUsd } from "../../../shared/pricing";
import { modelsForStudio, type StudioId } from "../../../shared/modelCapabilities";
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
  const [studioTab, setStudioTab] = useState<"code" | "chat" | "image" | "video">("code");
  const [message, setMessage] = useState<string | null>(null);
  const localScanRef = useRef(false);

  const { data: pricing } = useCachedResource<PricingReport>(
    "model-pricing",
    () => api.ai.pricing(),
    { maxAgeMs: 300_000, errorMessage: t("Could not load model prices.") },
  );

  const rows = useMemo(() => {
    if (!settings) return [] as ModelRow[];
    const list: ModelRow[] = modelsForStudio(settings, studioTab as StudioId).map((row) => ({
      provider: row.provider,
      providerName: row.providerName,
      model: row.model,
    }));
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
  }, [settings, query, providerFilter, studioTab]);

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

  const chain = settings.fallback?.chain ?? [];
  const studioLabel =
    studioTab === "image"
      ? t("Image")
      : studioTab === "video"
        ? t("Video")
        : studioTab === "chat"
          ? t("Chat")
          : t("Code");

  async function applyChain(next: { provider: string; model: string }[]) {
    setBusyKey("chain");
    setMessage(null);
    try {
      const first = next[0];
      const updated = await api.ai.updateSettings({
        fallback: { chain: next },
        ...(first
          ? { defaultProvider: first.provider as AiProviderId, defaultModel: first.model }
          : {}),
      });
      // Keep worker roles in sync so selected models are actually used.
      const auto = settings?.autoSwitchModels !== false ? await api.ai.autoConfigureAgents().catch(() => null) : null;
      onSettingsSaved(auto?.settings ?? updated);
      if (auto) setMessage(t("Selected models saved and workers auto-assigned."));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("Could not save the selected models."));
    } finally {
      setBusyKey(null);
    }
  }

  function toggleSelected(row: ModelRow) {
    const exists = chain.some((item) => item.provider === row.provider && item.model === row.model);
    void applyChain(
      exists
        ? chain.filter((item) => !(item.provider === row.provider && item.model === row.model))
        : [...chain, { provider: row.provider, model: row.model }],
    );
  }

  function moveSelected(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= chain.length) return;
    const next = [...chain];
    [next[index], next[target]] = [next[target], next[index]];
    void applyChain(next);
  }

  async function setDefault(row: ModelRow) {
    const key = `${row.provider}::${row.model}`;
    setBusyKey(key);
    setMessage(null);
    try {
      const rest = chain.filter(
        (item) => !(item.provider === row.provider && item.model === row.model),
      );
      const next = await api.ai.updateSettings({
        defaultProvider: row.provider as AiProviderId,
        defaultModel: row.model,
        fallback: { chain: [{ provider: row.provider, model: row.model }, ...rest] },
      });
      const auto = settings?.autoSwitchModels !== false ? await api.ai.autoConfigureAgents().catch(() => null) : null;
      onSettingsSaved(auto?.settings ?? next);
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
            <Cpu size={14} /> {t("Model selection")}
          </h3>
          <p>
            {t(
              "Add the models you want to use and put them in order. The first one is the default; the order is also the fallback chain. Agent workers can be auto-assigned from this list, or you can edit each role in Agent workers. Prices are USD per 1M tokens; “—” means no tariff was found.",
            )}
          </p>
        </div>
        <span className="model-picker-count">
          {rows.length} {t("models")}
        </span>
      </div>

      {studioTab === "code" ? (
      <div className="model-picker-selected">
          <div className="model-picker-selected-head">
            <strong>
              {t("Selected models")} {chain.length > 0 ? `· ${chain.length}` : ""}
            </strong>
            {chain.length > 0 ? (
              <button className="ghost-button" onClick={() => void applyChain([])} disabled={busyKey !== null}>
                {t("Auto")}
              </button>
            ) : (
              <span>{t("Auto selection is active. Add models below to choose the order.")}</span>
            )}
          </div>
          {chain.length > 0 ? (
            <div className="model-picker-selected-list">
              {chain.map((item, index) => (
                <span key={`${item.provider}::${item.model}`}>
                  <b>{index + 1}</b>
                  <code>{item.model}</code>
                  <small>{item.provider}</small>
                  <button onClick={() => moveSelected(index, -1)} disabled={index === 0 || busyKey !== null} title={t("Move up")}>
                    <ArrowUp size={9} />
                  </button>
                  <button
                    onClick={() => moveSelected(index, 1)}
                    disabled={index === chain.length - 1 || busyKey !== null}
                    title={t("Move down")}
                  >
                    <ArrowDown size={9} />
                  </button>
                  <button onClick={() => toggleSelected({ provider: item.provider, providerName: "", model: item.model })} disabled={busyKey !== null} title={t("Remove")}>
                    <X size={9} />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}


      <div className="model-picker-studio-tabs">
        {([
          ["code", "Code"],
          ["chat", "Chat"],
          ["image", "Image"],
          ["video", "Video"],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            className={studioTab === id ? "is-active" : ""}
            onClick={() => {
              setStudioTab(id);
              setProviderFilter("all");
            }}
          >
            {t(label)}
          </button>
        ))}
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
            const active =
              row.provider === (chain[0]?.provider ?? defaultProvider) &&
              row.model === (chain[0]?.model ?? defaultModel);
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
                {studioTab === "code" ? (
                  <>
                    <button
                      className={`ghost-button ${chain.some((item) => item.provider === row.provider && item.model === row.model) ? "is-selected" : ""}`}
                      onClick={() => toggleSelected(row)}
                      disabled={busyKey !== null}
                      title={t("Add to or remove from selected models")}
                    >
                      {chain.some((item) => item.provider === row.provider && item.model === row.model) ? (
                        <Check size={11} />
                      ) : null}
                      {chain.some((item) => item.provider === row.provider && item.model === row.model)
                        ? t("Selected")
                        : t("Select")}
                    </button>
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
                  </>
                ) : (
                  <button
                    className="ghost-button"
                    onClick={() => {
                      localStorage.setItem(
                        `cie:studio-model:${studioTab}`,
                        JSON.stringify({ provider: row.provider, model: row.model }),
                      );
                      setMessage(
                        t("Selected for {studio}: {model}", {
                          studio: studioLabel,
                          model: row.model,
                        }),
                      );
                    }}
                  >
                    {t("Use in {studio}", { studio: studioLabel })}
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
