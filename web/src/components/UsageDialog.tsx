import { useEffect, useState } from "react";
import { BarChart3, Loader2, X } from "lucide-react";
import type { AiUsageReport, AiTokenUsage } from "../../../shared/ai";
import type { ModelPricing, PricingReport } from "../../../shared/pricing";
import { formatUsd } from "../../../shared/pricing";
import { api } from "../api";
import { useI18n } from "../i18n";
import { readCache, writeCache } from "../lib/resourceCache";

export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(value));
}

function UsageCard({
  label,
  usage,
  costUsd,
}: {
  label: string;
  usage: AiTokenUsage;
  costUsd?: number;
}) {
  return (
    <div className="usage-card">
      <span className="usage-card-label">{label}</span>
      <div className="usage-card-totals">
        <div>
          <strong>{formatTokens(usage.totalTokens)}</strong>
          <small>tokens</small>
        </div>
        <em>{formatUsd(costUsd)}</em>
      </div>
      <div className="usage-card-breakdown">
        <div>
          <small>Input</small>
          <b>{formatTokens(usage.inputTokens)}</b>
        </div>
        <div>
          <small>Output</small>
          <b>{formatTokens(usage.outputTokens)}</b>
        </div>
        <div>
          <small>Cost</small>
          <b>{formatUsd(costUsd)}</b>
        </div>
      </div>
    </div>
  );
}

