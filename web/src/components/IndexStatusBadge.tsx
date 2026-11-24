import { useEffect, useRef, useState } from "react";
import { ListTree, Loader2, RefreshCw, X } from "lucide-react";
import type { ProjectIndexStatus } from "../../../shared/types";
import { api } from "../api";
import { useI18n } from "../i18n";

export function IndexStatusBadge({ projectId }: { projectId?: string }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<ProjectIndexStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!projectId) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    const load = () => {
      void api
        .indexStatus(projectId)
        .then((next) => {
          if (!cancelled) setStatus(next);
        })
        .catch(() => {
          if (!cancelled) setStatus(null);
        });
    };
    load();
    const timer = window.setInterval(load, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [projectId]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  if (!projectId || !status) return null;
  const ready = status.ready && !status.stale && !status.error;
  const building = status.building;
  const title = building
    ? `${t("Indexing project…")} ${status.processed}/${status.total}`
    : ready
      ? t("{count} documents indexed", { count: status.documents })
      : status.error
        ? status.error
        : t("Indexing starts automatically");

  async function reindex() {
    if (!projectId) return;
    setBusy(true);
    setMessage(null);
    try {
      const next = await api.buildIndex(projectId);
      setStatus(next);
      setMessage(t("Index rebuild started."));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("Could not start the index build."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="topbar-index-wrap" ref={wrapRef}>
      <button
        className={`topbar-index ${building ? "is-building" : ready ? "is-ready" : "is-warning"}`}
        title={title}
        aria-label={title}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {building ? <Loader2 size={14} className="spin" /> : <ListTree size={14} />}
        <span>{building ? `${status.processed}/${status.total}` : status.documents}</span>
      </button>
      {open ? (
        <div className="topbar-index-popover">
          <div className="topbar-index-popover-head">
            <strong>{t("Project index")}</strong>
            <button onClick={() => setOpen(false)} aria-label={t("Close")}>
              <X size={12} />
            </button>
          </div>
          <div className="topbar-index-rows">
            <div>
              <span>{t("Status")}</span>
              <strong>
                {building
                  ? t("Building…")
                  : ready
                    ? t("Ready")
                    : status.error
                      ? t("Error")
                      : status.stale
                        ? t("Stale")
                        : t("Not ready")}
              </strong>
            </div>
            <div>
              <span>{t("Documents")}</span>
              <strong>{status.documents}</strong>
            </div>
            <div>
              <span>{t("Last indexed")}</span>
              <strong>
                {status.updatedAt ? new Date(status.updatedAt).toLocaleString() : t("never")}
              </strong>
            </div>
          </div>
          {status.error ? <p className="topbar-index-error">{status.error}</p> : null}
          <p className="topbar-index-note">
            {t("External and agent changes are indexed automatically. Use rebuild when the index is stale or incomplete.")}
          </p>
          <button className="ghost-button" onClick={() => void reindex()} disabled={busy || building}>
            {busy || building ? <Loader2 size={11} className="spin" /> : <RefreshCw size={11} />}
            {t("Rebuild index")}
          </button>
          {message ? <small className="topbar-index-message">{message}</small> : null}
        </div>
      ) : null}
    </div>
  );
}
