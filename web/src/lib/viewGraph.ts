import type {
  AnalysisResult,
  Certainty,
  ChangeReport,
  GitChangedFile,
  GitStatus,
  GraphEdge,
  GraphNode,
  GraphNodeKind,
} from "../../../shared/types";
import type { Translate } from "../i18n";

export type ViewMode =
  | "universe"
  | "files"
  | "functions"
  | "architecture"
  | "changes"
  | "impact"
  | "heatmap"
  | "flows"
  | "3d";

type TranslatePlural = (count: number, one: string, other: string, vars?: Record<string, string | number>) => string;

export interface ViewGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  title: string;
  subtitle: string;
  notice?: string;
}

export interface CommitHighlight {
  hash: string;
  subject: string;
  files: GitChangedFile[];
}

interface BuildOptions {
  mode: ViewMode;
  analysis: AnalysisResult;
  selectedFolder: string | null;
  selectedFile: string | null;
  selectedNodeId: string | null;
  focusNodeId: string | null;
  depth: number;
  focusMode?: boolean;
  flowMode?: "data" | "business";
  changeReport?: ChangeReport | null;
  gitStatus?: GitStatus | null;
  commitHighlight?: CommitHighlight | null;
  clusterFunctions?: boolean;
  fullTree?: boolean;
  t: Translate;
  tn: TranslatePlural;
}

function isCallable(kind: GraphNodeKind): boolean {
  return kind === "function" || kind === "method" || kind === "class";
}

function groupOfFile(filePath: string | undefined): string {
  if (!filePath) return "project";
  const index = filePath.indexOf("/");
  return index === -1 ? "project" : `folder:${filePath.slice(0, index)}`;
}

function certaintyRank(certainty: Certainty): number {
  return certainty === "confirmed" ? 0 : certainty === "inferred" ? 1 : 2;
}

function worstCertainty(values: Certainty[]): Certainty {
  return values.reduce<Certainty>((worst, value) => (certaintyRank(value) > certaintyRank(worst) ? value : worst), "confirmed");
}

