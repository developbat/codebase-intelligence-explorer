import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Boxes,
  Braces,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Crosshair,
  Database,
  FileCode2,
  Folder,
  FolderOpen,
  FunctionSquare,
  GitCompareArrows,
  Info,
  Layers,
  ListTree,
  Lock,
  Network,
  Package,
  Radio,
  Route,
  Sigma,
  Workflow,
  X,
} from "lucide-react";
import type { AnalysisResult, ChangeReport, GitStatus, GraphEdge, GraphNode } from "../../../shared/types";
import type { AiSettingsPublic } from "../../../shared/ai";
import {
  CERTAINTY_COLOR,
  CERTAINTY_LABEL,
  EDGE_LABEL,
  KIND_COLOR,
  KIND_LABEL,
  formatBytes,
  formatNumber,
  shortPath,
  truncate,
} from "../lib/constants";
import { SourcePreview } from "./SourcePreview";
import { GitDiffView } from "./GitDiffView";
import { AiSymbolPanel } from "./AiSymbolPanel";
import { AiProjectSummaryPanel } from "./AiProjectSummary";
import { AiUnresolvedInvestigation } from "./AiUnresolvedInvestigation";
import { AiScopePanel } from "./AiScopePanel";
import { useI18n } from "../i18n";

interface InspectorProps {
  analysis: AnalysisResult;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  depth: number;
  changeReport: ChangeReport | null;
  gitStatus: GitStatus | null;
  aiSettings: AiSettingsPublic | null;
  onOpenAiSettings: () => void;
  onDepthChange: (depth: number) => void;
  onSelectNode: (id: string) => void;
  onOpenFile: (filePath: string) => void;
  onOpenFolder: (folderPath: string) => void;
  onFocusNode: (id: string) => void;
  onClose: () => void;
}

function KindIcon({ node, size = 15 }: { node: GraphNode; size?: number }) {
  const color = node.metadata?.unresolved ? "#fb7185" : KIND_COLOR[node.kind];
  const props = { size, style: { color }, strokeWidth: 1.9 };
  switch (node.kind) {
    case "project":
      return <Network {...props} />;
    case "module":
      return <Package {...props} />;
    case "folder":
      return <Folder {...props} />;
    case "file":
      return <FileCode2 {...props} />;
    case "class":
      return <Boxes {...props} />;
    case "interface":
    case "type":
      return <Braces {...props} />;
    case "function":
    case "method":
      return <FunctionSquare {...props} />;
    case "route":
      return <Route {...props} />;
    case "database":
      return <Database {...props} />;
    case "event":
      return <Radio {...props} />;
    default:
      return <Layers {...props} />;
  }
}

function CertaintyBadge({ certainty }: { certainty: GraphEdge["certainty"] }) {
  const { t } = useI18n();
  return (
    <span className="certainty-badge" style={{ color: CERTAINTY_COLOR[certainty], borderColor: `${CERTAINTY_COLOR[certainty]}44` }}>
      <span className="certainty-dot" style={{ background: CERTAINTY_COLOR[certainty] }} />
      {t(CERTAINTY_LABEL[certainty])}
    </span>
  );
}

