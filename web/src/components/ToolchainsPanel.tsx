import { useState } from "react";
import { Download, Loader2, RefreshCw, Wrench } from "lucide-react";
import type { ToolchainReport } from "../../../shared/toolchains";
import { api } from "../api";
import { useI18n } from "../i18n";
import { useCachedResource } from "../lib/resourceCache";

export function ToolchainsPanel() {
  const { t } = useI18n();
  const {
    data: report,
    loading: busy,
    error,
    updatedAt,
    refresh,
  } = useCachedResource<ToolchainReport>(
    "toolchains",
    (force) => api.toolchains(force),
    { maxAgeMs: 60_000, errorMessage: t("Could not check toolchains.") },
  );
  const [installing, setInstalling] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function install(id: string) {
    setInstalling(id);
    setMessage(null);
    try {
      const result = await api.installToolchain(id);
      setMessage(result.output || (result.ok ? t("Installed.") : t("Install failed.")));
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
            <Wrench size={13} /> {t("Toolchains")}
          </h3>
          <p>{t("Installed compilers, SDKs and mobile toolchains; missing tools can be installed here.")}</p>
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
        <div className="toolchains-list">
          {report.tools.map((tool) => {
            const installCommand = tool.installCommands.find((item) => item.platform === report.platform)?.command;
            return (
              <div key={tool.id} className={tool.installed ? "is-installed" : "is-missing"}>
                <span>
                  <strong>{tool.name}</strong>
                  <small>{tool.installed ? tool.version ?? t("installed") : t("missing")}</small>
                </span>
                {!tool.installed && installCommand ? (
                  <button
                    className="ghost-button"
                    onClick={() => void install(tool.id)}
                    disabled={installing !== null}
                    title={installCommand}
                  >
                    {installing === tool.id ? <Loader2 size={9} className="spin" /> : <Download size={9} />}
                    {t("Install")}
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <p>{t("Toolchain status could not be read.")}</p>
      )}
      {message ? <pre className="toolchains-output">{message.slice(-5_000)}</pre> : null}
    </section>
  );
}