function folderLabel(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

export function buildViewGraph(options: BuildOptions): ViewGraph {
  const {
    mode,
    analysis,
    selectedFolder,
    selectedFile,
    selectedNodeId,
    focusNodeId,
    depth,
    focusMode,
    flowMode,
    changeReport,
    gitStatus,
    commitHighlight,
    clusterFunctions,
    fullTree,
    t,
    tn,
  } = options;
  const nodeById = new Map(analysis.nodes.map((node) => [node.id, node]));

  let view: ViewGraph;
  if (mode === "universe") view = buildUniverse(analysis, nodeById, t, tn);
  else if (mode === "files") view = buildFiles(analysis, nodeById, selectedFolder, Boolean(fullTree), t, tn);
  else if (mode === "architecture") view = buildArchitecture(analysis, nodeById, t, tn);
  else if (mode === "changes") view = buildChanges(analysis, nodeById, changeReport ?? null, gitStatus ?? null, t, tn);
  else if (mode === "impact") view = buildImpact(analysis, nodeById, selectedNodeId, Math.max(1, depth), t);
  else if (mode === "heatmap") view = buildHeatmap(analysis, nodeById, t);
  else if (mode === "flows") {
    view =
      flowMode === "business"
        ? {
            nodes: [],
            edges: [],
            title: t("Business flow explorer"),
            subtitle: t("AI interpretation grounded in routes, calls, database access, and events"),
          }
        : buildDataFlow(analysis, nodeById, selectedNodeId, Math.max(1, depth), t);
  } else if (mode === "3d") {
    const base = selectedFile ? "functions" : selectedFolder ? "files" : "universe";
    view =
      base === "functions"
        ? buildFunctions(analysis, nodeById, selectedFile, focusNodeId, depth, Boolean(clusterFunctions), t, tn)
        : base === "files"
          ? buildFiles(analysis, nodeById, selectedFolder, Boolean(fullTree), t, tn)
          : buildUniverse(analysis, nodeById, t, tn);
  } else {
    view = buildFunctions(analysis, nodeById, selectedFile, focusNodeId, depth, Boolean(clusterFunctions), t, tn);
  }

  if (focusMode && selectedNodeId) {
    view = buildFocus(analysis, nodeById, selectedNodeId, Math.max(1, depth), t, tn);
  }

  return applyCommitHighlight(view, commitHighlight ?? null);
}

function applyCommitHighlight(view: ViewGraph, highlight: CommitHighlight | null): ViewGraph {
  if (!highlight || highlight.files.length === 0) return view;
  const statusByPath = new Map(highlight.files.map((file) => [file.path, file.status]));
  return {
    ...view,
    nodes: view.nodes.map((node) => {
      const status = node.filePath ? statusByPath.get(node.filePath) : undefined;
      if (!status) return node;
      return {
        ...node,
        metadata: {
          ...node.metadata,
          commitChanged: status,
          commitHash: highlight.hash,
        },
      };
    }),
  };
}

function buildUniverse(
  analysis: AnalysisResult,
  nodeById: Map<string, GraphNode>,
  t: Translate,
  tn: TranslatePlural,
): ViewGraph {
  const topFolders = analysis.nodes
    .filter((node) => node.kind === "folder" && node.parentId === "project")
    .sort((a, b) => (b.metadata?.fileCount ?? 0) - (a.metadata?.fileCount ?? 0));

  // A project with one or two top-level folders (e.g. "src") is more useful
  // when its second-level modules are the clusters of the universe.
  const useSecondLevel = topFolders.length > 0 && topFolders.length <= 2;
  const secondLevel = useSecondLevel
    ? analysis.nodes
        .filter(
          (node) =>
            node.kind === "folder" &&
            topFolders.some((folder) => folder.id === node.parentId),
        )
        .sort((a, b) => (b.metadata?.fileCount ?? 0) - (a.metadata?.fileCount ?? 0))
    : [];
  const displayFolders = (secondLevel.length > 0 ? secondLevel : topFolders).slice(0, 30);
  const displayFolderIds = new Set(displayFolders.map((folder) => folder.id));
  const groupPaths = displayFolders
    .map((folder) => folder.filePath ?? "")
    .filter(Boolean)
    .sort((a, b) => b.split("/").length - a.split("/").length);

  function groupForFile(filePath: string | undefined): string {
    if (!filePath) return "project";
    const groupPath = groupPaths.find((candidate) => filePath.startsWith(`${candidate}/`));
    if (groupPath) return `folder:${groupPath}`;
    const fileNodeId = `file:${filePath}`;
    if (nodeById.has(fileNodeId)) return fileNodeId;
    return groupOfFile(filePath);
  }

  // Files that live outside a displayed cluster (for example src/index.ts)
  // stay visible as individual nodes when there are only a few of them.
  const standaloneFiles = analysis.nodes
    .filter((node) => {
      if (node.kind !== "file" || !node.filePath) return false;
      const group = groupForFile(node.filePath);
      return group === node.id || group === "project";
    })
    .sort((a, b) => a.label.localeCompare(b.label))
    .slice(0, 18);
  const standaloneIds = new Set(standaloneFiles.map((file) => file.id));

  const importCounts = new Map<string, { count: number; certainty: Certainty }>();
  for (const edge of analysis.edges) {
    if (edge.kind !== "IMPORTS") continue;
    const source = nodeById.get(edge.source);
    if (!source || source.kind !== "file") continue;
    const target = nodeById.get(edge.target);
    const sourceGroup = groupForFile(source.filePath);
    let targetGroup = target ? groupForFile(target.filePath) : "project";
    if (target?.kind === "module") targetGroup = target.id;
    if (!displayFolderIds.has(sourceGroup) && !standaloneIds.has(sourceGroup)) continue;
    if (!displayFolderIds.has(targetGroup) && !standaloneIds.has(targetGroup) && target?.kind !== "module") continue;
    if (sourceGroup === targetGroup) continue;
    const key = `${sourceGroup}|${targetGroup}`;
    const previous = importCounts.get(key);
    importCounts.set(key, {
      count: (previous?.count ?? 0) + 1,
      certainty: previous ? worstCertainty([previous.certainty, edge.certainty]) : edge.certainty,
    });
  }

  const moduleUsage = new Map<string, number>();
  for (const edge of analysis.edges) {
    if (edge.kind === "IMPORTS" && nodeById.get(edge.target)?.kind === "module") {
      moduleUsage.set(edge.target, (moduleUsage.get(edge.target) ?? 0) + 1);
    }
  }
  const modules = [...moduleUsage.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([id]) => nodeById.get(id))
    .filter((node): node is GraphNode => Boolean(node));

  const nodes: GraphNode[] = [nodeById.get("project")!]
    .concat(
      displayFolders.map((folder) => ({
        ...folder,
        metadata: {
          ...folder.metadata,
          groupPath: folder.filePath
            ? folder.filePath.split("/").slice(0, -1).join("/") || undefined
            : undefined,
        },
      })),
    )
    .concat(standaloneFiles)
    .concat(modules)
    .filter(Boolean);

  const includedIds = new Set(nodes.map((node) => node.id));
  const edges: GraphEdge[] = [];
  for (const [key, value] of importCounts) {
    const [source, target] = key.split("|");
    if (!includedIds.has(source) || !includedIds.has(target)) continue;
    edges.push({
      id: `universe-import-${source}-${target}`,
      source,
      target,
      kind: "IMPORTS",
      certainty: value.certainty,
      label: value.count > 1 ? tn(value.count, "{count} import", "{count} imports") : undefined,
    });
  }

  const hidden = topFolders.length - displayFolders.length;
  return {
    nodes,
    edges,
    title: analysis.projectName,
    subtitle: t("{modules} modules · {rootFiles} root files · {symbols} symbols", {
      modules: displayFolders.length,
      rootFiles: standaloneFiles.length,
      symbols: analysis.stats.symbols,
    }),
    notice:
      hidden > 0
        ? t("To keep the view readable, {hidden} top-level folders are hidden. Browse them in the Files view.", {
            hidden,
          })
        : undefined,
  };
}

function buildFiles(
  analysis: AnalysisResult,
  nodeById: Map<string, GraphNode>,
  selectedFolder: string | null,
  fullTree: boolean,
  t: Translate,
  tn: TranslatePlural,
): ViewGraph {
  const scope = selectedFolder ?? "";
  const scopeId = scope ? `folder:${scope}` : "project";
  const scopeNode = nodeById.get(scopeId);

  if (fullTree) {
    const prefix = scope ? `${scope}/` : "";
    const allFolders = analysis.nodes
      .filter((node) => node.kind === "folder" && node.filePath && (!scope || node.filePath.startsWith(prefix)))
      .slice(0, 140);
    const allFiles = analysis.files
      .filter((file) => !scope || file.path.startsWith(prefix))
      .slice(0, 240);
    const includedFiles = new Set(allFiles.map((file) => `file:${file.path}`));
    const includedFolders = new Set(allFolders.map((folder) => folder.id));
    const nodes: GraphNode[] = [];
    if (scopeNode) nodes.push(scopeNode);
    nodes.push(...allFolders, ...allFiles.map((file) => nodeById.get(`file:${file.path}`)).filter((node): node is GraphNode => Boolean(node)));

    const edges: GraphEdge[] = [];
    for (const folder of allFolders) {
      if (folder.parentId === scopeId) {
        edges.push({ id: `full-contains-${folder.id}`, source: scopeId, target: folder.id, kind: "CONTAINS", certainty: "confirmed" });
      } else if (folder.parentId && includedFolders.has(folder.parentId)) {
        edges.push({ id: `full-contains-${folder.id}`, source: folder.parentId, target: folder.id, kind: "CONTAINS", certainty: "confirmed" });
      }
    }
    for (const file of allFiles) {
      const fileNodeId = `file:${file.path}`;
      const parentId = nodeById.get(fileNodeId)?.parentId;
      if (parentId && (includedFolders.has(parentId) || parentId === scopeId)) {
        edges.push({ id: `full-contains-${fileNodeId}`, source: parentId, target: fileNodeId, kind: "CONTAINS", certainty: "confirmed" });
      }
    }
    for (const edge of analysis.edges) {
      if (edge.kind !== "IMPORTS") continue;
      if (includedFiles.has(edge.source) && (includedFiles.has(edge.target) || includedFolders.has(edge.target))) {
        edges.push(edge);
      }
    }

    return {
      nodes,
      edges,
      title: scope ? folderLabel(scope) : analysis.projectName,
      subtitle: t("{files} files · {folders} folders in this branch", {
        files: allFiles.length,
        folders: allFolders.length,
      }),
      notice:
        analysis.files.length > 240
          ? t("Full tree view is capped at 240 files. Select a folder to narrow it down.")
          : t("Full tree view: every folder and file under this scope is expanded."),
    };
  }

  const directFiles = analysis.files
    .filter((file) => {
      const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
      return dir === scope;
    })
    .map((file) => nodeById.get(`file:${file.path}`))
    .filter((node): node is GraphNode => Boolean(node))
    .sort((a, b) => a.label.localeCompare(b.label));

  const subfolders = analysis.nodes
    .filter((node) => node.kind === "folder" && node.parentId === scopeId)
    .sort((a, b) => (b.metadata?.fileCount ?? 0) - (a.metadata?.fileCount ?? 0));

  const includedFiles = directFiles.slice(0, 180);
  const includedFolderIds = new Set(subfolders.map((folder) => folder.id));
  const includedFileIds = new Set(includedFiles.map((file) => file.id));

  const nodes: GraphNode[] = [];
  if (scopeNode) nodes.push(scopeNode);
  nodes.push(...subfolders, ...includedFiles);

  const edges: GraphEdge[] = [];
  for (const node of subfolders) {
    edges.push({
      id: `files-contains-${node.id}`,
      source: scopeId,
      target: node.id,
      kind: "CONTAINS",
      certainty: "confirmed",
    });
  }
  for (const file of includedFiles) {
    edges.push({
      id: `files-contains-${file.id}`,
      source: scopeId,
      target: file.id,
      kind: "CONTAINS",
      certainty: "confirmed",
    });
  }
  for (const edge of analysis.edges) {
    if (edge.kind !== "IMPORTS") continue;
    if (includedFileIds.has(edge.source) && (includedFileIds.has(edge.target) || includedFolderIds.has(edge.target))) {
      edges.push(edge);
    }
  }

  const title = scope ? folderLabel(scope) : analysis.projectName;
  const hidden = directFiles.length - includedFiles.length;
  return {
    nodes,
    edges,
    title,
    subtitle: scope
      ? t("/{scope} · {files} files · {subfolders} subfolders", {
          scope,
          files: directFiles.length,
          subfolders: subfolders.length,
        })
      : t("Project root · {files} files", { files: analysis.stats.files }),
    notice:
      hidden > 0
        ? t("Showing the first {shown} files in this view ({hidden} hidden).", {
            shown: includedFiles.length,
            hidden,
          })
        : subfolders.length + directFiles.length === 0
          ? t("This folder has no analyzed source files.")
          : undefined,
  };
}

function buildFunctions(
  analysis: AnalysisResult,
  nodeById: Map<string, GraphNode>,
  selectedFile: string | null,
  focusNodeId: string | null,
  depth: number,
  clusterFunctions: boolean,
  t: Translate,
  tn: TranslatePlural,
): ViewGraph {
  const focusNode = focusNodeId ? nodeById.get(focusNodeId) : undefined;

  if (focusNode && isCallable(focusNode.kind)) {
    const selected = new Map<string, GraphNode>([[focusNode.id, focusNode]]);
    const adjacency = new Map<string, GraphEdge[]>();
    for (const edge of analysis.edges) {
      if (edge.kind !== "CALLS" && edge.kind !== "EXTENDS" && edge.kind !== "IMPLEMENTS") continue;
      adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), edge]);
      adjacency.set(edge.target, [...(adjacency.get(edge.target) ?? []), edge]);
    }

    let frontier = [focusNode.id];
    for (let level = 0; level < Math.max(1, depth); level += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const edge of adjacency.get(id) ?? []) {
          const neighbourId = edge.source === id ? edge.target : edge.source;
          if (!selected.has(neighbourId)) {
            const neighbour = nodeById.get(neighbourId);
            if (neighbour && (isCallable(neighbour.kind) || neighbour.kind === "interface")) {
              selected.set(neighbourId, neighbour);
              next.push(neighbourId);
            }
          }
        }
      }
      frontier = next;
    }

    const edges = analysis.edges.filter(
      (edge) =>
        (edge.kind === "CALLS" || edge.kind === "EXTENDS" || edge.kind === "IMPLEMENTS") &&
        selected.has(edge.source) &&
        selected.has(edge.target),
    );

    return {
      nodes: [...selected.values()],
      edges,
      title: focusNode.metadata?.qualifiedName ?? focusNode.label,
      subtitle: t("{depth}-step neighborhood · {nodes} nodes · {edges} relationships", {
        depth,
        nodes: selected.size,
        edges: edges.length,
      }),
      notice:
        edges.length === 0
          ? t("No resolved call relationships were found for this node. This may be a static-analysis limit.")
          : undefined,
    };
  }

  if (selectedFile) {
    const fileNode = nodeById.get(`file:${selectedFile}`);
    const fileSymbols = analysis.nodes.filter(
      (node) =>
        node.filePath === selectedFile &&
        (node.kind === "function" ||
          node.kind === "method" ||
          node.kind === "class" ||
          node.kind === "interface" ||
          node.kind === "type" ||
          node.kind === "enum"),
    );
    const included = new Map<string, GraphNode>();
    for (const node of fileSymbols.slice(0, 160)) included.set(node.id, node);

    // Class/interface parents keep methods visually grouped.
    for (const node of [...included.values()]) {
      if (node.parentId && nodeById.get(node.parentId)?.kind === "class") {
        included.set(node.parentId, nodeById.get(node.parentId)!);
      }
    }

    // One hop of callers/callees outside the file.
    for (const edge of analysis.edges) {
      if (edge.kind !== "CALLS") continue;
      if (included.has(edge.source) && !included.has(edge.target)) {
        const target = nodeById.get(edge.target);
        if (target && isCallable(target.kind)) included.set(target.id, target);
      }
      if (included.has(edge.target) && !included.has(edge.source)) {
        const source = nodeById.get(edge.source);
        if (source && isCallable(source.kind)) included.set(source.id, source);
      }
    }

    const edges = analysis.edges.filter(
      (edge) =>
        (edge.kind === "CALLS" ||
          edge.kind === "EXTENDS" ||
          edge.kind === "IMPLEMENTS" ||
          edge.kind === "CONTAINS") &&
        included.has(edge.source) &&
        included.has(edge.target),
    );

    if (included.size === 0 && fileNode) {
      return {
        nodes: [fileNode],
        edges: [],
        title: fileNode.label,
        subtitle: selectedFile,
        notice: t("No symbols were extracted from this file."),
      };
    }

    return {
      nodes: [...included.values()],
      edges,
      title: fileNode?.label ?? selectedFile,
      subtitle: t("{symbols} symbols · {calls} call relationships", {
        symbols: fileSymbols.length,
        calls: edges.filter((edge) => edge.kind === "CALLS").length,
      }),
      notice: fileSymbols.length > 160 ? t("Showing the first 160 symbols in this file.") : undefined,
    };
  }

  const degree = (node: GraphNode) =>
    (node.metadata?.callCount ?? 0) + (node.metadata?.callerCount ?? 0);

  if (clusterFunctions) {
    const callables = analysis.nodes
      .filter((node) => node.kind === "function" || node.kind === "method")
      .sort((a, b) => degree(b) - degree(a))
      .slice(0, 500);
    const fileScores = new Map<string, { score: number; symbols: number }>();
    for (const node of callables) {
      if (!node.filePath) continue;
      const entry = fileScores.get(node.filePath) ?? { score: 0, symbols: 0 };
      entry.score += degree(node) + 1;
      entry.symbols += 1;
      fileScores.set(node.filePath, entry);
    }
    const clusterPaths = [...fileScores.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, 80)
      .map(([filePath]) => filePath);
    const included = new Set(clusterPaths.map((filePath) => `file:${filePath}`));
    const nodes = clusterPaths
      .map((filePath) => {
        const fileNode = nodeById.get(`file:${filePath}`);
        if (!fileNode) return null;
        return {
          ...fileNode,
          metadata: {
            ...fileNode.metadata,
            aggregate: true,
            symbolCount: fileScores.get(filePath)?.symbols ?? 0,
          },
        };
      })
      .filter((node) => Boolean(node)) as GraphNode[];

    const nodeByIdLocal = new Map(analysis.nodes.map((node) => [node.id, node]));
    const aggregated = new Map<string, { source: string; target: string; count: number; certainty: Certainty }>();
    for (const edge of analysis.edges) {
      if (edge.kind !== "CALLS") continue;
      const source = nodeByIdLocal.get(edge.source);
      const target = nodeByIdLocal.get(edge.target);
      if (!source?.filePath || !target?.filePath || source.filePath === target.filePath) continue;
      const sourceId = `file:${source.filePath}`;
      const targetId = `file:${target.filePath}`;
      if (!included.has(sourceId) || !included.has(targetId)) continue;
      const key = `${sourceId}|${targetId}`;
      const previous = aggregated.get(key);
      aggregated.set(key, {
        source: sourceId,
        target: targetId,
        count: (previous?.count ?? 0) + 1,
        certainty: previous
          ? worstCertainty([previous.certainty, edge.certainty])
          : edge.certainty,
      });
    }
    const edges: GraphEdge[] = [...aggregated.values()].map((edge) => ({
      id: `cluster-call-${edge.source}-${edge.target}`,
      source: edge.source,
      target: edge.target,
      kind: "CALLS",
      certainty: edge.certainty,
      label: edge.count > 1 ? tn(edge.count, "{count} call", "{count} calls") : undefined,
    }));

    return {
      nodes,
      edges,
      title: t("Function clusters"),
      subtitle: t("{files} files · {calls} cross-file calls", {
        files: nodes.length,
        calls: edges.length,
      }),
      notice: t(
        "Functions are grouped by file for large graphs. Click a file cluster to inspect it; double-click to open its function map.",
      ),
    };
  }

  const callables = analysis.nodes
    .filter((node) => node.kind === "function" || node.kind === "method")
    .sort((a, b) => degree(b) - degree(a));
  const top = callables.slice(0, 60);
  const included = new Set(top.map((node) => node.id));
  const edges = analysis.edges.filter(
    (edge) => edge.kind === "CALLS" && included.has(edge.source) && included.has(edge.target),
  );

  return {
    nodes: top,
    edges,
    title: t("Global call map"),
    subtitle: t("Top {count} functions / methods · {edges} calls", {
      count: top.length,
      edges: edges.length,
    }),
    notice: t(
      "The global call graph is limited to the most connected functions. Select a file or focus on a function to explore further.",
    ),
  };
}

