import { AlertTriangle, FolderTree, Route, CornerDownRight } from "lucide-react";
import type { AnalysisResult } from "../../../shared/types";
import { useI18n } from "../i18n";

const ENTRY_PATTERNS: RegExp[] = [
  /^public\/index\.(php|html)$/i,
  /^index\.(php|ts|tsx|js|jsx)$/i,
  /^app\/bootstrap\.php$/i,
  /^bootstrap\/app\.php$/i,
  /^artisan$/,
  /^manage\.py$/,
  /^(wsgi|asgi)\.py$/,
  /^(app|main|server)\.(py|ts|tsx|js|jsx|mjs|cjs)$/i,
  /^src\/(index|main|server)\.(ts|tsx|js|jsx|mjs|cjs)$/i,
  /^main\.go$/i,
  /^cmd\/.*\/main\.go$/i,
  /^src\/(main|lib)\.rs$/i,
  /^src\/main\/java\/.*\/(Application|Main)\.java$/i,
  /^(Program|Startup)\.cs$/i,
  /^(config\.ru|app\.rb)$/i,
  /^bin\/rails$/i,
  /^Sources\/.*\/main\.swift$/i,
  /^lib\/.*\/application\.ex$/i,
  /^lib\/main\.dart$/i,
];

function entryPointRank(filePath: string): number {
  for (let index = 0; index < ENTRY_PATTERNS.length; index += 1) {
    if (ENTRY_PATTERNS[index].test(filePath)) return index;
  }
  return -1;
}

export function ProjectProfile({ analysis }: { analysis: AnalysisResult }) {
  const { t } = useI18n();
  const entryPoints = analysis.files
    .map((file) => ({ path: file.path, rank: entryPointRank(file.path) }))
    .filter((file) => file.rank >= 0)
    .sort((a, b) => a.rank - b.rank)
    .map((file) => file.path)
    .slice(0, 8);

  const folderCounts = new Map<string, number>();
  for (const file of analysis.files) {
    const top = file.path.includes("/") ? file.path.split("/")[0] : ".";
    folderCounts.set(top, (folderCounts.get(top) ?? 0) + 1);
  }
  const topFolders = [...folderCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  const routes = analysis.nodes.filter((node) => node.kind === "route");
  const databaseObjects = analysis.nodes.filter((node) => node.kind === "database");
  const events = analysis.nodes.filter((node) => node.kind === "event");

  if (analysis.files.length === 0) return null;

  return (
    <div className="project-profile">
      <div className="inspector-section-title">
        <FolderTree size={12} /> {t("Project profile")}
      </div>
      <p className="section-note">
        {t("Inferred from the file tree, symbols, routes, and manifests without using AI.")}
      </p>

      {analysis.tooling ? (
        <>
          <div className="profile-row">
            <span className="profile-label">{t("Ecosystems")}</span>
            <div className="profile-list">
              {analysis.tooling.ecosystems.length > 0 ? (
                analysis.tooling.ecosystems.map((item) => (
                  <span key={item} className="profile-file">{item}</span>
                ))
              ) : (
                <span className="profile-file">{t("none detected")}</span>
              )}
              {analysis.tooling.packageManagers.map((manager) => (
                <span key={manager} className="profile-file"><em>{manager}</em></span>
              ))}
            </div>
          </div>

          <div className="profile-row">
            <span className="profile-label">{t("Tooling")}</span>
            <div className="profile-list">
              <span className="profile-file">
                {analysis.tooling.testFramework ?? t("No test framework detected")}
              </span>
              {analysis.tooling.manifests.map((manifest) => (
                <span key={manifest} className="profile-file"><em>{manifest}</em></span>
              ))}
            </div>
          </div>

          {analysis.tooling.testCommands.length > 0 ? (
            <div className="profile-row">
              <span className="profile-label">{t("Test commands")}</span>
              <div className="profile-list">
                {analysis.tooling.testCommands.map((command) => (
                  <code key={command} className="profile-file">{command}</code>
                ))}
              </div>
            </div>
          ) : null}

          {(analysis.tooling.typecheckCommands ?? []).length > 0 ? (
            <div className="profile-row">
              <span className="profile-label">{t("Typecheck commands")}</span>
              <div className="profile-list">
                {(analysis.tooling.typecheckCommands ?? []).map((command) => (
                  <code key={command} className="profile-file">{command}</code>
                ))}
              </div>
            </div>
          ) : null}

          {analysis.tooling.buildCommands.length > 0 ? (
            <div className="profile-row">
              <span className="profile-label">{t("Build commands")}</span>
              <div className="profile-list">
                {analysis.tooling.buildCommands.map((command) => (
                  <code key={command} className="profile-file">{command}</code>
                ))}
              </div>
            </div>
          ) : null}

          {analysis.tooling.lintCommands.length + analysis.tooling.formatCommands.length > 0 ? (
            <div className="profile-row">
              <span className="profile-label">{t("Lint & format")}</span>
              <div className="profile-list">
                {[...analysis.tooling.lintCommands, ...analysis.tooling.formatCommands].map((command) => (
                  <code key={command} className="profile-file">{command}</code>
                ))}
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {analysis.frameworks && analysis.frameworks.length > 0 ? (
        <div className="profile-row">
          <span className="profile-label">{t("Detected stack")}</span>
          <div className="ai-chips">
            {analysis.frameworks.map((framework) => (
              <code key={framework} className="framework-chip">
                {framework}
              </code>
            ))}
          </div>
        </div>
      ) : null}

      <div className="profile-metrics">
        <span><strong>{analysis.stats.files}</strong> {t("Files")}</span>
        <span><strong>{analysis.stats.symbols}</strong> {t("Symbols")}</span>
        <span><strong>{analysis.stats.functions}</strong> {t("Functions")}</span>
        <span><strong>{routes.length}</strong> {t("Routes")}</span>
        <span><strong>{databaseObjects.length}</strong> {t("Database objects")}</span>
        <span><strong>{events.length}</strong> {t("Events")}</span>
      </div>

      {entryPoints.length > 0 ? (
        <div className="profile-row">
          <span className="profile-label">{t("Likely entry points")}</span>
          <div className="profile-list">
            {entryPoints.map((entry) => (
              <span key={entry} className="profile-file">
                <CornerDownRight size={10} /> {entry}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {topFolders.length > 0 ? (
        <div className="profile-row">
          <span className="profile-label">{t("Largest modules")}</span>
          <div className="profile-folder-list">
            {topFolders.map(([folder, count]) => (
              <span key={folder} className="profile-folder">
                <FolderTree size={10} /> {folder === "." ? t("Root") : folder}
                <em>{count}</em>
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {routes.length > 0 ? (
        <div className="profile-row">
          <span className="profile-label"><Route size={11} /> {t("Sample routes")}</span>
          <div className="profile-list">
            {routes.slice(0, 5).map((route) => (
              <span key={route.id} className="profile-file">
                {route.label}
                {route.metadata?.framework ? <em>{String(route.metadata.framework)}</em> : null}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {analysis.stats.files > 0 && analysis.stats.symbols === 0 ? (
        <div className="profile-warning">
          <AlertTriangle size={11} />
          {t("The scanner found files but no symbols. The language may not be supported yet.")}
        </div>
      ) : null}
    </div>
  );
}
