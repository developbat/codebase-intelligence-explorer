import { useEffect, useState } from "react";
import { Database, Loader2 } from "lucide-react";
import type { ProjectIndexStatus } from "../../../shared/types";
import { api } from "../api";
import { useI18n } from "../i18n";

export function IndexStatusBadge({ projectId }: { projectId?: string }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<ProjectIndexStatus | null>(null);

  useEffect(() => {
    if (!projectId) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    const load = () => {
      void api.indexStatus(projectId).then((next) => {
        if (!cancelled) setStatus(next);
      }).catch(() => {
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

  return (
    <span
      className={`topbar-index ${building ? "is-building" : ready ? "is-ready" : "is-warning"}`}
      title={title}
      aria-label={title}
    >
      {building ? <Loader2 size={14} className="spin" /> : <Database size={14} />}
    </span>
  );
}
