import { parser as phpParser } from "@lezer/php";
import { parser as pythonParser } from "@lezer/python";
import type {
  Certainty,
  Evidence,
  FileRecord,
  GraphEdge,
  GraphEdgeKind,
  GraphNode,
  SymbolRecord,
} from "../../shared/types";
import type { ScannedFile } from "./scanner";

type PolyglotLanguage = "php" | "python";

interface Frame {
  type: "class" | "function";
  symbolId: string;
  className?: string;
}

interface CallRecord {
  callerId: string;
  file: ScannedFile;
  line: number;
  name: string;
  receiver?: string;
  method?: string;
  thisCall: boolean;
  text: string;
}

interface RouteRecord {
  method: string;
  path: string;
  file: ScannedFile;
  line: number;
  framework: string;
  handlerClass?: string;
  handlerMethod?: string;
}

interface PolyglotSymbol extends SymbolRecord {
  className?: string;
  namespace?: string;
}

export interface PolyglotResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  symbols: SymbolRecord[];
  imports: Map<string, string[]>;
  routes: number;
}

const PHP_BUILTINS = new Set([
  "isset", "empty", "unset", "echo", "print", "include", "require", "include_once", "require_once",
  "array", "count", "array_map", "array_filter", "array_merge", "array_keys", "array_values",
  "in_array", "implode", "explode", "strlen", "str_replace", "str_contains", "sprintf", "trim",
  "json_encode", "json_decode", "is_array", "is_string", "is_null", "is_numeric", "intval",
  "floatval", "strval", "var_dump", "error_log", "date", "time", "file_get_contents", "file_put_contents",
  "preg_match", "preg_replace", "usort", "uasort", "sort", "ksort", "reset", "end", "key",
  "func_get_args", "call_user_func", "call_user_func_array", "compact", "extract", "define", "defined",
  "class_exists", "method_exists", "property_exists", "get_class", "gettype", "settype", "range",
  "max", "min", "abs", "round", "floor", "ceil", "number_format", "htmlspecialchars", "urlencode",
  "base64_encode", "base64_decode", "hash", "md5", "sha1", "uniqid", "microtime", "strtotime",
  "header", "http_response_code", "session_start", "setcookie", "die", "exit", "sleep", "usleep",
]);

const PYTHON_BUILTINS = new Set([
  "print", "len", "range", "str", "int", "float", "bool", "list", "dict", "set", "tuple", "type",
  "isinstance", "issubclass", "getattr", "setattr", "hasattr", "delattr", "super", "object",
  "enumerate", "zip", "map", "filter", "sorted", "reversed", "min", "max", "sum", "abs", "round",
  "open", "input", "repr", "format", "id", "hash", "vars", "dir", "callable", "iter", "next",
  "any", "all", "Exception", "ValueError", "TypeError", "KeyError", "RuntimeError", "StopIteration",
  "NotImplementedError", "AttributeError", "IndexError", "ZeroDivisionError", "OSError", "IOError",
  "async", "await", "self", "__init__", "__str__", "__repr__", "depends", "router", "app",
]);

function buildLineIndex(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function lineAt(lineStarts: number[], position: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (lineStarts[middle] <= position) low = middle + 1;
    else high = middle - 1;
  }
  return Math.max(1, high + 1);
}

function textBeforeBody(content: string, from: number, to: number): string {
  const text = content.slice(from, to);
  const brace = text.indexOf("{");
  const colon = text.search(/:\s*(?:\n|$)/);
  const cut = [brace, colon].filter((value) => value > 0).sort((a, b) => a - b)[0];
  return cut ? text.slice(0, cut).replace(/\s+/g, " ").trim() : text.replace(/\s+/g, " ").trim().slice(0, 240);
}

