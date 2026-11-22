import { useEffect, useState } from "react";
import { ListChecks, Loader2, Play, RefreshCw, Wrench } from "lucide-react";
import type { ProjectToolList } from "../../../shared/projectTools";
import { api } from "../api";
import { useI18n } from "../i18n";

export function ToolsPanel({ projectId }: { projectId?: string }) {
  const { t } = useI18n();
  const [data, setData] = useState<ProjectToolList | null>(null);
  const [loading, setLoading] = useState(false);
  const [runBusy, setRunBusy] = useState<string | null>(null);
  const [output, setOutput] = useState<{ name: string; text: string; ok: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!projectId) {
      setData(null);
      return;
    }
    setLoading(true);
    try {
      setData(await api.projectTools(projectId));
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("Could not load project tools."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [projectId]);

  async function run(name: string) {
    if (!projectId || runBusy) return;
    setRunBusy(name);
    setOutput(null);
    setError(null);
    try {
      const result = await api.runProjectTool(projectId, name);
      setOutput({
        name,
        ok: result.result.exitCode === 0,
        text: [result.result.stdout, result.result.stderr].filter(Boolean).join("\n").slice(-20_000) || t("No output."),
      });
      await load();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("Could not run this tool."));
    } finally {
      setRunBusy(null);
    }
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
        <button className="ghost-button" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={11} className={loading ? "spin" : ""} /> {t("Refresh")}
        </button>
      </div>

      {!projectId ? (
        <div className="tools-empty">{t("Open a project to manage its tools.")}</div>
      ) : null}
      {error ? <div className="form-error">{error}</div> : null}

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
                <code>{tool.command}</code>
                <small>
                  {tool.tags.join(" · ")}
                  {tool.lastRunAt ? ` · ${t("Last run")}: ${new Date(tool.lastRunAt).toLocaleString()}` : ""}
                  {` · ${tool.successCount} ✓ / ${tool.failureCount} ✕`}
                </small>
              </div>
              <button
                className="tool-run"
                onClick={() => void run(tool.name)}
                disabled={runBusy !== null}
                title={tool.command}
              >
                {runBusy === tool.name ? <Loader2 size={11} className="spin" /> : <Play size={11} />}
                {t("Run")}
              </button>
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

      <p className="tools-footnote">
        {t("Scripts are stored in")} <code>.cie/agent/tools</code>{" "}
        {t("and registered in .cie/agent/tools.json.")}
      </p>
    </div>
  );
}
