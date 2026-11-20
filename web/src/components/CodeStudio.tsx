import { useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { php } from "@codemirror/lang-php";
import { oneDark } from "@codemirror/theme-one-dark";
import { diffLines } from "diff";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Code2,
  FileCode2,
  Folder,
  FolderOpen,
  Loader2,
  Play,
  RefreshCw,
  Save,
  Sparkles,
  Terminal,
  WandSparkles,
  X,
} from "lucide-react";
import type { AnalysisResult, RunCommandResult } from "../../../shared/types";
import type { AiCodeEditResult, AiSettingsPublic } from "../../../shared/ai";
import { api } from "../api";
import { activeProvider } from "../lib/ai";
import { buildTree, collectFolderPaths, type TreeNode } from "../lib/tree";
import { useI18n } from "../i18n";

interface CodeStudioProps {
  analysis: AnalysisResult;
  aiSettings: AiSettingsPublic | null;
  onOpenSettings: () => void;
  onRescan: () => void;
}

function languageExtension(filePath: string) {
  const extension = filePath.split(".").pop()?.toLowerCase() ?? "";
  if (["ts", "tsx"].includes(extension)) {
    return [javascript({ typescript: true, jsx: extension === "tsx" })];
  }
  if (["js", "jsx", "mjs", "cjs"].includes(extension)) {
    return [javascript({ jsx: extension === "jsx" })];
  }
  if (extension === "py") return [python()];
  if (extension === "php") return [php()];
  return [];
}

function quickCommandsFor(analysis: AnalysisResult): string[] {
  const commands: string[] = [];
  if (analysis.frameworks?.some((framework) => ["Jest", "Vitest"].includes(framework))) {
    commands.push("npm test", "npm run build");
  }
  if (analysis.frameworks?.includes("Laravel")) {
    commands.push("php artisan test");
  }
  if (analysis.languages.python > 0) {
    commands.push("pytest");
  }
  if (analysis.languages.php > 0 && !analysis.frameworks?.includes("Laravel")) {
    commands.push("vendor/bin/phpunit");
  }
  if (commands.length === 0) commands.push("npm test");
  return [...new Set(commands)].slice(0, 4);
}

function StudioTree({
  nodes,
  depth,
  expanded,
  onToggle,
  onOpen,
  selected,
}: {
  nodes: TreeNode[];
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  selected: string | null;
}) {
  return (
    <>
      {nodes.map((node) => {
        const isFolder = node.type === "folder";
        const isExpanded = expanded.has(node.path);
        return (
          <div key={node.path}>
            <button
              className={`studio-tree-row ${isFolder ? "is-folder" : "is-file"} ${selected === node.path ? "is-selected" : ""}`}
              style={{ paddingLeft: `${8 + depth * 12}px` }}
              onClick={() => (isFolder ? onToggle(node.path) : onOpen(node.path))}
              title={node.path}
            >
              {isFolder ? (
                isExpanded ? (
                  <ChevronDown size={12} />
                ) : (
                  <ChevronRight size={12} />
                )
              ) : (
                <span className="studio-tree-spacer" />
              )}
              {isFolder ? (
                isExpanded ? (
                  <FolderOpen size={13} />
                ) : (
                  <Folder size={13} />
                )
              ) : (
                <FileCode2 size={13} />
              )}
              <span>{node.name}</span>
            </button>
            {isFolder && isExpanded ? (
              <StudioTree
                nodes={node.children}
                depth={depth + 1}
                expanded={expanded}
                onToggle={onToggle}
                onOpen={onOpen}
                selected={selected}
              />
            ) : null}
          </div>
        );
      })}
    </>
  );
}

