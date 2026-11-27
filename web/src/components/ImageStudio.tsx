import { useEffect, useMemo, useState } from "react";
import {
  Download,
  FileText,
  Image as ImageIcon,
  Loader2,
  Paperclip,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import type { AiSettingsPublic } from "../../../shared/ai";
import { FREE_IMAGE_MODELS, modelsForStudio } from "../../../shared/modelCapabilities";
import { api, type AnalysisResult, type RecentProject } from "../api";
import { useI18n } from "../i18n";
import { LibraryPicker } from "./LibraryPicker";
import { StudioLeftPanel } from "./StudioLeftPanel";
import { makeEntry, useStudioSessions } from "../lib/studioSessions";

interface GeneratedImage {
  id: string;
  prompt: string;
  url: string;
  model: string;
  width: number;
  height: number;
  seed: number;
  createdAt: string;
}

function makeSeed(): number {
  return Math.floor(Math.random() * 1_000_000_000);
}

function imageUrl(
  prompt: string,
  model: string,
  width: number,
  height: number,
  seed: number,
  reference?: string,
): string {
  const params = new URLSearchParams({
    width: String(width),
    height: String(height),
    seed: String(seed),
    nologo: "true",
    model,
  });
  if (reference && /^https?:\/\//i.test(reference)) params.set("image", reference);
  return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params.toString()}`;
}

export function ImageStudio({
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
}: {
  aiSettings: AiSettingsPublic | null;
  projectId?: string;
  analysis?: AnalysisResult | null;
  recent?: RecentProject[];
  onLoadRecent?: (project: RecentProject) => void;
  onRemoveRecent?: (id: string) => void;
  onOpenProject?: () => void;
  onOpenCodeStudio?: () => void;
  onOpenSettings?: () => void;
  onOpenReports?: () => void;
}) {
  const { t } = useI18n();
  const {
    sessions,
    active: sessionActive,
    activeId,
    setActiveId,
    create,
    remove,
    update,
    append,
  } = useStudioSessions(projectId ?? "studio", "image");
  const [prompt, setPrompt] = useState("");
  const providerImageModels = modelsForStudio(aiSettings, "image");
  const [model, setModel] = useState<string>(() => {
    try {
      const raw = localStorage.getItem("cie:studio-model:image");
      if (!raw) return "free:flux";
      const parsed = JSON.parse(raw) as { provider?: string; model?: string };
      if (!parsed.provider || !parsed.model) return "free:flux";
      return parsed.provider === "free" ? `free:${parsed.model}` : `${parsed.provider}::${parsed.model}`;
    } catch {
      return "free:flux";
    }
  });
  const [size, setSize] = useState("1024x1024");
  const [seed, setSeed] = useState(makeSeed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reference, setReference] = useState<{
    id: string;
    title: string;
    url: string;
  } | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [imageFile, setImageFile] = useState("");
  const [imageFileRef, setImageFileRef] = useState<{ name: string; url: string } | null>(null);
  const [selectedImageId, setSelectedImageId] = useState<string>("");
  const gallery: GeneratedImage[] = useMemo(
    () =>
      (sessionActive?.entries ?? [])
        .filter((entry) => entry.type === "image" && entry.asset?.url)
        .map((entry) => ({
          id: entry.id,
          prompt: entry.content,
          url: entry.asset!.url,
          model: entry.asset!.model ?? entry.model ?? "",
          width: entry.asset!.width ?? 1024,
          height: entry.asset!.height ?? 1024,
          seed: entry.asset!.seed ?? 0,
          createdAt: entry.createdAt,
        }))
        .reverse(),
    [sessionActive],
  );
  const active =
    gallery.find((item) => item.id === selectedImageId) ?? gallery[gallery.length - 1] ?? null;

  const [width, height] = useMemo(
    () => size.split("x").map((value) => Number(value) || 1024),
    [size],
  );
  const selected = useMemo(() => {
    if (model.startsWith("free:")) {
      const id = model.slice(5);
      const free = FREE_IMAGE_MODELS.find((item) => item.id === id) ?? FREE_IMAGE_MODELS[0];
      return { free: true, provider: "free", model: free.id, label: t(free.name) };
    }
    const [provider, ...rest] = model.split("::");
    const name = rest.join("::");
    const row = providerImageModels.find(
      (item) => item.provider === provider && item.model === name,
    );
    return row
      ? { free: false, provider: row.provider, model: row.model, label: row.model }
      : { free: true, provider: "free", model: "flux", label: t(FREE_IMAGE_MODELS[0].name) };
  }, [model, providerImageModels, t]);

  useEffect(() => {
    if (!selected) return;
    localStorage.setItem(
      "cie:studio-model:image",
      JSON.stringify({ provider: selected.provider, model: selected.model }),
    );
  }, [selected]);

  async function saveImageNote(item: { prompt: string; url: string; model: string }) {
    if (!projectId) return;
    try {
      await api.saveStudioNote(projectId, {
        title: `Image note · ${item.prompt.slice(0, 60)}`,
        content: `# ${item.prompt}\n\nModel: ${item.model}\n\nImage: ${item.url}`,
      });
    } catch {
      // note saving is best-effort
    }
  }

  async function generate(nextSeed = seed) {
    const text = prompt.trim();
    if (!text) {
      setError(t("Describe the image you want."));
      return;
    }
    setError(null);
    setBusy(true);
    setSeed(nextSeed);
    try {
      let url: string;
      let actualWidth = width;
      let actualHeight = height;
      if (selected.free) {
        url = imageUrl(text, selected.model, width, height, nextSeed, reference?.url);
      } else {
        const result = await api.imageStudio({
          prompt: text,
          provider: selected.provider,
          model: selected.model,
          width,
          height,
          seed: nextSeed,
          referenceUrl: reference?.url,
        });
        url = result.url;
        actualWidth = result.width;
        actualHeight = result.height;
      }
      const session = sessionActive ?? create();
      const withPrompt = append(session, makeEntry("user", "text", text));
      append(
        withPrompt,
        makeEntry("assistant", "image", text, {
          model: selected.label,
          asset: {
            url,
            kind: "image",
            title: text,
            model: selected.label,
            provider: selected.provider,
            width: actualWidth,
            height: actualHeight,
            seed: nextSeed,
          },
        }),
      );
      void api.library
        .import({
          url,
          kind: "image",
          title: text,
          prompt: text,
          provider: selected.provider,
          model: selected.model,
          projectId,
        })
        .catch(() => undefined);
      const probe = new Image();
      probe.onload = () => setBusy(false);
      probe.onerror = () => {
        setBusy(false);
        setError(t("Image generation failed. Try again or change the prompt."));
      };
      probe.src = url;
    } catch (requestError) {
      setBusy(false);
      setError(
        requestError instanceof Error ? requestError.message : t("Image generation failed. Try again or change the prompt."),
      );
    }
  }

  return (
    <div className="studio-shell image-studio">
      <StudioLeftPanel
        analysis={analysis ?? null}
        recent={recent}
        sessions={sessions}
        activeId={activeId}
        kind="image"
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
          setSelectedImageId("");
        }}
        onDelete={(id) => remove(id)}
      />

      <main className="image-studio-main">
        <div className="image-studio-scroll">
        <div className="chat-studio-head">
          <div>
            <h2>{t("Image")}</h2>
            <span>
              {selected.label} · {width}×{height} · seed {seed}
            </span>
          </div>
          {gallery.length > 0 ? (
            <button
              className="ghost-button"
              onClick={() => {
                if (sessionActive) {
                  update({
                    ...sessionActive,
                    entries: sessionActive.entries.filter((entry) => entry.type !== "image"),
                  });
                }
                setSelectedImageId("");
              }}
            >
              <Sparkles size={12} /> {t("Clear gallery")}
            </button>
          ) : null}
        </div>

        {error ? <div className="chat-studio-error">{error}</div> : null}

        <div className="image-studio-canvas">
          {active ? (
            <figure>
              <img src={active.url} alt={active.prompt} />
              {busy ? (
                <div className="image-studio-loading">
                  <Loader2 size={16} className="spin" /> {t("Painting…")}
                </div>
              ) : null}
              <figcaption>
                <p>{active.prompt}</p>
                <div>
                  <span>
                    {active.model} · {active.width}×{active.height} · seed {active.seed}
                  </span>
                  <button className="studio-message-note" onClick={() => void saveImageNote(active)} disabled={!projectId}>
                    <FileText size={10} /> {t("Save note")}
                  </button>
                  <a href={active.url} target="_blank" rel="noreferrer">
                    <Download size={11} /> {t("Open image")}
                  </a>
                </div>
              </figcaption>
            </figure>
          ) : (
            <div className="chat-studio-empty">
              <ImageIcon size={30} />
              <h3>{t("Describe an image to begin")}</h3>
              <p>
                {t(
                  "The free generator needs no key. Generated images stay in this browser gallery.",
                )}
              </p>
            </div>
          )}
        </div>

        {gallery.length > 0 ? (
          <div className="image-studio-gallery">
            {gallery.map((item) => (
              <button
                key={item.id}
                className={active?.id === item.id ? "is-active" : ""}
                onClick={() => setSelectedImageId(item.id)}
                title={item.prompt}
              >
                <img src={item.url} alt={item.prompt} loading="lazy" />
              </button>
            ))}
          </div>
        ) : null}

        </div>

        <div className="studio-bottom-controls">
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={3}
            placeholder={t("A lighthouse at dawn, cinematic light, wide shot…")}
          />
          <div className="studio-composer-bottom">
            <div className="studio-composer-left">
              <div className="studio-attach-wrap">
                <button
                  className="chat-studio-attach"
                  onClick={() => setAttachMenuOpen((value) => !value)}
                  title={t("Attach")}
                  aria-label={t("Attach")}
                >
                  <Paperclip size={14} />
                </button>
                {attachMenuOpen ? (
                  <div className="studio-attach-menu">
                    <button
                      onClick={() => {
                        setAttachMenuOpen(false);
                        setLibraryOpen(true);
                      }}
                    >
                      <ImageIcon size={11} /> {t("From library")}
                    </button>
                    <label>
                      <input
                        hidden
                        type="file"
                        accept="image/*"
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (!file) return;
                          const reader = new FileReader();
                          reader.onload = () =>
                            setImageFileRef({ name: file.name, url: String(reader.result ?? "") });
                          reader.readAsDataURL(file);
                          setAttachMenuOpen(false);
                        }}
                      />
                      <ImageIcon size={11} /> {t("From file")}
                    </label>
                  </div>
                ) : null}
              </div>
              <select
                className="studio-model-select"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                title={t("Model")}
              >
                <optgroup label={t("Free models")}>
                  {FREE_IMAGE_MODELS.map((item) => (
                    <option key={`free:${item.id}`} value={`free:${item.id}`}>
                      {t(item.name)}
                    </option>
                  ))}
                </optgroup>
                {providerImageModels.length > 0 ? (
                  <optgroup label="Pollinations">
                    {providerImageModels.map((row) => (
                      <option key={`${row.provider}::${row.model}`} value={`${row.provider}::${row.model}`}>
                        {row.model}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </select>
              <select
                className="studio-size-select"
                value={size}
                onChange={(event) => setSize(event.target.value)}
                title={t("Size")}
              >
                <option value="512x512">512</option>
                <option value="768x768">768</option>
                <option value="1024x1024">1024</option>
                <option value="1024x768">1024×768</option>
                <option value="768x1024">768×1024</option>
                <option value="1280x720">1280×720</option>
              </select>
              <label className="studio-seed">
                <span>{t("Seed")}</span>
                <input
                  type="number"
                  value={seed}
                  onChange={(event) => setSeed(Number(event.target.value) || 0)}
                />
              </label>
              {reference || imageFileRef ? (
                <span className="studio-reference-chip" title={(reference ?? imageFileRef)?.url}>
                  {reference?.title ?? imageFileRef?.name}
                  <button
                    onClick={() => {
                      setReference(null);
                      setImageFileRef(null);
                    }}
                    aria-label={t("Remove reference")}
                  >
                    ×
                  </button>
                </span>
              ) : null}
            </div>
            <div className="studio-composer-right">
              <button
                className="ghost-button"
                onClick={() => void generate(seed + 1)}
                disabled={busy || !prompt.trim()}
                title={t("New variation")}
              >
                <RefreshCw size={12} />
              </button>
              <button className="chat-studio-send" onClick={() => void generate()} disabled={busy}>
                {busy ? <Loader2 size={13} className="spin" /> : <Wand2 size={13} />}
                {busy ? t("Generating…") : t("Generate")}
              </button>
            </div>
          </div>
          {gallery.length > 0 ? (
            <button
              className="studio-clear-gallery"
              onClick={() => {
                if (sessionActive) {
                  update({
                    ...sessionActive,
                    entries: sessionActive.entries.filter((entry) => entry.type !== "image"),
                  });
                }
                setSelectedImageId("");
              }}
            >
              <Trash2 size={10} /> {t("Clear gallery")}
            </button>
          ) : null}
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
