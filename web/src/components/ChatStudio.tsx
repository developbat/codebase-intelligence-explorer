import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUp,
  Bot,
  FileText,
  Globe2,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  MessageSquarePlus,
  Paperclip,
  Plus,
  Sparkles,
  Square,
  Trash2,
  User,
  X,
} from "lucide-react";
import type { AiProviderId, AiSettingsPublic, AiTokenUsage } from "../../../shared/ai";
import {
  modelsForStudio,
  preferredStudioModel,
  type StudioModelRow,
} from "../../../shared/modelCapabilities";
import { formatUsd } from "../../../shared/pricing";
import { api, type AnalysisResult, type RecentProject } from "../api";
import { useI18n } from "../i18n";
import { MarkdownText } from "./MarkdownText";
import { LibraryPicker } from "./LibraryPicker";
import { StudioLeftPanel } from "./StudioLeftPanel";
import { makeEntry, useStudioSessions, type StudioEntry } from "../lib/studioSessions";

const MODEL_KEY = "cie:chat-studio:model";

interface ChatStudioProps {
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
}

function formatTokens(value?: number): string {
  if (!value) return "0";
  return value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value);
}

function urlsIn(text: string): string[] {
  return [...new Set(text.match(/https?:\/\/[^\s<>"')]+/gi) ?? [])].slice(0, 3);
}

export function ChatStudio({
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
}: ChatStudioProps) {
  const { t, locale } = useI18n();
  const {
    sessions,
    active,
    activeId,
    setActiveId,
    create,
    remove,
    update,
    append,
  } = useStudioSessions(projectId ?? "studio", "chat");
  const messages = active?.entries ?? [];
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [useWeb, setUseWeb] = useState(true);
  const [attachment, setAttachment] = useState<{ name: string; content: string } | null>(null);
  const [noteMessage, setNoteMessage] = useState<string | null>(null);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [modelChoice, setModelChoice] = useState<{ provider: AiProviderId; model: string } | null>(
    () => {
      try {
        const raw = localStorage.getItem(MODEL_KEY) ?? localStorage.getItem("cie:studio-model:chat");
        return raw ? (JSON.parse(raw) as { provider: AiProviderId; model: string }) : null;
      } catch {
        return null;
      }
    },
  );
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const studioModels: StudioModelRow[] = useMemo(
    () => modelsForStudio(aiSettings, "chat"),
    [aiSettings],
  );
  const model =
    modelChoice &&
    studioModels.some(
      (row) => row.provider === modelChoice.provider && row.model === modelChoice.model,
    )
      ? modelChoice
      : preferredStudioModel(aiSettings, "chat", modelChoice);

  const grouped = useMemo(() => {
    const map = new Map<string, { name: string; rows: StudioModelRow[] }>();
    for (const row of studioModels) {
      const group = map.get(row.provider) ?? { name: row.providerName, rows: [] };
      group.rows.push(row);
      map.set(row.provider, group);
    }
    return [...map.entries()];
  }, [studioModels]);

  const detectedUrls = useMemo(() => urlsIn(input), [input]);

  useEffect(() => {
    if (!model) return;
    localStorage.setItem(MODEL_KEY, JSON.stringify(model));
    localStorage.setItem("cie:studio-model:chat", JSON.stringify(model));
  }, [model]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy]);

  async function attachFile(file: File) {
    if (file.size > 400_000) {
      setError(t("Text file is too large (400 KB limit)."));
      return;
    }
    try {
      const content = await file.text();
      setAttachment({ name: file.name, content: content.slice(0, 200_000) });
      setError(null);
    } catch {
      setError(t("Could not read this file."));
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function send() {
    const text = input.trim();
    if ((!text && !attachment) || busy || !model) return;
    const prompt = attachment
      ? `${text}${text ? "\n\n" : ""}Attached file: ${attachment.name}\n\n${attachment.content}`
      : text;
    const session = active ?? create();
    const userEntry = makeEntry("user", "text", prompt, {
      provider: model.provider,
      model: model.model,
      attachment: attachment?.name,
    });
    const withUser = append(session, userEntry);
    const history = [...withUser.entries].slice(-16).map((entry) => ({
      role: entry.role,
      content: entry.content,
    }));
    setInput("");
    setAttachment(null);
    setBusy(true);
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await api.chatStudio(
        {
          messages: history,
          provider: model.provider,
          model: model.model,
          language: locale,
          web: useWeb,
        },
        controller.signal,
      );
      append(
        withUser,
        makeEntry("assistant", "text", result.text, {
          provider: result.provider,
          model: result.model,
          tokenUsage: result.tokenUsage,
          costUsd: result.costUsd,
          sources: result.sources,
        } as Partial<StudioEntry>),
      );
    } catch (requestError) {
      if (controller.signal.aborted) {
        setError(t("Stopped."));
      } else {
        setError(
          requestError instanceof Error ? requestError.message : t("Chat request failed."),
        );
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  async function saveNotes(entries = active?.entries ?? []) {
    if (!projectId || !active || entries.length === 0) return;
    const transcript = entries
      .map(
        (entry) =>
          `## ${entry.role === "user" ? "User" : "Assistant"} · ${new Date(entry.createdAt).toLocaleString()}\n\n${entry.content}`,
      )
      .join("\n\n");
    try {
      const result = await api.saveStudioNote(projectId, {
        title: `Studio notes · ${active.title}`,
        content: `# ${active.title}\n\n${transcript}`,
      });
      setNoteMessage(t("Note saved: {path}", { path: result.path }));
    } catch (requestError) {
      setNoteMessage(
        requestError instanceof Error ? requestError.message : t("Could not save the note."),
      );
    }
  }

  return (
    <div className="studio-shell chat-studio">
      <StudioLeftPanel
        analysis={analysis ?? null}
        recent={recent}
        sessions={sessions}
        activeId={activeId}
        kind="chat"
        onLoadRecent={onLoadRecent ?? (() => undefined)}
        onRemoveRecent={onRemoveRecent ?? (() => undefined)}
        onOpenProject={onOpenProject ?? (() => undefined)}
        onOpenCodeStudio={onOpenCodeStudio}
        onOpenSettings={onOpenSettings}
        onOpenReports={onOpenReports}
        onOpenLibrary={() => setLibraryOpen(true)}
        onSelect={setActiveId}
        onCreate={() => create()}
        onDelete={(id) => remove(id)}
      />

      <main className="chat-studio-main">
        <div className="chat-studio-head">
          <div>
            <h2>{active?.title ?? t("Chat Studio")}</h2>
            <span>
              {model ? `${model.provider}/${model.model}` : t("Choose a model")}
              {useWeb ? ` · ${t("URL fetch on")}` : ""}
            </span>
          </div>
          {messages.length > 0 ? (
            <button
              className="ghost-button"
              onClick={() => active && update({ ...active, entries: [] })}
              disabled={busy}
              title={t("Clear conversation")}
            >
              <Trash2 size={12} /> {t("Clear")}
            </button>
          ) : null}
        </div>

        <div className="chat-studio-messages">
          {messages.length === 0 ? (
            <div className="chat-studio-empty">
              <Bot size={30} />
              <h3>{t("What should we work on?")}</h3>
              <p>
                {t(
                  "Ask a question, paste a link, or attach a file. This studio chats and researches; it does not edit code.",
                )}
              </p>
            </div>
          ) : (
            messages.map((message, index) => (
              <article key={index} className={`chat-studio-message is-${message.role}`}>
                <div className="chat-studio-message-head">
                  {message.role === "user" ? <User size={12} /> : <Bot size={12} />}
                  <span>{message.role === "user" ? t("You") : message.model ?? t("Assistant")}</span>
                  {message.attachment ? (
                    <small>
                      <FileText size={9} /> {message.attachment}
                    </small>
                  ) : null}
                  {message.tokenUsage ? (
                    <small>
                      {formatTokens(message.tokenUsage.totalTokens)} {t("tokens")}
                      {message.costUsd ? ` · ${formatUsd(message.costUsd)}` : ""}
                    </small>
                  ) : null}
                  <button
                    className="studio-message-note"
                    onClick={() => void saveNotes([message])}
                    disabled={!projectId}
                    title={t("Save this message as a project note")}
                  >
                    <FileText size={9} /> {t("Save note")}
                  </button>
                </div>
                <div className="chat-studio-message-body">
                  {message.role === "assistant" ? (
                    <MarkdownText value={message.content} />
                  ) : (
                    message.content
                  )}
                </div>
                {message.sources && message.sources.length > 0 ? (
                  <div className="chat-studio-sources">
                    {message.sources.map((source) => (
                      <a
                        key={source.url}
                        href={source.url}
                        target="_blank"
                        rel="noreferrer"
                        title={source.error ?? source.url}
                      >
                        <Globe2 size={9} />
                        {source.title || source.url}
                        {source.error ? ` · ${source.error}` : ""}
                      </a>
                    ))}
                  </div>
                ) : null}
              </article>
            ))
          )}
          {busy ? (
            <div className="chat-studio-thinking">
              <Loader2 size={13} className="spin" /> {t("Thinking…")}
            </div>
          ) : null}
          <div ref={bottomRef} />
        </div>

        {error ? (
          <div className="chat-studio-error">
            <AlertTriangle size={12} /> {error}
          </div>
        ) : null}
        {noteMessage ? <div className="chat-studio-note-message">{noteMessage}</div> : null}

        <div className="chat-studio-composer">
          {attachment ? (
            <div className="chat-studio-attachment">
              <FileText size={11} /> {attachment.name}
              <button onClick={() => setAttachment(null)} aria-label={t("Remove attachment")}>
                <X size={10} />
              </button>
            </div>
          ) : null}
          {detectedUrls.length > 0 && useWeb ? (
            <div className="chat-studio-urls">
              <Globe2 size={10} /> {detectedUrls.length} {t("URL(s) will be fetched")}
            </div>
          ) : null}
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            rows={3}
            placeholder={t("Ask anything, paste a URL, or describe what you need…")}
            disabled={busy || !model}
          />
          <div className="studio-composer-bottom">
            <div className="studio-composer-left">
              <div className="studio-attach-wrap">
                <button
                  className="chat-studio-attach"
                  onClick={() => setAttachMenuOpen((value) => !value)}
                  disabled={busy}
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
                        fileRef.current?.click();
                      }}
                    >
                      <FileText size={11} /> {t("From file")}
                    </button>
                    <button
                      onClick={() => {
                        setAttachMenuOpen(false);
                        setLibraryOpen(true);
                      }}
                    >
                      <ImageIcon size={11} /> {t("From library")}
                    </button>
                  </div>
                ) : null}
                <input
                  ref={fileRef}
                  type="file"
                  hidden
                  accept=".txt,.md,.markdown,.json,.csv,.log,.html,.css,.js,.ts"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void attachFile(file);
                  }}
                />
              </div>
              <select
                className="studio-model-select"
                value={model ? `${model.provider}::${model.model}` : ""}
                onChange={(event) => {
                  const [provider, ...rest] = event.target.value.split("::");
                  setModelChoice({ provider, model: rest.join("::") });
                }}
                title={t("Model")}
              >
                {grouped.length === 0 ? <option value="">{t("No chat model configured")}</option> : null}
                {grouped.map(([provider, group]) => (
                  <optgroup key={provider} label={group.name}>
                    {group.rows.map((row) => (
                      <option key={`${row.provider}::${row.model}`} value={`${row.provider}::${row.model}`}>
                        {row.model}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <label className="studio-web-toggle">
                <input
                  type="checkbox"
                  checked={useWeb}
                  onChange={(event) => setUseWeb(event.target.checked)}
                />
                <Globe2 size={11} /> {t("Fetch URLs")}
              </label>
            </div>
            {busy ? (
              <button className="chat-studio-send is-stop" onClick={stop}>
                <Square size={12} /> {t("Stop")}
              </button>
            ) : (
              <button
                className="chat-studio-send"
                onClick={() => void send()}
                disabled={(!input.trim() && !attachment) || !model}
              >
                <ArrowUp size={14} /> {t("Send")}
              </button>
            )}
          </div>
        </div>
      </main>

      <LibraryPicker
        open={libraryOpen}
        mode="select"
        onClose={() => setLibraryOpen(false)}
        onSelect={(asset) => {
          setInput((current) => `${current}${current ? "\n" : ""}[${asset.title}](${asset.url})`);
        }}
      />
    </div>
  );
}