function buildChanges(
  analysis: AnalysisResult,
  nodeById: Map<string, GraphNode>,
  report: ChangeReport | null,
  status: GitStatus | null,
  t: Translate,
  _tn: TranslatePlural,
): ViewGraph {
  const files = (report?.files ?? status?.files ?? []).filter((file) => file.sinceAnalysis !== false);
  const included = new Set<string>();

  for (const file of files) {
    included.add(`file:${file.path}`);
    for (const affected of file.affectedNodes ?? []) included.add(affected.id);
  }

  if (report) {
    for (const node of report.impact.nodes) included.add(node.id);
    for (const route of report.impact.routes) included.add(route.id);
    for (const test of report.impact.tests) included.add(test.id);
  }

  const nodes = [...included]
    .map((id) => nodeById.get(id))
    .filter((node): node is GraphNode => Boolean(node));

  const edges = analysis.edges.filter((edge) => {
    if (
      edge.kind !== "CALLS" &&
      edge.kind !== "IMPORTS" &&
      edge.kind !== "ROUTES_TO" &&
      edge.kind !== "READS_FROM" &&
      edge.kind !== "WRITES_TO"
    ) {
      return false;
    }
    return included.has(edge.source) && included.has(edge.target);
  });

  const changedCount = files.length;
  const highImpact = files.filter((file) => file.impactLevel === "high").length;

  return {
    nodes,
    edges,
    title: t("Changes"),
    subtitle: report
      ? [
          _tn(changedCount, "{count} changed file", "{count} changed files"),
          _tn(report.summary.changedSymbols, "{count} changed symbol", "{count} changed symbols"),
          _tn(report.impact.nodes.length, "{count} impacted node", "{count} impacted nodes"),
        ].join(" · ")
      : [
          _tn(changedCount, "{count} changed file", "{count} changed files"),
          t("{count} high-impact", { count: highImpact }),
        ].join(" · "),
    notice:
      status && !status.available && changedCount === 0
        ? status.message ?? t("Git is not available for this project.")
        : changedCount === 0
          ? t("No changes found since the last analysis snapshot.")
          : report
            ? undefined
            : t("Run “Analyze changes” to compute the structural diff and impacted callers."),
  };
}