function tokensOf(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

function splitTopLevelCommas(text: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of text) {
    if ("([{".includes(character)) depth += 1;
    if (")]}".includes(character)) depth -= 1;
    if (character === "," && depth === 0) {
      if (current.trim()) result.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

function phpImportLines(content: string): string[] {
  const imports: string[] = [];
  const regex = /^\s*use\s+([^;]+);/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content))) {
    const value = match[1].trim();
    const brace = value.match(/^([^{]+)\{([^}]+)\}/);
    if (brace) {
      for (const part of brace[2].split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0];
        if (name) imports.push(`${brace[1].trim()}\\${name}`);
      }
    } else {
      imports.push(value.split(/\s+as\s+/)[0].trim());
    }
  }
  return imports;
}

function pythonImports(content: string): { specifier: string; line: number; names: string[] }[] {
  const imports: { specifier: string; line: number; names: string[] }[] = [];
  const lines = content.split("\n");
  lines.forEach((line, index) => {
    const from = line.match(/^\s*from\s+([.\w]+)\s+import\s+(.+)$/);
    if (from) {
      imports.push({
        specifier: from[1],
        line: index + 1,
        names: from[2].replace(/[()]/g, "").split(",").map((name) => name.trim().split(/\s+as\s+/)[0]).filter(Boolean),
      });
      return;
    }
    const direct = line.match(/^\s*import\s+(.+)$/);
    if (direct) {
      for (const part of direct[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (name) imports.push({ specifier: name, line: index + 1, names: [name.split(".").pop() ?? name] });
      }
    }
  });
  return imports;
}

function decoratorsFor(lines: string[], defLine: number): string[] {
  const decorators: string[] = [];
  for (let index = defLine - 2; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.trim().startsWith("@")) break;
    decorators.unshift(line.trim());
  }
  return decorators;
}

function addUniqueEdge(
  edges: GraphEdge[],
  edgeMap: Map<string, GraphEdge>,
  source: string,
  target: string,
  kind: GraphEdgeKind,
  certainty: Certainty,
  evidence?: Evidence,
): void {
  const key = `${source}|${target}|${kind}`;
  const existing = edgeMap.get(key);
  if (existing) {
    if (evidence && (existing.evidence?.length ?? 0) < 8) {
      const duplicate = existing.evidence?.some(
        (item) => item.filePath === evidence.filePath && item.startLine === evidence.startLine,
      );
      if (!duplicate) existing.evidence?.push(evidence);
    }
    return;
  }
  const edge: GraphEdge = {
    id: `poly-edge:${edgeMap.size + 1}`,
    source,
    target,
    kind,
    certainty,
    evidence: evidence ? [evidence] : undefined,
  };
  edges.push(edge);
  edgeMap.set(key, edge);
}

