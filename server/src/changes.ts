import type {
  AnalysisResult,
  ChangeReport,
  GraphEdge,
  GraphNode,
  GitChangedFile,
  GitStatus,
  StructuralChange,
  SymbolRecord,
} from "../../shared/types";
import { analyzeProject } from "./analyzer";
import { getGitStatus } from "./git";

function symbolKey(symbol: SymbolRecord): string {
  return `${symbol.kind}:${symbol.qualifiedName}`;
}

function nodeIdentity(node: GraphNode | undefined): string {
  if (!node) return "?";
  if (node.metadata?.qualifiedName) return `${node.kind}:${node.metadata.qualifiedName}`;
  if (node.kind === "folder" || node.kind === "file") return `${node.kind}:${node.filePath ?? node.label}`;
  return `${node.kind}:${node.filePath ?? ""}:${node.label}`;
}

function edgeIdentity(edge: GraphEdge, nodeById: Map<string, GraphNode>): string {
  return `${nodeIdentity(nodeById.get(edge.source))}|${edge.kind}|${nodeIdentity(nodeById.get(edge.target))}`;
}

function structuralDiff(previous: AnalysisResult, next: AnalysisResult): StructuralChange[] {
  const previousFiles = new Map(previous.files.map((file) => [file.path, file]));
  const nextFiles = new Map(next.files.map((file) => [file.path, file]));
  const allFiles = new Set([...previousFiles.keys(), ...nextFiles.keys()]);
  const changes: StructuralChange[] = [];

  for (const filePath of allFiles) {
    const before = previousFiles.get(filePath);
    const after = nextFiles.get(filePath);
    if (before?.hash === after?.hash) continue;

    const beforeSymbols = new Map(
      previous.symbols.filter((symbol) => symbol.filePath === filePath).map((symbol) => [symbolKey(symbol), symbol]),
    );
    const afterSymbols = new Map(
      next.symbols.filter((symbol) => symbol.filePath === filePath).map((symbol) => [symbolKey(symbol), symbol]),
    );
    const addedSymbols: string[] = [];
    const removedSymbols: string[] = [];
    const changedSymbols: string[] = [];

    for (const [key, symbol] of afterSymbols) {
      const prior = beforeSymbols.get(key);
      if (!prior) addedSymbols.push(symbol.qualifiedName);
      else if (prior.hash && symbol.hash ? prior.hash !== symbol.hash : prior.signature !== symbol.signature) {
        changedSymbols.push(symbol.qualifiedName);
      }
    }
    for (const [key, symbol] of beforeSymbols) {
      if (!afterSymbols.has(key)) removedSymbols.push(symbol.qualifiedName);
    }

    const beforeById = new Map(previous.nodes.map((node) => [node.id, node]));
    const afterById = new Map(next.nodes.map((node) => [node.id, node]));
    const beforeEdges = new Set(previous.edges.map((edge) => edgeIdentity(edge, beforeById)));
    const afterEdges = new Set(next.edges.map((edge) => edgeIdentity(edge, afterById)));
    let addedEdges = 0;
    let removedEdges = 0;
    for (const edge of afterEdges) if (!beforeEdges.has(edge)) addedEdges += 1;
    for (const edge of beforeEdges) if (!afterEdges.has(edge)) removedEdges += 1;

    if (addedSymbols.length || removedSymbols.length || changedSymbols.length || addedEdges || removedEdges) {
      changes.push({ path: filePath, addedSymbols, removedSymbols, changedSymbols, addedEdges, removedEdges });
    }
  }

  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

function deriveChangedFiles(previous: AnalysisResult, next: AnalysisResult, git: GitStatus): GitChangedFile[] {
  const gitFiles = new Map(
    git.files.filter((file) => file.sinceAnalysis !== false).map((file) => [file.path, file]),
  );
  const previousFiles = new Map(previous.files.map((file) => [file.path, file]));
  const nextFiles = new Map(next.files.map((file) => [file.path, file]));
  const result = new Map(gitFiles);

  for (const [filePath, file] of nextFiles) {
    const before = previousFiles.get(filePath);
    if (!before) {
      if (!result.has(filePath)) {
        result.set(filePath, { path: filePath, status: "added", sinceAnalysis: true, impactLevel: "low" });
      }
    } else if (before.hash !== file.hash) {
      const existing = result.get(filePath);
      result.set(filePath, { ...(existing ?? { path: filePath, status: "modified" as const }), sinceAnalysis: true });
    }
  }
  for (const [filePath] of previousFiles) {
    if (!nextFiles.has(filePath) && !result.has(filePath)) {
      result.set(filePath, { path: filePath, status: "deleted", sinceAnalysis: true, impactLevel: "medium" });
    }
  }

  return [...result.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function impactAnalysis(analysis: AnalysisResult, changedPaths: Set<string>, changedSymbols: Set<string>) {
  const nodeById = new Map(analysis.nodes.map((node) => [node.id, node]));
  const reverse = new Map<string, GraphEdge[]>();
  for (const edge of analysis.edges) {
    if (edge.kind !== "CALLS" && edge.kind !== "IMPORTS" && edge.kind !== "ROUTES_TO") continue;
    reverse.set(edge.target, [...(reverse.get(edge.target) ?? []), edge]);
  }

  const seedIds = new Set<string>();
  for (const node of analysis.nodes) {
    if (node.filePath && changedPaths.has(node.filePath)) seedIds.add(node.id);
    if (node.metadata?.qualifiedName && changedSymbols.has(node.metadata.qualifiedName)) seedIds.add(node.id);
  }

  const depthById = new Map<string, number>();
  for (const id of seedIds) depthById.set(id, 0);
  let frontier = [...seedIds];
  for (let depth = 1; depth <= 3; depth += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of reverse.get(id) ?? []) {
        if (!depthById.has(edge.source)) {
          depthById.set(edge.source, depth);
          next.push(edge.source);
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  const nodes = [...depthById.entries()]
    .map(([id, depth]) => {
      const node = nodeById.get(id);
      return node ? { id, label: node.metadata?.qualifiedName ?? node.label, kind: node.kind, filePath: node.filePath, depth } : null;
    })
    .filter((node): node is NonNullable<typeof node> => Boolean(node))
    .sort((a, b) => a.depth - b.depth)
    .slice(0, 160);

  const routeIds = new Set<string>();
  for (const edge of analysis.edges) {
    if (edge.kind === "ROUTES_TO" && depthById.has(edge.target)) routeIds.add(edge.source);
    if (edge.kind === "ROUTES_TO" && nodeById.get(edge.source)?.filePath && changedPaths.has(nodeById.get(edge.source)!.filePath!)) {
      routeIds.add(edge.source);
    }
  }
  const routes = [...routeIds]
    .map((id) => nodeById.get(id))
    .filter((node): node is GraphNode => Boolean(node))
    .map((node) => ({ id: node.id, label: node.label, filePath: node.filePath }));

  const testFiles = new Set<string>();
  for (const node of analysis.nodes) {
    if (node.kind !== "file" || !node.filePath) continue;
    const isTest = /(^|\/)(__tests__|tests?|spec)\//i.test(node.filePath) || /\.(test|spec)\.[^.]+$/i.test(node.filePath);
    if (!isTest) continue;
    if (changedPaths.has(node.filePath)) {
      testFiles.add(node.filePath);
      continue;
    }
    const imports = analysis.edges.filter(
      (edge) => edge.kind === "IMPORTS" && edge.source === node.id,
    );
    if (imports.some((edge) => nodeById.get(edge.target)?.filePath && changedPaths.has(nodeById.get(edge.target)!.filePath!))) {
      testFiles.add(node.filePath);
    }
  }
  const tests = [...testFiles].map((filePath) => ({
    id: `file:${filePath}`,
    label: filePath.split("/").pop() ?? filePath,
    filePath,
  }));

  return { nodes, routes, tests };
}

export async function buildChangeReport(progressId: string): Promise<{
  report: ChangeReport;
  analysis: AnalysisResult;
}> {
  const { loadAnalysis } = await import("./store");
  const previous = await loadAnalysis(progressId);
  const next = await analyzeProject(previous.rootPath);
  const git = await getGitStatus(previous.rootPath, previous);
  const structural = structuralDiff(previous, next);
  const files = deriveChangedFiles(previous, next, git);

  const changedPaths = new Set(files.map((file) => file.path));
  const changedSymbols = new Set<string>();
  for (const change of structural) {
    for (const symbol of change.addedSymbols) changedSymbols.add(symbol);
    for (const symbol of change.removedSymbols) changedSymbols.add(symbol);
    for (const symbol of change.changedSymbols) changedSymbols.add(symbol);
  }
  const impact = impactAnalysis(next, changedPaths, changedSymbols);

  const addedFiles = files.filter((file) => file.status === "added" || file.status === "untracked").length;
  const removedFiles = files.filter((file) => file.status === "deleted").length;
  const changedSymbolsCount =
    structural.reduce(
      (sum, change) => sum + change.addedSymbols.length + change.removedSymbols.length + change.changedSymbols.length,
      0,
    );

  const report: ChangeReport = {
    projectId: progressId,
    generatedAt: new Date().toISOString(),
    git,
    files,
    impact,
    structural,
    summary: {
      changedFiles: files.length,
      addedFiles,
      removedFiles,
      changedSymbols: changedSymbolsCount,
      impactNodes: impact.nodes.length,
      callsAffected: analysisCallCount(impact.nodes.map((node) => node.id), next),
    },
    previousAnalysisId: previous.id,
  };

  return { report, analysis: next };
}

function analysisCallCount(nodeIds: string[], analysis: AnalysisResult): number {
  const ids = new Set(nodeIds);
  return analysis.edges.filter((edge) => edge.kind === "CALLS" && (ids.has(edge.source) || ids.has(edge.target))).length;
}