function heatColor(ratio: number): string {
  const value = Math.max(0, Math.min(1, ratio));
  const cold = [96, 165, 250];
  const mid = [245, 184, 75];
  const hot = [248, 113, 113];
  const from = value < 0.5 ? cold : mid;
  const to = value < 0.5 ? mid : hot;
  const local = value < 0.5 ? value * 2 : (value - 0.5) * 2;
  const rgb = from.map((channel, index) => Math.round(channel + (to[index] - channel) * local));
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

export function findDataFlowStart(analysis: AnalysisResult): GraphNode | undefined {
  const flowKinds = new Set([
    "ROUTES_TO",
    "CALLS",
    "READS_FROM",
    "WRITES_TO",
    "PUBLISHES",
    "SUBSCRIBES_TO",
    "MAPS_TO",
  ]);
  const outgoing = new Map<string, number>();
  for (const edge of analysis.edges) {
    if (!flowKinds.has(edge.kind)) continue;
    outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + 1);
  }

  const routes = analysis.nodes
    .filter((node) => node.kind === "route")
    .map((route) => {
      const routesTo = analysis.edges.find(
        (edge) => edge.source === route.id && edge.kind === "ROUTES_TO",
      );
      const downstream = routesTo ? outgoing.get(routesTo.target) ?? 0 : 0;
      return { route, score: downstream + (routesTo ? 1 : 0) };
    })
    .sort((a, b) => b.score - a.score);

  if (routes.length > 0 && routes[0].score > 0) return routes[0].route;

  const functions = analysis.nodes
    .filter((node) => node.kind === "function" || node.kind === "method")
    .sort((a, b) => (outgoing.get(b.id) ?? 0) - (outgoing.get(a.id) ?? 0));

  return routes[0]?.route ?? functions[0];
}

