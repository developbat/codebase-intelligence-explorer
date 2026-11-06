import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  BrainCircuit,
  FileCode2,
  Loader2,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import type { AnalysisResult } from "../../../shared/types";
import type { AiContextFile, AiSettingsPublic } from "../../../shared/ai";
import { api } from "../api";
import { useI18n } from "../i18n";
import { activeProvider } from "../lib/ai";

interface ChatEntry {
  role: "user" | "assistant";
  content: string;
  evidence?: AiContextFile[];
  model?: string;
  provider?: string;
  chars?: number;
}

interface AiChatDrawerProps {
  open: boolean;
  analysis: AnalysisResult;
  settings: AiSettingsPublic | null;
  onClose: () => void;
  onOpenSettings: () => void;
  onOpenFile: (filePath: string) => void;
}

export function AiChatDrawer({
  open,
  analysis,
  settings,
  onClose,
  onOpenSettings,
  onOpenFile,
}: AiChatDrawerProps) {
  const { t, locale } = useI18n();
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMessages([]);
    setError(null);
  }, [analysis.id]);

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, loading]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const active = activeProvider(settings);
  const configured = Boolean(active);

  async function send() {
    const text = question.trim();
    if (!text || loading || !active) return;
    setQuestion("");
    setError(null);
    const history = messages.map((message) => ({ role: message.role, content: message.content }));
    setMessages((current) => [...current, { role: "user", content: text }]);
    setLoading(true);
    try {
      const result = await api.ai.chat(analysis.id, text, history, active.provider, active.model, locale);
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: result.answer,
          evidence: result.evidence,
          provider: result.provider,
          model: result.model,
          chars: result.usage?.inputChars,
        },
      ]);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("The model request failed."));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="chat-drawer">
      <div className="chat-header">
        <div className="chat-title">
          <span className="chat-mark">
            <BrainCircuit size={15} />
          </span>
          <span>
            <strong>{t("Ask the codebase")}</strong>
            <small>{active ? `${active.provider} · ${active.model}` : t("AI not configured")}</small>
          </span>
        </div>
        <button className="icon-button subtle" onClick={onClose} aria-label={t("Close")}>
          <X size={14} />
        </button>
      </div>

      <div className="chat-body" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="chat-intro">
            <Sparkles size={18} />
            <p>
              {t(
                "Ask about a flow, a route, a risky dependency, or how a function actually behaves. Answers are grounded in the graph and real source excerpts.",
              )}
            </p>
            <div className="chat-suggestions">
              {[
                t("How does the main order flow work?"),
                t("Which functions have the highest impact?"),
                t("Where is the payment logic and what can fail?"),
              ].map((suggestion) => (
                <button key={suggestion} onClick={() => setQuestion(suggestion)}>
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {messages.map((message, index) => (
          <div key={index} className={`chat-message chat-${message.role}`}>
            <div className="chat-bubble">
              <div className="chat-text">{message.content}</div>
              {message.evidence && message.evidence.length > 0 ? (
                <div className="chat-evidence">
                  {message.evidence.slice(0, 6).map((item, evidenceIndex) => (
                    <button key={evidenceIndex} onClick={() => onOpenFile(item.path)}>
                      <FileCode2 size={10} />
                      {item.path.split("/").pop()}
                      {item.startLine ? `:${item.startLine}` : ""}
                    </button>
                  ))}
                </div>
              ) : null}
              {message.role === "assistant" ? (
                <div className="chat-meta">
                  {message.provider} · {message.model}
                  {message.chars ? ` · ${t("{count} chars of context", { count: message.chars })}` : ""}
                </div>
              ) : null}
            </div>
          </div>
        ))}

        {loading ? (
          <div className="chat-message chat-assistant">
            <div className="chat-bubble chat-thinking">
              <Loader2 size={13} className="spin" /> {t("Reading relevant code…")}
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="chat-error">
            <AlertTriangle size={12} /> {error}
          </div>
        ) : null}
      </div>

      <div className="chat-footer">
        {!configured ? (
          <button className="ai-run-button" onClick={onOpenSettings}>
            <Sparkles size={13} /> {t("Configure a model to start")}
          </button>
        ) : (
          <>
            <textarea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
              placeholder={t("Ask about this codebase…")}
              rows={2}
              disabled={loading}
            />
            <button className="send-button" onClick={send} disabled={loading || !question.trim()}>
              {loading ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