export async function analyzePolyglot(files: ScannedFile[]): Promise<PolyglotResult> {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const edgeMap = new Map<string, GraphEdge>();
  const symbols: PolyglotSymbol[] = [];
  const calls: CallRecord[] = [];
  const routes: RouteRecord[] = [];
  const imports = new Map<string, string[]>();
  const importedSpecifiers = new Map<string, string[]>();
  const externalNamesByFile = new Map<string, Set<string>>();

  const addNode = (node: GraphNode): void => {
    if (!nodes.some((candidate) => candidate.id === node.id)) nodes.push(node);
  };

  for (const file of files) {
    const language: PolyglotLanguage | null =
      file.language === "php" ? "php" : file.language === "python" ? "python" : null;
    if (!language) continue;
    const content = file.content;
    const tree = language === "php" ? phpParser.parse(content) : pythonParser.parse(content);
    const lineStarts = buildLineIndex(content);
    const fileNodeId = `file:${file.relPath}`;
    const stack: Frame[] = [];
    let namespace = "";
    const pyImports = language === "python" ? pythonImports(content) : [];
    const fileImports = language === "php" ? phpImportLines(content) : pyImports.map((item) => item.specifier);
    const externalNames = new Set<string>();
    for (const name of fileImports) {
      externalNames.add(name.split(/[\\.]/).pop() ?? name);
    }
    for (const item of pyImports) {
      for (const importedName of item.names) externalNames.add(importedName);
    }
    externalNamesByFile.set(file.relPath, externalNames);
    imports.set(file.relPath, fileImports);
    importedSpecifiers.set(file.relPath, fileImports);

    const addSymbol = (
      name: string,
      kind: SymbolRecord["kind"],
      from: number,
      to: number,
      signature: string,
      parameters: string[],
      returnType: string | undefined,
      parent?: Frame,
      className?: string,
      async = false,
      exported = true,
    ): PolyglotSymbol => {
      const startLine = lineAt(lineStarts, from);
      const endLine = lineAt(lineStarts, to);
      const qualified = [namespace, className, name].filter(Boolean).join(language === "php" ? "\\" : ".");
      const symbol: PolyglotSymbol = {
        id: `symbol:${file.relPath}#${qualified.replace(/\\/g, ".")}@${startLine}`,
        name,
        qualifiedName: qualified,
        kind,
        filePath: file.relPath,
        startLine,
        endLine,
        signature,
        parameters,
        returnType,
        exported,
        async,
        parentSymbolId: parent?.symbolId,
        body: content.slice(from, to).slice(0, 6000),
        className,
        namespace,
      };
      symbols.push(symbol);
      addNode({
        id: symbol.id,
        kind: symbol.kind,
        label: name,
        filePath: file.relPath,
        startLine,
        endLine,
        language: file.language,
        parentId: parent?.symbolId ?? fileNodeId,
        metadata: {
          qualifiedName: qualified,
          signature,
          parameters,
          returnType,
          exported,
          async,
          callCount: 0,
          callerCount: 0,
        },
      });
      addUniqueEdge(
        edges,
        edgeMap,
        parent?.symbolId ?? fileNodeId,
        symbol.id,
        "CONTAINS",
        "confirmed",
        { filePath: file.relPath, startLine, endLine, description: `${kind} definition` },
      );
      return symbol;
    };

    tree.iterate({
      enter(ref) {
        const name = ref.name;
        const text = content.slice(ref.from, ref.to);

        if (language === "php") {
          if (name === "NamespaceDefinition") {
            namespace = text.replace(/^namespace\s+/, "").replace(/;.*$/, "").trim();
            return;
          }
          if (name === "ClassDeclaration" || name === "InterfaceDeclaration" || name === "TraitDeclaration" || name === "EnumDeclaration") {
            const nameNode = ref.node.getChild("Name");
            if (!nameNode) return;
            const className = content.slice(nameNode.from, nameNode.to);
            const kind = name === "InterfaceDeclaration" ? "interface" : name === "EnumDeclaration" ? "enum" : "class";
            const symbol = addSymbol(
              className,
              kind,
              ref.from,
              ref.to,
              textBeforeBody(content, ref.from, ref.to),
              [],
              undefined,
              stack.find((frame) => frame.type === "class"),
              undefined,
            );
            stack.push({ type: "class", symbolId: symbol.id, className });
            return;
          }
          if (name === "MethodDeclaration" || name === "FunctionDefinition") {
            const nameNode = ref.node.getChild("Name");
            if (!nameNode) return;
            const functionName = content.slice(nameNode.from, nameNode.to);
            const paramNode = ref.node.getChild("ParamList");
            const params = paramNode
              ? splitTopLevelCommas(content.slice(paramNode.from + 1, paramNode.to - 1)).map((param) => param.split("=")[0].trim())
              : [];
            const classFrame = [...stack].reverse().find((frame) => frame.type === "class");
            const symbol = addSymbol(
              functionName,
              classFrame ? "method" : "function",
              ref.from,
              ref.to,
              textBeforeBody(content, ref.from, ref.to),
              params,
              undefined,
              [...stack].reverse().find((frame) => frame.type === "function") ?? classFrame,
              classFrame?.className,
              false,
              name === "MethodDeclaration" ? !/private|protected/.test(text) : true,
            );
            stack.push({ type: "function", symbolId: symbol.id });
            return;
          }
        } else {
          if (name === "ClassDefinition") {
            const nameNode = ref.node.getChild("VariableName");
            if (!nameNode) return;
            const className = content.slice(nameNode.from, nameNode.to);
            const symbol = addSymbol(
              className,
              "class",
              ref.from,
              ref.to,
              textBeforeBody(content, ref.from, ref.to),
              [],
              undefined,
              stack.find((frame) => frame.type === "class"),
              undefined,
              false,
              true,
            );
            stack.push({ type: "class", symbolId: symbol.id, className });
            return;
          }
          if (name === "FunctionDefinition") {
            const nameNode = ref.node.getChild("VariableName");
            if (!nameNode) return;
            const functionName = content.slice(nameNode.from, nameNode.to);
            const paramNode = ref.node.getChild("ParamList");
            const params = paramNode
              ? splitTopLevelCommas(content.slice(paramNode.from + 1, paramNode.to - 1)).map((param) => param.split(":")[0].split("=")[0].trim())
              : [];
            const classFrame = [...stack].reverse().find((frame) => frame.type === "class");
            const symbol = addSymbol(
              functionName,
              classFrame ? "method" : "function",
              ref.from,
              ref.to,
              textBeforeBody(content, ref.from, ref.to),
              params,
              undefined,
              [...stack].reverse().find((frame) => frame.type === "function") ?? classFrame,
              classFrame?.className,
              text.trimStart().startsWith("async "),
              true,
            );
            stack.push({ type: "function", symbolId: symbol.id });
            return;
          }
        }

        if (name !== "CallExpression") return;
        const callerFrame = [...stack].reverse().find((frame) => frame.type === "function");
        const callText = tokensOf(text);
        const open = text.indexOf("(");
        const callee = (open >= 0 ? text.slice(0, open) : text).replace(/\s+/g, " ").trim();
        if (!callee) return;
        const callLine = lineAt(lineStarts, ref.from);
        const classFrame = [...stack].reverse().find((frame) => frame.type === "class");

        if (language === "php") {
          const thisMatch = callee.match(/^\$this\s*->\s*([A-Za-z_]\w*)/);
          const classMatch = callee.match(/^\\?([A-Za-z_\\][\w\\]*)\s*::\s*([A-Za-z_]\w*)/);
          const simple = callee.match(/^\$?([A-Za-z_]\w*)$/);
          if (callerFrame && thisMatch) {
            calls.push({ callerId: callerFrame.symbolId, file, line: callLine, name: thisMatch[1], method: thisMatch[1], thisCall: true, text: callText });
          } else if (callerFrame && classMatch) {
            calls.push({ callerId: callerFrame.symbolId, file, line: callLine, name: classMatch[2], method: classMatch[2], receiver: classMatch[1], thisCall: false, text: callText });
          } else if (callerFrame && simple && !PHP_BUILTINS.has(simple[1].toLowerCase())) {
            calls.push({ callerId: callerFrame.symbolId, file, line: callLine, name: simple[1], thisCall: false, text: callText });
          }

          const staticRoute = callee.match(/^(?:\\?[A-Za-z_\\][\w\\]*)\s*::\s*(get|post|put|patch|delete|options|any)$/i);
          const instanceRoute = /(router|route|app)/i.test(callee)
            ? callee.match(/^\$?[A-Za-z_]\w*\s*->\s*(get|post|put|patch|delete|options|any)$/i)
            : null;
          const routeMatch = staticRoute ?? instanceRoute;
          if (routeMatch) {
            const stringArgs = [...text.matchAll(/(['"])(.*?)\1/g)].map((match) => match[2]);
            const routePath = stringArgs[0];
            if (routePath?.startsWith("/")) {
              const handler = text.slice(open + 1);
              const arrayHandler = handler.match(/\[\s*\\?([A-Za-z_\\][\w\\]*)\s*::\s*class\s*,\s*['"](\w+)['"]\s*\]/);
              const stringHandler = handler.match(/['"]([A-Za-z_\\][\w\\]*)@(\w+)['"]/);
              routes.push({
                method: routeMatch[1].toUpperCase() === "ANY" ? "ANY" : routeMatch[1].toUpperCase(),
                path: routePath,
                file,
                line: callLine,
                framework: staticRoute ? "Laravel" : "PHP Router",
                handlerClass: arrayHandler?.[1] ?? stringHandler?.[1],
                handlerMethod: arrayHandler?.[2] ?? stringHandler?.[2],
              });
            }
          }
        } else {
          const thisMatch = callee.match(/^self\.([A-Za-z_]\w*)/);
          const memberMatch = callee.match(/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/);
          const simple = callee.match(/^([A-Za-z_]\w*)$/);
          if (callerFrame && thisMatch) {
            calls.push({ callerId: callerFrame.symbolId, file, line: callLine, name: thisMatch[1], method: thisMatch[1], thisCall: true, text: callText });
          } else if (callerFrame && memberMatch && !PYTHON_BUILTINS.has(memberMatch[2])) {
            calls.push({ callerId: callerFrame.symbolId, file, line: callLine, name: memberMatch[2], method: memberMatch[2], receiver: memberMatch[1], thisCall: false, text: callText });
          } else if (callerFrame && simple && !PYTHON_BUILTINS.has(simple[1])) {
            calls.push({ callerId: callerFrame.symbolId, file, line: callLine, name: simple[1], thisCall: false, text: callText });
          }
        }
      },
      leave(ref) {
        if (["ClassDeclaration", "InterfaceDeclaration", "TraitDeclaration", "EnumDeclaration", "ClassDefinition", "MethodDeclaration", "FunctionDefinition"].includes(ref.name)) {
          stack.pop();
        }
      },
    });

    // Python route decorators: associate the decorators directly above a def.
    if (language === "python") {
      const lines = content.split("\n");
      for (const symbol of symbols.filter((candidate) => candidate.filePath === file.relPath && candidate.kind === "function")) {
        for (const decorator of decoratorsFor(lines, symbol.startLine)) {
          const routeMatch = decorator.match(/^@([\w.]+)\.(get|post|put|patch|delete|options|head)\(\s*["']([^"']+)["']/i);
          const flaskRoute = decorator.match(/^@([\w.]+)\.route\(\s*["']([^"']+)["'](.*)$/);
          if (routeMatch) {
            routes.push({
              method: routeMatch[2].toUpperCase(),
              path: routeMatch[3],
              file,
              line: symbol.startLine,
              framework: routeMatch[1].includes("router") ? "FastAPI" : "Flask",
              handlerMethod: symbol.name,
            });
            break;
          }
          if (flaskRoute) {
            const methods = flaskRoute[3].match(/methods\s*=\s*\[([^\]]+)\]/);
            const routeMethods = methods
              ? methods[1].split(",").map((item) => item.replace(/['"\s]/g, "").toUpperCase())
              : ["GET"];
            for (const method of routeMethods) {
              routes.push({
                method,
                path: flaskRoute[2],
                file,
                line: symbol.startLine,
                framework: "Flask",
                handlerMethod: symbol.name,
              });
            }
            break;
          }
        }
      }
    }
  }

  const byName = new Map<string, PolyglotSymbol[]>();
  const byQualified = new Map<string, PolyglotSymbol>();
  const methodsByClass = new Map<string, Map<string, PolyglotSymbol>>();
  for (const symbol of symbols) {
    byName.set(symbol.name, [...(byName.get(symbol.name) ?? []), symbol]);
    byQualified.set(symbol.qualifiedName, symbol);
    if (symbol.className && symbol.kind === "method") {
      const methods = methodsByClass.get(symbol.className) ?? new Map<string, PolyglotSymbol>();
      methods.set(symbol.name, symbol);
      methodsByClass.set(symbol.className, methods);
    }
  }

  const fileClassMap = new Map<string, PolyglotSymbol>();
  for (const symbol of symbols) {
    if (symbol.kind === "class" || symbol.kind === "interface" || symbol.kind === "enum") {
      fileClassMap.set(symbol.qualifiedName, symbol);
    }
  }

  // Imports: PHP fully-qualified names and Python module names.
  const pythonModules = new Map<string, string>();
  for (const symbol of symbols) {
    if (!symbol.filePath.endsWith(".py")) continue;
    const module = symbol.filePath.replace(/\.py$/, "").replace(/\/__init__$/, "").split("/").join(".");
    pythonModules.set(module, symbol.filePath);
  }
  for (const symbol of symbols) {
    if (symbol.kind === "class") {
      const module = symbol.filePath.replace(/\.py$/, "").replace(/\/__init__$/, "").split("/").join(".");
      pythonModules.set(`${module}.${symbol.name}`, symbol.filePath);
    }
  }

  for (const [filePath, specifiers] of importedSpecifiers) {
    const sourceId = `file:${filePath}`;
    for (const specifier of specifiers) {
      const targetSymbol = fileClassMap.get(specifier.replace(/^\\/, ""));
      let targetPath: string | undefined = targetSymbol?.filePath;
      if (!targetPath && filePath.endsWith(".py")) {
        const module = specifier.replace(/^\.+/, "").replace(/\./g, "/");
        targetPath = pythonModules.get(specifier) ?? pythonModules.get(module) ?? pythonModules.get(specifier.replace(/^\./, ""));
      }
      if (targetPath && targetPath !== filePath) {
        addUniqueEdge(edges, edgeMap, sourceId, `file:${targetPath}`, "IMPORTS", "inferred", {
          filePath,
          description: `Import: ${specifier}`,
        });
      }
    }
  }

  for (const call of calls) {
    let target: PolyglotSymbol | undefined;
    if (call.thisCall) {
      const caller = symbols.find((symbol) => symbol.id === call.callerId);
      const className = caller?.className;
      target = className ? methodsByClass.get(className)?.get(call.name) : undefined;
    } else if (call.receiver) {
      const className = call.receiver.split("\\").pop() ?? call.receiver;
      target =
        methodsByClass.get(className)?.get(call.name) ??
        [...methodsByClass.entries()].find(([name]) => name.endsWith(`\\${className}`))?.[1]?.get(call.name);
      if (!target) target = byName.get(call.name)?.find((symbol) => symbol.kind === "class");
    } else {
      const candidates = byName.get(call.name) ?? [];
      if (candidates.length === 1) target = candidates[0];
    }

    const evidence: Evidence = {
      filePath: call.file.relPath,
      startLine: call.line,
      endLine: call.line,
      description: `Call: ${call.text}`,
    };
    if (target) {
      addUniqueEdge(edges, edgeMap, call.callerId, target.id, "CALLS", "inferred", evidence);
      continue;
    }
    if (call.thisCall || call.receiver) continue;
    if (externalNamesByFile.get(call.file.relPath)?.has(call.name)) continue;
    if (call.file.language === "php" && PHP_BUILTINS.has(call.name.toLowerCase())) continue;
    if (call.file.language === "python" && PYTHON_BUILTINS.has(call.name)) continue;

    // PHP/Python resolution is syntax-based rather than type-checked. Do not
    // create unresolved-node noise for name-only calls we cannot map; the
    // call site remains inspectable through the caller's source.
  }

  for (const route of routes) {
    const routeId = `route:${route.method}:${route.path}@${route.file.relPath}:${route.line}`;
    addNode({
      id: routeId,
      kind: "route",
      label: `${route.method} ${route.path}`,
      filePath: route.file.relPath,
      startLine: route.line,
      endLine: route.line,
      language: route.file.language,
      parentId: "project",
      metadata: {
        method: route.method,
        path: route.path,
        framework: route.framework,
        signature: `${route.method} ${route.path}`,
      },
    });
    let target: PolyglotSymbol | undefined;
    if (route.handlerClass && route.handlerMethod) {
      target = methodsByClass.get(route.handlerClass.split("\\").pop() ?? route.handlerClass)?.get(route.handlerMethod);
    } else if (route.handlerMethod) {
      target = byName.get(route.handlerMethod)?.[0];
    }
    if (target) {
      addUniqueEdge(edges, edgeMap, routeId, target.id, "ROUTES_TO", "inferred", {
        filePath: route.file.relPath,
        startLine: route.line,
        endLine: route.line,
        description: `${route.framework} route ${route.method} ${route.path}`,
      });
    }
  }

  return {
    nodes,
    edges,
    symbols: symbols.map(({ className: _className, namespace: _namespace, ...symbol }) => symbol),
    imports,
    routes: routes.length,
  };
}
