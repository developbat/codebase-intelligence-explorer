import { useEffect, useState } from "react";
import { Copy, Image as ImageIcon, Loader2, RefreshCw, Trash2, Video, X } from "lucide-react";
import { api } from "../api";
import { useI18n } from "../i18n";

type LibraryAsset = Awaited<ReturnType<typeof api.library.list>>["assets"][number];

export function LibraryPicker({
  open,
  kind,
  projectId,
  mode = "select",
  onClose,
  onSelect,
  onCopied,
}: {
  open: boolean;
  kind?: "image" | "video";
  projectId?: string;
  mode?: "select" | "copy";
  onClose: () => void;
  onSelect?: (asset: LibraryAsset) => void;
  onCopied?: (path: string) => void;
}) {
  const { t } = useI18n();
  const [assets, setAssets] = useState<LibraryAsset[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyBusy, setCopyBusy] = useState<string | null>(null);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.library.list(kind);
      setAssets(result.assets);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("Could not load the library."));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kind]);

  async function copy(asset: LibraryAsset) {
    if (!projectId) return;
    setCopyBusy(asset.id);
    setError(null);
    try {
      const result = await api.library.copy({ assetId: asset.id, projectId });
      onCopied?.(result.path);
      onClose();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("Could not copy this asset."));
    } finally {
      setCopyBusy(null);
    }
  }

  async function remove(asset: LibraryAsset) {
    setCopyBusy(asset.id);
    try {
      await api.library.remove(asset.id);
      setAssets((current) => current.filter((item) => item.id !== asset.id));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("Could not remove this asset."));
    } finally {
      setCopyBusy(null);
    }
  }

  if (!open) return null;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="library-picker" onMouseDown={(event) => event.stopPropagation()}>
        <div className="library-picker-head">
          <div>
            <strong>{t("Asset library")}</strong>
            <span>
              {mode === "copy"
                ? t("Copy an asset into this project.")
                : t("Use a library asset as a reference.")}
            </span>
          </div>
          <div>
            <button className="ghost-button" onClick={() => void load()} disabled={busy}>
              {busy ? <Loader2 size={11} className="spin" /> : <RefreshCw size={11} />}
              {t("Refresh")}
            </button>
            <button className="icon-button" onClick={onClose} aria-label={t("Close")}>
              <X size={14} />
            </button>
          </div>
        </div>

        {error ? <div className="library-picker-error">{error}</div> : null}

        {assets.length === 0 && !busy ? (
          <div className="library-picker-empty">
            {t("No library assets yet. Generate an image or video first.")}
          </div>
        ) : (
          <div className="library-picker-grid">
            {assets.map((asset) => (
              <figure key={asset.id}>
                {asset.kind === "video" ? (
                  <video src={asset.url} muted preload="metadata" />
                ) : (
                  <img src={asset.url} alt={asset.title} loading="lazy" />
                )}
                <figcaption>
                  <span title={asset.title}>
                    {asset.kind === "video" ? <Video size={9} /> : <ImageIcon size={9} />}
                    {asset.title}
                  </span>
                  <div>
                    {mode === "copy" ? (
                      <button
                        onClick={() => void copy(asset)}
                        disabled={copyBusy !== null || !projectId}
                        title={t("Copy to project")}
                      >
                        {copyBusy === asset.id ? <Loader2 size={9} className="spin" /> : <Copy size={9} />}
                        {t("Copy")}
                      </button>
                    ) : (
                      <button
                        onClick={() => {
                          onSelect?.(asset);
                          onClose();
                        }}
                      >
                        {t("Use")}
                      </button>
                    )}
                    <button
                      className="is-danger"
                      onClick={() => void remove(asset)}
                      disabled={copyBusy !== null}
                      title={t("Remove from library")}
                    >
                      <Trash2 size={9} />
                    </button>
                  </div>
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
