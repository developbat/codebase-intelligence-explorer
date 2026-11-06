import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import ts from "typescript";
import type {
  AnalysisResult,
  Certainty,
  Evidence,
  FileRecord,
  GraphEdge,
  GraphNode,
  SymbolRecord,
} from "../../shared/types";
import { isWithin, scanProject, type ScannedFile } from "./scanner";
import { getGitSnapshot } from "./git";

const MAX_GRAPH_NODES = 12_000;
const MAX_BODY_CHARS = 12_000;
const MAX_EVIDENCE_PER_EDGE = 12;

/** Calls that resolve to TypeScript lib declarations are runtime/builtin noise. */
const TS_UTILITY_TYPES = new Set([
  "Record",
  "Partial",
  "Required",
  "Readonly",
  "Pick",
  "Omit",
  "Exclude",
  "Extract",
  "NonNullable",
  "ReturnType",
  "Parameters",
  "ConstructorParameters",
  "InstanceType",
  "ThisType",
  "Awaited",
  "Uppercase",
  "Lowercase",
  "Capitalize",
  "Uncapitalize",
]);

const BUILTIN_CALLS = new Set([
  "Set",
  "Map",
  "WeakMap",
  "WeakSet",
  "Promise",
  "Date",
  "RegExp",
  "Array",
  "Object",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "AbortController",
  "AbortSignal",
  "URL",
  "URLSearchParams",
  "TextEncoder",
  "TextDecoder",
  "Event",
  "EventTarget",
  "Blob",
  "FormData",
  "Headers",
  "Request",
  "Response",
  "Intl",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
  "fetch",
  "require",
  "structuredClone",
  "encodeURIComponent",
  "decodeURIComponent",
  "String",
  "Number",
  "Boolean",
  "Object",
  "Array",
  "Promise",
  "Error",
  "JSON",
  "Math",
  "Date",
  "RegExp",
  "Symbol",
  "BigInt",
]);

interface ExtractedSymbol extends SymbolRecord {
  decl: ts.Node;
  rangeNode: ts.Node;
}

interface AnalyzeOptions {
  signal?: AbortSignal;
}

interface GraphBuilder {
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
  truncated: boolean;
}

export function projectIdForPath(rootPath: string): string {
  return crypto.createHash("sha1").update(rootPath).digest("hex").slice(0, 16);
}

function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = (node as ts.HasModifiers).modifiers;
  return Boolean(modifiers?.some((modifier) => modifier.kind === kind));
}

function isExported(node: ts.Node): boolean {
  if (hasModifier(node, ts.SyntaxKind.ExportKeyword) || hasModifier(node, ts.SyntaxKind.DefaultKeyword)) {
    return true;
  }
  if (ts.isVariableDeclaration(node)) {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (ts.isVariableStatement(current)) {
        return hasModifier(current, ts.SyntaxKind.ExportKeyword);
      }
      if (ts.isSourceFile(current) || ts.isBlock(current)) break;
      current = current.parent;
    }
  }
  return false;
}

