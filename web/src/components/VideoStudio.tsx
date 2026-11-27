import { useEffect, useMemo, useState } from "react";
import { Clapperboard, Download, FileText, Loader2, Play, Plus, RefreshCw, Sparkles, X } from "lucide-react";
import type { AiSettingsPublic } from "../../../shared/ai";
import { modelsForStudio } from "../../../shared/modelCapabilities";
import { api, type AnalysisResult, type RecentProject } from "../api";
import { useI18n } from "../i18n";
import { LibraryPicker } from "./LibraryPicker";
import { StudioLeftPanel } from "./StudioLeftPanel";
import { makeEntry, useStudioSessions } from "../lib/studioSessions";

interface GeneratedVideo {
  id: string;
  prompt: string;
  url: string;
  model: string;
  provider: string;
  bytes: number;
  duration: number;
  createdAt: string;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function VideoStudio({
  aiSettings,
  projectId,
  analysis,
  recent = [],
  onLoadRecent,
  onRemoveRecent,
  onOpenProject,
  onOpenCodeStudio,
  onOpenSettings,
  onOpenReports,
  onSettingsSaved,
}: {
  aiSettings: AiSettingsPublic | null;
  projectId?: string;
  analysis?: AnalysisResult | null;
  recent?: RecentProject[];
  onLoadRecent?: (project: RecentProject) => void;
  onRemoveRecent?: (id: string) => void;
  onOpenProject?: () => void;
  onOpenCodeStudio?: () => void;
  onOpenSettings: () => void;
  onOpenReports?: () => void;
  onSettingsSaved: (settings: AiSettingsPublic) => void;
}) {
  const { t } = useI18n();
  const models = modelsForStudio(aiSettings, "video");
  const [prompt, setPrompt] = useState("");
  const [modelKey, setModelKey] = useState(() => {
    try {
      const raw = localStorage.getItem("cie:studio-model:video");
      if (!raw) return "";
      const parsed = JSON.parse(raw) as { provider?: string; model?: string };
      return parsed.provider && parsed.model ? `${parsed.provider}::${parsed.model}` : "";
    } catch {
      return "";
    }
  });
  const [duration, setDuration] = useState(4);
  const [busy, setBusy] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [reference, setReference] = useState<{ id: string; title: string; url: string } | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [keyBusy, setKeyBusy] = useState(false);
  const [modelMessage, setModelMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const {
    sessions,
    active: sessionActive,
    activeId,
    setActiveId,
    create,
    remove,
    update,
    append,
  } = useStudioSessions(projectId ?? "studio", "video");
  const [selectedVideoId, setSelectedVideoId] = useState<string>("");
  const [toolPath, setToolPath] = useState("");
  const [toolAction, setToolAction] = useState<"trim" | "convert" | "resize" | "extract-audio">("trim");
  const [toolStart, setToolStart] = useState("0");
  const [toolEnd, setToolEnd] = useState("10");
  const [toolFormat, setToolFormat] = useState<"mp4" | "webm" | "mov" | "gif" | "mp3" | "m4a">("mp4");
  const [toolWidth, setToolWidth] = useState("1280");
  const [toolBusy, setToolBusy] = useState(false);
  const [toolResult, setToolResult] = useState<string | null>(null);
  const gallery: GeneratedVideo[] = useMemo(
    () =>
      (sessionActive?.entries ?? [])
        .filter((entry) => entry.type === "video" && entry.asset?.url)
        .map((entry) => ({
          id: entry.id,
          prompt: entry.content,
          url: entry.asset!.url,
          model: entry.asset!.model ?? entry.model ?? "",
          provider: entry.asset!.provider ?? entry.provider ?? "",
          bytes: entry.asset!.bytes ?? 0,
          duration: entry.asset!.duration ?? 4,
          createdAt: entry.createdAt,
        }))
        .reverse(),
    [sessionActive],
  );
  const active =
    gallery.find((item) => item.id === selectedVideoId) ?? gallery[gallery.length - 1] ?? null;

  const selected =
    models.find((row) => `${row.provider}::${row.model}` === modelKey) ?? models[0] ?? null;

  useEffect(() => {
    if (!selected) return;
    localStorage.setItem(
      "cie:studio-model:video",
      JSON.stringify({ provider: selected.provider, model: selected.model }),
    );
  }, [selected]);

  async function savePollinationsKey() {
    if (!keyInput.trim()) return;
    setKeyBusy(true);
    setModelMessage(null);
    try {
      await api.ai.updateSettings({
        provider: "pollinations",
        apiKey: keyInput.trim(),
        model: selected?.model,
        models: aiSettings?.providers.find((provider) => provider.id === "pollinations")?.models,
      });
      await api.ai.models("pollinations", true);
      onSettingsSaved(await api.ai.settings());
      setKeyInput("");
      setModelMessage(t("Pollinations key saved. Video models are ready."));
    } catch (requestError) {
      setModelMessage(
        requestError instanceof Error ? requestError.message : t("Could not save the key."),
      );
    } finally {
      setKeyBusy(false);
    }
  }

  async function refreshModels() {
    setKeyBusy(true);
    setModelMessage(null);
    try {
      await api.ai.models("pollinations", true);
      onSettingsSaved(await api.ai.settings());
      setModelMessage(t("Video model list refreshed."));
    } catch (requestError) {
      setModelMessage(
        requestError instanceof Error ? requestError.message : t("Could not refresh video models."),
      );
    } finally {
      setKeyBusy(false);
    }
  }

  async function generate() {
    const text = prompt.trim();
    if (!text || !selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.videoStudio({
        prompt: text,
        provider: selected.provider,
        model: selected.model,
        duration,
        referenceUrl: reference?.url,
      });
      void api.library
        .import({
          url: result.url,
          kind: "video",
          title: text,
          prompt: text,
          fileName: result.fileName,
          bytes: result.bytes,
          provider: result.provider,
          model: result.model,
          projectId,
        })
        .catch(() => undefined);
      const session = sessionActive ?? create();
      const withPrompt = append(session, makeEntry("user", "text", text));
      append(
        withPrompt,
        makeEntry("assistant", "video", text, {
          model: result.model,
          provider: result.provider,
          asset: {
            url: result.url,
            kind: "video",
            title: text,
            model: result.model,
            provider: result.provider,
            bytes: result.bytes,
            duration: result.duration,
          },
        }),
      );
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : t("Video generation failed."),
      );
    } finally {
      setBusy(false);
    }
  }

  async function saveVideoNote(item: { prompt: string; url: string; model: string; provider: string }) {
    if (!projectId) return;
    try {
      await api.saveStudioNote(projectId, {
        title: `Video note · ${item.prompt.slice(0, 60)}`,
        content: `# ${item.prompt}\n\nModel: ${item.provider}/${item.model}\n\nVideo: ${item.url}`,
      });
    } catch {
      // note saving is best-effort
    }
  }

  async function transform() {
    if (!projectId || !toolPath.trim() || toolBusy) return;
    setToolBusy(true);
    setToolResult(null);
    setError(null);
    try {
      const result = await api.videoTransform({
        projectId,
        path: toolPath.trim(),
        action: toolAction,
        startSeconds: toolAction === "trim" ? Number(toolStart) : undefined,
        endSeconds: toolAction === "trim" ? Number(toolEnd) : undefined,
        format: toolAction === "trim" ? "mp4" : toolAction === "extract-audio" ? "mp3" : toolFormat,
        maxWidth: toolAction === "resize" ? Number(toolWidth) || undefined : undefined,
      });
      setToolResult(
        `${result.output.path} · ${formatBytes(result.output.bytes)}${
          result.output.durationSeconds ? ` · ${result.output.durationSeconds.toFixed(1)}s` : ""
        }`,
      );
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : t("Video transform failed."),
      );
    } finally {
      setToolBusy(false);
    }
  }

