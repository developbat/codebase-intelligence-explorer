import { useEffect, useMemo, useState } from "react";
import { diffLines } from "diff";
import { FileText, History, Loader2, RotateCcw, Save, X } from "lucide-react";
import type {
  AiPromptDefinition,
  AiPromptVersionContent,
  AiPromptVersionInfo,
} from "../../../shared/ai";
import { api } from "../api";
import { useI18n } from "../i18n";

interface PromptManagerDialogProps {
  open: boolean;
  projectId?: string;
  embedded?: boolean;
  onClose: () => void;
}

export function PromptManagerDialog({
  open,
  projectId,
  embedded = false,
  onClose,
}: PromptManagerDialogProps) {
  const { t } = useI18n();
  const [prompts, setPrompts] = useState<AiPromptDefinition[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [system, setSystem] = useState("");
  const [scope, setScope] = useState<"project" | "global">(projectId ? "project" : "global");
  const [busy, setBusy] = useState<"load" | "save" | "reset" | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyVersion, setHistoryVersion] = useState<AiPromptVersionContent | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);

  const selected = prompts.find((prompt) => prompt.id === selectedId) ?? prompts[0];

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setBusy("load");
    setMessage(null);
    api.ai
      .prompts(projectId)
      .then(({ prompts: list }) => {
        if (cancelled) return;
        setPrompts(list);
        const first = list[0];
        if (first) {
          setSelectedId(first.id);
          setSystem(first.system);
          setScope(first.source === "global" || !projectId ? "global" : "project");
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setMessage({
            ok: false,
            text: error instanceof Error ? error.message : t("Could not load prompts."),
          });
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId, t]);

  function selectPrompt(prompt: AiPromptDefinition) {
    setSelectedId(prompt.id);
    setSystem(prompt.system);
    setScope(prompt.source === "global" || !projectId ? "global" : "project");
    setShowPreview(false);
    setShowDiff(false);
    setHistoryOpen(false);
    setHistoryVersion(null);
    setMessage(null);
  }

  function changeScope(next: "project" | "global") {
    setScope(next);
    setHistoryVersion(null);
    setShowDiff(false);
    setMessage(null);
  }

  const history = useMemo(
    () =>
      (selected?.history ?? []).filter(
        (entry) => entry.scope === (scope === "project" ? "project" : "global"),
      ),
    [selected, scope],
  );
  const diffSource = historyVersion?.system ?? system;
  const diffParts = useMemo(
    () => (selected ? diffLines(selected.defaultSystem, diffSource) : []),
    [selected, diffSource],
  );

  async function loadVersion(info: AiPromptVersionInfo) {
    if (!selected || historyBusy) return;
    setHistoryBusy(true);
    setMessage(null);
    try {
      const content = await api.ai.promptVersionContent(
        selected.id,
        info.version,
        info.scope,
        info.scope === "project" ? projectId : undefined,
      );
      setHistoryVersion(content);
      setShowDiff(true);
      setShowPreview(false);
    } catch (error) {
      setMessage({
        ok: false,
        text: error instanceof Error ? error.message : t("Could not load the prompt version."),
      });
    } finally {
      setHistoryBusy(false);
    }
  }

  function useVersion() {
    if (!historyVersion) return;
    setSystem(historyVersion.system);
    setHistoryVersion(null);
    setShowDiff(false);
    setMessage({
      ok: true,
      text: t("Version v{version} loaded. Save to create a new version.", {
        version: historyVersion.version,
      }),
    });
  }

  const tokenEstimate = Math.max(1, Math.ceil(system.length / 4));
  const preview = useMemo(() => {
    const samples: Record<string, string> = {
      tools: t("[dynamic tool catalog]"),
      language: t("Write every human-readable value in Turkish."),
    };
    return system.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, name: string) => samples[name] ?? `<${name}>`);
  }, [system, t]);

  async function save() {
    if (!selected) return;
    setBusy("save");
    setMessage(null);
    try {
      const updated = await api.ai.savePrompt(
        selected.id,
        system,
        scope === "project" ? projectId : undefined,
      );
      setPrompts((current) =>
        current.map((prompt) => (prompt.id === updated.id ? updated : prompt)),
      );
      setSystem(updated.system);
      setHistoryVersion(null);
      setShowDiff(false);
      setMessage({ ok: true, text: t("Prompt saved · v{version}", { version: updated.version }) });
    } catch (error) {
      setMessage({
        ok: false,
        text: error instanceof Error ? error.message : t("Could not save the prompt."),
      });
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    if (!selected) return;
    setBusy("reset");
    setMessage(null);
    try {
      const updated = await api.ai.resetPrompt(
        selected.id,
        scope === "project" ? projectId : undefined,
      );
      setPrompts((current) =>
        current.map((prompt) => (prompt.id === updated.id ? updated : prompt)),
      );
      setSystem(updated.system);
      setHistoryVersion(null);
      setShowDiff(false);
      setMessage({ ok: true, text: t("Prompt reset to default.") });
    } catch (error) {
      setMessage({
        ok: false,
        text: error instanceof Error ? error.message : t("Could not reset the prompt."),
      });
    } finally {
      setBusy(null);
    }
  }

  if (!open) return null;

  return (
    <div
      className={embedded ? "settings-embedded-backdrop" : "modal-backdrop"}
      onMouseDown={embedded ? undefined : onClose}
    >
      <div
        className={embedded ? "settings-embedded-panel" : "prompt-modal"}
        onMouseDown={embedded ? undefined : (event) => event.stopPropagation()}
      >
        {embedded ? null : (
          <div className="modal-header">
            <div>
              <div className="modal-eyebrow">{t("AI behavior")}</div>
              <h2>
                <FileText size={16} /> {t("Prompt manager")}
              </h2>
            </div>
            <button className="icon-button" onClick={onClose} aria-label={t("Close")}>
              <X size={16} />
            </button>
          </div>
        )}
        <p className="modal-text">
          {t(
            "Edit the system prompts used by the agent. Project overrides take precedence over global overrides; defaults stay untouched.",
          )}
        </p>

        {busy === "load" ? (
          <div className="prompt-loading">
            <Loader2 size={14} className="spin" /> {t("Loading prompts…")}
          </div>
        ) : (
          <div className="prompt-layout">
            <div className="prompt-list">
              {prompts.map((prompt) => (
                <button
                  key={prompt.id}
                  className={`prompt-list-item ${prompt.id === selected?.id ? "is-active" : ""}`}
                  onClick={() => selectPrompt(prompt)}
                >
                  <span>{t(prompt.title)}</span>
                  <small>
                    v{prompt.version} · {t(prompt.source)}
                  </small>
                </button>
              ))}
            </div>

            {selected ? (
              <div className="prompt-editor">
                <div className="prompt-editor-head">
                  <div>
                    <strong>{t(selected.title)}</strong>
                    <span>{t(selected.description)}</span>
                  </div>
                  <span className="prompt-version">v{selected.version}</span>
                </div>

                <div className="prompt-scope-row">
                  <label>
                    <input
                      type="radio"
                      checked={scope === "project"}
                      onChange={() => changeScope("project")}
                      disabled={!projectId}
                    />
                    {t("This project")}
                  </label>
                  <label>
                    <input
                      type="radio"
                      checked={scope === "global"}
                      onChange={() => changeScope("global")}
                    />
                    {t("All projects")}
                  </label>
                  <span>{t("{tokens} tokens", { tokens: tokenEstimate })}</span>
                </div>

                {scope === "global" ? (
                  <div className="prompt-warning">
                    {t("Global overrides affect every project. Use project scope for local changes.")}
                  </div>
                ) : null}

                <div className="prompt-variables">
                  {selected.variables.map((variable) => (
                    <button
                      key={variable.name}
                      title={variable.description}
                      onClick={() =>
                        setSystem((current) => `${current}${current.endsWith("\n") ? "" : "\n"}{{${variable.name}}}`)
                      }
                    >
                      {`{{${variable.name}}}`}
                    </button>
                  ))}
                  <span>{t("Insert a variable at the end")}</span>
                </div>

                <textarea
                  className="prompt-textarea"
                  value={system}
                  onChange={(event) => setSystem(event.target.value)}
                  spellCheck={false}
                />

                {message ? (
                  <div className={`ai-test-result ${message.ok ? "is-ok" : "is-error"}`}>
                    {message.text}
                  </div>
                ) : null}

                <div className="prompt-actions">
                  <button
                    className="ghost-button"
                    onClick={() => {
                      setShowPreview((value) => !value);
                      setShowDiff(false);
                    }}
                  >
                    {showPreview ? t("Hide preview") : t("Preview")}
                  </button>
                  <button
                    className="ghost-button"
                    onClick={() => {
                      setShowDiff((value) => !value);
                      setShowPreview(false);
                    }}
                  >
                    <FileText size={12} /> {showDiff ? t("Hide diff") : t("Diff")}
                  </button>
                  <button
                    className="ghost-button"
                    onClick={() => {
                      setHistoryOpen((value) => !value);
                      setHistoryVersion(null);
                    }}
                  >
                    <History size={12} /> {t("History")}
                    {history.length > 0 ? ` (${history.length})` : ""}
                  </button>
                  <button className="ghost-button" onClick={reset} disabled={busy !== null}>
                    {busy === "reset" ? <Loader2 size={12} className="spin" /> : <RotateCcw size={12} />}
                    {t("Reset to default")}
                  </button>
                  <span className="modal-spacer" />
                  <button className="primary-button" onClick={save} disabled={busy !== null || !system.trim()}>
                    {busy === "save" ? <Loader2 size={12} className="spin" /> : <Save size={12} />}
                    {t("Save prompt")}
                  </button>
                </div>

                {showDiff ? (
                  <div className="prompt-diff">
                    <div className="prompt-diff-head">
                      <strong>
                        {historyVersion
                          ? t("Default → v{version}", { version: historyVersion.version })
                          : t("Default → current")}
                      </strong>
                      <small>{t("Read-only comparison")}</small>
                    </div>
                    <div className="prompt-diff-body">
                      {diffParts.flatMap((part, partIndex) =>
                        part.value
                          .split("\n")
                          .filter((line, lineIndex, lines) => lineIndex < lines.length - 1 || line.length > 0)
                          .map((line, lineIndex) => (
                            <div
                              key={`${partIndex}-${lineIndex}`}
                              className={`prompt-diff-line ${
                                part.added ? "is-add" : part.removed ? "is-remove" : "is-same"
                              }`}
                            >
                              <span>{part.added ? "+" : part.removed ? "-" : " "}</span>
                              <code>{line || " "}</code>
                            </div>
                          )),
                      )}
                    </div>
                  </div>
                ) : null}

                {historyOpen ? (
                  <div className="prompt-history">
                    <div className="prompt-history-head">
                      <strong>{t("Version history")}</strong>
                      <span>{scope === "project" ? t("This project") : t("All projects")}</span>
                    </div>
                    <div className="prompt-history-current">
                      <span>
                        {t("Current")} v{selected.version}
                      </span>
                      <small>{selected.source === "default" ? t("default") : t(selected.source)}</small>
                    </div>
                    {historyBusy ? (
                      <div className="prompt-loading">
                        <Loader2 size={12} className="spin" /> {t("Loading version…")}
                      </div>
                    ) : history.length === 0 ? (
                      <small className="prompt-history-empty">
                        {t("No saved versions for this scope.")}
                      </small>
                    ) : (
                      <div className="prompt-history-list">
                        {history.map((entry) => (
                          <button
                            key={`${entry.scope}-${entry.version}`}
                            className={
                              historyVersion?.version === entry.version &&
                              historyVersion.scope === entry.scope
                                ? "is-active"
                                : ""
                            }
                            onClick={() => void loadVersion(entry)}
                          >
                            <span>v{entry.version}</span>
                            <small>{new Date(entry.updatedAt).toLocaleString()}</small>
                          </button>
                        ))}
                      </div>
                    )}
                    {historyVersion ? (
                      <div className="prompt-history-actions">
                        <span>
                          {t("Previewing v{version}", { version: historyVersion.version })}
                        </span>
                        <button className="ghost-button" onClick={useVersion}>
                          {t("Use this version")}
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {showPreview && !showDiff ? <pre className="prompt-preview">{preview}</pre> : null}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
