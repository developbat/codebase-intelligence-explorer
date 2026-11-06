import type {
  AnalysisResult,
  Certainty,
  ChangeReport,
  GitStatus,
  GraphEdge,
  GraphNode,
  GraphNodeKind,
} from "../../../shared/types";
import type { Translate } from "../i18n";

export type ViewMode = "universe" | "files" | "functions" | "architecture" | "changes" | "3d";

type TranslatePlural = (count: number, one: string, other: string, vars?: Record<string, string | number>) => string;

export interface ViewGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  title: string;
  subtitle: string;
  notice?: string;
}

interface BuildOptions {
  mode: ViewMode;
  analysis: AnalysisResult;
  selectedFolder: string | null;
  selectedFile: string | null;
  focusNodeId: string | null;
  depth: number;
  changeReport?: ChangeReport | null;
  gitStatus?: GitStatus | null;
  clusterFunctions?: boolean;
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
  const { mode, analysis, selectedFolder, selectedFile, focusNodeId, depth, changeReport, gitStatus, clusterFunctions, t, tn } = options;
  const nodeById = new Map(analysis.nodes.map((node) => [node.id, node]));

  if (mode === "universe") return buildUniverse(analysis, nodeById, t, tn);
  if (mode === "files") return buildFiles(analysis, nodeById, selectedFolder, t, tn);
  if (mode === "architecture") return buildArchitecture(analysis, nodeById, t, tn);
  if (mode === "changes") return buildChanges(analysis, nodeById, changeReport ?? null, gitStatus ?? null, t, tn);
  if (mode === "3d") {
    const base = selectedFile ? "functions" : selectedFolder ? "files" : "universe";
    return base === "functions"
      ? buildFunctions(analysis, nodeById, selectedFile, focusNodeId, depth, Boolean(clusterFunctions), t, tn)
      : base === "files"
        ? buildFiles(analysis, nodeById, selectedFolder, t, tn)
        : buildUniverse(analysis, nodeById, t, tn);
  }
  return buildFunctions(analysis, nodeById, selectedFile, focusNodeId, depth, Boolean(clusterFunctions), t, tn);
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
  t: Translate,
  tn: TranslatePlural,
): ViewGraph {
  const scope = selectedFolder ?? "";
  const scopeId = scope ? `folder:${scope}` : "project";
  const scopeNode = nodeById.get(scopeId);
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