function packageNameOf(specifier: string): string {
  if (specifier.startsWith("node:")) return specifier.slice(5);
  const parts = specifier.split("/");
  if (specifier.startsWith("@") && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

function trimSource(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n/* … truncated … */` : text;
}

function loadCompilerOptions(tsconfigPath: string | null): ts.CompilerOptions {
  const defaults: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    allowJs: true,
    checkJs: false,
    skipLibCheck: true,
    resolveJsonModule: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    noEmit: true,
    declaration: false,
    composite: false,
    incremental: false,
  };
  if (!tsconfigPath) return defaults;

  const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (read.error) return defaults;

  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(tsconfigPath), undefined, tsconfigPath);
  return {
    ...defaults,
    ...parsed.options,
    noEmit: true,
    declaration: false,
    composite: false,
    incremental: false,
    allowJs: true,
    skipLibCheck: true,
    jsx: parsed.options.jsx ?? defaults.jsx,
  };
}

function addNode(graph: GraphBuilder, node: GraphNode): boolean {
  if (graph.nodes.has(node.id)) return true;
  if (graph.nodes.size >= MAX_GRAPH_NODES) {
    graph.truncated = true;
    return false;
  }
  graph.nodes.set(node.id, node);
  return true;
}

function addEdge(
  graph: GraphBuilder,
  source: string,
  target: string,
  kind: GraphEdge["kind"],
  certainty: Certainty,
  evidence?: Evidence,
): void {
  const key = `${source}|${target}|${kind}|${certainty}`;
  const existing = graph.edges.get(key);
  if (existing) {
    if (evidence && (existing.evidence?.length ?? 0) < MAX_EVIDENCE_PER_EDGE) {
      const duplicate = existing.evidence?.some(
        (item) =>
          item.filePath === evidence.filePath &&
          item.startLine === evidence.startLine &&
          item.endLine === evidence.endLine,
      );
      if (!duplicate) existing.evidence?.push(evidence);
    }
    return;
  }
  graph.edges.set(key, {
    id: `edge:${graph.edges.size + 1}`,
    source,
    target,
    kind,
    certainty,
    evidence: evidence ? [evidence] : undefined,
  });
}

function buildFunctionSignature(
  sf: ts.SourceFile,
  name: string,
  node: ts.SignatureDeclaration,
): string {
  const typeParams = node.typeParameters?.map((param) => param.getText(sf)).join(", ");
  const params = node.parameters.map((param) => param.getText(sf)).join(", ");
  const returnType = node.type?.getText(sf);
  const isAsync = hasModifier(node, ts.SyntaxKind.AsyncKeyword);
  return `${isAsync ? "async " : ""}${name}${typeParams ? `<${typeParams}>` : ""}(${params})${returnType ? `: ${returnType}` : ""}`;
}

function bodyOf(sf: ts.SourceFile, node: ts.SignatureDeclaration): string | undefined {
  const body = (node as ts.SignatureDeclaration & { body?: ts.ConciseBody }).body;
  if (!body) return undefined;
  if (ts.isBlock(body)) return trimSource(body.getText(sf), MAX_BODY_CHARS);
  return `return ${trimSource(body.getText(sf), MAX_BODY_CHARS)};`;
}

function rangeFor(sf: ts.SourceFile, node: ts.Node) {
  return {
    startLine: lineOf(sf, node.getStart(sf)),
    endLine: lineOf(sf, node.getEnd()),
  };
}

/**
 * Builds the knowledge graph for a project using the TypeScript compiler API.
 * Read-only: sources are parsed, never executed, written or modified.
 */
export async function analyzeProject(inputPath: string, options: AnalyzeOptions = {}): Promise<AnalysisResult> {
  const startedAt = Date.now();
  const scan = await scanProject(inputPath, { signal: options.signal });
  const { rootPath, files, warnings } = scan;

  const graph: GraphBuilder = { nodes: new Map(), edges: new Map(), truncated: false };
  const fileRecords: FileRecord[] = [];
  const symbols: ExtractedSymbol[] = [];
  const symbolByDecl = new Map<ts.Node, ExtractedSymbol>();
  const classByDecl = new Map<ts.Node, ExtractedSymbol>();
  const symbolsByName = new Map<string, ExtractedSymbol[]>();

  const projectId = projectIdForPath(rootPath);
  addNode(graph, {
    id: "project",
    kind: "project",
    label: scan.projectName,
    metadata: {
      fileCount: files.length,
      folderCount: 0,
      symbolCount: 0,
    },
  });

  // ---------------------------------------------------------------------
  // Folders
  // ---------------------------------------------------------------------
  const folderSet = new Set<string>();
  for (const file of files) {
    const dir = path.posix.dirname(file.relPath);
    if (dir === ".") continue;
    const segments = dir.split("/");
    for (let i = 1; i <= segments.length; i += 1) {
      folderSet.add(segments.slice(0, i).join("/"));
    }
  }
  for (const folder of [...folderSet].sort((a, b) => a.localeCompare(b))) {
    const parentRel = path.posix.dirname(folder);
    const parentId = parentRel === "." ? "project" : `folder:${parentRel}`;
    addNode(graph, {
      id: `folder:${folder}`,
      kind: "folder",
      label: path.posix.basename(folder),
      filePath: folder,
      parentId,
      metadata: { aggregate: true },
    });
    addEdge(graph, parentId, `folder:${folder}`, "CONTAINS", "confirmed");
  }

  // ---------------------------------------------------------------------
  // Files
  // ---------------------------------------------------------------------
  for (const file of files) {
    const dir = path.posix.dirname(file.relPath);
    const parentId = dir === "." ? "project" : `folder:${dir}`;
    const fileNodeId = `file:${file.relPath}`;
    addNode(graph, {
      id: fileNodeId,
      kind: "file",
      label: path.posix.basename(file.relPath),
      filePath: file.relPath,
      language: file.language,
      parentId,
    });
    addEdge(graph, parentId, fileNodeId, "CONTAINS", "confirmed");

    fileRecords.push({
      id: fileNodeId,
      path: file.relPath,
      language: file.language,
      bytes: file.bytes,
      loc: file.loc,
      hash: file.hash,
      imports: [],
    });
  }

  // ---------------------------------------------------------------------
  // Compiler program
  // ---------------------------------------------------------------------
  const compilerOptions = loadCompilerOptions(scan.tsconfigPath);
  const program = ts.createProgram({
    rootNames: files.map((file) => file.absPath),
    options: compilerOptions,
  });
  const checker = program.getTypeChecker();
  const scannedByAbs = new Map(files.map((file) => [path.resolve(file.absPath), file]));

  const sourceFiles = new Map<string, ts.SourceFile>();
  for (const file of files) {
    const sourceFile = program.getSourceFile(file.absPath);
    if (sourceFile) sourceFiles.set(file.relPath, sourceFile);
    else warnings.push(`${file.relPath} could not be added to the TypeScript program.`);
  }

  // ---------------------------------------------------------------------
  // Symbol extraction
  // ---------------------------------------------------------------------
  function registerSymbol(
    file: ScannedFile,
    sf: ts.SourceFile,
    options: {
      node: ts.Node;
      rangeNode?: ts.Node;
      name: string;
      kind: ExtractedSymbol["kind"];
      parent?: ExtractedSymbol;
      signature: string;
      parameters?: string[];
      returnType?: string;
      body?: string;
    },
  ): ExtractedSymbol {
    const rangeNode = options.rangeNode ?? options.node;
    const { startLine, endLine } = rangeFor(sf, rangeNode);
    const qualifiedName = options.parent ? `${options.parent.qualifiedName}.${options.name}` : options.name;
    const id = `symbol:${file.relPath}#${qualifiedName}@${startLine}`;
    const parentId = options.parent ? options.parent.id : `file:${file.relPath}`;

    const record: ExtractedSymbol = {
      id,
      name: options.name,
      qualifiedName,
      kind: options.kind,
      filePath: file.relPath,
      startLine,
      endLine,
      signature: options.signature,
      parameters: options.parameters ?? [],
      returnType: options.returnType,
      exported: isExported(options.node) || isExported(rangeNode),
      async: hasModifier(options.node, ts.SyntaxKind.AsyncKeyword),
      parentSymbolId: options.parent?.id,
      body: options.body,
      hash: crypto
        .createHash("sha1")
        .update(`${options.signature}\n${options.body ?? ""}`)
        .digest("hex"),
      decl: options.node,
      rangeNode,
    };

    symbols.push(record);
    symbolByDecl.set(options.node, record);
    if (options.kind === "class" || options.kind === "interface") {
      classByDecl.set(options.node, record);
    }
    const list = symbolsByName.get(record.name);
    if (list) list.push(record);
    else symbolsByName.set(record.name, [record]);

    const added = addNode(graph, {
      id,
      kind: options.kind,
      label: options.name,
      filePath: file.relPath,
      startLine,
      endLine,
      language: file.language,
      parentId,
      metadata: {
        qualifiedName,
        signature: options.signature,
        parameters: record.parameters,
        returnType: record.returnType,
        exported: record.exported,
        async: record.async,
        arrow: options.node !== rangeNode,
        callCount: 0,
        callerCount: 0,
      },
    });
    if (!added) {
      // Graph is capped but the symbol remains resolvable for call targets.
      return record;
    }
    addEdge(graph, parentId, id, "CONTAINS", "confirmed", {
      filePath: file.relPath,
      startLine,
      endLine,
      description: `${options.kind} definition`,
    });
    return record;
  }

  function functionSymbol(
    file: ScannedFile,
    sf: ts.SourceFile,
    node: ts.SignatureDeclaration,
    name: string,
    parent?: ExtractedSymbol,
    rangeNode?: ts.Node,
  ): ExtractedSymbol {
    return registerSymbol(file, sf, {
      node,
      rangeNode,
      name,
      kind: parent ? "method" : "function",
      parent,
      signature: buildFunctionSignature(sf, name, node),
      parameters: node.parameters.map((param) => param.name.getText(sf)),
      returnType: node.type?.getText(sf),
      body: bodyOf(sf, node),
    });
  }

  function walkCommonJsExport(
    statement: ts.ExpressionStatement,
    file: ScannedFile,
    sf: ts.SourceFile,
    parent?: ExtractedSymbol,
  ): boolean {
    if (!ts.isBinaryExpression(statement.expression)) return false;
    const assignment = statement.expression;
    if (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
    const left = assignment.left;
    const right = assignment.right;
    let name: string | null = null;
    if (ts.isPropertyAccessExpression(left)) {
      const target = left.expression;
      const isExportsTarget =
        (ts.isIdentifier(target) && target.text === "exports") ||
        (ts.isPropertyAccessExpression(target) &&
          ts.isIdentifier(target.expression) &&
          target.expression.text === "module" &&
          target.name.text === "exports");
      if (isExportsTarget) name = left.name.text;
    }
    if (!name || (!ts.isArrowFunction(right) && !ts.isFunctionExpression(right))) return false;
    const symbol = functionSymbol(file, sf, right, name, parent, statement);
    if (ts.isBlock(right.body)) scanNested(right.body, file, sf, symbol);
    return true;
  }

  function scanNested(node: ts.Node, file: ScannedFile, sf: ts.SourceFile, parent?: ExtractedSymbol): void {
    ts.forEachChild(node, (child) => {
      if (ts.isExpressionStatement(child) && walkCommonJsExport(child, file, sf, parent)) {
        return;
      }
      if (ts.isFunctionDeclaration(child)) {
        const name = child.name?.text ?? "default";
        const symbol = functionSymbol(file, sf, child, name, parent);
        if (child.body) scanNested(child.body, file, sf, symbol);
        return;
      }
      if (ts.isClassDeclaration(child)) {
        walkClass(child, file, sf, parent);
        return;
      }
      if (ts.isInterfaceDeclaration(child) || ts.isTypeAliasDeclaration(child) || ts.isEnumDeclaration(child)) {
        walkStatement(child, file, sf, parent);
        return;
      }
      if (ts.isVariableStatement(child)) {
        walkVariableStatement(child, file, sf, parent);
        return;
      }
      scanNested(child, file, sf, parent);
    });
  }

  function walkVariableStatement(
    node: ts.VariableStatement,
    file: ScannedFile,
    sf: ts.SourceFile,
    parent?: ExtractedSymbol,
  ): void {
    for (const declaration of node.declarationList.declarations) {
      if (!declaration.initializer) continue;
      const init = declaration.initializer;
      if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && ts.isIdentifier(declaration.name)) {
        const name = declaration.name.text;
        const symbol = functionSymbol(file, sf, init, name, parent, declaration);
        if (ts.isBlock(init.body)) scanNested(init.body, file, sf, symbol);
      }
    }
  }

  function walkClass(
    node: ts.ClassDeclaration,
    file: ScannedFile,
    sf: ts.SourceFile,
    parent?: ExtractedSymbol,
  ): void {
    const name = node.name?.text ?? "default";
    const classSymbol = registerSymbol(file, sf, {
      node,
      name,
      kind: "class",
      parent,
      signature: node.name ? `class ${node.name.text}` : "class",
    });

    for (const member of node.members) {
      if (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member) || ts.isGetAccessor(member) || ts.isSetAccessor(member)) {
        let memberName = "constructor";
        if (ts.isGetAccessor(member)) memberName = `get ${member.name.getText(sf)}`;
        else if (ts.isSetAccessor(member)) memberName = `set ${member.name.getText(sf)}`;
        else if (!ts.isConstructorDeclaration(member) && member.name) memberName = member.name.getText(sf);
        const methodSymbol = functionSymbol(file, sf, member, memberName, classSymbol, member);
        if (member.body) scanNested(member.body, file, sf, methodSymbol);
      } else if (ts.isPropertyDeclaration(member) && member.initializer) {
        const init = member.initializer;
        if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && member.name) {
          const methodSymbol = functionSymbol(file, sf, init, member.name.getText(sf), classSymbol, member);
          if (ts.isBlock(init.body)) scanNested(init.body, file, sf, methodSymbol);
        }
      } else if (ts.isClassDeclaration(member)) {
        walkClass(member, file, sf, classSymbol);
      }
    }
  }

  function walkStatement(
    node: ts.Statement,
    file: ScannedFile,
    sf: ts.SourceFile,
    parent?: ExtractedSymbol,
  ): void {
    if (ts.isFunctionDeclaration(node)) {
      const name = node.name?.text ?? "default";
      const symbol = functionSymbol(file, sf, node, name, parent);
      if (node.body) scanNested(node.body, file, sf, symbol);
      return;
    }
    if (ts.isClassDeclaration(node)) {
      walkClass(node, file, sf, parent);
      return;
    }
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
      const kind = ts.isInterfaceDeclaration(node)
        ? "interface"
        : ts.isTypeAliasDeclaration(node)
          ? "type"
          : "enum";
      const name = node.name.text;
      registerSymbol(file, sf, {
        node,
        name,
        kind,
        parent,
        signature: trimSource(node.getText(sf).replace(/\s+/g, " "), 220),
      });
      return;
    }
    if (ts.isVariableStatement(node)) {
      walkVariableStatement(node, file, sf, parent);
      return;
    }
    if (ts.isExpressionStatement(node) && walkCommonJsExport(node, file, sf, parent)) {
      return;
    }
    scanNested(node, file, sf, parent);
  }

  for (const file of files) {
    const sf = sourceFiles.get(file.relPath);
    if (!sf) continue;
    for (const statement of sf.statements) {
      walkStatement(statement, file, sf);
    }
  }

  // ---------------------------------------------------------------------
  // Imports / exports and internal module edges
  // ---------------------------------------------------------------------
  const externalModules = new Set<string>();
  for (const file of files) {
    const sf = sourceFiles.get(file.relPath);
    if (!sf) continue;
    const record = fileRecords.find((item) => item.path === file.relPath);
    if (!record) continue;
    const ownerRecord = record;
    const ownerSource = sf;

    function addSpecifier(
      specifierNode: ts.StringLiteralLike,
      isExport: boolean,
      mode: "static" | "require" | "dynamic",
    ): void {
      const specifier = specifierNode.text;
      if (!ownerRecord.imports.includes(specifier)) ownerRecord.imports.push(specifier);

      const resolved = ts.resolveModuleName(specifier, file.absPath, compilerOptions, ts.sys).resolvedModule;
      const resolvedPath = resolved ? path.resolve(resolved.resolvedFileName) : null;
      const target = resolvedPath ? scannedByAbs.get(resolvedPath) : undefined;
      const evidence: Evidence = {
        filePath: file.relPath,
        startLine: lineOf(ownerSource, specifierNode.getStart(ownerSource)),
        endLine: lineOf(ownerSource, specifierNode.getEnd()),
        description: `${isExport ? "Re-export" : mode === "require" ? "require()" : mode === "dynamic" ? "Dinamik import" : "Import"}: ${specifier}`,
      };

      if (target) {
        addEdge(
          graph,
          `file:${file.relPath}`,
          `file:${target.relPath}`,
          isExport ? "EXPORTS" : "IMPORTS",
          mode === "static" ? "confirmed" : "inferred",
          evidence,
        );
        return;
      }

      if (!specifier.startsWith(".") && !specifier.startsWith("/") && !path.isAbsolute(specifier)) {
        const packageName = packageNameOf(specifier);
        if (!packageName) return;
        externalModules.add(packageName);
        const moduleId = `module:${packageName}`;
        addNode(graph, {
          id: moduleId,
          kind: "module",
          label: packageName,
          parentId: "project",
          metadata: { external: true, packageName },
        });
        addEdge(
          graph,
          `file:${file.relPath}`,
          moduleId,
          "IMPORTS",
          mode === "static" ? "confirmed" : "inferred",
          evidence,
        );
      } else if (resolvedPath && !isWithin(rootPath, resolvedPath)) {
        // Relative import escaping the project root cannot be analyzed.
        const label = specifier;
        const unresolvedId = `unresolved:${label}`;
        addNode(graph, {
          id: unresolvedId,
          kind: "module",
          label,
          metadata: { unresolved: true },
        });
        addEdge(graph, `file:${file.relPath}`, unresolvedId, "IMPORTS", "unresolved", evidence);
      }
    }

    for (const statement of sf.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        addSpecifier(statement.moduleSpecifier, false, "static");
      } else if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        addSpecifier(statement.moduleSpecifier, true, "static");
      } else if (
        ts.isImportEqualsDeclaration(statement) &&
        ts.isExternalModuleReference(statement.moduleReference) &&
        ts.isStringLiteral(statement.moduleReference.expression)
      ) {
        addSpecifier(statement.moduleReference.expression, false, "static");
      }
    }

    // CommonJS require() and dynamic import() are still static source evidence
    // when the specifier is a string literal.
    const visitDynamicImport = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.arguments.length === 1) {
        const argument = node.arguments[0];
        if (ts.isStringLiteralLike(argument)) {
          if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
            addSpecifier(argument, false, "require");
          } else if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
            addSpecifier(argument, false, "dynamic");
          }
        }
      }
      ts.forEachChild(node, visitDynamicImport);
    };
    visitDynamicImport(sf);
  }

  // ---------------------------------------------------------------------
  // Heritage (extends / implements)
  // ---------------------------------------------------------------------
  function resolveNamedSymbol(expression: ts.Expression, filePath: string): ExtractedSymbol | undefined {
    const symbol = checker.getSymbolAtLocation(expression);
    if (symbol) {
      const declarations = symbol.declarations ?? [];
      for (const declaration of declarations) {
        const direct = classByDecl.get(declaration) ?? symbolByDecl.get(declaration);
        if (direct) return direct;
        if (declaration.parent) {
          const parent = classByDecl.get(declaration.parent) ?? symbolByDecl.get(declaration.parent);
          if (parent) return parent;
        }
      }
    }
    const name = ts.isIdentifier(expression)
      ? expression.text
      : ts.isPropertyAccessExpression(expression)
        ? expression.name.text
        : expression.getText();
    const candidates = symbolsByName.get(name) ?? [];
    const sameFile = candidates.filter((candidate) => candidate.filePath === filePath);
    if (sameFile.length === 1) return sameFile[0];
    if (candidates.length === 1) return candidates[0];
    return undefined;
  }

  for (const symbol of symbols) {
    if (symbol.kind !== "class" && symbol.kind !== "interface") continue;
    if (!ts.isClassDeclaration(symbol.decl) && !ts.isInterfaceDeclaration(symbol.decl)) continue;
    const sf = sourceFiles.get(symbol.filePath);
    if (!sf) continue;
    for (const clause of symbol.decl.heritageClauses ?? []) {
      const kind = clause.token === ts.SyntaxKind.ExtendsKeyword ? "EXTENDS" : "IMPLEMENTS";
      for (const type of clause.types) {
        const target = resolveNamedSymbol(type.expression, symbol.filePath);
        const evidence: Evidence = {
          filePath: symbol.filePath,
          startLine: lineOf(sf, type.getStart(sf)),
          endLine: lineOf(sf, type.getEnd()),
          description: `${kind === "EXTENDS" ? "Inheritance" : "Interface implementation"}: ${type.getText(sf)}`,
        };
        if (target) {
          addEdge(graph, symbol.id, target.id, kind, "confirmed", evidence);
          continue;
        }
        const name = type.expression.getText(sf);
        const heritageInfo = calleeSymbolInfo(type.expression);
        if (TS_UTILITY_TYPES.has(name) || heritageInfo.external) {
          // TypeScript utility types and external base classes are not
          // unresolved project symbols.
          continue;
        }
        {
          const unresolvedId = `unresolved:${name}`;
          addNode(graph, {
            id: unresolvedId,
            kind: "class",
            label: name,
            metadata: { unresolved: true },
          });
          addEdge(graph, symbol.id, unresolvedId, kind, "unresolved", evidence);
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // Call graph
  // ---------------------------------------------------------------------
  function declarationTarget(declaration: ts.Node | undefined): ExtractedSymbol | undefined {
    if (!declaration) return undefined;
    const direct = symbolByDecl.get(declaration);
    if (direct) return direct;

    if (ts.isConstructorDeclaration(declaration) && declaration.parent) {
      return classByDecl.get(declaration.parent);
    }
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      return symbolByDecl.get(declaration.initializer);
    }
    if (ts.isPropertyDeclaration(declaration) && declaration.initializer) {
      return symbolByDecl.get(declaration.initializer);
    }

    let current: ts.Node | undefined = declaration;
    while (current) {
      const mapped = symbolByDecl.get(current);
      if (mapped) return mapped;
      current = current.parent;
    }
    return undefined;
  }

  function calleeName(expression: ts.Expression): string | null {
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    if (ts.isParenthesizedExpression(expression)) return calleeName(expression.expression);
    return null;
  }

  function collectCalls(root: ts.SignatureDeclaration, sf: ts.SourceFile) {
    const calls: (ts.CallExpression | ts.NewExpression)[] = [];
    function visit(node: ts.Node) {
      if (node !== root) {
        if (
          ts.isFunctionDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          ts.isArrowFunction(node) ||
          ts.isMethodDeclaration(node) ||
          ts.isConstructorDeclaration(node) ||
          ts.isGetAccessor(node) ||
          ts.isSetAccessor(node)
        ) {
          return;
        }
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) calls.push(node);
      ts.forEachChild(node, visit);
    }
    visit(root);
    return calls;
  }

  const unresolvedSeen = new Set<string>();

  function isExternalDeclaration(declaration: ts.Declaration): boolean {
    const file = declaration.getSourceFile();
    return file.isDeclarationFile || file.fileName.includes("node_modules");
  }

  function calleeSymbolInfo(expression: ts.Expression): {
    external: boolean;
    localRuntimeValue: boolean;
    exists: boolean;
  } {
    let symbol = checker.getSymbolAtLocation(expression);
    if (!symbol) return { external: false, localRuntimeValue: false, exists: false };
    if (symbol.flags & ts.SymbolFlags.Alias) {
      try {
        symbol = checker.getAliasedSymbol(symbol);
      } catch {
        // keep the alias symbol
      }
    }
    const declarations = symbol.declarations ?? [];
    const external = declarations.length > 0 && declarations.every(isExternalDeclaration);
    const localRuntimeValue = declarations.some((declaration) => {
      if (ts.isBindingElement(declaration) || ts.isVariableDeclaration(declaration)) {
        if (symbolByDecl.has(declaration)) return false;
        if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
          if (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) {
            return false;
          }
        }
        return true;
      }
      return false;
    });
    return { external, localRuntimeValue, exists: true };
  }

  for (const symbol of symbols) {
    if (symbol.kind !== "function" && symbol.kind !== "method") continue;
    if (!ts.isFunctionLike(symbol.decl)) continue;
    const sf = sourceFiles.get(symbol.filePath);
    if (!sf) continue;

    for (const call of collectCalls(symbol.decl, sf)) {
      const callLine = lineOf(sf, call.getStart(sf));
      const evidence: Evidence = {
        filePath: symbol.filePath,
        startLine: callLine,
        endLine: lineOf(sf, call.getEnd()),
        description: `Call: ${call.getText(sf).replace(/\s+/g, " ").slice(0, 140)}`,
      };

      const calleeInfo = calleeSymbolInfo(call.expression);
      if (calleeInfo.external) {
        // Calls into node_modules / lib.d.ts are external APIs, not unresolved
        // inner-project relationships.
        continue;
      }

      const simpleCallee = calleeName(call.expression);
      if (simpleCallee && BUILTIN_CALLS.has(simpleCallee)) {
        continue;
      }

      if (ts.isNewExpression(call)) {
        const classTarget = resolveNamedSymbol(call.expression, symbol.filePath);
        if (classTarget && classTarget.kind === "class") {
          addEdge(graph, symbol.id, classTarget.id, "CALLS", "confirmed", evidence);
          continue;
        }
      }

      if (calleeInfo.localRuntimeValue) {
        // A local value that holds a callback / state setter is a runtime
        // dispatch, not an unknown project function. Do not create a noisy
        // unresolved node for every setter.
        continue;
      }

      const signature = checker.getResolvedSignature(call);
      const declaration = signature?.getDeclaration();
      const target = declarationTarget(declaration);
      if (target) {
        const isExternal =
          declaration?.getSourceFile().fileName.includes("node_modules") ||
          declaration?.getSourceFile().isDeclarationFile;
        if (!isExternal) {
          addEdge(graph, symbol.id, target.id, "CALLS", "confirmed", evidence);
        }
        continue;
      }

      const name = calleeName(call.expression);
      if (!name || BUILTIN_CALLS.has(name)) continue;

      const propertyCall = ts.isPropertyAccessExpression(call.expression);
      const thisCall = propertyCall && call.expression.expression.kind === ts.SyntaxKind.ThisKeyword;
      const candidates = symbolsByName.get(name) ?? [];
      const sameFile = candidates.filter((candidate) => candidate.filePath === symbol.filePath);

      if (thisCall) {
        const methodCandidates = sameFile.filter((candidate) => candidate.kind === "method");
        if (methodCandidates.length === 1) {
          addEdge(graph, symbol.id, methodCandidates[0].id, "CALLS", "inferred", evidence);
          continue;
        }
      }

      // Property calls that the checker could not resolve are usually external
      // or dynamic dispatch. Do not guess a target for them.
      if (propertyCall) continue;

      const inferredTarget = sameFile.length === 1 ? sameFile[0] : candidates.length === 1 ? candidates[0] : null;
      if (inferredTarget) {
        addEdge(graph, symbol.id, inferredTarget.id, "CALLS", "inferred", evidence);
        continue;
      }

      const unresolvedId = `unresolved:${name}`;
      if (!unresolvedSeen.has(unresolvedId)) {
        unresolvedSeen.add(unresolvedId);
        addNode(graph, {
          id: unresolvedId,
          kind: "function",
          label: name,
          metadata: { unresolved: true },
        });
      }
      addEdge(graph, symbol.id, unresolvedId, "CALLS", "unresolved", evidence);
    }
  }

  // ---------------------------------------------------------------------
  // MVP 2: framework and architecture adapters
  // ---------------------------------------------------------------------
  const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "all"]);
  const NEST_METHODS: Record<string, string> = {
    Get: "GET",
    Post: "POST",
    Put: "PUT",
    Patch: "PATCH",
    Delete: "DELETE",
    Options: "OPTIONS",
    Head: "HEAD",
    All: "ANY",
  };
  const routeIds = new Set<string>();

  function simpleName(node: ts.Expression | ts.Node): string | null {
    if (ts.isIdentifier(node)) return node.text;
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    return null;
  }

  function enclosingSymbolOf(node: ts.Node): ExtractedSymbol | undefined {
    let current: ts.Node | undefined = node;
    while (current) {
      const found = symbolByDecl.get(current);
      if (found) return found;
      current = current.parent;
    }
    return undefined;
  }

  function decoratorInfos(node: ts.Node): { name: string; args?: ts.NodeArray<ts.Expression>; line: number }[] {
    if (!ts.canHaveDecorators(node)) return [];
    const decorators = ts.getDecorators(node) ?? [];
    return decorators.map((decorator) => {
      const expression = decorator.expression;
      const line = lineOf(decorator.getSourceFile(), decorator.getStart());
      if (ts.isCallExpression(expression)) {
        return { name: simpleName(expression.expression) ?? "", args: expression.arguments, line };
      }
      return { name: simpleName(expression) ?? "", line };
    });
  }

  function stringArgument(args: ts.NodeArray<ts.Expression> | undefined, index = 0): string | null {
    const argument = args?.[index];
    if (!argument) return null;
    if (ts.isStringLiteralLike(argument)) return argument.text;
    if (ts.isObjectLiteralExpression(argument)) {
      for (const property of argument.properties) {
        if (ts.isPropertyAssignment(property)) {
          const name = property.name.getText();
          if (["tableName", "name", "collection"].includes(name) && ts.isStringLiteralLike(property.initializer)) {
            return property.initializer.text;
          }
        }
      }
    }
    return null;
  }

  function joinRoutePath(base: string, suffix: string): string {
    const parts = [base, suffix]
      .map((part) => part.trim().replace(/^\/+|\/+$/g, ""))
      .filter(Boolean);
    return `/${parts.join("/")}`;
  }

  function addRouteNode(options: {
    method: string;
    routePath: string;
    file: ScannedFile;
    sf: ts.SourceFile;
    startLine: number;
    endLine?: number;
    framework: string;
    target?: ExtractedSymbol;
    certainty?: Certainty;
    description?: string;
  }): void {
    const { method, routePath, file, startLine, endLine, framework, target } = options;
    const id = `route:${method}:${routePath}@${file.relPath}:${startLine}`;
    if (routeIds.has(id)) return;
    routeIds.add(id);
    const added = addNode(graph, {
      id,
      kind: "route",
      label: `${method} ${routePath}`,
      filePath: file.relPath,
      startLine,
      endLine: endLine ?? startLine,
      language: file.language,
      parentId: "project",
      metadata: { method, path: routePath, framework, signature: `${method} ${routePath}` },
    });
    if (!added) return;
    if (target) {
      addEdge(graph, id, target.id, "ROUTES_TO", options.certainty ?? "inferred", {
        filePath: file.relPath,
        startLine,
        endLine: endLine ?? startLine,
        description: options.description ?? `${framework} route ${method} ${routePath}`,
      });
    }
  }

  // Express / Fastify / Koa / Hono style app.get("/path", handler)
  for (const file of files) {
    const sf = sourceFiles.get(file.relPath);
    if (!sf) continue;
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        HTTP_METHODS.has(node.expression.name.text.toLowerCase())
      ) {
        const method = node.expression.name.text.toUpperCase() === "ALL" ? "ANY" : node.expression.name.text.toUpperCase();
        const first = node.arguments[0];
        const receiver = node.expression.expression.getText(sf);
        const routeContext =
          /(^|\.)(app|router|routes?|server|api|fastify|hono)$/i.test(receiver) ||
          /(route|controller|endpoint|api)/i.test(file.relPath);
        if (routeContext && first && ts.isStringLiteralLike(first) && first.text.startsWith("/")) {
          const handler = node.arguments[1];
          let target: ExtractedSymbol | undefined;
          if (handler && !ts.isArrowFunction(handler) && !ts.isFunctionExpression(handler)) {
            target = resolveNamedSymbol(handler, file.relPath);
          }
          addRouteNode({
            method,
            routePath: first.text,
            file,
            sf,
            startLine: lineOf(sf, node.getStart(sf)),
            endLine: lineOf(sf, node.getEnd()),
            framework: "Express-compatible",
            target,
            certainty: "inferred",
            description: `Framework route registration: ${node.getText(sf).replace(/\s+/g, " ").slice(0, 160)}`,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  // NestJS decorators
  for (const symbol of symbols) {
    if (symbol.kind !== "class" || !ts.isClassDeclaration(symbol.decl)) continue;
    const sf = sourceFiles.get(symbol.filePath);
    if (!sf) continue;
    const classDecorators = decoratorInfos(symbol.decl);
    const controller = classDecorators.find((decorator) => decorator.name === "Controller");
    if (!controller) continue;
    const basePath = stringArgument(controller.args, 0) ?? "";
    for (const member of symbol.decl.members) {
      if (!ts.isMethodDeclaration(member)) continue;
      const methodSymbol = symbolByDecl.get(member);
      if (!methodSymbol) continue;
      for (const decorator of decoratorInfos(member)) {
        const httpMethod = NEST_METHODS[decorator.name];
        if (!httpMethod) continue;
        const suffix = stringArgument(decorator.args, 0) ?? "";
        addRouteNode({
          method: httpMethod,
          routePath: joinRoutePath(basePath, suffix),
          file: files.find((candidate) => candidate.relPath === symbol.filePath)!,
          sf,
          startLine: lineOf(sf, member.getStart(sf)),
          endLine: lineOf(sf, member.getEnd()),
          framework: "NestJS",
          target: methodSymbol,
          certainty: "confirmed",
          description: `NestJS @${decorator.name} decorator`,
        });
      }
    }
  }

  function nextDynamicPath(segment: string): string {
    const optionalCatchAll = segment.match(/^\[\[\.\.\.(.+)\]\]$/);
    if (optionalCatchAll) return `*`;
    const catchAll = segment.match(/^\[\.\.\.(.+)\]$/);
    if (catchAll) return `*`;
    const dynamic = segment.match(/^\[(.+)\]$/);
    if (dynamic) return `:${dynamic[1]}`;
    return segment;
  }

  function defaultExportSymbol(sf: ts.SourceFile, filePath: string): ExtractedSymbol | undefined {
    for (const statement of sf.statements) {
      if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
        if (ts.isIdentifier(statement.expression)) {
          const found = symbolByDecl.get(statement.expression);
          if (found) return found;
          const candidates = (symbolsByName.get(statement.expression.text) ?? []).filter(
            (candidate) => candidate.filePath === filePath,
          );
          if (candidates.length === 1) return candidates[0];
        }
      }
      if (ts.isFunctionDeclaration(statement) && hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
        const found = symbolByDecl.get(statement);
        if (found) return found;
      }
      if (ts.isClassDeclaration(statement) && hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
        const found = symbolByDecl.get(statement);
        if (found) return found;
      }
    }
    return undefined;
  }

  function addFrameworkRoute(
    file: ScannedFile,
    sf: ts.SourceFile,
    method: string,
    routePath: string,
    target: ExtractedSymbol | undefined,
    framework: string,
  ): void {
    addRouteNode({
      method,
      routePath,
      file,
      sf,
      startLine: target?.startLine ?? 1,
      endLine: target?.endLine ?? 1,
      framework,
      target,
      certainty: "inferred",
      description: `${framework} file-system route`,
    });
  }

  // Next.js app/route.ts, app/page.tsx, pages/**, pages/api/**
  for (const file of files) {
    const sf = sourceFiles.get(file.relPath);
    if (!sf) continue;
    const path = file.relPath;

    const apiMatch = path.match(/(?:^|\/)pages\/api\/(.*)\.(?:ts|tsx|js|jsx)$/);
    if (apiMatch) {
      const segments = apiMatch[1].split("/").filter(Boolean).map(nextDynamicPath);
      const routePath = `/${["api", ...segments].filter(Boolean).join("/")}`.replace(/\/$/, "") || "/api";
      addFrameworkRoute(file, sf, "ANY", routePath, defaultExportSymbol(sf, file.relPath), "Next.js Pages API");
    }

    const appRouteMatch = path.match(/(?:^|\/)app\/(.*)\/route\.(?:ts|tsx|js|jsx)$/);
    if (appRouteMatch) {
      const segments = appRouteMatch[1]
        .split("/")
        .filter((segment) => segment && !segment.startsWith("(") && !segment.startsWith("@"))
        .map(nextDynamicPath);
      const routePath = `/${segments.join("/")}`.replace(/\/$/, "") || "/";
      for (const methodName of Object.keys(NEST_METHODS)) {
        const exported = (symbolsByName.get(methodName) ?? []).filter(
          (candidate) => candidate.filePath === file.relPath,
        );
        if (exported.length === 0) continue;
        addFrameworkRoute(file, sf, NEST_METHODS[methodName], routePath, exported[0], "Next.js App Router");
      }
    }

    const appPageMatch = path.match(/(?:^|\/)app\/(.*)\/page\.(?:tsx|jsx|ts|js)$/);
    if (appPageMatch) {
      const segments = appPageMatch[1]
        .split("/")
        .filter((segment) => segment && !segment.startsWith("(") && !segment.startsWith("@"))
        .map(nextDynamicPath);
      const routePath = `/${segments.join("/")}`.replace(/\/$/, "") || "/";
      addFrameworkRoute(file, sf, "GET", routePath, defaultExportSymbol(sf, file.relPath), "Next.js App Router");
    }

    const pagesMatch = path.match(/(?:^|\/)pages\/(.+)\.(?:tsx|jsx|ts|js)$/);
    if (pagesMatch && !path.includes("/pages/api/")) {
      const segments = pagesMatch[1].split("/");
      if (!segments.some((segment) => segment.startsWith("_") || ["404", "500"].includes(segment))) {
        const routeSegments = segments.filter((segment) => segment !== "index").map(nextDynamicPath);
        const routePath = `/${routeSegments.join("/")}`.replace(/\/$/, "") || "/";
        addFrameworkRoute(file, sf, "GET", routePath, defaultExportSymbol(sf, file.relPath), "Next.js Pages");
      }
    }
  }

  // Database models: Prisma schema (read-only auxiliary file)
  const prismaCandidates = [path.join(rootPath, "prisma", "schema.prisma"), path.join(rootPath, "schema.prisma")];
  for (const schemaPath of prismaCandidates) {
    let content: string;
    try {
      content = await fs.readFile(schemaPath, "utf8");
    } catch {
      continue;
    }
    const rel = path.relative(rootPath, schemaPath).split(path.sep).join("/");
    const existing = fileRecords.find((record) => record.path === rel);
    const schemaFile: ScannedFile = {
      absPath: schemaPath,
      relPath: rel,
      language: "typescript",
      content,
      bytes: Buffer.byteLength(content, "utf8"),
      loc: content.split("\n").length,
      hash: crypto.createHash("sha1").update(content).digest("hex"),
    };
    if (!existing) {
      const segments = rel.split("/");
      let parentId = "project";
      for (let index = 0; index < segments.length - 1; index += 1) {
        const folderPath = segments.slice(0, index + 1).join("/");
        const folderId = `folder:${folderPath}`;
        addNode(graph, {
          id: folderId,
          kind: "folder",
          label: segments[index],
          filePath: folderPath,
          parentId,
          metadata: { aggregate: true },
        });
        addEdge(graph, parentId, folderId, "CONTAINS", "confirmed");
        parentId = folderId;
      }
      addNode(graph, {
        id: `file:${rel}`,
        kind: "file",
        label: segments[segments.length - 1],
        filePath: rel,
        language: "prisma",
        parentId,
      });
      addEdge(graph, parentId, `file:${rel}`, "CONTAINS", "confirmed");
      fileRecords.push({
        id: `file:${rel}`,
        path: rel,
        language: "prisma",
        bytes: schemaFile.bytes,
        loc: schemaFile.loc,
        hash: schemaFile.hash,
        imports: [],
      });
    }

    const lines = content.split("\n");
    const models: { name: string; table: string; line: number; fields: { name: string; type: string; line: number }[] }[] = [];
    let current: (typeof models)[number] | null = null;
    lines.forEach((line, index) => {
      const start = line.match(/^\s*model\s+(\w+)\s*\{/);
      if (start) {
        current = { name: start[1], table: start[1], line: index + 1, fields: [] };
        models.push(current);
        return;
      }
      if (!current) return;
      if (/^\s*\}\s*$/.test(line)) {
        current = null;
        return;
      }
      const map = line.match(/^\s*@@map\(\s*"([^"]+)"\s*\)/);
      if (map) {
        current.table = map[1];
        return;
      }
      const field = line.match(/^\s*(\w+)\s+(\w+)(\[\])?\??/);
      if (field && !line.trim().startsWith("//") && !line.trim().startsWith("@")) {
        current.fields.push({ name: field[1], type: field[2], line: index + 1 });
      }
    });

    const modelIds = new Map<string, string>();
    for (const model of models) {
      const table = model.table;
      const id = `database:${table.toLowerCase()}`;
      modelIds.set(model.name.toLowerCase(), id);
      addNode(graph, {
        id,
        kind: "database",
        label: table,
        filePath: rel,
        startLine: model.line,
        endLine: model.line,
        language: "prisma",
        metadata: {
          orm: "Prisma",
          table,
          model: model.name,
          signature: `model ${model.name} → ${table}`,
          aggregate: true,
        },
      });
    }
    for (const model of models) {
      const sourceId = modelIds.get(model.name.toLowerCase());
      if (!sourceId) continue;
      for (const field of model.fields) {
        const targetId = modelIds.get(field.type.toLowerCase());
        if (!targetId || targetId === sourceId) continue;
        addEdge(graph, sourceId, targetId, "RELATES_TO", "confirmed", {
          filePath: rel,
          startLine: field.line,
          endLine: field.line,
          description: `Prisma relation ${model.name}.${field.name} → ${field.type}`,
        });
      }
    }
  }

  // Prisma / SQL query usage and generic SQL tables
  const READ_METHODS = /^(find|count|aggregate|groupBy|queryRaw)/i;
  const WRITE_METHODS = /^(create|update|upsert|delete|executeRaw)/i;
  const SQL_CALLS = new Set(["query", "execute", "raw", "$queryRaw", "$executeRaw"]);

  function databaseNodeForTable(table: string, options: { file?: ScannedFile; line?: number; orm?: string } = {}): string {
    const id = `database:${table.toLowerCase()}`;
    const existing = graph.nodes.get(id);
    if (existing) {
      if (options.file && !existing.filePath) {
        existing.filePath = options.file.relPath;
        existing.startLine = options.line;
      }
      return id;
    }
    addNode(graph, {
      id,
      kind: "database",
      label: table,
      filePath: options.file?.relPath,
      startLine: options.line,
      endLine: options.line,
      metadata: { table, orm: options.orm ?? "SQL", inferred: true, aggregate: true },
    });
    return id;
  }

  function recordDatabaseAccess(
    source: ExtractedSymbol | undefined,
    file: ScannedFile,
    sf: ts.SourceFile,
    call: ts.CallExpression,
    kind: "READS_FROM" | "WRITES_TO",
    table: string,
    description: string,
  ): void {
    const sourceId = source?.id ?? `file:${file.relPath}`;
    const databaseId = databaseNodeForTable(table, {
      file,
      line: lineOf(sf, call.getStart(sf)),
      orm: "SQL/ORM",
    });
    addEdge(graph, sourceId, databaseId, kind, "inferred", {
      filePath: file.relPath,
      startLine: lineOf(sf, call.getStart(sf)),
      endLine: lineOf(sf, call.getEnd()),
      description,
    });
  }

  for (const file of files) {
    const sf = sourceFiles.get(file.relPath);
    if (!sf) continue;
    for (const symbol of symbols.filter((candidate) => candidate.filePath === file.relPath)) {
      if (!ts.isFunctionLike(symbol.decl)) continue;
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          const method = node.expression.name.text;
          const chain: string[] = [];
          let receiver: ts.Expression = node.expression.expression;
          while (ts.isPropertyAccessExpression(receiver)) {
            chain.unshift(receiver.name.text);
            receiver = receiver.expression;
          }
          if (ts.isIdentifier(receiver)) chain.unshift(receiver.text);

          // Prisma-style client.model.findMany()
          if (chain.includes("prisma") && (READ_METHODS.test(method) || WRITE_METHODS.test(method))) {
            const modelName = chain[chain.length - 1];
            if (modelName && !["prisma", "transaction", "client"].includes(modelName)) {
              const kind = WRITE_METHODS.test(method) ? "WRITES_TO" : "READS_FROM";
              recordDatabaseAccess(
                symbol,
                file,
                sf,
                node,
                kind,
                modelName,
                `ORM query ${method} on ${modelName}`,
              );
            }
          }

          // Raw SQL: db.query("SELECT ... FROM users")
          if (SQL_CALLS.has(method) && node.arguments[0]) {
            const argument = node.arguments[0];
            const sql = ts.isStringLiteralLike(argument)
              ? argument.text
              : ts.isNoSubstitutionTemplateLiteral(argument)
                ? argument.text
                : ts.isTemplateExpression(argument)
                  ? argument.head.text + argument.templateSpans.map((span) => span.literal.text).join("")
                  : "";
            const match = sql.match(/\b(select|insert\s+into|update|delete\s+from)\b[\s\S]*?\b(from|into|update)\s+["`]?([\w.]+)/i);
            if (match) {
              const verb = match[1].toLowerCase();
              const table = match[3].split(".").pop() ?? match[3];
              const kind = verb.startsWith("select") ? "READS_FROM" : "WRITES_TO";
              recordDatabaseAccess(symbol, file, sf, node, kind, table, `SQL ${verb} on ${table}`);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(symbol.decl);
    }
  }

  // TypeORM / Sequelize entity decorators map classes to tables
  for (const symbol of symbols) {
    if (symbol.kind !== "class" || !ts.isClassDeclaration(symbol.decl)) continue;
    const sf = sourceFiles.get(symbol.filePath);
    if (!sf) continue;
    for (const decorator of decoratorInfos(symbol.decl)) {
      if (decorator.name !== "Entity" && decorator.name !== "Table") continue;
      const table = stringArgument(decorator.args, 0) ?? symbol.name;
      const orm = decorator.name === "Entity" ? "TypeORM" : "Sequelize";
      const databaseId = databaseNodeForTable(table, {
        file: files.find((candidate) => candidate.relPath === symbol.filePath),
        line: decorator.line,
        orm,
      });
      addEdge(graph, symbol.id, databaseId, "MAPS_TO", "confirmed", {
        filePath: symbol.filePath,
        startLine: decorator.line,
        endLine: decorator.line,
        description: `${orm} @${decorator.name} → ${table}`,
      });
    }
  }

  // Events: emit/publish and on/subscribe
  const PUBLISH_METHODS = new Set(["emit", "publish"]);
  const SUBSCRIBE_METHODS = new Set(["on", "once", "addListener", "subscribe", "addEventListener"]);
  const eventIds = new Set<string>();
  function eventNode(name: string): string {
    const id = `event:${name}`;
    if (!eventIds.has(id)) {
      eventIds.add(id);
      addNode(graph, {
        id,
        kind: "event",
        label: name,
        metadata: { name, signature: `event ${name}`, aggregate: true },
      });
    }
    return id;
  }

  for (const file of files) {
    const sf = sourceFiles.get(file.relPath);
    if (!sf) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const receiver = node.expression.expression.getText(sf);
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteralLike(argument)) {
          if (PUBLISH_METHODS.has(method)) {
            const sourceId = enclosingSymbolOf(node)?.id ?? `file:${file.relPath}`;
            addEdge(graph, sourceId, eventNode(argument.text), "PUBLISHES", "inferred", {
              filePath: file.relPath,
              startLine: lineOf(sf, node.getStart(sf)),
              endLine: lineOf(sf, node.getEnd()),
              description: `Event publish: ${node.getText(sf).replace(/\s+/g, " ").slice(0, 120)}`,
            });
          } else if (
            SUBSCRIBE_METHODS.has(method) &&
            /(emitter|event|bus|socket|ws|pubsub|stream|client)/i.test(receiver)
          ) {
            const sourceId = enclosingSymbolOf(node)?.id ?? `file:${file.relPath}`;
            addEdge(graph, sourceId, eventNode(argument.text), "SUBSCRIBES_TO", "inferred", {
              filePath: file.relPath,
              startLine: lineOf(sf, node.getStart(sf)),
              endLine: lineOf(sf, node.getEnd()),
              description: `Event subscribe: ${node.getText(sf).replace(/\s+/g, " ").slice(0, 120)}`,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  // NestJS event decorators
  for (const symbol of symbols) {
    if (symbol.kind !== "method") continue;
    const sf = sourceFiles.get(symbol.filePath);
    if (!sf) continue;
    for (const decorator of decoratorInfos(symbol.rangeNode)) {
      if (decorator.name !== "OnEvent" && decorator.name !== "EventPattern") continue;
      const eventName = stringArgument(decorator.args, 0);
      if (!eventName) continue;
      addEdge(graph, symbol.id, eventNode(eventName), "SUBSCRIBES_TO", "inferred", {
        filePath: symbol.filePath,
        startLine: decorator.line,
        endLine: decorator.line,
        description: `NestJS @${decorator.name}(${eventName})`,
      });
    }
  }

  // ---------------------------------------------------------------------
  // Derived metadata and stats
  // ---------------------------------------------------------------------
  let confirmedEdges = 0;
  let inferredEdges = 0;
  let unresolvedEdges = 0;
  for (const edge of graph.edges.values()) {
    if (edge.certainty === "confirmed") confirmedEdges += 1;
    else if (edge.certainty === "inferred") inferredEdges += 1;
    else unresolvedEdges += 1;

    if (edge.kind === "CALLS") {
      const source = graph.nodes.get(edge.source);
      const target = graph.nodes.get(edge.target);
      if (source?.metadata) source.metadata.callCount = (source.metadata.callCount ?? 0) + 1;
      if (target?.metadata) target.metadata.callerCount = (target.metadata.callerCount ?? 0) + 1;
    }
  }

  // Compute folder file counts for aggregate views.
  const folderFileCounts = new Map<string, number>();
  for (const folder of folderSet) folderFileCounts.set(folder, 0);
  for (const file of files) {
    let dir = path.posix.dirname(file.relPath);
    while (dir !== ".") {
      folderFileCounts.set(dir, (folderFileCounts.get(dir) ?? 0) + 1);
      dir = path.posix.dirname(dir);
    }
  }
  for (const [folder, count] of folderFileCounts) {
    const node = graph.nodes.get(`folder:${folder}`);
    if (node?.metadata) node.metadata.fileCount = count;
  }

  const projectNode = graph.nodes.get("project");
  if (projectNode?.metadata) {
    projectNode.metadata.fileCount = fileRecords.length;
    projectNode.metadata.folderCount = [...graph.nodes.values()].filter((node) => node.kind === "folder").length;
    projectNode.metadata.symbolCount = symbols.length;
  }

  if (graph.truncated) {
    warnings.push("Graph node limit reached; analysis was truncated. Choose a smaller folder.");
  }

  const gitSnapshot = await getGitSnapshot(rootPath);

  const languages: Record<string, number> = {};
  for (const file of fileRecords) languages[file.language] = (languages[file.language] ?? 0) + 1;

  const totalLines = fileRecords.reduce((sum, file) => sum + file.loc, 0);
  const functions = symbols.filter((symbol) => symbol.kind === "function" || symbol.kind === "method").length;
  const classes = symbols.filter((symbol) => symbol.kind === "class").length;
  const nodeKinds = [...graph.nodes.values()];
  const routes = nodeKinds.filter((node) => node.kind === "route").length;
  const databases = nodeKinds.filter((node) => node.kind === "database").length;
  const events = nodeKinds.filter((node) => node.kind === "event").length;
  const folderCount = nodeKinds.filter((node) => node.kind === "folder").length;

  const dependencyNames = new Set([
    ...Object.keys(scan.packageJson?.dependencies ?? {}),
    ...Object.keys(scan.packageJson?.devDependencies ?? {}),
  ]);
  const frameworks = new Set<string>();
  const frameworkMarkers: [string, RegExp][] = [
    ["Next.js", /^next$/],
    ["NestJS", /^@nestjs\/core$/],
    ["Express", /^express$/],
    ["Fastify", /^fastify$/],
    ["Koa", /^koa$/],
    ["Hono", /^hono$/],
    ["React", /^react$/],
    ["Vue", /^vue$/],
    ["Svelte", /^svelte$/],
    ["Prisma", /^@prisma\/client$|^prisma$/],
    ["TypeORM", /^typeorm$/],
    ["Sequelize", /^sequelize$/],
    ["Drizzle", /^drizzle-orm$/],
    ["Vitest", /^vitest$/],
    ["Jest", /^jest$/],
  ];
  for (const [name, pattern] of frameworkMarkers) {
    if ([...dependencyNames].some((dependency) => pattern.test(dependency))) frameworks.add(name);
  }
  if (routes > 0 && frameworks.size === 0) frameworks.add("Framework routes");
  if (databases > 0) frameworks.add("Database");
  if (events > 0) frameworks.add("Events");

  return {
    id: projectId,
    projectName: scan.projectName,
    rootPath,
    createdAt: new Date().toISOString(),
    stats: {
      files: fileRecords.length,
      folders: folderCount,
      lines: totalLines,
      symbols: symbols.length,
      functions,
      classes,
      nodes: graph.nodes.size,
      edges: graph.edges.size,
      confirmedEdges,
      inferredEdges,
      unresolvedEdges,
      routes,
      databases,
      events,
      sourceBytes: fileRecords.reduce((sum, file) => sum + file.bytes, 0),
      durationMs: Date.now() - startedAt,
      truncated: graph.truncated,
    },
    warnings,
    languages,
    frameworks: [...frameworks].sort((a, b) => a.localeCompare(b)),
    git: gitSnapshot,
    files: fileRecords,
    // Source bodies stay out of the API payload; the inspector reads the real
    // file on demand. This keeps large analyses small and evidence-fresh.
    symbols: symbols.map(({ decl: _decl, rangeNode: _rangeNode, body: _body, ...record }) => record),
    nodes: [...graph.nodes.values()],
    edges: [...graph.edges.values()],
    externalModules: [...externalModules].sort((a, b) => a.localeCompare(b)),
  };
}
