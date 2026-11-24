import { useEffect, useState } from "react";
import { ListChecks, Loader2, Play, RefreshCw, Wrench } from "lucide-react";
import type { ProjectTool, ProjectToolList } from "../../../shared/projectTools";
import { api } from "../api";
import { useI18n } from "../i18n";
import { useCachedResource } from "../lib/resourceCache";

export function ToolsPanel({ projectId }: { projectId?: string }) {
  const { t } = useI18n();
  const {
    data,
    loading,
    error,
    updatedAt,
    refresh,
  } = useCachedResource<ProjectToolList>(
    projectId ? `tools:${projectId}` : null,
    () => api.projectTools(projectId!),
    { maxAgeMs: 30_000, errorMessage: t("Could not load project tools.") },
  );
  const [runBusy, setRunBusy] = useState<string | null>(null);
  const [output, setOutput] = useState<{ name: string; text: string; ok: boolean } | null>(null);
  const [tryName, setTryName] = useState<string | null>(null);
  const [tryInput, setTryInput] = useState("{}");
  const [tryError, setTryError] = useState<string | null>(null);
  const [registry, setRegistry] = useState<{
    builtIn: {
      action: string;
      groups: string[];
      description: string;
      whenToUse: string;
      example: string;
      permission?: "write" | "command";
      destructive?: boolean;
      tryable: boolean;
    }[];
    project: ProjectToolList["tools"];
  } | null>(null);
  const [tryBuiltinAction, setTryBuiltinAction] = useState<string | null>(null);
  const [tryBuiltinArgs, setTryBuiltinArgs] = useState("{}");
  const [tryBuiltinError, setTryBuiltinError] = useState<string | null>(null);
  const [tryBuiltinOutput, setTryBuiltinOutput] = useState<{
    action: string;
    ok: boolean;
    text: string;
  } | null>(null);
  const [tryBuiltinBusy, setTryBuiltinBusy] = useState(false);
  const [history, setHistory] = useState<
    { at: string; kind: "builtin" | "project"; name: string; ok: boolean; text: string }[]
  >([]);

  useEffect(() => {
    if (!projectId) {
      setHistory([]);
      return;
    }
    try {
      const raw = localStorage.getItem(`cie:tool-tries:${projectId}`);
      const parsed = raw ? (JSON.parse(raw) as typeof history) : [];
      setHistory(Array.isArray(parsed) ? parsed.slice(0, 20) : []);
    } catch {
      setHistory([]);
    }
  }, [projectId]);

  function recordTry(entry: {
    kind: "builtin" | "project";
    name: string;
    ok: boolean;
    text: string;
  }) {
    setHistory((current) => {
      const next = [
        { ...entry, at: new Date().toISOString(), text: entry.text.slice(0, 2_000) },
        ...current,
      ].slice(0, 20);
      if (projectId) {
        try {
          localStorage.setItem(`cie:tool-tries:${projectId}`, JSON.stringify(next));
        } catch {
          // local history is best-effort
        }
      }
      return next;
    });
  }

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void api
      .toolRegistry(projectId)
      .then((result) => {
        if (!cancelled) setRegistry(result);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectId, updatedAt]);

  function inputTemplate(tool: ProjectTool): string {
    const schema = tool.inputSchema;
    if (!schema) return "{}";
    const payload: Record<string, unknown> = {};
    for (const key of schema.required ?? []) {
      const property = schema.properties?.[key];
      payload[key] =
        property?.type === "number"
          ? 0
          : property?.type === "boolean"
            ? false
            : property?.type === "array"
              ? []
              : property?.type === "object"
                ? {}
                : "";
    }
    return JSON.stringify(payload, null, 2);
  }

  function openTry(tool: ProjectTool) {
    setTryName(tool.name);
    setTryInput(inputTemplate(tool));
    setTryError(null);
    setOutput(null);
  }

  async function run(name: string, input?: Record<string, unknown>) {
    if (!projectId || runBusy) return;
    setRunBusy(name);
    setOutput(null);
    setTryError(null);
    try {
      const result = await api.runProjectTool(projectId, name, input);
      const text =
        [result.result.stdout, result.result.stderr].filter(Boolean).join("\n").slice(-20_000) ||
        t("No output.");
      setOutput({ name, ok: result.result.exitCode === 0, text });
      recordTry({
        kind: "project",
        name,
        ok: result.result.exitCode === 0,
        text,
      });
      await refresh(true);
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : t("Could not run this tool.");
      if (input) setTryError(message);
      else setOutput({ name, ok: false, text: message });
    } finally {
      setRunBusy(null);
    }
  }

  function openBuiltinTry(action: string, example: string) {
    setTryBuiltinAction(action);
    setTryBuiltinError(null);
    setTryBuiltinOutput(null);
    try {
      const parsed = JSON.parse(example) as { args?: Record<string, unknown> };
      setTryBuiltinArgs(JSON.stringify(parsed.args ?? {}, null, 2));
    } catch {
      setTryBuiltinArgs("{}");
    }
  }

  async function runBuiltinTry(tool: {
    action: string;
    permission?: "write" | "command";
    destructive?: boolean;
  }) {
    if (!projectId || tryBuiltinBusy) return;
    let args: Record<string, unknown>;
    try {
      const parsed = JSON.parse(tryBuiltinArgs || "{}") as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(t("JSON input must be an object."));
      }
      args = parsed as Record<string, unknown>;
    } catch (error) {
      setTryBuiltinError(error instanceof Error ? error.message : t("Invalid JSON input."));
      return;
    }
    if (
      (tool.permission || tool.destructive) &&
      !window.confirm(
        t("This tool can write files or run commands. Run it with your approvals for this try?"),
      )
    ) {
      return;
    }
    setTryBuiltinBusy(true);
    setTryBuiltinError(null);
    setTryBuiltinOutput(null);
    try {
      const result = await api.tryBuiltinTool(projectId, tool.action, args, {
        allowWrite: tool.permission === "write",
        allowCommands: tool.permission === "command",
        confirmDestructive: tool.destructive === true,
      });
      setTryBuiltinOutput({
        action: tool.action,
        ok: result.ok,
        text: result.observation,
      });
      recordTry({
        kind: "builtin",
        name: tool.action,
        ok: result.ok,
        text: result.observation,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : t("Could not run this tool.");
      setTryBuiltinError(message);
      recordTry({ kind: "builtin", name: tool.action, ok: false, text: message });
    } finally {
      setTryBuiltinBusy(false);
    }
  }

  function runWithInput(tool: ProjectTool) {
    let parsed: Record<string, unknown>;
    try {
      const value = JSON.parse(tryInput || "{}") as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(t("JSON input must be an object."));
      }
      parsed = value as Record<string, unknown>;
    } catch (error) {
      setTryError(error instanceof Error ? error.message : t("Invalid JSON input."));
      return;
    }
    void run(tool.name, parsed);
  }

  return (
    <div className="tools-panel">
      <div className="tools-head">
        <div>
          <h3>
            <Wrench size={14} /> {t("Project tools")}
          </h3>
          <p>
            {t(
              "The agent can create reusable scripts under .cie/agent/tools. They appear here with a short description, and you can run them with one click or with the agent's run_project_tool.",
            )}
          </p>
        </div>
        <button className="ghost-button" onClick={() => void refresh(true)} disabled={loading}>
          <RefreshCw size={11} className={loading ? "spin" : ""} /> {t("Refresh")}
        </button>
      </div>

      {!projectId ? (
        <div className="tools-empty">{t("Open a project to manage its tools.")}</div>
      ) : null}
      {error ? <div className="form-error">{error}</div> : null}
      {updatedAt ? (
        <small className="toolchains-updated">
          {t("Last checked")}: {new Date(updatedAt).toLocaleTimeString()}
        </small>
      ) : null}

      {projectId && data && data.tools.length === 0 ? (
        <div className="tools-empty">
          <ListChecks size={18} />
          <strong>{t("No tools yet")}</strong>
          <p>
            {t(
              "Ask the agent to create one, for example: “check-links adında bir proje aracı oluştur.” The script is saved under .cie/agent/tools.",
            )}
          </p>
        </div>
      ) : null}

      {data && data.tools.length > 0 ? (
        <div className="tools-list">
          {data.tools.map((tool) => (
            <div key={tool.name} className="tool-card">
              <div className="tool-card-main">
                <strong>
                  <Wrench size={11} /> {tool.name}
                </strong>
                <p>{tool.description}</p>
                {tool.whenToUse ? <p className="tool-when">{tool.whenToUse}</p> : null}
                <code>{tool.command}</code>
                {tool.inputSchema?.required?.length || tool.timeoutMs ? (
                  <small className="tool-manifest">
                    {tool.inputSchema?.required?.length
                      ? `${t("Input")}: ${tool.inputSchema.required.join(", ")}`
                      : ""}
                    {tool.inputSchema?.required?.length && tool.timeoutMs ? " · " : ""}
                    {tool.timeoutMs ? `${t("Timeout")}: ${Math.round(tool.timeoutMs / 1000)}s` : ""}
                  </small>
                ) : null}
                <small>
                  {tool.tags.join(" · ")}
                  {tool.lastRunAt ? ` · ${t("Last run")}: ${new Date(tool.lastRunAt).toLocaleString()}` : ""}
                  {` · ${tool.successCount} ✓ / ${tool.failureCount} ✕`}
                </small>
              </div>
              <button
                className="tool-run"
                onClick={() => openTry(tool)}
                disabled={runBusy !== null}
                title={tool.command}
              >
                <Play size={11} /> {t("Try")}
              </button>
              {tryName === tool.name ? (
                <div className="tool-try">
                  <label>
                    <span>{t("JSON input")}</span>
                    <small>
                      {tool.inputSchema?.required?.length
                        ? `${t("Required")}: ${tool.inputSchema.required.join(", ")}`
                        : t("Optional; leave {} for no input.")}
                    </small>
                    <textarea
                      value={tryInput}
                      onChange={(event) => setTryInput(event.target.value)}
                      rows={5}
                      spellCheck={false}
                    />
                  </label>
                  {tryError ? <div className="tool-try-error">{tryError}</div> : null}
                  <div className="tool-try-actions">
                    {tool.inputSchema?.required?.length ? null : (
                      <button onClick={() => void run(tool.name)} disabled={runBusy !== null}>
                        {runBusy === tool.name ? <Loader2 size={11} className="spin" /> : <Play size={11} />}
                        {t("Run")}
                      </button>
                    )}
                    <button onClick={() => void runWithInput(tool)} disabled={runBusy !== null}>
                      {runBusy === tool.name ? <Loader2 size={11} className="spin" /> : <Play size={11} />}
                      {t("Run with input")}
                    </button>
                    <button onClick={() => setTryName(null)}>{t("Cancel")}</button>
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {output ? (
        <div className={`tool-output ${output.ok ? "is-ok" : "is-error"}`}>
          <div>
            <strong>{output.name}</strong>
            <span>{output.ok ? t("Passed") : t("Failed")}</span>
          </div>
          <pre>{output.text}</pre>
        </div>
      ) : null}

      {registry ? (
        <details className="tools-registry">
          <summary>
            <Wrench size={11} /> {t("Agent tool registry")} · {registry.builtIn.length}{" "}
            {t("built-in tools")}
          </summary>
          <div className="tools-registry-list">
            {registry.builtIn.map((tool) => (
              <div key={tool.action}>
                <code>{tool.action}</code>
                <span>
                  {tool.groups.join(" · ")}
                  {tool.permission ? ` · ${tool.permission}` : ""}
                  {tool.destructive ? ` · ${t("destructive")}` : ""}
                </span>
                <small>{tool.description}</small>
                <em>{tool.whenToUse}</em>
                {tool.tryable ? (
                  <div className="tools-registry-actions">
                    <button
                      onClick={() => openBuiltinTry(tool.action, tool.example)}
                      disabled={tryBuiltinBusy}
                    >
                      <Play size={10} /> {t("Try")}
                    </button>
                  </div>
                ) : null}
                {tryBuiltinAction === tool.action ? (
                  <div className="tools-builtin-try">
                    <label>
                      <span>{t("JSON input")}</span>
                      <small>
                        {tool.permission
                          ? `${t("Permission")}: ${tool.permission}`
                          : t("Read-only tool")}
                        {tool.destructive ? ` · ${t("destructive")}` : ""}
                      </small>
                      <textarea
                        value={tryBuiltinArgs}
                        onChange={(event) => setTryBuiltinArgs(event.target.value)}
                        rows={5}
                        spellCheck={false}
                      />
                    </label>
                    {tryBuiltinError ? <div className="tool-try-error">{tryBuiltinError}</div> : null}
                    <div className="tool-try-actions">
                      <button
                        onClick={() => void runBuiltinTry(tool)}
                        disabled={tryBuiltinBusy}
                      >
                        {tryBuiltinBusy ? <Loader2 size={10} className="spin" /> : <Play size={10} />}
                        {t("Run")}
                      </button>
                      <button onClick={() => setTryBuiltinAction(null)}>{t("Cancel")}</button>
                    </div>
                    {tryBuiltinOutput?.action === tool.action ? (
                      <pre
                        className={`tools-builtin-output ${
                          tryBuiltinOutput.ok ? "is-ok" : "is-error"
                        }`}
                      >
                        {tryBuiltinOutput.text}
                      </pre>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </details>
      ) : null}

      {history.length > 0 ? (
        <details className="tools-history">
          <summary>
            {t("Recent tool tries")} · {history.length}
            <button
              onClick={(event) => {
                event.preventDefault();
                setHistory([]);
                if (projectId) localStorage.removeItem(`cie:tool-tries:${projectId}`);
              }}
            >
              {t("Clear")}
            </button>
          </summary>
          <div className="tools-history-list">
            {history.map((entry) => (
              <div key={`${entry.at}-${entry.kind}-${entry.name}`} className={entry.ok ? "is-ok" : "is-error"}>
                <span>
                  <b>{entry.kind === "builtin" ? t("Built-in") : t("Project")}</b>
                  <code>{entry.name}</code>
                </span>
                <small>
                  {new Date(entry.at).toLocaleString()} · {entry.ok ? t("Passed") : t("Failed")}
                </small>
                <pre>{entry.text.slice(0, 600)}</pre>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      <p className="tools-footnote">
        {t("Scripts are stored in")} <code>.cie/agent/tools</code>{" "}
        {t("and registered in .cie/agent/tools.json.")}
      </p>
    </div>
  );
}