function buildDataFlow(
  analysis: AnalysisResult,
  nodeById: Map<string, GraphNode>,
  selectedNodeId: string | null,
  depth: number,
  t: Translate,
): ViewGraph {
  const flowKinds = new Set([
    "ROUTES_TO",
    "CALLS",
    "READS_FROM",
    "WRITES_TO",
    "PUBLISHES",
    "SUBSCRIBES_TO",
    "MAPS_TO",
  ]);
  const root =
    (selectedNodeId ? nodeById.get(selectedNodeId) : undefined) ??
    findDataFlowStart(analysis);

  if (!root) {
    return {
      nodes: analysis.nodes.filter((node) => node.id === "project"),
      edges: [],
      title: t("Data flow explorer"),
      subtitle: t("No route or function data flow was found"),
      notice: t("Select a route or function to trace its data flow."),
    };
  }

  const included = new Map<string, GraphNode>([[root.id, root]]);
  const flowDepth = new Map<string, number>([[root.id, 0]]);
  let frontier = [root.id];
  const maxDepth = Math.max(1, Math.min(5, depth));

  for (let level = 1; level <= maxDepth; level += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of analysis.edges) {
        if (edge.source !== id || !flowKinds.has(edge.kind)) continue;
        if (included.has(edge.target)) continue;
        const target = nodeById.get(edge.target);
        if (!target) continue;
        included.set(target.id, target);
        flowDepth.set(target.id, level);
        next.push(target.id);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  const MAX_FLOW_NODES = 260;
  const capped = [...included.values()].slice(0, MAX_FLOW_NODES);
  const includedIds = new Set(capped.map((node) => node.id));
  const nodes = capped.map((node) => ({
    ...node,
    metadata: {
      ...node.metadata,
      flowDepth: flowDepth.get(node.id) ?? 0,
    },
  }));
  const edges = analysis.edges
    .filter((edge) => flowKinds.has(edge.kind) && includedIds.has(edge.source) && includedIds.has(edge.target))
    .slice(0, 400);
  const calls = edges.filter((edge) => edge.kind === "CALLS").length;
  const reads = edges.filter((edge) => edge.kind === "READS_FROM").length;
  const writes = edges.filter((edge) => edge.kind === "WRITES_TO").length;
  const events = edges.filter(
    (edge) => edge.kind === "PUBLISHES" || edge.kind === "SUBSCRIBES_TO",
  ).length;
  const dataEdges = edges.filter((edge) => edge.kind !== "ROUTES_TO").length;

  return {
    nodes,
    edges,
    title: t("Data flow: {label}", { label: root.metadata?.qualifiedName ?? root.label }),
    subtitle: t("{nodes} steps · {calls} calls · {reads} reads · {writes} writes · {events} events", {
      nodes: nodes.length,
      calls,
      reads,
      writes,
      events,
    }),
    notice:
      included.size > MAX_FLOW_NODES
        ? t("Data-flow graph is capped at {count} nodes for performance.", { count: MAX_FLOW_NODES })
        : edges.length === 0
          ? t("No downstream data relationships were found for this node.")
          : dataEdges === 0
            ? t("Only the route binding was resolved; no downstream calls or data access were found.")
            : t("Static data-flow estimate. Runtime branches may differ."),
  };
}

function buildImpact(
  analysis: AnalysisResult,
  nodeById: Map<string, GraphNode>,
  selectedNodeId: string | null,
  depth: number,
  t: Translate,
): ViewGraph {
  const root = selectedNodeId ? nodeById.get(selectedNodeId) : undefined;
  if (!root) {
    return {
      nodes: analysis.nodes.filter((node) => node.id === "project"),
      edges: [],
      title: t("Impact analysis"),
      subtitle: t("Select a node to analyze its dependents"),
      notice: t("Pick a function, class, file, route, or module to see what depends on it."),
    };
  }

  const impactKinds = new Set([
    "CALLS",
    "IMPORTS",
    "ROUTES_TO",
    "READS_FROM",
    "WRITES_TO",
    "PUBLISHES",
    "SUBSCRIBES_TO",
    "EXTENDS",
    "IMPLEMENTS",
    "MAPS_TO",
    "RELATES_TO",
  ]);

  const impacted = new Map<string, number>([[root.id, 0]]);
  let frontier = [root.id];
  const maxDepth = Math.max(1, Math.min(5, depth));
  for (let level = 1; level <= maxDepth; level += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of analysis.edges) {
        if (!impactKinds.has(edge.kind) || edge.target !== id) continue;
        if (impacted.has(edge.source)) continue;
        const source = nodeById.get(edge.source);
        if (!source) continue;
        impacted.set(source.id, level);
        next.push(source.id);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  const MAX_IMPACT_NODES = 350;
  const cappedImpact = [...impacted.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, MAX_IMPACT_NODES);
  const nodes: GraphNode[] = [];
  for (const [id, level] of cappedImpact) {
    const node = nodeById.get(id);
    if (!node) continue;
    nodes.push({
      ...node,
      metadata: {
        ...node.metadata,
        impactDepth: level,
      },
    });
  }

  const included = new Set(nodes.map((node) => node.id));
  const edges = analysis.edges
    .filter((edge) => impactKinds.has(edge.kind) && included.has(edge.source) && included.has(edge.target))
    .slice(0, 500);
  const direct = [...impacted.values()].filter((level) => level === 1).length;
  const total = impacted.size - 1;

  return {
    nodes,
    edges,
    title: t("Impact analysis"),
    subtitle: t("{direct} direct dependents · {total} impacted nodes · depth {depth}", {
      direct,
      total,
      depth: maxDepth,
    }),
    notice:
      total === 0
        ? t("No incoming dependencies were found for this node.")
        : impacted.size > MAX_IMPACT_NODES
          ? t("Impact graph is capped at {count} nodes for performance.", { count: MAX_IMPACT_NODES })
          : t("Impact is computed from reverse calls, imports, routes, and data relationships."),
  };
}

function buildHeatmap(
  analysis: AnalysisResult,
  nodeById: Map<string, GraphNode>,
  t: Translate,
): ViewGraph {
  const weights: Record<string, number> = {
    CALLS: 3,
    IMPORTS: 2,
    ROUTES_TO: 2,
    READS_FROM: 1.5,
    WRITES_TO: 1.5,
    PUBLISHES: 1.5,
    SUBSCRIBES_TO: 1.5,
    EXTENDS: 2,
    IMPLEMENTS: 2,
    MAPS_TO: 1,
    RELATES_TO: 1,
  };
  const scores = new Map<string, number>();
  for (const edge of analysis.edges) {
    const weight = weights[edge.kind];
    if (!weight) continue;
    scores.set(edge.source, (scores.get(edge.source) ?? 0) + weight);
    scores.set(edge.target, (scores.get(edge.target) ?? 0) + weight);
  }

  const ranked = analysis.nodes
    .filter(
      (node) =>
        node.kind !== "project" &&
        node.kind !== "folder" &&
        node.kind !== "module" &&
        (scores.get(node.id) ?? 0) > 0,
    )
    .sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0))
    .slice(0, 180);

  const maxScore = Math.max(1, ...ranked.map((node) => scores.get(node.id) ?? 0));
  const nodes = ranked.map((node) => {
    const score = scores.get(node.id) ?? 0;
    return {
      ...node,
      metadata: {
        ...node.metadata,
        heatScore: Math.round(score * 10) / 10,
        heatColor: heatColor(score / maxScore),
        heatMetric: `heat:${score}`,
      },
    };
  });
  const included = new Set(nodes.map((node) => node.id));
  const edges = analysis.edges
    .filter(
      (edge) =>
        Boolean(weights[edge.kind]) &&
        included.has(edge.source) &&
        included.has(edge.target),
    )
    .slice(0, 550);

  return {
    nodes,
    edges,
    title: t("Dependency heatmap"),
    subtitle: t("Top {count} structural hotspots by calls, imports, and routes", {
      count: nodes.length,
    }),
    notice: t("Heat colors show structural degree, not runtime performance."),
  };
}