function EmptyInspector({
  analysis,
  aiSettings,
  onOpenAiSettings,
  onOpenFile,
}: {
  analysis: AnalysisResult;
  aiSettings: AiSettingsPublic | null;
  onOpenAiSettings: () => void;
  onOpenFile: (filePath: string) => void;
}) {
  const { t, localeInfo } = useI18n();
  const languages = Object.entries(analysis.languages).sort((a, b) => b[1] - a[1]);
  const topFunctions = [...analysis.nodes]
    .filter((node) => node.kind === "function" || node.kind === "method")
    .sort(
      (a, b) =>
        (b.metadata?.callerCount ?? 0) +
        (b.metadata?.callCount ?? 0) -
        ((a.metadata?.callerCount ?? 0) + (a.metadata?.callCount ?? 0)),
    )
    .slice(0, 6);
  const unresolved = analysis.nodes.filter((node) => node.metadata?.unresolved).slice(0, 6);

  return (
    <div className="inspector-empty">
      <div className="inspector-eyebrow">{t("Project summary")}</div>
      <h2>{analysis.projectName}</h2>
      <p className="inspector-path" title={analysis.rootPath}>
        {analysis.rootPath}
      </p>

      <div className="stat-grid">
        <div className="stat-card">
          <FileCode2 size={15} />
          <span className="stat-value">{formatNumber(analysis.stats.files, localeInfo.dateLocale)}</span>
          <span className="stat-label">{t("Files")}</span>
        </div>
        <div className="stat-card">
          <Sigma size={15} />
          <span className="stat-value">{formatNumber(analysis.stats.symbols, localeInfo.dateLocale)}</span>
          <span className="stat-label">{t("Symbols")}</span>
        </div>
        <div className="stat-card">
          <Workflow size={15} />
          <span className="stat-value">{formatNumber(analysis.stats.edges, localeInfo.dateLocale)}</span>
          <span className="stat-label">{t("Relationships")}</span>
        </div>
        <div className="stat-card">
          <AlertTriangle size={15} />
          <span className="stat-value">{formatNumber(analysis.stats.unresolvedEdges, localeInfo.dateLocale)}</span>
          <span className="stat-label">{t("Unresolved")}</span>
        </div>
      </div>

      {analysis.frameworks && analysis.frameworks.length > 0 ? (
        <div className="inspector-section">
          <div className="inspector-section-title">{t("Frameworks")}</div>
          <div className="ai-chips">
            {analysis.frameworks.map((framework) => (
              <code key={framework} className="framework-chip">
                {framework}
              </code>
            ))}
          </div>
        </div>
      ) : null}

      <div className="inspector-section">
        <div className="inspector-section-title">{t("Languages")}</div>
        <div className="language-list">
          {languages.map(([language, count]) => {
            const percent = analysis.stats.files > 0 ? Math.round((count / analysis.stats.files) * 100) : 0;
            return (
              <div key={language} className="language-row">
                <span className="language-name">{language}</span>
                <span className="language-bar">
                  <span style={{ width: `${percent}%` }} />
                </span>
                <span className="language-count">
                  {count} · {percent}%
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {topFunctions.length > 0 ? (
        <div className="inspector-section">
          <div className="inspector-section-title">{t("Most connected functions")}</div>
          <div className="compact-list">
            {topFunctions.map((node) => (
              <div key={node.id} className="compact-row">
                <KindIcon node={node} size={13} />
                <span className="compact-name" title={node.metadata?.qualifiedName}>
                  {truncate(node.metadata?.qualifiedName ?? node.label, 34)}
                </span>
                <span className="compact-meta">
                  {node.metadata?.callerCount ?? 0}↙ {node.metadata?.callCount ?? 0}↗
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {unresolved.length > 0 ? (
        <div className="inspector-section">
          <div className="inspector-section-title">
            <AlertTriangle size={12} /> {t("Unresolved relationships")}
          </div>
          <div className="compact-list">
            {unresolved.map((node) => (
              <div key={node.id} className="compact-row unresolved-row">
                <CircleDashed size={13} />
                <span className="compact-name">{node.label}</span>
                <span className="compact-meta">{t("no evidence")}</span>
              </div>
            ))}
          </div>
          <p className="section-note">
            {t(
              "This link could not be resolved statically. It is drawn as a dotted red line and must not be treated as a verified relationship.",
            )}
          </p>
        </div>
      ) : null}

      {analysis.warnings.length > 0 ? (
        <div className="inspector-section warning-section">
          <div className="inspector-section-title">
            <Info size={12} /> {t("Analysis notes")}
          </div>
          {analysis.warnings.map((warning, index) => (
            <p key={index} className="warning-line">
              {warning}
            </p>
          ))}
        </div>
      ) : null}

      <AiProjectSummaryPanel
        analysis={analysis}
        settings={aiSettings}
        onOpenSettings={onOpenAiSettings}
        onOpenFile={onOpenFile}
      />

      <div className="inspector-static-note">
        <CheckCircle2 size={13} />
        {t("This view is generated without AI, using static analysis and source evidence only.")}
      </div>
    </div>
  );
}

export function Inspector({
  analysis,
  selectedNodeId,
  selectedEdgeId,
  depth,
  changeReport,
  gitStatus,
  aiSettings,
  onOpenAiSettings,
  onDepthChange,
  onSelectNode,
  onOpenFile,
  onOpenFolder,
  onFocusNode,
  onClose,
}: InspectorProps) {
  const { t, tn, localeInfo } = useI18n();
  const [activeCallSiteKey, setActiveCallSiteKey] = useState<string | null>(null);
  const nodeById = useMemo(() => new Map(analysis.nodes.map((node) => [node.id, node])), [analysis]);
  const edgeById = useMemo(() => new Map(analysis.edges.map((edge) => [edge.id, edge])), [analysis]);

  const node = selectedNodeId ? nodeById.get(selectedNodeId) : undefined;
  const edge = selectedEdgeId ? edgeById.get(selectedEdgeId) : undefined;

  if (edge) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    return (
      <aside className="inspector">
        <div className="inspector-header">
          <span>{t("Relation")}</span>
          <span className="inspector-header-actions">
            <span className="inspector-header-meta">{t(EDGE_LABEL[edge.kind])}</span>
            <button className="icon-button subtle" onClick={onClose} aria-label={t("Close inspector")}>
              <X size={13} />
            </button>
          </span>
        </div>
        <div className="inspector-body">
          <div className="relationship-hero">
            <div className="relationship-kind">{t(EDGE_LABEL[edge.kind])}</div>
            <CertaintyBadge certainty={edge.certainty} />
          </div>
          <div className="edge-endpoints">
            {source ? (
              <button className="endpoint" onClick={() => onSelectNode(source.id)}>
                <KindIcon node={source} />
                <span className="endpoint-main">
                  <span className="endpoint-name">{truncate(source.metadata?.qualifiedName ?? source.label, 38)}</span>
                  <span className="endpoint-sub">{shortPath(source.filePath, 38)}</span>
                </span>
              </button>
            ) : null}
            <div className="endpoint-arrow">
              {t(EDGE_LABEL[edge.kind])} <ChevronRight size={14} />
            </div>
            {target ? (
              <button className="endpoint" onClick={() => onSelectNode(target.id)}>
                <KindIcon node={target} />
                <span className="endpoint-main">
                  <span className="endpoint-name">{truncate(target.metadata?.qualifiedName ?? target.label, 38)}</span>
                  <span className="endpoint-sub">{shortPath(target.filePath, 38)}</span>
                </span>
              </button>
            ) : null}
          </div>

          <div className="inspector-section">
            <div className="inspector-section-title">{t("Evidence")}</div>
            {edge.evidence && edge.evidence.length > 0 ? (
              edge.evidence.map((item, index) => (
                <div key={index} className="evidence-item">
                  <FileCode2 size={13} />
                  <div>
                    <div className="evidence-file">{item.filePath}</div>
                    <div className="evidence-meta">
                      {item.startLine
                        ? t("line {start}", { start: item.startLine }) +
                          (item.endLine && item.endLine !== item.startLine ? `–${item.endLine}` : "")
                        : t("position unknown")}
                      {item.description ? ` · ${item.description}` : ""}
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <p className="section-note">{t("No source evidence was recorded for this relationship.")}</p>
            )}
          </div>

          <div className={`certainty-explainer ${edge.certainty}`}>
            {edge.certainty === "confirmed"
              ? t("This relationship is confirmed by TypeScript symbol resolution or explicit source/config evidence.")
              : edge.certainty === "inferred"
                ? t("This relationship was derived from a heuristic; it is not definitive static evidence.")
                : t("The target symbol could not be resolved reliably. The relationship is marked as a possibility.")}
          </div>
        </div>
      </aside>
    );
  }

  if (!node) {
    return (
      <aside className="inspector">
        <div className="inspector-header">
          <span>{t("Inspector")}</span>
          <span className="inspector-header-actions">
            <span className="inspector-header-meta">
              <Lock size={11} /> {t("read-only")}
            </span>
            <button className="icon-button subtle" onClick={onClose} aria-label={t("Close inspector")}>
              <X size={13} />
            </button>
          </span>
        </div>
        <div className="inspector-body">
          <EmptyInspector
            analysis={analysis}
            aiSettings={aiSettings}
            onOpenAiSettings={onOpenAiSettings}
            onOpenFile={onOpenFile}
          />
        </div>
      </aside>
    );
  }

  const incoming = analysis.edges.filter((item) => item.target === node.id && item.kind !== "CONTAINS");
  const outgoing = analysis.edges.filter((item) => item.source === node.id && item.kind !== "CONTAINS");
  const methods = analysis.symbols.filter((symbol) => symbol.parentSymbolId === node.id);
  const fileRecord = node.filePath ? analysis.files.find((file) => file.path === node.filePath) : undefined;
  const fileSymbols = node.filePath
    ? analysis.symbols.filter((symbol) => symbol.filePath === node.filePath).slice(0, 40)
    : [];
  const childFolders = analysis.nodes.filter((item) => item.kind === "folder" && item.parentId === node.id);
  const childFiles = analysis.nodes.filter((item) => item.kind === "file" && item.parentId === node.id);
  const changedFile = [...(changeReport?.files ?? []), ...(gitStatus?.files ?? [])].find(
    (file) => file.path === node.filePath,
  );
  const structuralChange = changeReport?.structural.find((change) => change.path === node.filePath);
  const callable = node.kind === "function" || node.kind === "method" || node.kind === "class";

  const callSites: {
    key: string;
    filePath: string;
    startLine?: number;
    endLine?: number;
    description?: string;
    edgeKind: GraphEdge["kind"];
    sourceId: string;
    sourceLabel: string;
  }[] = [];
  if (node.metadata?.unresolved) {
    for (const edge of analysis.edges) {
      if (edge.target !== node.id || !edge.evidence) continue;
      const source = nodeById.get(edge.source);
      for (const evidence of edge.evidence) {
        const key = `${edge.source}:${evidence.filePath}:${evidence.startLine ?? 1}`;
        if (callSites.some((site) => site.key === key)) continue;
        callSites.push({
          key,
          filePath: evidence.filePath,
          startLine: evidence.startLine,
          endLine: evidence.endLine,
          description: evidence.description,
          edgeKind: edge.kind,
          sourceId: edge.source,
          sourceLabel: source?.metadata?.qualifiedName ?? source?.label ?? edge.source,
        });
      }
    }
  }
  const shownCallSite = callSites.find((site) => site.key === activeCallSiteKey) ?? callSites[0];
  const canFocus = callable && !node.metadata?.unresolved;

  const relationshipRow = (item: GraphEdge, direction: "in" | "out") => {
    const otherId = direction === "in" ? item.source : item.target;
    const other = nodeById.get(otherId);
    if (!other) return null;
    return (
      <button key={item.id} className="relationship-row" onClick={() => onSelectNode(other.id)}>
        {direction === "in" ? (
          <ArrowDownLeft size={13} className="relationship-arrow incoming" />
        ) : (
          <ArrowUpRight size={13} className="relationship-arrow outgoing" />
        )}
        <span className="relationship-main">
          <span className="relationship-name">{truncate(other.metadata?.qualifiedName ?? other.label, 34)}</span>
          <span className="relationship-sub">
            {t(EDGE_LABEL[item.kind])} · {t(KIND_LABEL[other.kind])}
            {other.filePath ? ` · ${truncate(other.filePath, 28)}` : ""}
          </span>
        </span>
        <span className="certainty-dot" style={{ background: CERTAINTY_COLOR[item.certainty] }} />
      </button>
    );
  };

  return (
    <aside className="inspector">
      <div className="inspector-header">
        <span>{t("Inspector")}</span>
        <span className="inspector-header-actions">
          <span className="inspector-header-meta">
            <Lock size={11} /> {t("read-only")}
          </span>
          <button className="icon-button subtle" onClick={onClose} aria-label={t("Close inspector")}>
            <X size={13} />
          </button>
        </span>
      </div>
      <div className="inspector-body">
        <div className="entity-hero">
          <div className="entity-hero-icon" style={{ borderColor: `${KIND_COLOR[node.kind]}55`, color: KIND_COLOR[node.kind] }}>
            <KindIcon node={node} size={19} />
          </div>
          <div className="entity-hero-text">
            <div className="entity-kind" style={{ color: KIND_COLOR[node.kind] }}>
              {node.metadata?.unresolved ? t("Unresolved symbol") : t(KIND_LABEL[node.kind])}
              {node.metadata?.exported ? " · export" : ""}
              {node.metadata?.async ? " · async" : ""}
            </div>
            <h2>{node.metadata?.qualifiedName ?? node.label}</h2>
            {node.filePath ? (
              <div className="entity-location" title={node.filePath}>
                {node.filePath}
                {node.startLine ? `:${node.startLine}` : ""}
              </div>
            ) : node.kind === "project" ? (
              <div className="entity-location">{analysis.rootPath}</div>
            ) : null}
          </div>
        </div>

        <div className="action-row">
          {canFocus ? (
            <button className="action-button primary" onClick={() => onFocusNode(node.id)}>
              <Crosshair size={13} /> {t("Focus")}
            </button>
          ) : null}
          {node.filePath && node.kind !== "folder" && node.kind !== "module" && node.kind !== "project" ? (
            <button className="action-button" onClick={() => onOpenFile(node.filePath!)}>
              <FileCode2 size={13} /> {t("File")}
            </button>
          ) : null}
          {node.kind === "folder" && node.filePath !== undefined ? (
            <button className="action-button" onClick={() => onOpenFolder(node.filePath ?? "")}>
              <FolderOpen size={13} /> {t("Folder")}
            </button>
          ) : null}
          {node.kind === "file" && node.filePath ? (
            <button
              className="action-button"
              onClick={() => onOpenFolder(node.filePath!.includes("/") ? node.filePath!.slice(0, node.filePath!.lastIndexOf("/")) : "")}
            >
              <FolderOpen size={13} /> {t("Folder")}
            </button>
          ) : null}
        </div>

        {node.metadata?.unresolved ? (
          <>
            <div className="unresolved-callout">
              <AlertTriangle size={14} />
              <span>
                {t(
                  "This node is a call target the analyzer could not resolve statically. The call sites below are the exact source locations that produced it. Inspect them to see whether it is a real function, a dynamic dispatch, an external API, or a string-based registration.",
                )}
              </span>
            </div>
            <div className="inspector-section call-site-section">
              <div className="inspector-section-title">
                <FileCode2 size={12} /> {t("Call sites")}
                <span className="section-count">{callSites.length}</span>
              </div>
              {callSites.length === 0 ? (
                <p className="section-note">{t("No call-site evidence was recorded for this unresolved target.")}</p>
              ) : (
                <>
                  <p className="section-note">
                    {t(
                      "Select a call site to inspect the surrounding source. This is where a human decides what the unresolved target actually is.",
                    )}
                  </p>
                  <div className="call-site-list">
                    {callSites.slice(0, 12).map((site) => (
                      <button
                        key={site.key}
                        className={`call-site-row ${shownCallSite?.key === site.key ? "is-active" : ""}`}
                        onClick={() => setActiveCallSiteKey(site.key)}
                      >
                        <FileCode2 size={11} />
                        <span className="call-site-file">
                          {site.filePath}
                          {site.startLine ? `:${site.startLine}` : ""}
                        </span>
                        <span className="call-site-caller">
                          {site.sourceLabel} · {t(EDGE_LABEL[site.edgeKind])}
                        </span>
                      </button>
                    ))}
                  </div>
                  {shownCallSite ? (
                    <div className="call-site-preview">
                      <div className="call-site-preview-head">
                        <span>
                          {shownCallSite.filePath}
                          {shownCallSite.startLine ? `:${shownCallSite.startLine}` : ""}
                        </span>
                        <button className="inline-action" onClick={() => onSelectNode(shownCallSite.sourceId)}>
                          {t("Open caller")}
                        </button>
                      </div>
                      <SourcePreview
                        analysisId={analysis.id}
                        filePath={shownCallSite.filePath}
                        startLine={shownCallSite.startLine ?? 1}
                        endLine={shownCallSite.endLine ?? shownCallSite.startLine ?? 1}
                      />
                    </div>
                  ) : null}
                  <AiUnresolvedInvestigation
                    analysis={analysis}
                    nodeId={node.id}
                    settings={aiSettings}
                    onOpenSettings={onOpenAiSettings}
                    onOpenFile={onOpenFile}
                  />
                </>
              )}
            </div>
          </>
        ) : null}

        {node.startLine ? (
          <div className="metric-strip">
            <div className="metric">
              <span className="metric-value">{incoming.filter((item) => item.kind === "CALLS").length}</span>
              <span className="metric-label">{t("callers")}</span>
            </div>
            <div className="metric">
              <span className="metric-value">{outgoing.filter((item) => item.kind === "CALLS").length}</span>
              <span className="metric-label">{t("callees")}</span>
            </div>
            <div className="metric">
              <span className="metric-value">
                {node.endLine && node.startLine ? node.endLine - node.startLine + 1 : "—"}
              </span>
              <span className="metric-label">{t("lines")}</span>
            </div>
          </div>
        ) : null}

        {node.metadata?.signature ? (
          <div className="signature-block">
            <div className="signature-label">{t("Signature")}</div>
            <code>{node.metadata.signature}</code>
          </div>
        ) : null}

        {node.metadata?.parameters && node.metadata.parameters.length > 0 ? (
          <div className="param-row">
            <span className="param-label">{t("Parameters")}</span>
            {node.metadata.parameters.map((parameter, index) => (
              <code key={index} className="param-chip">
                {parameter}
              </code>
            ))}
          </div>
        ) : null}

        {canFocus ? (
          <div className="depth-control">
            <span>{t("Focus depth")}</span>
            <div className="segmented small">
              {[1, 2, 3].map((value) => (
                <button key={value} className={depth === value ? "is-active" : ""} onClick={() => onDepthChange(value)}>
                  {value}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {changedFile ? (
          <div className="inspector-section change-section">
            <div className="inspector-section-title">
              <GitCompareArrows size={12} /> {t("Git change")}
              <span className={`change-badge status-${changedFile.status}`}>{t(changedFile.status)}</span>
              {changedFile.impactLevel ? (
                <span className={`impact-badge impact-${changedFile.impactLevel}`}>{t(changedFile.impactLevel)}</span>
              ) : null}
            </div>
            <div className="change-meta-row">
              <span>{changedFile.path}</span>
              {changedFile.additions !== undefined || changedFile.deletions !== undefined ? (
                <span className="change-numbers">
                  {changedFile.additions !== undefined ? `+${changedFile.additions}` : ""}
                  {changedFile.deletions !== undefined ? ` −${changedFile.deletions}` : ""}
                </span>
              ) : null}
            </div>
            {structuralChange ? (
              <div className="structural-list">
                {structuralChange.addedSymbols.length > 0 ? (
                  <div className="structural-row added">
                    <span>+</span>
                    {structuralChange.addedSymbols.join(", ")}
                  </div>
                ) : null}
                {structuralChange.removedSymbols.length > 0 ? (
                  <div className="structural-row removed">
                    <span>−</span>
                    {structuralChange.removedSymbols.join(", ")}
                  </div>
                ) : null}
                {structuralChange.changedSymbols.length > 0 ? (
                  <div className="structural-row changed">
                    <span>~</span>
                    {structuralChange.changedSymbols.join(", ")}
                  </div>
                ) : null}
              </div>
            ) : null}
            <GitDiffView
              analysisId={analysis.id}
              filePath={changedFile.path}
              base={changeReport?.git.analysisHead ?? gitStatus?.analysisHead ?? analysis.git?.head}
            />
          </div>
        ) : null}

        {node.filePath && node.kind !== "folder" && node.kind !== "module" && node.kind !== "project" ? (
          <div className="inspector-section source-section">
            <div className="inspector-section-title">
              <FileCode2 size={12} /> {t("Source code")}
              {node.startLine ? <span className="section-count">{node.startLine}–{node.endLine}</span> : null}
            </div>
            <SourcePreview
              analysisId={analysis.id}
              filePath={node.filePath}
              startLine={node.startLine ?? 1}
              endLine={node.endLine}
            />
          </div>
        ) : null}

        {node.kind === "file" || node.kind === "folder" || node.kind === "module" ? (
          <AiScopePanel
            analysis={analysis}
            nodeId={node.id}
            nodeKind={node.kind}
            settings={aiSettings}
            onOpenSettings={onOpenAiSettings}
            onOpenFile={onOpenFile}
          />
        ) : null}

        {!node.metadata?.unresolved &&
        (node.kind === "function" || node.kind === "method" || node.kind === "class") ? (
          <AiSymbolPanel
            analysis={analysis}
            nodeId={node.id}
            symbolKind={node.kind}
            settings={aiSettings}
            onOpenSettings={onOpenAiSettings}
            onOpenFile={onOpenFile}
          />
        ) : null}

        {incoming.length > 0 ? (
          <div className="inspector-section">
            <div className="inspector-section-title">
              <ArrowDownLeft size={12} /> {t("Incoming relationships")}
              <span className="section-count">{incoming.length}</span>
            </div>
            <div className="relationship-list">{incoming.slice(0, 12).map((item) => relationshipRow(item, "in"))}</div>
          </div>
        ) : null}

        {outgoing.length > 0 ? (
          <div className="inspector-section">
            <div className="inspector-section-title">
              <ArrowUpRight size={12} /> {t("Outgoing relationships")}
              <span className="section-count">{outgoing.length}</span>
            </div>
            <div className="relationship-list">{outgoing.slice(0, 12).map((item) => relationshipRow(item, "out"))}</div>
          </div>
        ) : null}

        {methods.length > 0 ? (
          <div className="inspector-section">
            <div className="inspector-section-title">
              <ListTree size={12} /> {t("Members")}
              <span className="section-count">{methods.length}</span>
            </div>
            <div className="compact-list">
              {methods.map((method) => {
                const methodNode = nodeById.get(method.id);
                return (
                  <button key={method.id} className="compact-row clickable" onClick={() => onSelectNode(method.id)}>
                    {methodNode ? <KindIcon node={methodNode} size={13} /> : <FunctionSquare size={13} />}
                    <span className="compact-name">{method.name}</span>
                    <span className="compact-meta">{t("line {line}", { line: method.startLine })}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {node.kind === "file" && fileRecord ? (
          <>
            <div className="file-meta-grid">
              <div>
                <span>{t("Lines")}</span>
                <strong>{formatNumber(fileRecord.loc, localeInfo.dateLocale)}</strong>
              </div>
              <div>
                <span>{t("Size")}</span>
                <strong>{formatBytes(fileRecord.bytes)}</strong>
              </div>
              <div>
                <span>{t("Language")}</span>
                <strong>{fileRecord.language}</strong>
              </div>
              <div>
                <span>Hash</span>
                <strong>{fileRecord.hash.slice(0, 8)}</strong>
              </div>
            </div>

            {fileRecord.imports.length > 0 ? (
              <div className="inspector-section">
                <div className="inspector-section-title">
                  <Package size={12} /> {t("Imports")}
                  <span className="section-count">{fileRecord.imports.length}</span>
                </div>
                <div className="import-list">
                  {fileRecord.imports.map((specifier) => (
                    <code key={specifier} className="import-chip">
                      {specifier}
                    </code>
                  ))}
                </div>
              </div>
            ) : null}

            {fileSymbols.length > 0 ? (
              <div className="inspector-section">
                <div className="inspector-section-title">
                  <Braces size={12} /> {t("Symbols")}
                  <span className="section-count">{analysis.symbols.filter((symbol) => symbol.filePath === node.filePath).length}</span>
                </div>
                <div className="compact-list">
                  {fileSymbols.map((symbol) => (
                    <button key={symbol.id} className="compact-row clickable" onClick={() => onSelectNode(symbol.id)}>
                      <span className="symbol-kind-dot" style={{ background: KIND_COLOR[symbol.kind] }} />
                      <span className="compact-name" title={symbol.qualifiedName}>
                        {truncate(symbol.qualifiedName, 36)}
                      </span>
                      <span className="compact-meta">{symbol.startLine}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        {node.kind === "folder" ? (
          <div className="inspector-section">
            <div className="inspector-section-title">
              <Folder size={12} /> {t("Contents")}
              <span className="section-count">{childFolders.length + childFiles.length}</span>
            </div>
            <div className="compact-list">
              {childFolders.map((folder) => (
                <button key={folder.id} className="compact-row clickable" onClick={() => onOpenFolder(folder.filePath ?? "")}>
                  <Folder size={13} style={{ color: KIND_COLOR.folder }} />
                  <span className="compact-name">{folder.label}</span>
                  <span className="compact-meta">
                    {tn(folder.metadata?.fileCount ?? 0, "{count} file", "{count} files")}
                  </span>
                </button>
              ))}
              {childFiles.map((file) => (
                <button key={file.id} className="compact-row clickable" onClick={() => onOpenFile(file.filePath!)}>
                  <FileCode2 size={13} style={{ color: KIND_COLOR.file }} />
                  <span className="compact-name">{file.label}</span>
                  <span className="compact-meta">{file.language}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {node.kind === "project" ? (
          <div className="inspector-section">
            <div className="inspector-section-title">
              <Workflow size={12} /> Graph
            </div>
            <div className="file-meta-grid">
              <div>
                <span>{t("Nodes")}</span>
                <strong>{formatNumber(analysis.stats.nodes, localeInfo.dateLocale)}</strong>
              </div>
              <div>
                <span>{t("Relationships")}</span>
                <strong>{formatNumber(analysis.stats.edges, localeInfo.dateLocale)}</strong>
              </div>
              <div>
                <span>{t("Confirmed")}</span>
                <strong>{formatNumber(analysis.stats.confirmedEdges, localeInfo.dateLocale)}</strong>
              </div>
              <div>
                <span>{t("Unresolved")}</span>
                <strong>{formatNumber(analysis.stats.unresolvedEdges, localeInfo.dateLocale)}</strong>
              </div>
            </div>
          </div>
        ) : null}

        {node.kind === "project" ? (
          <AiProjectSummaryPanel
            analysis={analysis}
            settings={aiSettings}
            onOpenSettings={onOpenAiSettings}
            onOpenFile={onOpenFile}
          />
        ) : null}

        <div className="inspector-static-note">
          <CheckCircle2 size={13} />
          {t("Static facts and AI interpretation are kept separate.")}
        </div>
      </div>
    </aside>
  );
}
