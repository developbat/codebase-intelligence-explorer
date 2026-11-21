import crypto from "node:crypto";
import type { GraphEdge, GraphNode, SymbolRecord } from "../../shared/types";
import type { ScannedFile } from "./scanner";

interface GenericResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  symbols: SymbolRecord[];
}

interface TypeDecl {
  name: string;
  kind: SymbolRecord["kind"];
}

interface FunctionDecl {
  name: string;
  async: boolean;
  parentName?: string;
}

interface Scope {
  name: string;
  qualifiedName: string;
  symbolId?: string;
  startLine: number;
  endLine: number;
}

const CODE_LANGUAGES = new Set([
  "go",
  "rust",
  "java",
  "kotlin",
  "scala",
  "groovy",
  "csharp",
  "fsharp",
  "visualbasic",
  "c",
  "cpp",
  "objectivec",
  "d",
  "ruby",
  "swift",
  "dart",
  "elixir",
  "erlang",
  "clojure",
  "haskell",
  "ocaml",
  "perl",
  "julia",
  "crystal",
  "nim",
  "zig",
  "solidity",
  "lua",
  "r",
  "powershell",
  "shell",
  "fortran",
  "pascal",
  "tcl",
  "protobuf",
  "graphql",
  "prisma",
]);

const BRACE_LANGUAGES = new Set([
  "go",
  "rust",
  "java",
  "kotlin",
  "scala",
  "groovy",
  "csharp",
  "c",
  "cpp",
  "objectivec",
  "d",
  "swift",
  "dart",
  "solidity",
  "zig",
  "perl",
  "r",
  "powershell",
  "shell",
  "protobuf",
  "graphql",
  "prisma",
]);

const END_LANGUAGES = new Set(["ruby", "elixir", "julia", "crystal", "lua", "visualbasic", "pascal"]);
const INDENT_LANGUAGES = new Set(["haskell", "ocaml", "fsharp", "nim"]);

const CONTROL_WORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "else",
  "do",
  "try",
  "using",
  "lock",
  "foreach",
  "case",
  "sizeof",
  "typeof",
  "await",
  "throw",
  "delete",
  "yield",
  "match",
  "loop",
  "when",
  "with",
]);

function indentOf(line: string): number {
  return line.match(/^\s*/)?.[0].replace(/\t/g, "  ").length ?? 0;
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    !trimmed ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("--") ||
    trimmed.startsWith(";") ||
    trimmed.startsWith("#!") ||
    (trimmed.startsWith("#") && !trimmed.startsWith("#["))
  );
}

function braceEndLine(lines: string[], start: number): number {
  let depth = 0;
  let opened = false;
  for (let index = start; index < lines.length; index += 1) {
    const code = lines[index]
      .replace(/\/\/.*$/, "")
      .replace(/#.*$/, "")
      .replace(/\/\*.*?\*\//g, "");
    for (const character of code) {
      if (character === "{") {
        depth += 1;
        opened = true;
      } else if (character === "}") {
        depth -= 1;
        if (opened && depth <= 0) return index + 1;
      }
    }
    if (opened && depth === 0) return index + 1;
  }
  return Math.min(lines.length, start + 1);
}

function endKeywordLine(lines: string[], start: number): number {
  let depth = 1;
  for (let index = start + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) continue;
    if (/^(end|end\s+\w+)\b/.test(trimmed)) {
      depth -= 1;
      if (depth <= 0) return index + 1;
    } else if (
      /^(def|defp|defmodule|class|module|struct|enum|function|do|if|unless|case|begin|while|for|sub|property|select)\b/.test(
        trimmed,
      )
    ) {
      depth += 1;
    }
  }
  return Math.min(lines.length, start + 1);
}

function indentEndLine(lines: string[], start: number, language: string): number {
  const base = indentOf(lines[start]);
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (indentOf(line) <= base) {
      return END_LANGUAGES.has(language) ? index : index - 1;
    }
  }
  return lines.length;
}

