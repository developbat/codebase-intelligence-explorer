import { useState } from "react";
import { Download, Loader2, RefreshCw, Wrench } from "lucide-react";
import type { ToolchainReport } from "../../../shared/toolchains";
import { api } from "../api";
import { useI18n } from "../i18n";
import { useCachedResource } from "../lib/resourceCache";

export function ToolchainsPanel({ projectId }: { projectId?: string }) {
  const { t } = useI18n();
  const {
    data: report,
    loading: busy,
    error,
    updatedAt,
    refresh,
  } = useCachedResource<ToolchainReport>(
    `toolchains:${projectId ?? "global"}`,
    (force) => api.toolchains(force, projectId),
    { maxAgeMs: 60_000, errorMessage: t("Could not check toolchains.") },
  );
  const [installing, setInstalling] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function install(id: string) {
    const tool = report?.tools.find((item) => item.id === id);
    setInstalling(id);
    setMessage(`${t("Installing")} ${tool?.name ?? id}…`);
    try {
      const result = await api.installToolchain(id, projectId);
      const status = result.skipped
        ? t("Skipped")
        : result.ok
          ? t("Installed successfully")
          : t("Failed");
      setMessage(
        `${status}: ${tool?.name ?? id}${result.command ? `\n$ ${result.command}` : ""}\n\n${result.output}`.trim(),
      );
      await refresh(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("Install failed."));
    } finally {
      setInstalling(null);
    }
  }

  async function installRecommendedTools() {
    if (
      !window.confirm(
        t(
          "Install the missing recommended tools? This may install system runtimes such as Node.js or Git and can take a few minutes.",
        ),
      )
    ) {
      return;
    }
    setInstalling("recommended");
    setMessage(null);
    try {
      const result = await api.installRecommendedTools(projectId);
      setMessage(
        result.results.length > 0
          ? result.results
              .map(
                (item) =>
                  `${item.id}: ${item.skipped ? t("skipped") : item.ok ? t("ok") : t("failed")}\n${item.output.slice(-1_200)}`,
              )
              .join("\n\n")
          : t("No recommended installs were needed."),
      );
      await refresh(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("Install failed."));
    } finally {
      setInstalling(null);
    }
  }

  return (
    <section className="settings-section">
      <div className="toolchains-head">
        <div>
          <h3>
            <Wrench size={13} /> {t("Development environment")}
          </h3>
          <p>{t("Detected runtimes, package managers and language servers. Missing recommended tools can be installed here.")}</p>
        </div>
        <button className="ghost-button" onClick={() => void refresh(true)} disabled={busy || installing !== null}>
          {busy ? <Loader2 size={11} className="spin" /> : <RefreshCw size={11} />}
          {t("Refresh")}
        </button>
      </div>
      {error ? <div className="form-error">{error}</div> : null}
      {updatedAt ? (
        <small className="toolchains-updated">
          {t("Last checked")}: {new Date(updatedAt).toLocaleTimeString()}
        </small>
      ) : null}
      {report ? (
        <>
          <div className="toolchains-summary">
            <span>
              <strong>{t("Project languages")}:</strong>{" "}
              {report.languages.length > 0 ? report.languages.join(", ") : t("none detected")}
            </span>
            <span className={report.recommendedMissing.length > 0 ? "is-warning" : "is-ok"}>
              <strong>{t("Recommended missing")}:</strong> {report.recommendedMissing.length}
            </span>
            {report.recommendedMissing.length > 0 ? (
              <button
                className="ghost-button"
                onClick={() => void installRecommendedTools()}
                disabled={installing !== null}
              >
                {installing === "recommended" ? (
                  <Loader2 size={9} className="spin" />
                ) : (
                  <Download size={9} />
                )}
                {t("Install recommended")}
              </button>
            ) : null}
          </div>
          {report.runtime ? (
            <small className="toolchains-runtime">
              {t("Runtime")}:{" "}
              {report.tools.find((tool) => tool.id === "node")?.version ?? "—"} · npm{" "}
              {report.tools.find((tool) => tool.id === "npm")?.version ?? "—"}
              {report.runtime.bundled ? ` · ${t("bundled")}` : ""} · {t("Tools")}:{" "}
              <code>{report.runtime.managedToolsDir}</code>
            </small>
          ) : null}
          <div className="toolchains-list">
            {[...report.tools]
              .sort((a, b) => {
                const rank = (tool: typeof a) =>
                  tool.recommended && !tool.installed
                    ? 0
                    : tool.required && !tool.installed
                      ? 1
                      : tool.recommended
                        ? 2
                        : tool.installed
                          ? 4
                          : 3;
                return rank(a) - rank(b) || a.name.localeCompare(b.name);
              })
              .map((tool) => {
                const installCommand = tool.installCommands.find(
                  (item) => item.platform === report.platform,
                )?.command;
                const needsProject = tool.local === true && !projectId;
                return (
                  <div key={tool.id} className={tool.installed ? "is-installed" : "is-missing"}>
                    <span>
                      <strong>{tool.name}</strong>
                      <small>
                        {tool.category}
                        {tool.recommended ? ` · ${t("recommended")}` : ""}
                        {tool.required ? ` · ${t("required")}` : ""}
                        {tool.installed ? ` · ${tool.version ?? t("installed")}` : ` · ${t("missing")}`}
                      </small>
                      {tool.note ? <small>{tool.note}</small> : null}
                      {needsProject ? (
                        <small>{t("Open a project to install this tool.")}</small>
                      ) : null}
                    </span>
                    {!tool.installed && installCommand ? (
                      <button
                        className="ghost-button"
                        onClick={() => void install(tool.id)}
                        disabled={installing !== null || needsProject}
                        title={
                          needsProject
                            ? t("Open a project to install this tool locally.")
                            : installCommand
                        }
                      >
                        {installing === tool.id ? <Loader2 size={9} className="spin" /> : <Download size={9} />}
                        {t("Install")}
                      </button>
                    ) : null}
                  </div>
                );
              })}
          </div>
        </>
      ) : (
        <p>{t("Toolchain status could not be read.")}</p>
      )}
      {message ? <pre className="toolchains-output">{message.slice(-5_000)}</pre> : null}
    </section>
  );
}
