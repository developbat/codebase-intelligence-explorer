import { useEffect, useState } from "react";
import {
  AlertTriangle,
  FileCode2,
  FileText,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
} from "lucide-react";
import type { ContentInventory } from "../../../shared/contentInventory";
import { api } from "../api";
import { useI18n } from "../i18n";

interface ContentInventoryPanelProps {
  analysisId: string;
  onOpenFile: (path: string, line?: number) => void;
}

export function ContentInventoryPanel({ analysisId, onOpenFile }: ContentInventoryPanelProps) {
  const { t } = useI18n();
  const [inventory, setInventory] = useState<ContentInventory | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      setInventory(await api.contentInventory(analysisId));
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : t("Could not load the content inventory."),
      );
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisId]);

  return (
    <div className="studio-inventory-panel">
      <div className="studio-inventory-head">
        <span>
          <ImageIcon size={11} /> {t("Content inventory")}
        </span>
        <button onClick={() => void load()} disabled={busy}>
          {busy ? <Loader2 size={11} className="spin" /> : <RefreshCw size={11} />}
          {t("Refresh")}
        </button>
      </div>
      {busy ? (
        <div className="source-loading">
          <Loader2 size={13} className="spin" /> {t("Scanning assets and documents…")}
        </div>
      ) : error ? (
        <div className="source-error">
          <AlertTriangle size={13} /> {error}
        </div>
      ) : !inventory ? null : (
        <>
          <div className="studio-inventory-summary">
            <span>
              <b>{inventory.summary.assets}</b> {t("assets")}
            </span>
            <span className={inventory.summary.broken > 0 ? "is-bad" : ""}>
              <b>{inventory.summary.broken}</b> {t("broken")}
            </span>
            <span className={inventory.summary.unreferenced > 0 ? "is-warn" : ""}>
              <b>{inventory.summary.unreferenced}</b> {t("unreferenced")}
            </span>
            <span>
              <b>{inventory.summary.markdownFiles}</b> {t("documents")}
            </span>
            <span className={inventory.summary.headingWarnings > 0 ? "is-warn" : ""}>
              <b>{inventory.summary.headingWarnings}</b> {t("heading warnings")}
            </span>
          </div>

          {inventory.broken.length > 0 ? (
            <section className="studio-inventory-section">
              <h4>
                <AlertTriangle size={10} /> {t("Broken references")}
              </h4>
              {inventory.broken.slice(0, 30).map((item) => (
                <button
                  key={`${item.file}:${item.line}:${item.reference}`}
                  className="is-bad"
                  onClick={() => onOpenFile(item.file, item.line)}
                  title={item.resolved ?? item.reference}
                >
                  <FileCode2 size={9} />
                  <span>
                    {item.file}:{item.line}
                  </span>
                  <small>{item.reference}</small>
                </button>
              ))}
            </section>
          ) : null}

          {inventory.unreferenced.length > 0 ? (
            <section className="studio-inventory-section">
              <h4>
                <ImageIcon size={10} /> {t("Unreferenced assets")}
              </h4>
              {inventory.unreferenced.slice(0, 30).map((item) => (
                <button
                  key={item.path}
                  onClick={() => onOpenFile(item.path)}
                  title={item.path}
                >
                  <ImageIcon size={9} />
                  <span>{item.path}</span>
                  <small>{Math.max(1, Math.round(item.bytes / 1024))} KB</small>
                </button>
              ))}
            </section>
          ) : null}

          {inventory.markdown.length > 0 ? (
            <section className="studio-inventory-section">
              <h4>
                <FileText size={10} /> {t("Markdown documents")}
              </h4>
              {inventory.markdown.slice(0, 20).map((doc) => (
                <details key={doc.file} className={doc.warnings.length > 0 ? "is-warn" : ""}>
                  <summary>
                    <span>{doc.file}</span>
                    <small>
                      {doc.headings.length} {t("headings")}
                      {doc.warnings.length > 0 ? ` · ${doc.warnings.length} ${t("warnings")}` : ""}
                    </small>
                  </summary>
                  {doc.warnings.length > 0 ? (
                    <div className="studio-inventory-warnings">
                      {doc.warnings.map((warning) => (
                        <div key={warning}>⚠ {warning}</div>
                      ))}
                    </div>
                  ) : null}
                  <div className="studio-inventory-headings">
                    {doc.headings.slice(0, 40).map((heading) => (
                      <button
                        key={`${heading.line}-${heading.text}`}
                        style={{ paddingLeft: `${6 + (heading.level - 1) * 10}px` }}
                        onClick={() => onOpenFile(doc.file, heading.line)}
                      >
                        h{heading.level} · {heading.text}
                      </button>
                    ))}
                  </div>
                </details>
              ))}
            </section>
          ) : null}

          {inventory.broken.length === 0 &&
          inventory.unreferenced.length === 0 &&
          inventory.summary.headingWarnings === 0 ? (
            <div className="studio-preview-empty">
              <ImageIcon size={18} />
              <span>{t("No broken references, unreferenced assets or heading warnings.")}</span>
            </div>
          ) : null}

          {inventory.notes.length > 0 ? (
            <div className="studio-inventory-notes">
              {inventory.notes.map((note) => (
                <div key={note}>{note}</div>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