export function CodeStudio({ analysis, aiSettings, onOpenSettings, onRescan }: CodeStudioProps) {
  const { t, locale } = useI18n();
  const active = activeProvider(aiSettings);
  const tree = useMemo(() => buildTree(analysis.files), [analysis.files]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [contents, setContents] = useState<Record<string, string>>({});
  const [savedContents, setSavedContents] = useState<Record<string, string>>({});
  const [fileLoading, setFileLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [analysisStale, setAnalysisStale] = useState(false);
  const [command, setCommand] = useState("");
  const [commandResult, setCommandResult] = useState<RunCommandResult | null>(null);
  const [commandBusy, setCommandBusy] = useState(false);
  const [aiInstruction, setAiInstruction] = useState("");
  const [aiResult, setAiResult] = useState<AiCodeEditResult | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [bottomTab, setBottomTab] = useState<"terminal" | "ai">("terminal");
  const requestRef = useRef(0);

  const quickCommands = useMemo(() => quickCommandsFor(analysis), [analysis]);
  const activeContent = activeFile ? contents[activeFile] ?? "" : "";
  const activeSaved = activeFile ? savedContents[activeFile] ?? "" : "";
  const dirty = Boolean(activeFile && activeContent !== activeSaved);
  const activeLanguage = activeFile?.split(".").pop()?.toUpperCase() ?? "";

  useEffect(() => {
    setExpanded(new Set(collectFolderPaths(tree, 50)));
    setOpenTabs([]);
    setActiveFile(null);
    setContents({});
    setSavedContents({});
    setAiResult(null);
    setAnalysisStale(false);
    setError(null);
    setMessage(null);
    const initial =
      analysis.files.find((file) =>
        /(^|\/)(public\/index|index|main|app|server|bootstrap|artisan|manage)\.(php|py|ts|tsx|js|jsx)$/i.test(
          file.path,
        ),
      ) ?? analysis.files[0];
    if (initial) void openFile(initial.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis.id, analysis.createdAt]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveFile();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFile, contents]);

  async function openFile(filePath: string) {
    setActiveFile(filePath);
    setOpenTabs((current) => (current.includes(filePath) ? current : [...current, filePath]));
    if (contents[filePath] !== undefined) return;
    const token = ++requestRef.current;
    setFileLoading(true);
    setError(null);
    try {
      const result = await api.fileContent(analysis.id, filePath);
      if (token !== requestRef.current) return;
      setContents((current) => ({ ...current, [filePath]: result.content }));
      setSavedContents((current) => ({ ...current, [filePath]: result.content }));
    } catch (requestError) {
      if (token === requestRef.current) {
        setError(requestError instanceof Error ? requestError.message : t("Could not open the file"));
      }
    } finally {
      if (token === requestRef.current) setFileLoading(false);
    }
  }

  function closeTab(filePath: string) {
    setOpenTabs((current) => {
      const next = current.filter((path) => path !== filePath);
      if (activeFile === filePath) {
        const fallback = next[next.length - 1] ?? null;
        setActiveFile(fallback);
      }
      return next;
    });
  }

  async function saveFile() {
    if (!activeFile || saving) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const content = contents[activeFile] ?? "";
      const written = await api.writeFile(analysis.id, activeFile, content);
      setSavedContents((current) => ({ ...current, [activeFile]: content }));
      setAnalysisStale(true);
      setMessage(
        written.backupPath
          ? t("Saved. A local backup was created before writing.")
          : t("Saved."),
      );
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("Could not save the file"));
    } finally {
      setSaving(false);
    }
  }

  async function runCommand(nextCommand = command) {
    const trimmed = nextCommand.trim();
    if (!trimmed || commandBusy) return;
    setCommand(trimmed);
    setBottomTab("terminal");
    setCommandBusy(true);
    setError(null);
    try {
      const result = await api.runCommand(analysis.id, trimmed);
      setCommandResult(result);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("Command failed to start"));
    } finally {
      setCommandBusy(false);
    }
  }

  async function generateEdit() {
    if (!active || !activeFile || !aiInstruction.trim() || aiBusy) return;
    if (dirty) {
      setError(t("Save the file before generating an AI edit."));
      return;
    }
    setAiBusy(true);
    setError(null);
    setAiResult(null);
    try {
      const result = await api.ai.edit(
        analysis.id,
        activeFile,
        aiInstruction.trim(),
        active.provider,
        active.model,
        locale,
      );
      setAiResult(result);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("AI edit failed"));
    } finally {
      setAiBusy(false);
    }
  }

  async function applyEdit() {
    if (!aiResult || saving) return;
    setSaving(true);
    setError(null);
    try {
      await api.writeFile(analysis.id, aiResult.filePath, aiResult.newContent);
      setContents((current) => ({ ...current, [aiResult.filePath]: aiResult.newContent }));
      setSavedContents((current) => ({ ...current, [aiResult.filePath]: aiResult.newContent }));
      setActiveFile(aiResult.filePath);
      setOpenTabs((current) =>
        current.includes(aiResult.filePath) ? current : [...current, aiResult.filePath],
      );
      setAnalysisStale(true);
      setMessage(t("AI edit applied and saved."));
      setAiResult(null);
      setAiInstruction("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("Could not apply the edit"));
    } finally {
      setSaving(false);
    }
  }

  const diff = useMemo(
    () => (aiResult ? diffLines(aiResult.originalContent, aiResult.newContent) : []),
    [aiResult],
  );

  return (
    <div className="code-studio">
      <aside className="code-studio-sidebar">
        <div className="code-studio-side-head">
          <div>
            <span className="studio-eyebrow">{t("Code Studio")}</span>
            <strong>{analysis.projectName}</strong>
          </div>
          <span className="studio-write-pill">{t("Write mode")}</span>
        </div>
        <div className="studio-tree-toolbar">
          <button onClick={() => setExpanded(new Set(collectFolderPaths(tree, 50)))}>
            {t("Expand all")}
          </button>
          <button onClick={() => setExpanded(new Set())}>{t("Collapse all")}</button>
        </div>
        <div className="studio-file-tree">
          <StudioTree
            nodes={tree}
            depth={0}
            expanded={expanded}
            onToggle={(path) =>
              setExpanded((current) => {
                const next = new Set(current);
                if (next.has(path)) next.delete(path);
                else next.add(path);
                return next;
              })
            }
            onOpen={(path) => void openFile(path)}
            selected={activeFile}
          />
        </div>
        <div className="studio-side-foot">
          <span>{t("{count} files", { count: analysis.files.length })}</span>
          <span>{analysis.git?.branch ?? t("no Git")}</span>
        </div>
      </aside>

      <section className="code-studio-main">
        <div className="studio-tabbar">
          <div className="studio-tabs">
            {openTabs.map((filePath) => (
              <button
                key={filePath}
                className={`studio-tab ${activeFile === filePath ? "is-active" : ""}`}
                onClick={() => setActiveFile(filePath)}
                title={filePath}
              >
                <span>{filePath.split("/").pop()}</span>
                {contents[filePath] !== savedContents[filePath] ? <i /> : null}
                <X
                  size={10}
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTab(filePath);
                  }}
                />
              </button>
            ))}
          </div>
          <div className="studio-tab-actions">
            {analysisStale ? (
              <button className="studio-stale" onClick={onRescan}>
                <RefreshCw size={11} /> {t("Graph stale — rescan")}
              </button>
            ) : null}
            <button onClick={() => void saveFile()} disabled={!activeFile || saving || !dirty}>
              {saving ? <Loader2 size={12} className="spin" /> : <Save size={12} />}
              {t("Save")}
            </button>
          </div>
        </div>

        {error ? (
          <div className="studio-banner error">
            <AlertTriangle size={12} /> {error}
          </div>
        ) : null}
        {message ? (
          <div className="studio-banner success">
            <CheckCircle2 size={12} /> {message}
          </div>
        ) : null}

        <div className="studio-editor">
          {activeFile ? (
            <>
              <div className="studio-editor-meta">
                <span>{activeFile}</span>
                <span>
                  {activeLanguage || t("text")} · {t("line count", { count: activeContent.split("\n").length })}
                </span>
              </div>
              <div className="studio-editor-scroll">
                <CodeMirror
                  value={activeContent}
                  height="100%"
                  theme={oneDark}
                  extensions={languageExtension(activeFile)}
                  onChange={(value) =>
                    setContents((current) => ({ ...current, [activeFile]: value }))
                  }
                  basicSetup={{
                    lineNumbers: true,
                    foldGutter: true,
                    highlightActiveLine: true,
                    bracketMatching: true,
                    autocompletion: true,
                  }}
                />
              </div>
            </>
          ) : (
            <div className="studio-editor-empty">
              <Code2 size={24} />
              <span>{t("Select a file from the project tree to start editing.")}</span>
            </div>
          )}
          {fileLoading ? (
            <div className="studio-file-loading">
              <Loader2 size={14} className="spin" /> {t("Opening file…")}
            </div>
          ) : null}
        </div>

        <div className="studio-bottom">
          <div className="studio-bottom-tabs">
            <button
              className={bottomTab === "terminal" ? "is-active" : ""}
              onClick={() => setBottomTab("terminal")}
            >
              <Terminal size={12} /> {t("Terminal")}
            </button>
            <button
              className={bottomTab === "ai" ? "is-active" : ""}
              onClick={() => setBottomTab("ai")}
            >
              <WandSparkles size={12} /> {t("AI edit")}
            </button>
            <span className="studio-bottom-spacer" />
            {commandResult ? (
              <span className={`studio-exit ${commandResult.exitCode === 0 ? "ok" : "bad"}`}>
                {t("exit")} {commandResult.exitCode ?? "—"} · {commandResult.durationMs} ms
              </span>
            ) : null}
          </div>

          {bottomTab === "terminal" ? (
            <div className="studio-terminal">
              <div className="studio-command-row">
                <span>$</span>
                <input
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void runCommand();
                  }}
                  placeholder={t("Type a command and press Enter…")}
                  spellCheck={false}
                />
                <button onClick={() => void runCommand()} disabled={commandBusy || !command.trim()}>
                  {commandBusy ? <Loader2 size={12} className="spin" /> : <Play size={12} />}
                  {t("Run")}
                </button>
              </div>
              <div className="studio-quick-commands">
                {quickCommands.map((quick) => (
                  <button key={quick} onClick={() => void runCommand(quick)} disabled={commandBusy}>
                    {quick}
                  </button>
                ))}
                <span>{t("Commands run locally in the project root.")}</span>
              </div>
              <pre className="studio-terminal-output">
                {commandResult
                  ? `${commandResult.stdout}${commandResult.stderr ? `\n${commandResult.stderr}` : ""}`
                  : t("No command output yet.")}
              </pre>
            </div>
          ) : (
            <div className="studio-ai-panel">
              <div className="studio-ai-head">
                <div>
                  <strong>{t("Ask AI to edit the active file")}</strong>
                  <span>
                    {active
                      ? `${active.provider} · ${active.model}`
                      : t("Configure an AI provider to enable code edits.")}
                  </span>
                </div>
                {!active ? (
                  <button className="action-button" onClick={onOpenSettings}>
                    <Sparkles size={12} /> {t("Configure AI")}
                  </button>
                ) : null}
              </div>
              <textarea
                value={aiInstruction}
                onChange={(event) => setAiInstruction(event.target.value)}
                placeholder={t("Example: add input validation and return a clear error message.")}
                rows={3}
              />
              <div className="studio-ai-actions">
                <button
                  className="primary-button"
                  onClick={() => void generateEdit()}
                  disabled={!active || !activeFile || !aiInstruction.trim() || aiBusy}
                >
                  {aiBusy ? <Loader2 size={12} className="spin" /> : <WandSparkles size={12} />}
                  {t("Generate edit")}
                </button>
                {aiResult ? (
                  <>
                    <button className="action-button primary" onClick={() => void applyEdit()} disabled={saving}>
                      <Save size={12} /> {t("Apply & save")}
                    </button>
                    <button className="action-button" onClick={() => setAiResult(null)}>
                      {t("Discard")}
                    </button>
                  </>
                ) : null}
              </div>
              {aiResult ? (
                <div className="studio-ai-result">
                  <div className="studio-ai-explanation">
                    <strong>{t("AI explanation")}</strong>
                    <span>{aiResult.explanation}</span>
                  </div>
                  <div className="studio-diff">
                    {diff.map((part, partIndex) => (
                      <div key={partIndex} className={part.added ? "is-add" : part.removed ? "is-remove" : "is-context"}>
                        {part.value
                          .split("\n")
                          .filter((line, lineIndex, lines) => lineIndex < lines.length - 1 || line.length > 0)
                          .map((line, lineIndex) => (
                            <div key={lineIndex} className="studio-diff-line">
                              <span>{part.added ? "+" : part.removed ? "−" : " "}</span>
                              {line}
                            </div>
                          ))}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="studio-ai-hint">
                  <Sparkles size={14} />
                  <span>
                    {t(
                      "The model returns a complete replacement for the selected file. You review the diff before anything is written.",
                    )}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      <aside className="code-studio-right">
        <div className="studio-right-head">
          <span className="studio-eyebrow">{t("Project")}</span>
          <strong>{analysis.projectName}</strong>
          <span>{analysis.rootPath}</span>
        </div>
        <div className="studio-project-stats">
          <span>
            <strong>{analysis.stats.files}</strong> {t("files")}
          </span>
          <span>
            <strong>{analysis.stats.symbols}</strong> {t("symbols")}
          </span>
          <span>
            <strong>{analysis.stats.functions}</strong> {t("functions")}
          </span>
        </div>
        <div className="studio-warning">
          <AlertTriangle size={13} />
          <span>
            {t(
              "Code Studio writes to disk. Every save creates a local backup under ~/.codebase-intelligence-explorer/editor-backups.",
            )}
          </span>
        </div>
        <button className="studio-rescan" onClick={onRescan}>
          <RefreshCw size={12} /> {t("Rescan project analysis")}
        </button>
        <div className="studio-shortcuts">
          <strong>{t("Shortcuts")}</strong>
          <span><kbd>⌘</kbd><kbd>S</kbd> {t("Save file")}</span>
          <span>{t("Run commands from the terminal tab.")}</span>
        </div>
      </aside>
    </div>
  );
}