function parenEndLine(lines: string[], start: number): number {
  let depth = 0;
  let opened = false;
  for (let index = start; index < lines.length; index += 1) {
    for (const character of lines[index]) {
      if (character === "(") {
        depth += 1;
        opened = true;
      } else if (character === ")") {
        depth -= 1;
        if (opened && depth <= 0) return index + 1;
      }
    }
  }
  return Math.min(lines.length, start + 1);
}

function dotEndLine(lines: string[], start: number): number {
  for (let index = start; index < lines.length; index += 1) {
    if (lines[index].trimEnd().endsWith(".")) return index + 1;
  }
  return Math.min(lines.length, start + 1);
}

function endLineFor(language: string, lines: string[], start: number): number {
  if (BRACE_LANGUAGES.has(language)) return braceEndLine(lines, start);
  if (language === "clojure") return parenEndLine(lines, start);
  if (language === "erlang") return dotEndLine(lines, start);
  if (language === "fortran") return endKeywordLine(lines, start);
  if (END_LANGUAGES.has(language) || INDENT_LANGUAGES.has(language)) {
    return indentEndLine(lines, start, language);
  }
  return Math.min(lines.length, start + 1);
}

function parametersOf(line: string): string[] {
  const match = line.match(/\(([^)]*)\)/);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function signatureOf(line: string): string {
  return line.trim().replace(/\s*\{.*$/, "").slice(0, 240);
}

function typeDecl(language: string, line: string): TypeDecl | null {
  const trimmed = line.trim();
  if (language === "go") {
    const struct = trimmed.match(/^type\s+([A-Za-z_]\w*)\s+(struct|interface)\b/);
    if (struct) return { name: struct[1], kind: struct[2] === "interface" ? "interface" : "class" };
    const alias = trimmed.match(/^type\s+([A-Za-z_]\w*)\s*=/);
    if (alias) return { name: alias[1], kind: "type" };
  }
  if (language === "rust") {
    const match = trimmed.match(/^(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|type)\s+([A-Za-z_]\w*)/);
    if (match) {
      return {
        name: match[2],
        kind: match[1] === "enum" ? "enum" : match[1] === "trait" ? "interface" : match[1] === "type" ? "type" : "class",
      };
    }
  }
  if (["java", "kotlin", "scala", "csharp", "groovy", "d"].includes(language)) {
    const match = trimmed.match(
      /^(?:public|private|protected|internal|abstract|final|sealed|static|data|open|partial|export|strictfp|synchronized)?\s*(class|interface|enum|record|struct|trait|object)\s+([A-Za-z_]\w*)/,
    );
    if (match) {
      return {
        name: match[2],
        kind: match[1] === "interface" || match[1] === "trait" ? "interface" : match[1] === "enum" ? "enum" : "class",
      };
    }
  }
  if (["c", "cpp", "objectivec"].includes(language)) {
    const match = trimmed.match(/^(?:class|struct|enum|union)\s+([A-Za-z_]\w*)/);
    if (match) return { name: match[1], kind: trimmed.startsWith("enum") ? "enum" : "class" };
    const objc = trimmed.match(/^@(?:interface|protocol)\s+([A-Za-z_]\w*)/);
    if (objc) return { name: objc[1], kind: trimmed.startsWith("@protocol") ? "interface" : "class" };
    const typedef = trimmed.match(/^typedef\s+(?:struct|enum|union)\s*\{?[^}]*\}\s*([A-Za-z_]\w*)\s*;/);
    if (typedef) return { name: typedef[1], kind: "type" };
  }
  if (language === "ruby") {
    const match = trimmed.match(/^(class|module)\s+([A-Z]\w*)/);
    if (match) return { name: match[2], kind: "class" };
  }
  if (language === "swift") {
    const match = trimmed.match(
      /^(?:public|private|internal|open|final|indirect)?\s*(class|struct|enum|protocol|extension)\s+([A-Za-z_]\w*)/,
    );
    if (match) {
      return { name: match[2], kind: match[1] === "protocol" ? "interface" : match[1] === "enum" ? "enum" : "class" };
    }
  }
  if (language === "dart") {
    const match = trimmed.match(/^(?:abstract|final|sealed|base|interface)?\s*(class|enum|mixin|extension)\s+([A-Za-z_]\w*)/);
    if (match) return { name: match[2], kind: match[1] === "enum" ? "enum" : "class" };
  }
  if (language === "elixir") {
    const module = trimmed.match(/^defmodule\s+([\w.]+)/);
    if (module) return { name: module[1].split(".").pop() ?? module[1], kind: "class" };
    if (/^defprotocol\b/.test(trimmed)) {
      const name = trimmed.split(/\s+/)[1];
      if (name) return { name, kind: "interface" };
    }
  }
  if (language === "clojure") {
    const match = trimmed.match(/^\((defrecord|deftype|defprotocol|definterface)\s+([\w-]+)/);
    if (match) return { name: match[2], kind: match[1].includes("protocol") || match[1].includes("interface") ? "interface" : "class" };
  }
  if (language === "haskell") {
    const match = trimmed.match(/^(data|newtype|type|class)\s+([A-Z]\w*)/);
    if (match) return { name: match[2], kind: match[1] === "class" ? "class" : match[1] === "type" || match[1] === "newtype" ? "type" : "class" };
  }
  if (language === "ocaml") {
    const match = trimmed.match(/^(type|module|class)\s+([A-Za-z_]\w*)/);
    if (match) return { name: match[2], kind: match[1] === "type" ? "type" : "class" };
  }
  if (language === "julia") {
    const struct = trimmed.match(/^(?:mutable\s+)?struct\s+([A-Za-z_]\w*)/);
    if (struct) return { name: struct[1], kind: "class" };
    const abstract = trimmed.match(/^abstract\s+type\s+([A-Za-z_]\w*)/);
    if (abstract) return { name: abstract[1], kind: "type" };
    const module = trimmed.match(/^module\s+([A-Za-z_]\w*)/);
    if (module) return { name: module[1], kind: "class" };
  }
  if (language === "crystal") {
    const match = trimmed.match(/^(class|module|struct|enum)\s+([A-Z]\w*)/);
    if (match) return { name: match[2], kind: match[1] === "enum" ? "enum" : "class" };
  }
  if (language === "nim") {
    const match = trimmed.match(/^type\s+([A-Za-z_]\w*)\s*=/);
    if (match) return { name: match[1], kind: "type" };
  }
  if (language === "zig") {
    const match = trimmed.match(/^(?:pub\s+)?const\s+([A-Za-z_]\w*)\s*=\s*(struct|union|enum|opaque)/);
    if (match) return { name: match[1], kind: match[2] === "enum" ? "enum" : "class" };
  }
  if (language === "solidity") {
    const match = trimmed.match(/^(contract|interface|library)\s+([A-Za-z_]\w*)/);
    if (match) return { name: match[2], kind: match[1] === "interface" ? "interface" : "class" };
  }
  if (language === "fsharp") {
    const match = trimmed.match(/^(type|module)\s+([A-Za-z_]\w*)/);
    if (match) return { name: match[2], kind: match[1] === "module" ? "class" : "type" };
  }
  if (language === "visualbasic") {
    const match = trimmed.match(/^(Class|Module|Structure|Interface|Enum)\s+([A-Za-z_]\w*)/i);
    if (match) return { name: match[2], kind: /interface/i.test(match[1]) ? "interface" : /enum/i.test(match[1]) ? "enum" : "class" };
  }
  if (language === "fortran") {
    const match = trimmed.match(/^(module|program)\s+([A-Za-z_]\w*)/i);
    if (match) return { name: match[2], kind: "class" };
  }
  if (language === "protobuf") {
    const match = trimmed.match(/^(message|service|enum)\s+([A-Za-z_]\w*)/);
    if (match) return { name: match[2], kind: match[1] === "enum" ? "enum" : match[1] === "service" ? "interface" : "class" };
  }
  if (language === "graphql") {
    const match = trimmed.match(/^(type|interface|enum|input)\s+([A-Za-z_]\w*)/);
    if (match) return { name: match[2], kind: match[1] === "enum" ? "enum" : match[1] === "interface" ? "interface" : "type" };
  }
  if (language === "prisma") {
    const match = trimmed.match(/^(model|enum|type)\s+([A-Za-z_]\w*)/);
    if (match) return { name: match[2], kind: match[1] === "enum" ? "enum" : match[1] === "type" ? "type" : "class" };
  }
  return null;
}

function functionDecl(language: string, line: string): FunctionDecl | null {
  const trimmed = line.trim();
  if (CONTROL_WORDS.has(trimmed.split(/\s|\(/)[0])) return null;
  const async = /\b(async|suspend|await)\b/.test(trimmed);
  if (language === "go") {
    const method = trimmed.match(/^func\s+\([^)]*\b\*?([A-Za-z_]\w*)\b[^)]*\)\s+([A-Za-z_]\w*)\s*\(/);
    if (method) return { name: method[2], async, parentName: method[1] };
    const fn = trimmed.match(/^func\s+([A-Za-z_]\w*)\s*\(/);
    if (fn) return { name: fn[1], async };
  }
  if (language === "rust") {
    const fn = trimmed.match(/^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*[<(]/);
    if (fn) return { name: fn[1], async };
  }
  if (language === "kotlin") {
    const fn = trimmed.match(/^(?:public|private|protected|internal|open|override|suspend|inline|operator|tailrec|external|abstract|final)?\s*fun\s+([A-Za-z_]\w*)\s*[<(]/);
    if (fn) return { name: fn[1], async };
  }
  if (language === "scala") {
    const fn = trimmed.match(/^(?:private|protected|override|final|implicit|inline)?\s*def\s+([A-Za-z_]\w*)\s*[\[(]/);
    if (fn) return { name: fn[1], async };
  }
  if (language === "ruby") {
    const fn = trimmed.match(/^def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/);
    if (fn) return { name: fn[1], async };
  }
  if (language === "swift") {
    const fn = trimmed.match(/^(?:public|private|internal|open|static|class|override|mutating|async)?\s*func\s+([A-Za-z_]\w*)\s*[<(]/);
    if (fn) return { name: fn[1], async };
  }
  if (language === "dart") {
    const fn = trimmed.match(/^(?:static\s+)?(?:Future<[^>]+>|void|[A-Za-z_][\w<>?]*)\s+([A-Za-z_]\w*)\s*\(/);
    if (fn) return { name: fn[1], async };
  }
  if (language === "elixir") {
    const fn = trimmed.match(/^defp?\s+([a-z_]\w*[?!]?)/);
    if (fn) return { name: fn[1], async };
  }
  if (language === "haskell") {
    const fn = line.match(/^([a-z_]\w*)\s*(?:::|=)/);
    if (fn) return { name: fn[1], async };
  }
  if (language === "ocaml") {
    const fn = trimmed.match(/^let\s+(?:rec\s+)?([a-z_]\w*)/);
    if (fn) return { name: fn[1], async };
  }
  if (language === "perl") {
    const fn = trimmed.match(/^sub\s+([A-Za-z_]\w*)/);
    if (fn) return { name: fn[1], async };
  }
  if (language === "julia") {
    const fn = trimmed.match(/^function\s+([A-Za-z_]\w*)/);
    if (fn) return { name: fn[1], async };
  }
  if (language === "crystal") {
    const fn = trimmed.match(/^def\s+([A-Za-z_]\w*[?!=]?)/);
    if (fn) return { name: fn[1], async };
  }
  if (language === "nim") {
    const fn = trimmed.match(/^(?:proc|func|method|template|macro|iterator)\s+([A-Za-z_]\w*)/);
    if (fn) return { name: fn[1], async };
  }
  if (language === "zig") {
    const fn = trimmed.match(/^(?:pub\s+)?fn\s+([A-Za-z_]\w*)\s*\(/);
    if (fn) return { name: fn[1], async };
  }
  if (language === "solidity") {
    const fn = trimmed.match(/^(?:function|modifier)\s+([A-Za-z_]\w*)\s*\(/);
    if (fn) return { name: fn[1], async };
    if (/^constructor\s*\(/.test(trimmed)) return { name: "constructor", async: false };
  }
  if (language === "lua") {
    const fn = trimmed.match(/^(?:local\s+)?function\s+([A-Za-z_][\w.:]*)/);
    if (fn) return { name: fn[1].split(/[.:]/).pop() ?? fn[1], async };
  }
  if (language === "r") {
    const fn = trimmed.match(/^([A-Za-z_.][\w.]*)\s*<-\s*function/);
    if (fn) return { name: fn[1], async };
  }
  if (language === "powershell") {
    const fn = trimmed.match(/^function\s+([A-Za-z_][\w-]*)/);
    if (fn) return { name: fn[1], async };
  }
  if (language === "shell") {
    const fn = trimmed.match(/^(?:function\s+)?([A-Za-z_]\w*)\s*\(\s*\)\s*\{/);
    if (fn) return { name: fn[1], async };
  }
  if (language === "fsharp") {
    const fn = trimmed.match(/^let\s+(?:rec\s+)?([A-Za-z_]\w*)/);
    if (fn) return { name: fn[1], async };
  }
  if (language === "visualbasic") {
    const fn = trimmed.match(/^(?:Public|Private|Friend|Protected|Shared|Async|Overrides|MustOverride)?\s*(?:Sub|Function)\s+([A-Za-z_]\w*)/i);
    if (fn) return { name: fn[1], async };
  }
  if (language === "clojure") {
    const fn = trimmed.match(/^\(defn-?\s+([A-Za-z_][\w-]*)/);
    if (fn) return { name: fn[1], async };
  }
  if (language === "erlang") {
    const fn = trimmed.match(/^([a-z][\w@]*)\s*\([^)]*\)\s*->/);
    if (fn) return { name: fn[1], async };
  }
  if (language === "fortran") {
    const fn = trimmed.match(/^(?:recursive\s+|pure\s+|elemental\s+)?(?:subroutine|function)\s+([A-Za-z_]\w*)/i);
    if (fn) return { name: fn[1], async };
  }
  if (language === "pascal") {
    const fn = trimmed.match(/^(?:procedure|function)\s+([A-Za-z_]\w*)/i);
    if (fn) return { name: fn[1], async };
  }
  if (language === "tcl") {
    const fn = trimmed.match(/^proc\s+([A-Za-z_]\w*)/);
    if (fn) return { name: fn[1], async };
  }
  if (["java", "csharp", "d", "groovy", "c", "cpp", "objectivec"].includes(language)) {
    if (language === "c" || language === "cpp") {
      const qualified = trimmed.match(/^(?:[\w:<>,*&]+\s+)+([A-Za-z_]\w*)::([A-Za-z_]\w*)\s*\(/);
      if (qualified) return { name: qualified[2], async, parentName: qualified[1] };
    }
    if (language === "objectivec") {
      const method = trimmed.match(/^[-+]\s*\([^)]*\)\s*([A-Za-z_]\w*)/);
      if (method) return { name: method[1], async };
    }
    const modifiers =
      /^(?:(?:public|private|protected|internal|static|final|abstract|virtual|override|async|synchronized|native|default|sealed|extern|unsafe|new|inline|constexpr|const|friend|explicit|operator)\s+)+/;
    if (modifiers.test(trimmed)) {
      const method = trimmed.match(/^(?:(?:public|private|protected|internal|static|final|abstract|virtual|override|async|synchronized|native|default|sealed|extern|unsafe|new|inline|constexpr|const|friend|explicit|operator)\s+)+(?:[\w<>[\],.?*&:]+\s+)+([A-Za-z_]\w*)\s*\(/);
      if (method) return { name: method[1], async };
    }
    if (language === "c" || language === "cpp") {
      const cFunction = trimmed.match(/^(?:(?:static|inline|extern|virtual|constexpr|const|friend|explicit|unsigned|signed|struct|class)\s+)*(?:[\w:<>,*&]+\s+)+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:const\s*)?\{/);
      if (cFunction && !CONTROL_WORDS.has(cFunction[1])) return { name: cFunction[1], async };
    }
    if (language === "csharp" || language === "java" || language === "d" || language === "groovy") {
      const ctor = trimmed.match(/^(?:public|private|protected|internal)?\s*([A-Z][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{/);
      if (ctor && !CONTROL_WORDS.has(ctor[1])) return { name: ctor[1], async };
    }
  }
  return null;
}

function isExported(language: string, line: string, name: string): boolean {
  if (language === "go") return /^[A-Z]/.test(name);
  if (language === "rust") return /\bpub\b/.test(line);
  if (["java", "csharp", "kotlin", "scala", "swift", "dart", "groovy", "d"].includes(language)) {
    return !/\bprivate\b|\binternal\b/.test(line);
  }
  if (language === "ruby") return !/^\s*private\b/.test(line);
  return true;
}

export function analyzeGenericSymbols(files: ScannedFile[]): GenericResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const symbols: SymbolRecord[] = [];
  let edgeCounter = 0;
  let inBlockComment = false;

  for (const file of files) {
    if (!CODE_LANGUAGES.has(file.language)) continue;
    if (file.bytes > 400_000) continue;
    const lines = file.content.split("\n");
    const scopes: Scope[] = [];
    const typeSymbols = new Map<string, SymbolRecord>();
    const seenHaskell = new Set<string>();

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (inBlockComment) {
        if (line.includes("*/")) inBlockComment = false;
        continue;
      }
      if (/\/\*/.test(line) && !/\*\//.test(line)) {
        inBlockComment = true;
        continue;
      }
      if (isCommentLine(line)) continue;
      while (scopes.length > 0 && scopes[scopes.length - 1].endLine < index + 1) {
        scopes.pop();
      }
      const startLine = index + 1;
      const parentScope = scopes[scopes.length - 1];

      // Rust impl blocks are scopes, not symbols; methods inside belong to the type.
      if (file.language === "rust") {
        const impl = line.match(/^\s*impl(?:<[^>]*>)?\s+(?:[\w:<>, ]+\s+for\s+)?([A-Za-z_]\w*)/);
        if (impl) {
          const typeName = impl[1];
          scopes.push({
            name: typeName,
            qualifiedName: typeName,
            symbolId: typeSymbols.get(typeName)?.id,
            startLine,
            endLine: braceEndLine(lines, index),
          });
          continue;
        }
      }
      if (file.language === "cpp") {
        const namespace = line.match(/^\s*namespace\s+([A-Za-z_]\w*)\s*\{/);
        if (namespace) {
          scopes.push({
            name: namespace[1],
            qualifiedName: parentScope ? `${parentScope.qualifiedName}.${namespace[1]}` : namespace[1],
            startLine,
            endLine: braceEndLine(lines, index),
          });
          continue;
        }
      }

      const type = typeDecl(file.language, line);
      if (type) {
        const endLine = endLineFor(file.language, lines, index);
        const qualifiedName = parentScope ? `${parentScope.qualifiedName}.${type.name}` : type.name;
        const id = `symbol:${file.relPath}#${qualifiedName}@${startLine}`;
        const signature = signatureOf(line);
        const body = lines.slice(index, endLine).join("\n").slice(0, 6000);
        const record: SymbolRecord = {
          id,
          name: type.name,
          qualifiedName,
          kind: type.kind,
          filePath: file.relPath,
          startLine,
          endLine,
          signature,
          parameters: [],
          exported: isExported(file.language, line, type.name),
          async: false,
          parentSymbolId: parentScope?.symbolId,
          hash: crypto.createHash("sha1").update(`${signature}\n${body}`).digest("hex"),
          body,
        };
        symbols.push(record);
        typeSymbols.set(type.name, record);
        nodes.push({
          id,
          kind: type.kind,
          label: type.name,
          filePath: file.relPath,
          startLine,
          endLine,
          language: file.language,
          parentId: parentScope?.symbolId ?? `file:${file.relPath}`,
          metadata: {
            qualifiedName,
            signature,
            parameters: [],
            exported: record.exported,
            async: false,
            callCount: 0,
            callerCount: 0,
          },
        });
        edges.push({
          id: `generic-edge:${++edgeCounter}`,
          source: parentScope?.symbolId ?? `file:${file.relPath}`,
          target: id,
          kind: "CONTAINS",
          certainty: "confirmed",
          evidence: [{ filePath: file.relPath, startLine, endLine, description: `${type.kind} definition` }],
        });
        scopes.push({
          name: type.name,
          qualifiedName,
          symbolId: id,
          startLine,
          endLine,
        });
        continue;
      }

      const fn = functionDecl(file.language, line);
      if (!fn) continue;
      if (file.language === "haskell") {
        if (line.includes("::") && !line.includes("=")) continue;
        if (seenHaskell.has(fn.name)) continue;
        seenHaskell.add(fn.name);
      }
      const explicitParent = fn.parentName ? typeSymbols.get(fn.parentName) : undefined;
      const effectiveParent = parentScope ??
        (explicitParent
          ? {
              name: explicitParent.name,
              qualifiedName: explicitParent.qualifiedName,
              symbolId: explicitParent.id,
              startLine: explicitParent.startLine,
              endLine: explicitParent.endLine,
            }
          : undefined);
      const endLine = endLineFor(file.language, lines, index);
      const qualifiedName = effectiveParent ? `${effectiveParent.qualifiedName}.${fn.name}` : fn.name;
      const id = `symbol:${file.relPath}#${qualifiedName}@${startLine}`;
      const signature = signatureOf(line);
      const body = lines.slice(index, endLine).join("\n").slice(0, 6000);
      const kind: SymbolRecord["kind"] = effectiveParent ? "method" : "function";
      const record: SymbolRecord = {
        id,
        name: fn.name,
        qualifiedName,
        kind,
        filePath: file.relPath,
        startLine,
        endLine,
        signature,
        parameters: parametersOf(line),
        exported: isExported(file.language, line, fn.name),
        async: fn.async,
        parentSymbolId: effectiveParent?.symbolId,
        hash: crypto.createHash("sha1").update(`${signature}\n${body}`).digest("hex"),
        body,
      };
      symbols.push(record);
      nodes.push({
        id,
        kind,
        label: fn.name,
        filePath: file.relPath,
        startLine,
        endLine,
        language: file.language,
        parentId: parentScope?.symbolId ?? `file:${file.relPath}`,
        metadata: {
          qualifiedName,
          signature,
          parameters: record.parameters,
          exported: record.exported,
          async: record.async,
          callCount: 0,
          callerCount: 0,
        },
      });
      edges.push({
        id: `generic-edge:${++edgeCounter}`,
        source: effectiveParent?.symbolId ?? `file:${file.relPath}`,
        target: id,
        kind: "CONTAINS",
        certainty: "confirmed",
        evidence: [{ filePath: file.relPath, startLine, endLine, description: `${kind} definition` }],
      });
    }
  }

  // Basic inferred call graph between generic symbols.
  const byName = new Map<string, SymbolRecord>();
  for (const symbol of symbols) {
    if (!byName.has(symbol.name)) byName.set(symbol.name, symbol);
  }
  const callSeen = new Set<string>();
  for (const source of symbols) {
    if (!source.body) continue;
    const bodyLines = source.body.split("\n");
    for (let offset = 0; offset < bodyLines.length; offset += 1) {
      const line = bodyLines[offset];
      for (const [name, target] of byName) {
        if (name.length < 3 || name === source.name) continue;
        if (CONTROL_WORDS.has(name)) continue;
        if (!new RegExp(`\\b${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*\\(`).test(line)) continue;
        const key = `${source.id}|${target.id}`;
        if (callSeen.has(key)) continue;
        callSeen.add(key);
        edges.push({
          id: `generic-call:${++edgeCounter}`,
          source: source.id,
          target: target.id,
          kind: "CALLS",
          certainty: "inferred",
          evidence: [
            {
              filePath: source.filePath,
              startLine: source.startLine + offset,
              endLine: source.startLine + offset,
              description: `${source.name} calls ${target.name}`,
            },
          ],
        });
      }
    }
  }

  return { nodes, edges, symbols };
}