function buildFocus(
  analysis: AnalysisResult,
  nodeById: Map<string, GraphNode>,
  selectedNodeId: string,
  depth: number,
  t: Translate,
  tn: TranslatePlural,
): ViewGraph {
  const root = nodeById.get(selectedNodeId);
  if (!root) {
    return {
      nodes: analysis.nodes.filter((node) => node.id === "project"),
      edges: [],
      title: t("Focus"),
      subtitle: t("Select a node to focus"),
    };
  }

  const focusKinds = new Set([
    "CALLS",
    "IMPORTS",
    "ROUTES_TO",
    "READS_FROM",
    "WRITES_TO",
    "PUBLISHES",
    "SUBSCRIBES_TO",
    "EXTENDS",
    "IMPLEMENTS",
    "MAPS_TO",
    "RELATES_TO",
    "EXPORTS",
  ]);
  const included = new Map<string, GraphNode>([[root.id, root]]);

  let ancestor = root;
  for (let guard = 0; guard < 32; guard += 1) {
    const parent = ancestor.parentId ? nodeById.get(ancestor.parentId) : undefined;
    if (!parent) break;
    included.set(parent.id, parent);
    ancestor = parent;
  }

  let frontier = [root.id];
  const maxDepth = Math.max(1, Math.min(5, depth));
  for (let level = 1; level <= maxDepth; level += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of analysis.edges) {
        if (!focusKinds.has(edge.kind)) continue;
        const other = edge.source === id ? edge.target : edge.target === id ? edge.source : null;
        if (!other || included.has(other)) continue;
        const node = nodeById.get(other);
        if (!node) continue;
        included.set(other, node);
        next.push(other);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  const MAX_FOCUS_NODES = 300;
  const nodes = [...included.values()].slice(0, MAX_FOCUS_NODES);
  const includedIds = new Set(nodes.map((node) => node.id));
  const edges = analysis.edges
    .filter((edge) => includedIds.has(edge.source) && includedIds.has(edge.target))
    .slice(0, 600);

  return {
    nodes,
    edges,
    title: t("Focus: {label}", { label: root.metadata?.qualifiedName ?? root.label }),
    subtitle: tn(
      nodes.length,
      "{count} node · {depth}-step focus",
      "{count} nodes · {depth}-step focus",
      { depth: maxDepth },
    ),
    notice:
      included.size > MAX_FOCUS_NODES
        ? t("Focus graph is capped at {count} nodes for performance.", { count: MAX_FOCUS_NODES })
        : t("Focus mode shows the selected node, its parent context, and its neighborhood."),
  };
}


function buildArchitecture(
  analysis: AnalysisResult,
  nodeById: Map<string, GraphNode>,
  t: Translate,
  _tn: TranslatePlural,
): ViewGraph {
  const architectural = analysis.nodes.filter(
    (node) => node.kind === "route" || node.kind === "database" || node.kind === "event",
  );
  const included = new Set(architectural.map((node) => node.id));
  const connectedSymbols = new Set<string>();
  const edges: GraphEdge[] = [];

  for (const edge of analysis.edges) {
    if (
      edge.kind !== "ROUTES_TO" &&
      edge.kind !== "READS_FROM" &&
      edge.kind !== "WRITES_TO" &&
      edge.kind !== "PUBLISHES" &&
      edge.kind !== "SUBSCRIBES_TO" &&
      edge.kind !== "MAPS_TO" &&
      edge.kind !== "RELATES_TO"
    ) {
      continue;
    }
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) continue;
    if (included.has(source.id) || included.has(target.id)) {
      edges.push(edge);
      if (!included.has(source.id)) connectedSymbols.add(source.id);
      if (!included.has(target.id)) connectedSymbols.add(target.id);
    }
  }

  for (const id of connectedSymbols) {
    const node = nodeById.get(id);
    if (node) included.add(id);
  }

  const nodes = [...included]
    .map((id) => nodeById.get(id))
    .filter((node): node is GraphNode => Boolean(node));

  const routes = nodes.filter((node) => node.kind === "route").length;
  const databases = nodes.filter((node) => node.kind === "database").length;
  const events = nodes.filter((node) => node.kind === "event").length;

  return {
    nodes,
    edges,
    title: t("Architecture map"),
    subtitle: [
      _tn(routes, "{count} route", "{count} routes"),
      _tn(databases, "{count} database object", "{count} database objects"),
      _tn(events, "{count} event", "{count} events"),
    ].join(" · "),
    notice:
      nodes.length === 0
        ? t(
            "No routes, database models, or events were detected. MVP 2 adapters cover Express, NestJS, Next.js, Prisma, TypeORM, Sequelize, and common event emitters.",
          )
        : undefined,
  };
}