export function UsageDialog({
  open,
  projectId,
  projectName,
  embedded = false,
  onClose,
}: {
  open: boolean;
  projectId: string;
  projectName: string;
  embedded?: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [report, setReport] = useState<AiUsageReport | null>(
    () => readCache<AiUsageReport>(`usage:${projectId}`, 15_000)?.value ?? null,
  );
  const [pricing, setPricing] = useState<PricingReport | null>(
    () => readCache<PricingReport>("model-pricing", 300_000)?.value ?? null,
  );
  const [showAllPrices, setShowAllPrices] = useState(false);
  const [pricingBusy, setPricingBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const cachedUsage = readCache<AiUsageReport>(`usage:${projectId}`, 15_000);
    const cachedPricing = readCache<PricingReport>("model-pricing", 300_000);
    if (cachedUsage?.value && !cachedUsage.stale && cachedPricing?.value && !cachedPricing.stale) {
      setReport(cachedUsage.value);
      setPricing(cachedPricing.value);
      setBusy(false);
      return;
    }
    setBusy(!cachedUsage?.value);
    setError(null);
    Promise.all([
      api.usage(projectId),
      api.ai.pricing().catch(() => null),
    ])
      .then(([value, priceValue]) => {
        if (!cancelled) {
          setReport(value);
          writeCache(`usage:${projectId}`, value);
          if (priceValue) {
            setPricing(priceValue);
            writeCache("model-pricing", priceValue);
          }
        }
      })
      .catch((requestError) => {
        if (!cancelled) {
          setError(requestError instanceof Error ? requestError.message : t("Could not load usage."));
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId, t]);

  if (!open) return null;

  const usedModels = new Set(
    (report?.byModel ?? []).map((bucket) => `${bucket.provider}::${bucket.model}`),
  );
  const priceRows = (pricing?.prices ?? [])
    .filter((price) => showAllPrices || usedModels.has(`${price.provider}::${price.model}`))
    .sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
    )
    .slice(0, showAllPrices ? 600 : 100);

  return (
    <div
      className={embedded ? "settings-embedded-backdrop" : "modal-backdrop"}
      onMouseDown={embedded ? undefined : onClose}
    >
      <div
        className={embedded ? "settings-embedded-panel" : "ai-modal usage-modal"}
        onMouseDown={embedded ? undefined : (event) => event.stopPropagation()}
      >
        {embedded ? null : (
          <div className="modal-header">
            <div>
              <div className="modal-eyebrow">{t("Token budget")}</div>
              <h2>
                <BarChart3 size={16} /> {projectName}
              </h2>
            </div>
            <button className="icon-button" onClick={onClose} aria-label={t("Close")}>
              <X size={16} />
            </button>
          </div>
        )}
        <p className="modal-text">
          {t(
            "Usage is recorded locally for every AI request in this project, grouped by model and day.",
          )}
        </p>

        {busy ? (
          <div className="usage-loading">
            <Loader2 size={16} className="spin" /> {t("Loading usage…")}
          </div>
        ) : error ? (
          <div className="ai-test-result is-error">{error}</div>
        ) : report ? (
          <div className="usage-body">
            <div className="usage-cards">
              <UsageCard label={t("Today")} usage={report.today} costUsd={report.todayCostUsd} />
              <UsageCard label={t("Last 7 days")} usage={report.last7Days} costUsd={report.last7DaysCostUsd} />
              <UsageCard label={t("All time")} usage={report.total} costUsd={report.totalCostUsd} />
            </div>

            <div className="usage-section">
              <div className="usage-section-head">
                <strong>{t("Prices per 1M tokens")}</strong>
                <button
                  className="ghost-button"
                  onClick={() => {
                    setPricingBusy(true);
                    void api.ai
                      .refreshPricing()
                      .then((value) => {
                        setPricing(value);
                        writeCache("model-pricing", value);
                      })
                      .catch(() => undefined)
                      .finally(() => setPricingBusy(false));
                  }}
                  disabled={pricingBusy}
                >
                  {pricingBusy ? <Loader2 size={10} className="spin" /> : null}
                  {t("Refresh prices")}
                </button>
                <button className="ghost-button" onClick={() => setShowAllPrices((value) => !value)}>
                  {showAllPrices ? t("Only used models") : t("All models")}
                </button>
              </div>
              {priceRows.length === 0 ? (
                <div className="usage-empty">
                  {t("No price tariff found; usage is shown as free.")}
                </div>
              ) : (
                <table className="usage-table usage-price-table">
                  <thead>
                    <tr>
                      <th>{t("Provider")}</th>
                      <th>{t("Model")}</th>
                      <th>{t("Input / 1M")}</th>
                      <th>{t("Output / 1M")}</th>
                      <th>{t("Source")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {priceRows.map((price) => (
                      <tr key={`${price.provider}::${price.model}`}>
                        <td>{price.provider}</td>
                        <td className="mono">{price.model}</td>
                        <td>{formatUsd(price.inputPerMillion)}</td>
                        <td>{formatUsd(price.outputPerMillion)}</td>
                        <td className="mono">{price.source}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <small className="usage-price-note">
                {t(
                  "Prices are USD per 1M tokens. “free” means no tariff was found for that model. Provider catalogs differ; OpenRouter pricing is matched to configured provider models when possible.",
                )}
                {pricing?.updatedAt
                  ? ` ${t("Updated")}: ${new Date(pricing.updatedAt).toLocaleString()}`
                  : ""}
              </small>
            </div>

            <div className="usage-section">
              <strong>{t("By model")}</strong>
              {report.byModel.length === 0 ? (
                <div className="usage-empty">{t("No AI usage recorded for this project yet.")}</div>
              ) : (
                <table className="usage-table">
                  <thead>
                    <tr>
                      <th>{t("Provider")}</th>
                      <th>{t("Model")}</th>
                      <th>{t("Requests")}</th>
                      <th>{t("Input")}</th>
                      <th>{t("Output")}</th>
                      <th>{t("Total")}</th>
                      <th>{t("Cost")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.byModel.map((bucket) => (
                      <tr key={`${bucket.provider}-${bucket.model}`}>
                        <td>{bucket.provider}</td>
                        <td className="mono">{bucket.model}</td>
                        <td>{bucket.requests}</td>
                        <td>{formatTokens(bucket.inputTokens)}</td>
                        <td>{formatTokens(bucket.outputTokens)}</td>
                        <td className="strong">{formatTokens(bucket.totalTokens)}</td>
                        <td>{formatUsd(bucket.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="usage-section">
              <strong>{t("Daily")}</strong>
              {report.byDay.length === 0 ? (
                <div className="usage-empty">{t("No daily usage yet.")}</div>
              ) : (
                <table className="usage-table">
                  <thead>
                    <tr>
                      <th>{t("Day")}</th>
                      <th>{t("Requests")}</th>
                      <th>{t("Input")}</th>
                      <th>{t("Output")}</th>
                      <th>{t("Total")}</th>
                      <th>{t("Cost")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.byDay.map((day) => (
                      <tr key={day.day}>
                        <td className="mono">{day.day}</td>
                        <td>{day.requests}</td>
                        <td>{formatTokens(day.inputTokens)}</td>
                        <td>{formatTokens(day.outputTokens)}</td>
                        <td className="strong">{formatTokens(day.totalTokens)}</td>
                        <td>{formatUsd(day.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="usage-section">
              <strong>{t("Recent requests")}</strong>
              {report.recent.length === 0 ? (
                <div className="usage-empty">{t("No requests yet.")}</div>
              ) : (
                <div className="usage-recent">
                  {report.recent.map((entry) => (
                    <div key={entry.id}>
                      <span className="mono">{new Date(entry.createdAt).toLocaleString()}</span>
                      <span>{entry.kind}</span>
                      <span className="mono">{entry.model}</span>
                      <strong>{formatTokens(entry.totalTokens)}</strong>
                      <span>{formatUsd(entry.costUsd)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
