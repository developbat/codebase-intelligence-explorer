import { useEffect, useRef, useState } from "react";
import { Check, Download, FolderSearch, HardDrive, Loader2, Play, RefreshCw } from "lucide-react";
import type { AiSettingsPublic } from "../../../shared/ai";
import { api } from "../api";
import { useI18n } from "../i18n";

const SUGGESTED = ["qwen2.5-coder:1.5b", "llama3.2:3b"];

interface LocalStatus {
  installed: boolean;
  running: boolean;
  models: string[];
  diskModels: string[];
  baseUrl: string;
  modelsDir: string;
  fromDisk: boolean;
  error?: string;
}

function formatSize(bytes: number): string {
  if (bytes <= 0) return "";
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

export function LocalModelsPanel({ onSaved }: { onSaved: (settings: AiSettingsPublic) => void }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<LocalStatus | null>(null);
  const [model, setModel] = useState(SUGGESTED[0]);
  const [dirDraft, setDirDraft] = useState("");
  const [dirs, setDirs] = useState<{ dir: string; models: string[]; sizeBytes: number }[]>([]);
  const [busy, setBusy] = useState<"status" | "start" | "pull" | "dir" | "discover" | "use" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const autoDiscoverRef = useRef(false);

  async function refresh() {
    setBusy("status");
    try {
      const next = await api.ai.localModels();
      setStatus(next);
      setDirDraft((current) => current || next.modelsDir);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("Could not inspect local models."));
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!status || autoDiscoverRef.current) return;
    if (status.models.length > 0 || !status.installed) return;
    autoDiscoverRef.current = true;
    void api.ai
      .discoverLocalModels()
      .then((result) => setDirs(result.dirs))
      .catch(() => undefined);
  }, [status]);

  async function start() {
    setBusy("start");
    setMessage(null);
    try {
      setStatus(await api.ai.startLocalModels());
      setMessage(t("Local model server is running."));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("Could not start Ollama."));
    } finally {
      setBusy(null);
    }
  }

  async function discover() {
    setBusy("discover");
    setMessage(null);
    try {
      const result = await api.ai.discoverLocalModels();
      setDirs(result.dirs);
      if (result.dirs.length === 0) {
        setMessage(t("No existing model folder was found."));
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("Could not scan for model folders."));
    } finally {
      setBusy(null);
    }
  }

  async function saveDir(dir: string) {
    if (!dir.trim()) return;
    setBusy("dir");
    setMessage(null);
    try {
      await api.ai.updateSettings({ localModelsDir: dir.trim() });
      await api.ai.models("local", true).catch(() => undefined);
      setStatus(await api.ai.localModels());
      onSaved(await api.ai.settings());
      setMessage(t("Local model folder saved."));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("Could not save the model folder."));
    } finally {
      setBusy(null);
    }
  }

  async function pull(target = model) {
    const name = target.trim();
    if (!name) return;
    setBusy("pull");
    setMessage(null);
    try {
      const result = await api.ai.pullLocalModel(name);
      setMessage(result.output || (result.ok ? t("Model downloaded.") : t("Model download failed.")));
      setStatus(await api.ai.localModels());
      await api.ai.models("local", true);
      onSaved(await api.ai.settings());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("Model download failed."));
    } finally {
      setBusy(null);
    }
  }

  async function useModel(name: string) {
    setBusy("use");
    setMessage(null);
    try {
      const next = await api.ai.updateSettings({
        defaultProvider: "local",
        defaultModel: name,
        providerEnabled: { provider: "local", enabled: true },
      });
      const auto = await api.ai.autoConfigureAgents().catch(() => null);
      onSaved(auto?.settings ?? next);
      setMessage(t("Local model {model} is now active.", { model: name }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("Could not use this local model."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="local-models-panel">
      <div className="local-models-head">
        <div>
          <strong>
            <HardDrive size={13} /> {t("Local models (Ollama)")}
          </strong>
          <small>
            {!status
              ? t("Checking local models…")
              : status.running
                ? t("{count} local models ready · no API key · free", { count: status.models.length })
                : status.installed
                  ? t("Ollama is installed but not running.")
                  : t("Ollama is not installed.")}
            {status?.fromDisk ? ` · ${t("found on disk")}` : ""}
          </small>
        </div>
        <button className="ghost-button" onClick={() => void refresh()} disabled={busy !== null}>
          {busy === "status" ? <Loader2 size={11} className="spin" /> : <RefreshCw size={11} />}
          {t("Refresh")}
        </button>
      </div>

      <div className="local-model-actions">
        {status && !status.running ? (
          <button className="ghost-button" onClick={() => void start()} disabled={busy !== null}>
            {busy === "start" ? <Loader2 size={11} className="spin" /> : <Play size={11} />}
            {t("Start local model server")}
          </button>
        ) : null}
        <button className="ghost-button" onClick={() => void discover()} disabled={busy !== null}>
          {busy === "discover" ? <Loader2 size={11} className="spin" /> : <FolderSearch size={11} />}
          {t("Find existing model folders")}
        </button>
      </div>

      {dirs.length > 0 ? (
        <div className="local-model-dirs">
          {dirs.map((item) => (
            <div key={item.dir}>
              <code>{item.dir}</code>
              <small>
                {item.models.length} {t("models")}
                {item.sizeBytes > 0 ? ` · ${formatSize(item.sizeBytes)}` : ""}
              </small>
              <button onClick={() => void saveDir(item.dir)} disabled={busy !== null}>
                {dirDraft === item.dir ? <Check size={10} /> : null}
                {t("Use this folder")}
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="local-model-dir-row">
        <input
          value={dirDraft}
          onChange={(event) => setDirDraft(event.target.value)}
          placeholder={t("Model folder, e.g. ~/.ollama/models")}
          spellCheck={false}
        />
        <button className="ghost-button" onClick={() => void saveDir(dirDraft)} disabled={busy !== null || !dirDraft.trim()}>
          {busy === "dir" ? <Loader2 size={11} className="spin" /> : null}
          {t("Save folder")}
        </button>
      </div>

      {status?.models.length ? (
        <div className="local-model-list">
          {status.models.map((item) => (
            <span key={item}>
              <code>{item}</code>
              <button onClick={() => void useModel(item)} disabled={busy !== null} title={t("Use this model")}>
                {busy === "use" ? <Loader2 size={10} className="spin" /> : null}
                {t("Use")}
              </button>
            </span>
          ))}
        </div>
      ) : status ? (
        <small className="local-model-message">
          {t("No local model found. Download a small one below; it stays on this machine and costs nothing.")}
        </small>
      ) : null}

      <div className="local-model-pull">
        <input
          value={model}
          onChange={(event) => setModel(event.target.value)}
          placeholder={t("Ollama model name, e.g. qwen2.5-coder:1.5b")}
          spellCheck={false}
        />
        <button className="ghost-button" onClick={() => void pull()} disabled={busy !== null}>
          {busy === "pull" ? <Loader2 size={11} className="spin" /> : <Download size={11} />}
          {t("Download model")}
        </button>
      </div>
      <div className="local-model-suggestions">
        {SUGGESTED.map((item) => (
          <button key={item} onClick={() => void pull(item)} disabled={busy !== null}>
            {item}
          </button>
        ))}
      </div>
      {message ? <small className="local-model-message">{message.slice(-1_000)}</small> : null}
    </section>
  );
}
