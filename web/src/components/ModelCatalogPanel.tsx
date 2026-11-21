import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Download,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import type { CatalogImportResult, ModelCatalog } from "../../../shared/catalog";
import { api } from "../api";
import { useI18n } from "../i18n";

function formatPrice(value?: number): string {
  if (value === undefined) return "—";
  return `$${value.toFixed(value < 1 ? 3 : 2)}`;
}

export function ModelCatalogPanel() {
  const { t } = useI18n();
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<"url" | "json" | "clear" | null>(null);
  const [url, setUrl] = useState("");
  const [json, setJson] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [result, setResult] = useState<CatalogImportResult | null>(null);
  const [query, setQuery] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function load() {
    setLoading(true);
    try {
      const response = await api.ai.catalog();
      setCatalog(response.catalog);
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : t("Could not load the catalog.") });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function importFromUrl() {
    if (!url.trim()) return;
    setBusy("url");
    setMessage(null);
    setResult(null);
    try {
      const imported = await api.ai.importCatalog({ url: url.trim(), replace: true });
      setCatalog(imported.catalog);
      setResult(imported);
      setMessage({
        ok: true,
        text: t("Catalog imported · {models} models · {agents} agents", {
          models: imported.importedModels,
          agents: imported.importedAgents,
        }),
      });
      setUrl("");
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : t("Catalog import failed.") });
    } finally {
      setBusy(null);
    }
  }

  async function importJson() {
    if (!json.trim()) return;
    setBusy("json");
    setMessage(null);
    setResult(null);
    try {
      const imported = await api.ai.importCatalog({ json, replace: true });
      setCatalog(imported.catalog);
      setResult(imported);
      setMessage({
        ok: true,
        text: t("Catalog imported · {models} models · {agents} agents", {
          models: imported.importedModels,
          agents: imported.importedAgents,
        }),
      });
      setJson("");
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : t("Catalog import failed.") });
    } finally {
      setBusy(null);
    }
  }

  async function clear() {
    setBusy("clear");
    setMessage(null);
    try {
      await api.ai.clearCatalog();
      setCatalog(null);
      setResult(null);
      setMessage({ ok: true, text: t("Model catalog cleared.") });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : t("Could not clear the catalog.") });
    } finally {
      setBusy(null);
    }
  }

  async function readFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setMessage({ ok: false, text: t("Catalog JSON is too large (max 5 MB).") });
      return;
    }
    setJson(await file.text());
  }

  const visibleModels = useMemo(() => {
    if (!catalog) return [];
    const needle = query.trim().toLowerCase();
    if (!needle) return catalog.models.slice(0, 250);
    return catalog.models
      .filter((model) =>
        `${model.provider} ${model.id} ${model.name ?? ""} ${model.roles.join(" ")} ${model.tags.join(" ")}`
          .toLowerCase()
          .includes(needle),
      )
      .slice(0, 250);
  }, [catalog, query]);

  return (
    <div className="catalog-panel">
      <div className="catalog-head">
        <div>
          <strong>
            <Database size={14} /> {t("Model catalog")}
          </strong>
          <span>
            {t(
              "Import a JSON model/agent catalog once, then use it for role and fast-model selection without fetching providers every time.",
            )}
          </span>
        </div>
        <button className="ghost-button" onClick={() => void load()} disabled={loading || busy !== null}>
          <RefreshCw size={12} className={loading ? "spin" : ""} /> {t("Reload")}
        </button>
      </div>

      <div className="catalog-summary">
        {catalog ? (
          <>
            <span>
              <CheckCircle2 size={11} /> {catalog.models.length} {t("models")} · {catalog.agents.length}{" "}
              {t("agents")}
            </span>
            <span>
              {t("Source")}: <code>{catalog.sourceUrl ?? catalog.source}</code>
            </span>
            <span>
              {t("Hash")}: <code>{catalog.hash}</code>
            </span>
            <span>
              {t("Updated")}: {new Date(catalog.updatedAt).toLocaleString()}
            </span>
          </>
        ) : (
          <span>
            <AlertTriangle size={11} /> {t("No catalog imported yet. Auto-pick currently uses name heuristics and saved model lists.")}
          </span>
        )}
      </div>

      <div className="catalog-import-grid">
        <section className="catalog-import">
          <h3>
            <Download size={12} /> {t("Import from JSON URL")}
          </h3>
          <div className="catalog-url-row">
            <input
              className="text-input mono"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com/ai-catalog.json"
              spellCheck={false}
            />
            <button className="primary-button" onClick={() => void importFromUrl()} disabled={busy !== null || !url.trim()}>
              {busy === "url" ? <Loader2 size={13} className="spin" /> : <Download size={13} />}
              {t("Import")}
            </button>
          </div>
          <small>{t("The URL must return JSON, not HTML. Aibender-style catalog exports work.")}</small>
        </section>

        <section className="catalog-import">
          <h3>
            <Upload size={12} /> {t("Paste or choose JSON")}
          </h3>
          <textarea
            className="text-input mono catalog-json"
            value={json}
            onChange={(event) => setJson(event.target.value)}
            placeholder={'{"models":[{"id":"model-id","provider":"provider","roles":["fast"]}],"agents":[]}'}
            spellCheck={false}
            rows={5}
          />
          <div className="catalog-json-actions">
            <input
              ref={(node) => {
                fileRef.current = node;
              }}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(event) => void readFile(event.target.files?.[0])}
            />
            <button className="ghost-button" onClick={() => fileRef.current?.click()} disabled={busy !== null}>
              <Upload size={12} /> {t("Choose JSON file")}
            </button>
            <button className="primary-button" onClick={() => void importJson()} disabled={busy !== null || !json.trim()}>
              {busy === "json" ? <Loader2 size={13} className="spin" /> : <CheckCircle2 size={13} />}
              {t("Import JSON")}
            </button>
            {catalog ? (
              <button className="ghost-button is-danger" onClick={() => void clear()} disabled={busy !== null}>
                {busy === "clear" ? <Loader2 size={12} className="spin" /> : <Trash2 size={12} />}
                {t("Clear catalog")}
              </button>
            ) : null}
          </div>
        </section>
      </div>

      {message ? (
        <div className={`ai-test-result ${message.ok ? "is-ok" : "is-error"}`}>
          {message.ok ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
          {message.text}
        </div>
      ) : null}

      {result?.warnings.length ? (
        <div className="catalog-warnings">
          {result.warnings.map((warning) => (
            <p key={warning}>
              <AlertTriangle size={10} /> {warning}
            </p>
          ))}
        </div>
      ) : null}

      {catalog ? (
        <>
          <div className="catalog-toolbar">
            <div className="search-box catalog-search">
              <Search size={13} className="search-icon" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("Search catalog models…")}
                spellCheck={false}
              />
            </div>
            <span>
              {visibleModels.length}/{catalog.models.length} {t("models")}
            </span>
          </div>
          <div className="catalog-models">
            <div className="catalog-model-row catalog-model-head">
              <span>{t("Provider / model")}</span>
              <span>{t("Roles")}</span>
              <span>{t("Context")}</span>
              <span>{t("Input / output")}</span>
              <span>{t("Speed")}</span>
            </div>
            {visibleModels.map((model) => (
              <div key={`${model.provider}/${model.id}`} className="catalog-model-row">
                <span>
                  <code>{model.provider}</code>
                  <strong>{model.id}</strong>
                  {model.name && model.name !== model.id ? <small>{model.name}</small> : null}
                </span>
                <span className="catalog-roles">
                  {model.roles.length > 0 ? model.roles.map((role) => <em key={role}>{role}</em>) : "—"}
                </span>
                <span>{model.contextWindow ? `${Math.round(model.contextWindow / 1000)}K` : "—"}</span>
                <span>
                  {formatPrice(model.inputPrice)} / {formatPrice(model.outputPrice)}
                </span>
                <span>{model.speed ?? "—"}</span>
              </div>
            ))}
          </div>
          {visibleModels.length === 0 ? (
            <div className="catalog-empty">{t("No catalog models match this search.")}</div>
          ) : null}
          {catalog.agents.length > 0 ? (
            <div className="catalog-agents">
              <h3>{t("Agent presets")}</h3>
              {catalog.agents.map((agent) => (
                <div key={agent.id}>
                  <strong>{agent.name}</strong>
                  <span>{agent.role ?? "—"}</span>
                  <code>
                    {agent.provider} · {agent.model}
                  </code>
                  {agent.description ? <small>{agent.description}</small> : null}
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
