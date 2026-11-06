import { useEffect, useMemo, useState } from "react";
import {
  ArrowUp,
  Check,
  ChevronRight,
  Download,
  Eye,
  Folder,
  FolderOpen,
  HardDrive,
  Home,
  Loader2,
  Monitor,
  Search,
  X,
} from "lucide-react";
import type { FolderEntry, FolderListing } from "../../../shared/types";
import { api } from "../api";
import { useI18n } from "../i18n";

interface FolderBrowserDialogProps {
  open: boolean;
  initialPath?: string;
  onClose: () => void;
  onSelect: (path: string) => void;
}

function quickIcon(id: string) {
  if (id === "home") return Home;
  if (id === "desktop") return Monitor;
  if (id === "documents") return FolderOpen;
  if (id === "downloads") return Download;
  return HardDrive;
}

export function FolderBrowserDialog({ open, initialPath, onClose, onSelect }: FolderBrowserDialogProps) {
  const { t } = useI18n();
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [manualPath, setManualPath] = useState(initialPath ?? "");
  const [query, setQuery] = useState("");
  const [showHidden, setShowHidden] = useState(false);

  const load = (folderPath?: string) => {
    setLoading(true);
    setError(null);
    setQuery("");
    api.fs
      .list(folderPath)
      .then((result) => {
        setListing(result);
        setManualPath(result.path);
        setSelected(null);
      })
      .catch((requestError: unknown) => {
        setError(requestError instanceof Error ? requestError.message : t("Could not read this folder."));
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!open) return;
    setManualPath(initialPath ?? "");
    load(initialPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialPath]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const entries = useMemo(() => {
    if (!listing) return [];
    const needle = query.trim().toLowerCase();
    return listing.entries.filter(
      (entry) => (showHidden || !entry.hidden) && (!needle || entry.name.toLowerCase().includes(needle)),
    );
  }, [listing, query, showHidden]);

  const breadcrumbs = useMemo(() => {
    if (!listing) return [];
    const parts = listing.path.split("/").filter(Boolean);
    const result: { label: string; path: string }[] = [{ label: "/", path: "/" }];
    let accumulated = "";
    for (const part of parts) {
      accumulated += `/${part}`;
      result.push({ label: part, path: accumulated });
    }
    return result;
  }, [listing]);

  if (!open) return null;

  const choose = () => {
    const target = selected ?? listing?.path;
    if (!target) return;
    onSelect(target);
    onClose();
  };

  const enter = (entry: FolderEntry) => {
    setSelected(entry.path);
    load(entry.path);
  };

  return (
    <div
      className="modal-backdrop folder-backdrop"
      onMouseDown={(event) => {
        event.stopPropagation();
        onClose();
      }}
    >
      <div className="folder-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="modal-eyebrow">{t("Project folder")}</div>
            <h2>{t("Browse folders")}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label={t("Close")}>
            <X size={16} />
          </button>
        </div>

        <div className="folder-quick-row">
          {listing?.quickLocations.map((location) => {
            const Icon = quickIcon(location.id);
            return (
              <button key={location.id} className="folder-quick" onClick={() => load(location.path)} title={location.path}>
                <Icon size={12} /> {t(location.label)}
              </button>
            );
          })}
        </div>

        <div className="folder-path-row">
          <button
            className="icon-button subtle"
            onClick={() => listing?.parent && load(listing.parent)}
            disabled={!listing?.parent}
            title={t("Up one level")}
            aria-label={t("Up one level")}
          >
            <ArrowUp size={14} />
          </button>
          <div className="folder-breadcrumbs" title={listing?.path}>
            {breadcrumbs.map((crumb, index) => (
              <span key={crumb.path} className="folder-crumb">
                {index > 0 ? <ChevronRight size={10} /> : null}
                <button onClick={() => load(crumb.path)}>{crumb.label}</button>
              </span>
            ))}
          </div>
        </div>

        <div className="folder-toolbar">
          <div className="search-box folder-search">
            <Search size={13} className="search-icon" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("Filter folders…")}
              spellCheck={false}
            />
          </div>
          <label className="folder-hidden-toggle">
            <input type="checkbox" checked={showHidden} onChange={(event) => setShowHidden(event.target.checked)} />
            <Eye size={11} /> {t("Show hidden")}
          </label>
        </div>

        <div className="folder-list">
          {loading ? (
            <div className="folder-loading">
              <Loader2 size={16} className="spin" /> {t("Reading folders…")}
            </div>
          ) : null}
          {error ? (
            <div className="folder-error">
              {error}
              <span>{t("You can still type a path manually below.")}</span>
            </div>
          ) : null}
          {!loading && !error && entries.length === 0 ? (
            <div className="folder-empty">{t("No subfolders here.")}</div>
          ) : null}
          {!loading
            ? entries.map((entry) => (
                <button
                  key={entry.path}
                  className={`folder-entry ${selected === entry.path ? "is-selected" : ""}`}
                  onClick={() => setSelected(entry.path)}
                  onDoubleClick={() => enter(entry)}
                  title={entry.path}
                >
                  <Folder size={15} className="folder-entry-icon" />
                  <span className="folder-entry-name">{entry.name}</span>
                  {entry.symlink ? <span className="folder-entry-tag">{t("link")}</span> : null}
                  <ChevronRight size={12} className="folder-entry-arrow" />
                </button>
              ))
            : null}
        </div>

        <div className="folder-manual-row">
          <span>{t("Path")}</span>
          <input
            className="text-input mono"
            value={manualPath}
            onChange={(event) => setManualPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") load(manualPath);
            }}
            spellCheck={false}
          />
          <button className="ghost-button" onClick={() => load(manualPath)}>
            {t("Go")}
          </button>
        </div>

        <div className="folder-footer">
          <span className="folder-selected">
            <FolderOpen size={13} />
            {selected ?? listing?.path ?? t("No folder selected")}
          </span>
          <span className="modal-spacer" />
          <button className="ghost-button" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button className="primary-button" onClick={choose} disabled={!listing}>
            <Check size={13} /> {t("Select this folder")}
          </button>
        </div>
      </div>
    </div>
  );
}