  return (
    <div className="image-studio video-studio">

      <StudioLeftPanel
        analysis={analysis ?? null}
        recent={recent}
        sessions={sessions}
        activeId={activeId}
        kind="video"
        onLoadRecent={onLoadRecent ?? (() => undefined)}
        onRemoveRecent={onRemoveRecent ?? (() => undefined)}
        onOpenProject={onOpenProject ?? (() => undefined)}
        onOpenCodeStudio={onOpenCodeStudio}
        onOpenSettings={onOpenSettings}
        onOpenReports={onOpenReports}
        onOpenLibrary={() => setLibraryOpen(true)}
        onSelect={setActiveId}
        onCreate={() => {
          create();
          setSelectedVideoId("");
        }}
        onDelete={(id) => remove(id)}
      />

      <main className="image-studio-main">
        <div className="chat-studio-head">
          <div>
            <h2>{t("Video")}</h2>
            <span>
              {selected ? `${selected.provider}/${selected.model}` : t("No video model")} · {duration}s
            </span>
          </div>
          {gallery.length > 0 ? (
            <button className="ghost-button" onClick={() => {
              if (sessionActive) {
                update({
                  ...sessionActive,
                  entries: sessionActive.entries.filter((entry) => entry.type !== "video"),
                });
              }
              setSelectedVideoId("");
            }}>
              <RefreshCw size={12} /> {t("Clear gallery")}
            </button>
          ) : null}
        </div>

        {models.length > 0 ? (
          <div className="video-model-strip">
            {models.slice(0, 8).map((row) => (
              <button
                key={`strip-${row.provider}::${row.model}`}
                className={
                  selected?.provider === row.provider && selected?.model === row.model
                    ? "is-active"
                    : ""
                }
                onClick={() => setModelKey(`${row.provider}::${row.model}`)}
              >
                {row.model.replace(/^.*\//, "")}
                <em className={row.requiresKey ? "needs-key" : "is-ready"}>
                  {row.requiresKey ? t("key required") : t("ready")}
                </em>
              </button>
            ))}
            <button className="ghost-button" onClick={() => void refreshModels()} disabled={keyBusy}>
              {keyBusy ? <Loader2 size={10} className="spin" /> : <RefreshCw size={10} />}
            </button>
            <a
              className="ghost-button"
              href="https://enter.pollinations.ai/keys"
              target="_blank"
              rel="noreferrer"
            >
              <Sparkles size={10} /> {t("Get API key")}
            </a>
            <a
              className="ghost-button"
              href="https://gen.pollinations.ai/video/models"
              target="_blank"
              rel="noreferrer"
            >
              {t("Model pages")}
            </a>
          </div>
        ) : null}
        {selected?.requiresKey ? (
          <div className="video-key-setup">
            <strong>{t("Pollinations API key required")}</strong>
            <p>
              {t(
                "Video models run through Pollinations. Paste an sk_ key; it is stored locally like other provider keys.",
              )}
            </p>
            <input
              type="password"
              value={keyInput}
              onChange={(event) => setKeyInput(event.target.value)}
              placeholder="sk_…"
              spellCheck={false}
            />
            <div>
              <button
                className="primary-button"
                onClick={() => void savePollinationsKey()}
                disabled={keyBusy || !keyInput.trim()}
              >
                {keyBusy ? <Loader2 size={11} className="spin" /> : null}
                {t("Save key")}
              </button>
            </div>
          </div>
        ) : null}

        {error ? <div className="chat-studio-error">{error}</div> : null}

        <div className="image-studio-canvas video-studio-canvas">
          {active ? (
            <figure>
              <video src={active.url} controls playsInline />
              <figcaption>
                <p>{active.prompt}</p>
                <div>
                  <span>
                    {active.provider}/{active.model} · {active.duration}s · {formatBytes(active.bytes)}
                  </span>
                  <button className="studio-message-note" onClick={() => void saveVideoNote(active)} disabled={!projectId}>
                    <FileText size={10} /> {t("Save note")}
                  </button>
                  <a href={active.url} download>
                    <Download size={11} /> {t("Download video")}
                  </a>
                </div>
              </figcaption>
            </figure>
          ) : (
            <div className="chat-studio-empty video-model-screen">
              <Clapperboard size={30} />
              <h3>{t("Choose a video model")}</h3>
              <p>
                {t(
                  "Select a model, enter a prompt and generate. Models marked “key required” need a Pollinations API key.",
                )}
              </p>
              <div className="video-model-grid">
                {models.slice(0, 12).map((row) => (
                  <button
                    key={`card-${row.provider}::${row.model}`}
                    className={
                      selected?.provider === row.provider && selected?.model === row.model
                        ? "is-active"
                        : ""
                    }
                    onClick={() => setModelKey(`${row.provider}::${row.model}`)}
                  >
                    <strong>{row.model.replace(/^.*\//, "")}</strong>
                    <span>{row.providerName}</span>
                    <em className={row.requiresKey ? "needs-key" : "is-ready"}>
                      {row.requiresKey ? t("key required") : t("ready")}
                    </em>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {gallery.length > 0 ? (
          <div className="image-studio-gallery video-studio-gallery">
            {gallery.map((item) => (
              <button
                key={item.id}
                className={active?.id === item.id ? "is-active" : ""}
                onClick={() => setSelectedVideoId(item.id)}
                title={item.prompt}
              >
                <video src={item.url} muted preload="metadata" />
              </button>
            ))}
          </div>
        ) : null}

        <details className="video-studio-tools video-studio-tools-inline">
          <summary>{t("Local video tools")}</summary>
          {projectId ? (
            <div className="video-tools-grid">
              <input value={toolPath} onChange={(event) => setToolPath(event.target.value)} placeholder="assets/demo.mp4" />
              <select value={toolAction} onChange={(event) => setToolAction(event.target.value as typeof toolAction)}>
                <option value="trim">{t("Trim")}</option>
                <option value="convert">{t("Convert format")}</option>
                <option value="resize">{t("Resize")}</option>
                <option value="extract-audio">{t("Extract audio")}</option>
              </select>
              {toolAction === "trim" ? (
                <>
                  <input type="number" min="0" step="0.1" value={toolStart} onChange={(event) => setToolStart(event.target.value)} placeholder={t("Start (s)")} />
                  <input type="number" min="0" step="0.1" value={toolEnd} onChange={(event) => setToolEnd(event.target.value)} placeholder={t("End (s)")} />
                </>
              ) : null}
              {toolAction === "convert" || toolAction === "extract-audio" ? (
                <select value={toolFormat} onChange={(event) => setToolFormat(event.target.value as typeof toolFormat)}>
                  <option value="mp4">mp4</option>
                  <option value="webm">webm</option>
                  <option value="mov">mov</option>
                  <option value="gif">gif</option>
                  <option value="mp3">mp3</option>
                  <option value="m4a">m4a</option>
                </select>
              ) : null}
              {toolAction === "resize" ? (
                <input type="number" min="160" step="10" value={toolWidth} onChange={(event) => setToolWidth(event.target.value)} placeholder={t("Max width")} />
              ) : null}
              <button className="ghost-button" onClick={() => void transform()} disabled={toolBusy || !toolPath.trim()}>
                {toolBusy ? <Loader2 size={11} className="spin" /> : <Clapperboard size={11} />}
                {t("Run video tool")}
              </button>
              {toolResult ? <span className="video-studio-note">{toolResult}</span> : null}
            </div>
          ) : (
            <p className="video-studio-note">{t("Open a project to trim, convert or resize local videos.")}</p>
          )}
        </details>

        <div className="studio-bottom-controls">
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={3}
            placeholder={t("A paper boat drifting on a calm river at sunrise, cinematic…")}
          />
          <div className="studio-composer-bottom">
            <div className="studio-composer-left">
              <div className="studio-attach-wrap">
                <button className="chat-studio-attach" onClick={() => setLibraryOpen(true)} title={t("Library reference")}>
                  <Clapperboard size={14} />
                </button>
              </div>
              <select
                className="studio-model-select"
                value={selected ? `${selected.provider}::${selected.model}` : ""}
                onChange={(event) => setModelKey(event.target.value)}
              >
                {models.map((row) => (
                  <option key={`${row.provider}::${row.model}`} value={`${row.provider}::${row.model}`}>
                    {row.model}
                  </option>
                ))}
              </select>
              <select className="studio-size-select" value={duration} onChange={(event) => setDuration(Number(event.target.value))}>
                {[4, 6, 8].map((value) => (
                  <option key={value} value={value}>{value}s</option>
                ))}
              </select>
              {reference ? (
                <span className="studio-reference-chip" title={reference.url}>
                  {reference.title}
                  <button onClick={() => setReference(null)} aria-label={t("Remove reference")}>×</button>
                </span>
              ) : null}
            </div>
            <div className="studio-composer-right">
              <button
                className="chat-studio-send"
                onClick={() => void generate()}
                disabled={busy || selected?.requiresKey === true}
              >
                {busy ? <Loader2 size={13} className="spin" /> : <Play size={13} />}
                {busy ? t("Generating video…") : t("Generate video")}
              </button>
            </div>
          </div>
        </div>
      </main>
      <LibraryPicker
        open={libraryOpen}
        kind="image"
        mode="select"
        onClose={() => setLibraryOpen(false)}
        onSelect={(asset) => setReference({ id: asset.id, title: asset.title, url: asset.url })}
      />
    </div>
  );
}
