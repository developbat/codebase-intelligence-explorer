import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { php } from "@codemirror/lang-php";
import { go } from "@codemirror/lang-go";
import { rust } from "@codemirror/lang-rust";
import { java } from "@codemirror/lang-java";
import { cpp } from "@codemirror/lang-cpp";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { sql } from "@codemirror/lang-sql";
import { json } from "@codemirror/lang-json";
import { xml } from "@codemirror/lang-xml";
import { markdown } from "@codemirror/lang-markdown";
import { StreamLanguage } from "@codemirror/language";
import { c, csharp, kotlin, scala, dart } from "@codemirror/legacy-modes/mode/clike";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { r } from "@codemirror/legacy-modes/mode/r";
import { erlang } from "@codemirror/legacy-modes/mode/erlang";
import { clojure } from "@codemirror/legacy-modes/mode/clojure";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { diff as diffMode } from "@codemirror/legacy-modes/mode/diff";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { cmake } from "@codemirror/legacy-modes/mode/cmake";
import { cobol } from "@codemirror/legacy-modes/mode/cobol";
import { coffeeScript } from "@codemirror/legacy-modes/mode/coffeescript";
import { commonLisp } from "@codemirror/legacy-modes/mode/commonlisp";
import { crystal } from "@codemirror/legacy-modes/mode/crystal";
import { cypher } from "@codemirror/legacy-modes/mode/cypher";
import { d } from "@codemirror/legacy-modes/mode/d";
import { elm } from "@codemirror/legacy-modes/mode/elm";
import { fortran } from "@codemirror/legacy-modes/mode/fortran";
import { gas } from "@codemirror/legacy-modes/mode/gas";
import { gherkin } from "@codemirror/legacy-modes/mode/gherkin";
import { groovy } from "@codemirror/legacy-modes/mode/groovy";
import { haskell } from "@codemirror/legacy-modes/mode/haskell";
import { haxe, hxml } from "@codemirror/legacy-modes/mode/haxe";
import { jinja2 } from "@codemirror/legacy-modes/mode/jinja2";
import { julia } from "@codemirror/legacy-modes/mode/julia";
import { liveScript } from "@codemirror/legacy-modes/mode/livescript";
import { fSharp, oCaml, sml } from "@codemirror/legacy-modes/mode/mllike";
import { nginx } from "@codemirror/legacy-modes/mode/nginx";
import { octave } from "@codemirror/legacy-modes/mode/octave";
import { pascal } from "@codemirror/legacy-modes/mode/pascal";
import { perl } from "@codemirror/legacy-modes/mode/perl";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { protobuf } from "@codemirror/legacy-modes/mode/protobuf";
import { pug } from "@codemirror/legacy-modes/mode/pug";
import { puppet } from "@codemirror/legacy-modes/mode/puppet";
import { scheme } from "@codemirror/legacy-modes/mode/scheme";
import { smalltalk } from "@codemirror/legacy-modes/mode/smalltalk";
import { sparql } from "@codemirror/legacy-modes/mode/sparql";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { stylus } from "@codemirror/legacy-modes/mode/stylus";
import { tcl } from "@codemirror/legacy-modes/mode/tcl";
import { vb } from "@codemirror/legacy-modes/mode/vb";
import { vbScript } from "@codemirror/legacy-modes/mode/vbscript";
import { verilog } from "@codemirror/legacy-modes/mode/verilog";
import { vhdl } from "@codemirror/legacy-modes/mode/vhdl";
import { wast } from "@codemirror/legacy-modes/mode/wast";
import { webIDL } from "@codemirror/legacy-modes/mode/webidl";
import { xQuery } from "@codemirror/legacy-modes/mode/xquery";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, hoverTooltip } from "@codemirror/view";
import { autocompletion, type CompletionContext } from "@codemirror/autocomplete";
import { linter, lintGutter } from "@codemirror/lint";
import { diffLines } from "diff";
import {
  AlertTriangle,
  Bot,
  Check,
  CheckCheck,
  Database,
  Download,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Code2,
  Copy,
  Eye,
  ExternalLink,
  FileCode2,
  Gamepad2,
  Folder,
  FolderOpen,
  GripVertical,
  History,
  Info,
  ListChecks,
  Loader2,
  Maximize2,
  MessageSquare,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Server,
  Settings2,
  Send,
  Sparkles,
  Square,
  Star,
  Terminal,
  Trash2,
  Wand2,
  User,
  Upload,
  TestTube2,
  WandSparkles,
  Wrench,
  X,
} from "lucide-react";
import type {
  AnalysisResult,
  RunCommandResult,
  TestDiscovery,
  TestRunResult,
} from "../../../shared/types";
import { providerInfo, type AiAgentEvent, type AiAgentLogEntry, type AiAgentPermissionRequest, type AiAgentPlan, type AiAgentResult, type AiAgentStep, type AiPermissionDecision, type AiProviderId, type AiSettingsPublic, type AiTestGenerationResult, type AiTokenUsage, type AiWorkspaceMode } from "../../../shared/ai";
import { api } from "../api";
import { activeProvider } from "../lib/ai";
import { buildTree, collectFolderPaths, type TreeNode } from "../lib/tree";
import { useI18n } from "../i18n";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { MarkdownText } from "./MarkdownText";
import { formatTokens } from "./UsageDialog";
import { formatUsd } from "../../../shared/pricing";
import { AgentPermissionDialog } from "./AgentPermissionDialog";
import { SettingsScreen, type SettingsTab } from "./SettingsScreen";
import { AgentPlanCard } from "./AgentPlanCard";
import { ShellTerminalView } from "./ShellTerminalView";
import { TaskQueueCard } from "./TaskQueueCard";
import type { ProjectTaskQueue } from "../../../shared/tasks";
import type { ClarificationRequest, IntentAnalysis } from "../../../shared/intent";
import type { BrowserCheckResult } from "../../../shared/browserCheck";
import type { ProjectToolList } from "../../../shared/projectTools";
import type {
  BackgroundJob,
  DevCommandSuggestion,
  DuplicationReport,
  ProjectIndexHit,
  ProjectIndexStatus,
  RecentProject,
} from "../../../shared/types";

interface TerminalSession {
  id: string;
  title: string;
  kind: "command" | "shell";
  serverId?: string;
  shellStatus?: "running" | "exited";
  command: string;
  output: string;
  result: RunCommandResult | null;
  busy: boolean;
}


let terminalCounter = 0;

function createTerminalSession(title?: string, kind: "command" | "shell" = "command"): TerminalSession {
  terminalCounter += 1;
  return {
    id: `term-${Date.now()}-${terminalCounter}`,
    title: title ?? `${kind === "shell" ? "Shell" : "Terminal"} ${terminalCounter}`,
    kind,
    shellStatus: kind === "shell" ? "running" : undefined,
    command: "",
    output: "",
    result: null,
    busy: false,
  };
}

interface CodeStudioProps {
  analysis: AnalysisResult;
  aiSettings: AiSettingsPublic | null;
  recent?: RecentProject[];
  onSettingsSaved: (settings: AiSettingsPublic) => void;
  onRescan: () => void;
  onOpenProject?: () => void;
  settingsRequest?: { tab: SettingsTab; nonce: number } | null;
  onSettingsRequestConsumed?: () => void;
  onLoadRecent?: (project: RecentProject) => void;
  onRemoveRecent?: (id: string) => void;
  initialPrompt?: string;
  autoRunInitialPrompt?: boolean;
  onInitialPromptConsumed?: () => void;
}

function isImagePreviewPath(filePath: string): boolean {
  return /\.(svg|png|jpe?g|gif|webp|ico)$/i.test(filePath);
}

function languageExtension(filePath: string) {
  const extension = filePath.split(".").pop()?.toLowerCase() ?? "";
  const fileName = filePath.split("/").pop()?.toLowerCase() ?? "";
  if (fileName === "dockerfile" || fileName === "containerfile" || fileName.startsWith("dockerfile.")) {
    return [StreamLanguage.define(dockerFile)];
  }
  if (fileName === "cmakelists.txt") return [StreamLanguage.define(cmake)];
  if (["makefile", "gnumakefile", "justfile"].includes(fileName)) return [StreamLanguage.define(gas)];
  if (fileName === "jenkinsfile") return [StreamLanguage.define(groovy)];
  if (fileName === "nginx.conf") return [StreamLanguage.define(nginx)];
  if (["rakefile", "gemfile", "podfile", "fastfile", "brewfile", "vagrantfile"].includes(fileName)) {
    return [StreamLanguage.define(ruby)];
  }
  if (fileName.startsWith("dockerfile.")) return [StreamLanguage.define(dockerFile)];
  if (["ts", "tsx", "mts", "cts"].includes(extension)) {
    return [javascript({ typescript: true, jsx: extension === "tsx" })];
  }
  if (["js", "jsx", "mjs", "cjs", "es6"].includes(extension)) {
    return [javascript({ jsx: extension === "jsx" })];
  }
  if (extension === "py") return [python()];
  if (["php", "php3", "php4", "php5", "inc"].includes(extension)) return [php()];
  if (extension === "go") return [go()];
  if (extension === "rs") return [rust()];
  if (extension === "java") return [java()];
  if (["c", "h"].includes(extension)) return [StreamLanguage.define(c)];
  if (["cpp", "cc", "cxx", "hpp", "hxx"].includes(extension)) return [cpp()];
  if (["kt", "kts"].includes(extension)) return [StreamLanguage.define(kotlin)];
  if (["cs", "csx"].includes(extension)) return [StreamLanguage.define(csharp)];
  if (["rb", "rake", "gemspec"].includes(extension)) return [StreamLanguage.define(ruby)];
  if (extension === "swift") return [StreamLanguage.define(swift)];
  if (["scala", "sc", "sbt"].includes(extension)) return [StreamLanguage.define(scala)];
  if (extension === "dart") return [StreamLanguage.define(dart)];
  if (["sh", "bash", "zsh", "fish"].includes(extension)) return [StreamLanguage.define(shell)];
  if (extension === "lua") return [StreamLanguage.define(lua)];
  if (extension === "r") return [StreamLanguage.define(r)];
  if (["erl", "hrl"].includes(extension)) return [StreamLanguage.define(erlang)];
  if (["clj", "cljs", "cljc", "edn"].includes(extension)) return [StreamLanguage.define(clojure)];
  if (["hs", "lhs"].includes(extension)) return [StreamLanguage.define(haskell)];
  if (["ml", "mli"].includes(extension)) return [StreamLanguage.define(oCaml)];
  if (["fs", "fsi", "fsx"].includes(extension)) return [StreamLanguage.define(fSharp)];
  if (extension === "sml") return [StreamLanguage.define(sml)];
  if (["pl", "pm", "t"].includes(extension)) return [StreamLanguage.define(perl)];
  if (extension === "jl") return [StreamLanguage.define(julia)];
  if (["groovy", "gvy", "gradle"].includes(extension)) return [StreamLanguage.define(groovy)];
  if (["ps1", "psm1", "psd1"].includes(extension)) return [StreamLanguage.define(powerShell)];
  if (extension === "cr") return [StreamLanguage.define(crystal)];
  if (extension === "elm") return [StreamLanguage.define(elm)];
  if (extension === "d") return [StreamLanguage.define(d)];
  if (["f", "f77", "f90", "f95", "f03", "for"].includes(extension)) return [StreamLanguage.define(fortran)];
  if (["pas", "dpr"].includes(extension)) return [StreamLanguage.define(pascal)];
  if (extension === "pp") return [StreamLanguage.define(puppet)];
  if (extension === "proto") return [StreamLanguage.define(protobuf)];
  if (extension === "cmake") return [StreamLanguage.define(cmake)];
  if (["cob", "cbl", "cpy"].includes(extension)) return [StreamLanguage.define(cobol)];
  if (["lisp", "cl", "el"].includes(extension)) return [StreamLanguage.define(commonLisp)];
  if (["scm", "ss", "rkt"].includes(extension)) return [StreamLanguage.define(scheme)];
  if (extension === "tcl") return [StreamLanguage.define(tcl)];
  if (extension === "vb") return [StreamLanguage.define(vb)];
  if (extension === "vbs") return [StreamLanguage.define(vbScript)];
  if (["v", "sv", "svh"].includes(extension)) return [StreamLanguage.define(verilog)];
  if (["vhd", "vhdl"].includes(extension)) return [StreamLanguage.define(vhdl)];
  if (extension === "tex" || extension === "sty" || extension === "cls" || extension === "bib") return [StreamLanguage.define(stex)];
  if (extension === "coffee") return [StreamLanguage.define(coffeeScript)];
  if (extension === "ls") return [StreamLanguage.define(liveScript)];
  if (extension === "hx") return [StreamLanguage.define(haxe)];
  if (extension === "hxml") return [StreamLanguage.define(hxml)];
  if (["properties", "ini", "cfg", "conf", "hcl", "tf", "tfvars", "nix"].includes(extension)) return [StreamLanguage.define(properties)];
  if (extension === "cypher") return [StreamLanguage.define(cypher)];
  if (["sparql", "rq"].includes(extension)) return [StreamLanguage.define(sparql)];
  if (extension === "st") return [StreamLanguage.define(smalltalk)];
  if (extension === "webidl") return [StreamLanguage.define(webIDL)];
  if (["wat", "wast", "wasm"].includes(extension)) return [StreamLanguage.define(wast)];
  if (extension === "feature") return [StreamLanguage.define(gherkin)];
  if (["jinja", "jinja2", "j2"].includes(extension)) return [StreamLanguage.define(jinja2)];
  if (extension === "nginx") return [StreamLanguage.define(nginx)];
  if (extension === "styl") return [StreamLanguage.define(stylus)];
  if (["xq", "xquery"].includes(extension)) return [StreamLanguage.define(xQuery)];
  if (["asm", "s"].includes(extension)) return [StreamLanguage.define(gas)];
  if (["diff", "patch"].includes(extension)) return [StreamLanguage.define(diffMode)];
  if (extension === "ino") return [cpp()];
  if (extension === "gd" || extension === "vy" || ["bzl", "bazel", "star"].includes(extension)) return [python()];
  if (extension === "sol") return [javascript()];
  if (extension === "zig") return [StreamLanguage.define(c)];
  if (["mk", "mak", "bat", "cmd", "awk", "sed"].includes(extension)) return [StreamLanguage.define(shell)];
  if (["yaml", "yml"].includes(extension)) return [StreamLanguage.define(yaml)];
  if (extension === "toml") return [StreamLanguage.define(toml)];
  if (extension === "sql") return [sql()];
  if (["html", "htm", "vue", "svelte", "astro", "cshtml", "razor", "tpl"].includes(extension)) return [html()];
  if (["css", "scss", "sass", "less"].includes(extension)) return [css()];
  if (["json", "jsonc", "json5", "jsonl", "ndjson", "avsc", "ipynb", "jsonnet", "libsonnet"].includes(extension)) return [json()];
  if (["xml", "svg", "plist", "xsd", "xsl", "xslt", "csproj", "vbproj", "fsproj", "props", "targets", "xaml"].includes(extension)) return [xml()];
  if (["md", "mdx", "markdown", "rmd", "qmd"].includes(extension)) return [markdown()];
  return [];
}

function agentStepTarget(step: AiAgentStep): string {
  const value = step.args.path ?? step.args.query ?? step.args.command;
  return typeof value === "string" ? value : "";
}

const FILE_TEMPLATES = [
  { id: "empty", label: "Empty file", path: "", content: "" },
  {
    id: "env",
    label: "Environment example (env.example)",
    path: "env.example",
    content:
      "# Copy this file to .env and fill in real values.\n# Real .env and key files are never created by the editor.\nAPI_KEY=\nDATABASE_URL=\n",
  },
  {
    id: "json",
    label: "JSON config example",
    path: "config.example.json",
    content: '{\n  "example": true\n}\n',
  },
  {
    id: "yaml",
    label: "YAML config example",
    path: "config.example.yaml",
    content: "# Copy this file to config.yaml\nexample: true\n",
  },
  {
    id: "toml",
    label: "TOML config example",
    path: "config.example.toml",
    content: "# Copy this file to config.toml\nexample = true\n",
  },
] as const;

function quickCommandsFor(analysis: AnalysisResult): string[] {
  const commands: string[] = [];
  if (analysis.frameworks?.some((framework) => ["Jest", "Vitest"].includes(framework))) {
    commands.push("npm test", "npm run build");
  }
  if (analysis.frameworks?.includes("Laravel")) {
    commands.push("php artisan test");
  }
  if (analysis.languages.python > 0) {
    commands.push("pytest");
  }
  if (analysis.languages.php > 0 && !analysis.frameworks?.includes("Laravel")) {
    commands.push("vendor/bin/phpunit");
  }
  if (analysis.frameworks?.includes("Flutter")) {
    commands.push("flutter test", "flutter analyze");
  }
  if (analysis.files.some((file) => file.path === "project.godot")) {
    commands.push("godot --headless --path . --quit");
  }
  if (commands.length === 0) commands.push("npm test");
  return [...new Set(commands)].slice(0, 4);
}

function StudioTree({
  nodes,
  depth,
  expanded,
  onToggle,
  onOpen,
  selected,
}: {
  nodes: TreeNode[];
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  selected: string | null;
}) {
  return (
    <>
      {nodes.map((node) => {
        const isFolder = node.type === "folder";
        const isExpanded = expanded.has(node.path);
        return (
          <div key={node.path}>
            <button
              className={`studio-tree-row ${isFolder ? "is-folder" : "is-file"} ${selected === node.path ? "is-selected" : ""}`}
              style={{ paddingLeft: `${8 + depth * 12}px` }}
              onClick={() => (isFolder ? onToggle(node.path) : onOpen(node.path))}
              title={node.path}
            >
              {isFolder ? (
                isExpanded ? (
                  <ChevronDown size={12} />
                ) : (
                  <ChevronRight size={12} />
                )
              ) : (
                <span className="studio-tree-spacer" />
              )}
              {isFolder ? (
                isExpanded ? (
                  <FolderOpen size={13} />
                ) : (
                  <Folder size={13} />
                )
              ) : (
                <FileCode2 size={13} />
              )}
              <span>{node.name}</span>
            </button>
            {isFolder && isExpanded ? (
              <StudioTree
                nodes={node.children}
                depth={depth + 1}
                expanded={expanded}
                onToggle={onToggle}
                onOpen={onOpen}
                selected={selected}
              />
            ) : null}
          </div>
        );
      })}
    </>
  );
}

function CollapsibleAnswer({ value }: { value: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const long = value.length > 420 || value.split("\n").filter((line) => line.trim()).length > 5;
  if (!long) return <MarkdownText value={value} />;
  return (
    <>
      <div className={`studio-answer-body ${open ? "is-expanded" : "is-collapsed"}`}>
        <MarkdownText value={value} />
      </div>
      <button className="studio-answer-toggle" onClick={() => setOpen((current) => !current)}>
        {open ? t("Show less") : t("Show full result")}
      </button>
    </>
  );
}

function isLspEditorPath(filePath: string): boolean {
  return /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|py|pyi|go|rs|php)$/i.test(filePath);
}

function lspPosition(view: EditorView, lineNumber: number, character: number): number {
  const line = view.state.doc.line(
    Math.min(Math.max(1, lineNumber), view.state.doc.lines),
  );
  return Math.min(view.state.doc.length, line.from + Math.max(0, character - 1));
}

function lspCompletionType(kind?: number): string {
  const types: Record<number, string> = {
    2: "method",
    3: "function",
    4: "constructor",
    5: "field",
    6: "variable",
    7: "class",
    8: "interface",
    9: "module",
    10: "property",
    13: "enum",
    14: "keyword",
    15: "snippet",
    21: "constant",
  };
  return kind ? types[kind] ?? "text" : "text";
}

function lspEditorExtensions(projectId: string, filePath: string) {
  if (!isLspEditorPath(filePath)) return [];
  const hover = hoverTooltip(
    async (view, pos) => {
      const line = view.state.doc.lineAt(pos);
      const result = await api.lsp
        .hover(projectId, filePath, line.number, pos - line.from + 1)
        .catch(() => null);
      if (!result?.hover?.contents) return null;
      return {
        pos,
        create() {
          const dom = document.createElement("div");
          dom.className = "cm-lsp-hover";
          dom.textContent = result.hover?.contents ?? "";
          return { dom };
        },
      };
    },
    { hoverTime: 350 },
  );
  const completion = autocompletion({
    override: [
      async (context: CompletionContext) => {
        const line = context.state.doc.lineAt(context.pos);
        const result = await api.lsp
          .completion(projectId, filePath, line.number, context.pos - line.from + 1)
          .catch(() => null);
        if (!result?.items?.length) return null;
        const word = context.matchBefore(/[\w$]*/);
        return {
          from: word?.from ?? context.pos,
          options: result.items.map((item) => ({
            label: item.label,
            detail: item.detail,
            info: item.documentation,
            type: lspCompletionType(item.kind),
            apply: item.insertText ?? item.label,
          })),
        };
      },
    ],
  });
  const diagnostics = linter(
    async (view) => {
      const result = await api.lsp.diagnostics(projectId, filePath).catch(() => null);
      if (!result?.supported) return [];
      return result.diagnostics.map((item) => ({
        from: lspPosition(view, item.line, item.character),
        to: lspPosition(view, item.endLine, item.endCharacter),
        severity:
          item.severity === "error"
            ? ("error" as const)
            : item.severity === "warning"
              ? ("warning" as const)
              : ("info" as const),
        message: item.message,
        source: item.source,
      }));
    },
    { delay: 800 },
  );
  return [hover, completion, lintGutter(), diagnostics];
}

export function CodeStudio({
  analysis,
  aiSettings,
  recent = [],
  onSettingsSaved,
  onRescan,
  onOpenProject,
  settingsRequest,
  onSettingsRequestConsumed,
  onLoadRecent,
  onRemoveRecent,
  initialPrompt,
  autoRunInitialPrompt,
  onInitialPromptConsumed,
}: CodeStudioProps) {
  const { t, locale } = useI18n();
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [intentOpenIndex, setIntentOpenIndex] = useState<number | null>(null);
  const [pendingContinue, setPendingContinue] = useState<{ goal: string } | null>(null);
  const [chainBusy, setChainBusy] = useState(false);
  const [modelCatalog, setModelCatalog] = useState<string[]>([]);
  const [modelCatalogBusy, setModelCatalogBusy] = useState(false);
  const [modelCatalogProvider, setModelCatalogProvider] = useState<AiProviderId | null>(null);
  const [modelDraft, setModelDraft] = useState("");
  const configuredProviders = (aiSettings?.providers ?? []).filter(
    (provider) =>
      provider.enabled !== false &&
      (provider.hasKey ||
        provider.id === "custom" ||
        provider.id === "local" ||
        provider.custom),
  );
  const providerDisplayName = (id: AiProviderId) =>
    aiSettings?.providers.find((provider) => provider.id === id)?.name ?? providerInfo(id).name;
  const fallbackProvider = activeProvider(aiSettings);
  const modelChain = aiSettings?.fallback?.chain ?? [];
  // Settings are the single source of truth: the first selected model is the
  // active model, then the saved default, then the first configured provider.
  const settingsActive = modelChain[0]
    ? { provider: modelChain[0].provider as AiProviderId, model: modelChain[0].model }
    : aiSettings
      ? { provider: aiSettings.defaultProvider, model: aiSettings.defaultModel }
      : null;
  const codeModel =
    settingsActive && configuredProviders.some((provider) => provider.id === settingsActive.provider)
      ? settingsActive
      : fallbackProvider
        ? { provider: fallbackProvider.provider, model: fallbackProvider.model }
        : null;
  const active = codeModel;
  const pickerProvider = modelCatalogProvider ?? active?.provider ?? configuredProviders[0]?.id ?? null;
  const [pathOverrides, setPathOverrides] = useState<Record<string, string>>({});
  const [deletedPaths, setDeletedPaths] = useState<Set<string>>(new Set());
  const tree = useMemo(() => {
    const applyOverrides = (filePath: string) => {
      let result = filePath;
      for (const [from, to] of Object.entries(pathOverrides)) {
        if (result === from || result.startsWith(`${from}/`)) {
          result = to + result.slice(from.length);
        }
      }
      return result;
    };
    const isDeleted = (filePath: string) =>
      [...deletedPaths].some(
        (deleted) => filePath === deleted || filePath.startsWith(`${deleted}/`),
      );
    return buildTree(
      analysis.files
        .map((file) => ({ ...file, path: applyOverrides(file.path) }))
        .filter((file) => !isDeleted(file.path)),
    );
  }, [analysis.files, pathOverrides, deletedPaths]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const lspExtensions = useMemo(
    () => (activeFile ? lspEditorExtensions(analysis.id, activeFile) : []),
    [analysis.id, activeFile],
  );
  const [contents, setContents] = useState<Record<string, string>>({});
  const [savedContents, setSavedContents] = useState<Record<string, string>>({});
  const [fileLoading, setFileLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [analysisStale, setAnalysisStale] = useState(false);
  const [terminals, setTerminals] = useState<TerminalSession[]>(() => [createTerminalSession()]);
  const [activeTerminalId, setActiveTerminalId] = useState(() => terminals[0]?.id ?? "");
  const terminalOutputRef = useRef<Record<string, string>>({});
  const terminalFlushRef = useRef<Record<string, number | null>>({});
  const terminalAbortRef = useRef<Record<string, AbortController | null>>({});
  const agentTerminalRef = useRef<string | null>(null);
  const [jobs, setJobs] = useState<BackgroundJob[]>([]);
  const [jobOutputs, setJobOutputs] = useState<Record<string, string>>({});
  const [jobError, setJobError] = useState<string | null>(null);
  const [devCommands, setDevCommands] = useState<DevCommandSuggestion[]>([]);
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [commandFavorites, setCommandFavorites] = useState<string[]>([]);
  const [commandHistoryOpen, setCommandHistoryOpen] = useState(false);
  const commandHistoryIndexRef = useRef(-1);
  const jobOffsetsRef = useRef<Record<string, number>>({});
  const jobsTickRef = useRef(false);
  const [bottomTab, setBottomTab] = useState<"terminal" | "tests" | "jobs" | "checks">("terminal");
  const [testDiscovery, setTestDiscovery] = useState<TestDiscovery | null>(null);
  const [testCommand, setTestCommand] = useState("");
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<TestRunResult | null>(null);
  const [testOutput, setTestOutput] = useState("");
  const testAbortRef = useRef<AbortController | null>(null);
  const [testTimeout, setTestTimeout] = useState(
    () => Number(localStorage.getItem("cie:test-timeout")) || 300,
  );
  const [testGenInstruction, setTestGenInstruction] = useState("");
  const [testGenBusy, setTestGenBusy] = useState(false);
  const [testGenResult, setTestGenResult] = useState<AiTestGenerationResult | null>(null);
  const agentAbortRef = useRef<AbortController | null>(null);
  const agentStopRequestedRef = useRef(false);
  const [agentAllowWrite, setAgentAllowWrite] = useState(() =>
    localStorage.getItem("cie:agent-write") !== "off",
  );
  const [agentAllowCommands, setAgentAllowCommands] = useState(() =>
    localStorage.getItem("cie:agent-commands") === "on",
  );
  const [permissionQueue, setPermissionQueue] = useState<AiAgentPermissionRequest[]>([]);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const permissionRequest = permissionQueue[0] ?? null;
  const [chatInput, setChatInput] = useState("");
  const [studioMode, setStudioMode] = useState<AiWorkspaceMode>(() => {
    const stored = localStorage.getItem(`cie:studio-mode:${analysis.id}`);
    return stored === "ask" || stored === "plan" || stored === "research" ? stored : "build";
  });
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatRetryQuestion, setChatRetryQuestion] = useState<string | null>(null);
  type StudioChatMessage = {
    role: "user" | "assistant";
    content: string;
    evidence?: { path: string; startLine?: number }[];
    steps?: AiAgentStep[];
    logs?: AiAgentLogEntry[];
    tokenUsage?: AiTokenUsage;
    costUsd?: number;
    plan?: AiAgentPlan;
    planPath?: string;
    mode?: AiWorkspaceMode;
    provider?: string;
    model?: string;
    taskQueue?: ProjectTaskQueue;
    intent?: IntentAnalysis;
  };
  type StudioChatTab = { id: string; title: string; createdAt: string; updatedAt: string };
  const [chatMessages, setChatMessages] = useState<StudioChatMessage[]>([]);
  const [chatTabs, setChatTabs] = useState<StudioChatTab[]>([]);
  const [activeChatId, setActiveChatId] = useState("");
  const [chatLiveSteps, setChatLiveSteps] = useState<AiAgentStep[]>([]);
  const [chatLiveLogs, setChatLiveLogs] = useState<AiAgentLogEntry[]>([]);
  const [chatLivePlan, setChatLivePlan] = useState<AiAgentPlan | null>(null);
  const [chatLiveAnswer, setChatLiveAnswer] = useState("");
  const [taskQueue, setTaskQueue] = useState<ProjectTaskQueue | null>(null);
  const [clarification, setClarification] = useState<{
    request: ClarificationRequest;
    original: string;
  } | null>(null);
  const [modelNotice, setModelNotice] = useState<{
    from: { provider: string; model: string };
    to: { provider: string; model: string };
    reason: string;
  } | null>(null);
  const lastIntentRef = useRef<IntentAnalysis | null>(null);
  const [taskPanelOpen, setTaskPanelOpen] = useState(false);
  const [waitSeconds, setWaitSeconds] = useState(0);
  const chatLiveLogsRef = useRef<AiAgentLogEntry[]>([]);
  const lastIndexedChatRef = useRef<Record<string, string>>({});
  const chatHydratedRef = useRef(false);
  const skipChatSaveRef = useRef(false);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<"files" | "chat" | "tools" | "project">("chat");
  const [leftWidth, setLeftWidth] = useState(() => {
    const stored = Number(localStorage.getItem("cie:studio-left-width"));
    return Number.isFinite(stored) && stored >= 140 ? stored : 252;
  });
  const [rightWidth, setRightWidth] = useState(() => {
    const stored = Number(localStorage.getItem("cie:studio-right-width"));
    if (!Number.isFinite(stored) || stored < 200) return 420;
    return stored === 318 ? 420 : stored;
  });
  const [chatExpanded, setChatExpanded] = useState(false);
  const [previewFullscreen, setPreviewFullscreen] = useState(false);
  const [rightTab, setRightTab] = useState<"preview" | string>("preview");
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");

  useEffect(() => {
    if (!settingsRequest) return;
    setSettingsTab(settingsRequest.tab);
    setSettingsOpen(true);
    onSettingsRequestConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsRequest?.nonce]);
  const [settingsModelsAdd, setSettingsModelsAdd] = useState(false);
  const [indexStatus, setIndexStatus] = useState<ProjectIndexStatus | null>(null);
  const [environmentAlert, setEnvironmentAlert] = useState<{ names: string[] } | null>(null);
  const [checkCommand, setCheckCommand] = useState("");
  const [checkOutput, setCheckOutput] = useState("");
  const [checkBusy, setCheckBusy] = useState(false);
  const [checkResult, setCheckResult] = useState<RunCommandResult | null>(null);
  const [autoCheck, setAutoCheck] = useState(() => localStorage.getItem("cie:auto-check") === "on");
  const [autoSyntax, setAutoSyntax] = useState(() => localStorage.getItem("cie:auto-syntax") !== "off");
  const [autoFormat, setAutoFormat] = useState(() => localStorage.getItem("cie:auto-format") === "on");
  const [syntaxBusy, setSyntaxBusy] = useState(false);
  const [duplication, setDuplication] = useState<DuplicationReport | null>(null);
  const [duplicationBusy, setDuplicationBusy] = useState(false);
  const [browserCheck, setBrowserCheck] = useState<BrowserCheckResult | null>(null);
  const [browserCheckBusy, setBrowserCheckBusy] = useState(false);
  const [browserCheckError, setBrowserCheckError] = useState<string | null>(null);
  const [gameEngine, setGameEngine] = useState<string | null>(null);
  const [projectTools, setProjectTools] = useState<ProjectToolList | null>(null);
  const [projectToolsBusy, setProjectToolsBusy] = useState(false);
  const checkOutputRef = useRef("");
  const checkFlushRef = useRef<number | null>(null);
  const checkAbortRef = useRef<AbortController | null>(null);
  const [indexSearchOpen, setIndexSearchOpen] = useState(false);
  const [indexQuery, setIndexQuery] = useState("");
  const [indexResults, setIndexResults] = useState<ProjectIndexHit[]>([]);
  const [indexSearchBusy, setIndexSearchBusy] = useState(false);
  const [fileAction, setFileAction] = useState<{ type: "rename" | "delete"; path: string } | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [fileActionBusy, setFileActionBusy] = useState(false);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newFileDraft, setNewFileDraft] = useState("");
  const [newFileTemplate, setNewFileTemplate] = useState<string>("empty");
  const [newFileBusy, setNewFileBusy] = useState(false);
  const [assetBusy, setAssetBusy] = useState(false);
  const assetInputRef = useRef<HTMLInputElement | null>(null);
  const taskFileInputRef = useRef<HTMLInputElement | null>(null);
  const [attachment, setAttachment] = useState<{ path: string; name: string; bytes: number } | null>(null);
  const [formatting, setFormatting] = useState(false);
  const workflowScrollRef = useRef<HTMLDivElement>(null);
  const [resizing, setResizing] = useState<"left" | "right" | null>(null);
  const [previewPath, setPreviewPath] = useState("");
  const [previewKey, setPreviewKey] = useState(0);
  const [livePreviewUrl, setLivePreviewUrl] = useState("");
  const requestRef = useRef(0);
  const studioRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const pendingOpenFileRef = useRef<string | null>(null);
  const [pendingLine, setPendingLine] = useState<number | null>(null);
  const autoRunPromptRef = useRef<string | null>(null);

  useEffect(() => {
    chatHydratedRef.current = false;
    skipChatSaveRef.current = true;
    const tabsKey = `cie:studio-chat-tabs:${analysis.id}`;
    const activeKey = `cie:studio-active-chat:${analysis.id}`;
    const legacyKey = `cie:studio-chat:${analysis.id}`;
    const readMessages = (tabId: string): StudioChatMessage[] => {
      try {
        const raw = localStorage.getItem(`cie:studio-chat:${analysis.id}:${tabId}`);
        const parsed = JSON.parse(raw ?? "[]") as StudioChatMessage[];
        return Array.isArray(parsed) ? parsed.slice(-40) : [];
      } catch {
        return [];
      }
    };
    try {
      const parsedTabs = JSON.parse(localStorage.getItem(tabsKey) ?? "[]") as StudioChatTab[];
      let tabs = Array.isArray(parsedTabs)
        ? parsedTabs
            .filter((tab) => tab && typeof tab.id === "string")
            .map((tab) => ({
              ...tab,
              updatedAt: tab.updatedAt ?? tab.createdAt ?? new Date().toISOString(),
            }))
        : [];
      if (tabs.length === 0) {
        const id = `chat-${Date.now()}`;
        const at = new Date().toISOString();
        tabs = [{ id, title: t("New chat"), createdAt: at, updatedAt: at }];
        let migrated: StudioChatMessage[] = [];
        try {
          const legacy = JSON.parse(localStorage.getItem(legacyKey) ?? "[]") as StudioChatMessage[];
          migrated = Array.isArray(legacy) ? legacy.slice(-40) : [];
        } catch {
          migrated = [];
        }
        localStorage.setItem(`cie:studio-chat:${analysis.id}:${id}`, JSON.stringify(migrated));
      }
      const storedActive = localStorage.getItem(activeKey) ?? "";
      const active = tabs.some((tab) => tab.id === storedActive) ? storedActive : tabs[0].id;
      setChatTabs(tabs);
      setActiveChatId(active);
      setChatMessages(readMessages(active));
    } catch {
      const id = `chat-${Date.now()}`;
      const at = new Date().toISOString();
      setChatTabs([{ id, title: t("New chat"), createdAt: at, updatedAt: at }]);
      setActiveChatId(id);
      setChatMessages([]);
    } finally {
      window.setTimeout(() => {
        chatHydratedRef.current = true;
        skipChatSaveRef.current = false;
      }, 0);
    }
  }, [analysis.id]);

  useEffect(() => {
    if (!initialPrompt) return;
    setChatInput(initialPrompt);
    if (autoRunInitialPrompt) autoRunPromptRef.current = initialPrompt;
    onInitialPromptConsumed?.();
  }, [initialPrompt, autoRunInitialPrompt, onInitialPromptConsumed]);

  useEffect(() => {
    if (!autoRunPromptRef.current || !active || chatBusy) return;
    const prompt = autoRunPromptRef.current;
    autoRunPromptRef.current = null;
    void askProject(prompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, chatBusy]);

  useEffect(() => {
    setOpenTabs([]);
    setActiveFile(null);
    setContents({});
    setSavedContents({});
    const freshTerminal = createTerminalSession();
    setTerminals([freshTerminal]);
    setActiveTerminalId(freshTerminal.id);
    terminalOutputRef.current = {};
    agentTerminalRef.current = null;
    setJobs([]);
    setJobOutputs({});
    jobOffsetsRef.current = {};
    checkAbortRef.current?.abort();
    setCheckOutput("");
    setCheckCommand("");
    setCheckResult(null);
    setDuplication(null);
    setBrowserCheck(null);
    setBrowserCheckError(null);
    setGameEngine(null);
    setProjectTools(null);
    testAbortRef.current?.abort();
    setTestResult(null);
    setTestOutput("");
    setPendingLine(null);
    setPermissionQueue([]);
    setPermissionBusy(false);
    setTaskQueue(null);
    setError(null);
    setMessage(null);
    setAnalysisStale(false);
  }, [analysis.id]);

  useEffect(() => {
    if (!pendingLine || !activeFile) return;
    const timer = window.setTimeout(() => {
      const view = editorViewRef.current;
      if (!view) return;
      const lineNumber = Math.min(Math.max(1, pendingLine), view.state.doc.lines);
      const line = view.state.doc.line(lineNumber);
      view.dispatch({
        selection: { anchor: line.from },
        effects: EditorView.scrollIntoView(line.from, { y: "center" }),
      });
      view.focus();
      setPendingLine(null);
    }, 140);
    return () => window.clearTimeout(timer);
  }, [pendingLine, activeFile]);

  useEffect(() => {
    localStorage.setItem("cie:test-timeout", String(testTimeout));
  }, [testTimeout]);

  useEffect(() => {
    localStorage.setItem("cie:agent-write", agentAllowWrite ? "on" : "off");
  }, [agentAllowWrite]);

  useEffect(() => {
    localStorage.setItem("cie:agent-commands", agentAllowCommands ? "on" : "off");
  }, [agentAllowCommands]);
  useEffect(() => {
    void api
      .toolchains(false, analysis.id)
      .then((report) => {
        const names = report.tools
          .filter((tool) => report.recommendedMissing.includes(tool.id))
          .map((tool) => tool.name);
        setEnvironmentAlert(names.length > 0 ? { names } : null);
      })
      .catch(() => setEnvironmentAlert(null));
  }, [analysis.id]);
  useEffect(() => {
    void api.tasks
      .get(analysis.id)
      .then((result) => setTaskQueue(result.queue))
      .catch(() => undefined);
  }, [analysis.id]);
  useEffect(() => {
    const stored = localStorage.getItem(`cie:studio-mode:${analysis.id}`);
    setStudioMode(
      stored === "ask" || stored === "plan" || stored === "research" ? stored : "build",
    );
  }, [analysis.id]);
  useEffect(() => {
    localStorage.setItem(`cie:studio-mode:${analysis.id}`, studioMode);
  }, [analysis.id, studioMode]);
  const readOnlyMode = studioMode !== "build";
  const effectiveAllowWrite = readOnlyMode ? false : agentAllowWrite;
  const effectiveAllowCommands = readOnlyMode ? false : agentAllowCommands;
  const modePlaceholder =
    studioMode === "ask"
      ? t("Ask a question about this project…")
      : studioMode === "plan"
        ? t("Add a goal or criterion; AI will integrate it into the project plan…")
        : studioMode === "research"
          ? t("Research the web, a document, or this project…")
          : t("Ask, edit, run, or build something in this project…");

  useEffect(() => {
    localStorage.setItem("cie:auto-check", autoCheck ? "on" : "off");
  }, [autoCheck]);

  useEffect(() => {
    localStorage.setItem("cie:auto-syntax", autoSyntax ? "on" : "off");
  }, [autoSyntax]);

  useEffect(() => {
    localStorage.setItem("cie:auto-format", autoFormat ? "on" : "off");
  }, [autoFormat]);

  useEffect(() => {
    let cancelled = false;
    api.tasks
      .get(analysis.id)
      .then((result) => {
        if (!cancelled) setTaskQueue(result.queue);
      })
      .catch(() => {
        if (!cancelled) setTaskQueue(null);
      });
    return () => {
      cancelled = true;
    };
  }, [analysis.id]);

  // While the server owns a running task loop, keep the queue fresh even if
  // the chat stream was interrupted or the page was reloaded.
  useEffect(() => {
    if (taskQueue?.status !== "running") return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void api.tasks
        .get(analysis.id)
        .then((result) => {
          if (!cancelled && result.queue) setTaskQueue(result.queue);
        })
        .catch(() => undefined);
    }, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [analysis.id, taskQueue?.status]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setProjectToolsBusy(true);
      try {
        const result = await api.projectTools(analysis.id);
        if (!cancelled) setProjectTools(result);
      } catch {
        if (!cancelled) setProjectTools(null);
      } finally {
        if (!cancelled) setProjectToolsBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [analysis.id]);

  useEffect(() => {
    const readList = (key: string) => {
      try {
        const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
        return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
      } catch {
        return [];
      }
    };
    setCommandHistory(readList(`cie:studio-command-history:${analysis.id}`).slice(0, 50));
    setCommandFavorites(readList(`cie:studio-command-favorites:${analysis.id}`).slice(0, 30));
    setCommandHistoryOpen(false);
    commandHistoryIndexRef.current = -1;
    let cancelled = false;
    void api.processes
      .devCommands(analysis.id)
      .then((result) => {
        if (!cancelled) setDevCommands(result.commands);
      })
      .catch(() => {
        if (!cancelled) setDevCommands([]);
      });
    return () => {
      cancelled = true;
    };
  }, [analysis.id]);

  useEffect(() => {
    if (!activeChatId || chatMessages.length < 2 || chatBusy) return;
    const timer = window.setTimeout(() => {
      const firstUser = chatMessages.find((message) => message.role === "user");
      const title =
        firstUser?.content.slice(0, 500) ||
        chatTabs.find((tab) => tab.id === activeChatId)?.title ||
        t("New chat");
      const answer = chatMessages
        .map(
          (message) =>
            `${message.role === "user" ? "User" : "Agent"}: ${message.content}`,
        )
        .join("\n\n")
        .slice(-24_000);
      const signature = `${activeChatId}:${chatMessages.length}:${answer.length}`;
      if (lastIndexedChatRef.current[activeChatId] === signature) return;
      lastIndexedChatRef.current[activeChatId] = signature;
      void api
        .importConversations(analysis.id, [
          { question: title, answer, chatId: activeChatId },
        ])
        .catch(() => {
          // conversation import is best-effort
        });
    }, 1_200);
    return () => window.clearTimeout(timer);
  }, [analysis.id, activeChatId, chatBusy, chatMessages, chatTabs, t]);

  useEffect(() => {
    if (!chatTabs.length) return;
    localStorage.setItem(`cie:studio-chat-tabs:${analysis.id}`, JSON.stringify(chatTabs));
  }, [analysis.id, chatTabs]);

  useEffect(() => {
    if (!activeChatId) return;
    localStorage.setItem(`cie:studio-active-chat:${analysis.id}`, activeChatId);
  }, [analysis.id, activeChatId]);

  useEffect(() => {
    if (!chatHydratedRef.current || !activeChatId) return;
    if (skipChatSaveRef.current) {
      skipChatSaveRef.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(
          `cie:studio-chat:${analysis.id}:${activeChatId}`,
          JSON.stringify(
            chatMessages
              .slice(-40)
              .map(({ role, content, evidence, tokenUsage, logs, plan, planPath, mode, provider, model, taskQueue, intent }) => ({
                role,
                content,
                evidence,
                tokenUsage,
                logs: logs?.slice(-150),
                plan,
                planPath,
                mode,
                provider,
                model,
                taskQueue,
                intent,
              })),
          ),
        );
      } catch {
        // storage may be unavailable
      }
    }, 120);
    return () => window.clearTimeout(timer);
  }, [analysis.id, activeChatId, chatMessages]);

  useEffect(() => {
    if (!activeChatId) return;
    const firstUser = chatMessages.find((message) => message.role === "user");
    if (!firstUser) return;
    setChatTabs((current) =>
      current.map((tab) =>
        tab.id === activeChatId && tab.title === t("New chat")
          ? { ...tab, title: firstUser.content.replace(/\s+/g, " ").slice(0, 44) }
          : tab,
      ),
    );
  }, [activeChatId, chatMessages, t]);

  useEffect(() => {
    if (!activeChatId || chatMessages.length === 0) return;
    const at = new Date().toISOString();
    setChatTabs((current) =>
      current.map((tab) =>
        tab.id === activeChatId && tab.updatedAt !== at
          ? { ...tab, updatedAt: at }
          : tab,
      ),
    );
  }, [activeChatId, chatMessages]);

  async function selectCodeModel(provider: AiProviderId, model: string) {
    const next = {
      provider,
      model:
        model.trim() ||
        aiSettings?.providers.find((item) => item.id === provider)?.model ||
        "",
    };
    if (!next.model) return;
    setChainBusy(true);
    try {
      const rest = modelChain.filter(
        (item) => !(item.provider === next.provider && item.model === next.model),
      );
      const updated = await api.ai.updateSettings({
        defaultProvider: next.provider,
        defaultModel: next.model,
        fallback: { chain: [next, ...rest] },
      });
      const auto =
        aiSettings?.autoSwitchModels !== false
          ? await api.ai.autoConfigureAgents().catch(() => null)
          : null;
      onSettingsSaved(auto?.settings ?? updated);
      const continueGoal = pendingContinue?.goal;
      setPendingContinue(null);
      if (continueGoal) {
        void askProject(continueGoal, false, {
          retryFailed: true,
          skipClarify: true,
          workspaceMode: "build",
          provider: next.provider,
          model: next.model,
        });
      }
    } finally {
      setChainBusy(false);
      setModelPickerOpen(false);
      setModelCatalog([]);
      setModelCatalogProvider(null);
    }
  }

  async function saveModelChain(next: { provider: string; model: string }[]) {
    setChainBusy(true);
    try {
      const first = next[0];
      const updated = await api.ai.updateSettings({
        fallback: { chain: next },
        ...(first
          ? { defaultProvider: first.provider as AiProviderId, defaultModel: first.model }
          : {}),
      });
      const auto =
        aiSettings?.autoSwitchModels !== false
          ? await api.ai.autoConfigureAgents().catch(() => null)
          : null;
      onSettingsSaved(auto?.settings ?? updated);
    } finally {
      setChainBusy(false);
    }
  }

  function isModelSelected(provider: AiProviderId | null | undefined, model: string): boolean {
    if (!provider) return false;
    return modelChain.some((item) => item.provider === provider && item.model === model);
  }

  async function toggleModelInChain(provider: AiProviderId, model: string) {
    if (!model) return;
    const exists = modelChain.some((item) => item.provider === provider && item.model === model);
    await saveModelChain(
      exists
        ? modelChain.filter((item) => !(item.provider === provider && item.model === model))
        : [...modelChain, { provider, model }],
    );
  }

  async function removeModelFromChain(index: number) {
    await saveModelChain(modelChain.filter((_, itemIndex) => itemIndex !== index));
  }

  async function loadModels(provider: AiProviderId, refresh = false) {
    setModelCatalogBusy(true);
    setModelCatalogProvider(provider);
    try {
      const response = await api.ai.models(provider, refresh);
      setModelCatalog(response.models);
    } catch {
      setModelCatalog([]);
    } finally {
      setModelCatalogBusy(false);
    }
  }

  function openModelPicker() {
    const provider = codeModel?.provider ?? configuredProviders[0]?.id ?? null;
    setModelDraft(codeModel?.model ?? "");
    setModelPickerOpen((value) => !value);
    setModelCatalog([]);
    setModelCatalogProvider(provider);
    if (provider) void loadModels(provider);
  }

  const quickCommands = useMemo(() => quickCommandsFor(analysis), [analysis]);
  const livePreviewUrls = useMemo(
    () => [...new Set(jobs.flatMap((job) => job.urls ?? []))],
    [jobs],
  );
  useEffect(() => {
    if (livePreviewUrl && !livePreviewUrls.includes(livePreviewUrl)) {
      setLivePreviewUrl("");
    }
  }, [livePreviewUrl, livePreviewUrls]);
  const htmlFiles = useMemo(
    () => analysis.files.filter((file) => /\.html?$/i.test(file.path)).map((file) => file.path),
    [analysis.files],
  );
  const inventory = useMemo(() => {
    const counts = { html: 0, js: 0, css: 0, php: 0, python: 0, other: 0 };
    for (const file of analysis.files) {
      if (/\.html?$/i.test(file.path)) counts.html += 1;
      else if (/\.(js|mjs|cjs|jsx|ts|tsx)$/i.test(file.path)) counts.js += 1;
      else if (/\.(css|scss|sass|less)$/i.test(file.path)) counts.css += 1;
      else if (/\.php$/i.test(file.path)) counts.php += 1;
      else if (/\.py$/i.test(file.path)) counts.python += 1;
      else counts.other += 1;
    }
    return counts;
  }, [analysis.files]);
  const activeContent = activeFile ? contents[activeFile] ?? "" : "";
  const effectivePreviewPath = htmlFiles.includes(previewPath) ? previewPath : htmlFiles[0] ?? "";
  const activeTerminal = terminals.find((terminal) => terminal.id === activeTerminalId) ?? terminals[0];
  const terminalsRef = useRef(terminals);
  useEffect(() => {
    terminalsRef.current = terminals;
  }, [terminals]);
  useEffect(() => {
    return () => {
      for (const terminal of terminalsRef.current) {
        if (terminal.kind === "shell" && terminal.serverId) {
          void api.terminals.close(analysis.id, terminal.serverId).catch(() => {
            // project switch cleanup is best-effort
          });
        }
      }
    };
  }, [analysis.id]);
  const activeSaved = activeFile ? savedContents[activeFile] ?? "" : "";
  const dirty = Boolean(activeFile && activeContent !== activeSaved);
  const activeLanguage = activeFile?.split(".").pop()?.toUpperCase() ?? "";

  const sessionTokens = chatMessages.reduce(
    (total, message) => total + (message.tokenUsage?.totalTokens ?? 0),
    0,
  );
  const liveTokens = chatLiveSteps.reduce(
    (total, step) => total + (step.tokenUsage?.totalTokens ?? 0),
    0,
  );
  const checkGroups = [
    { label: t("Typecheck"), commands: analysis.tooling?.typecheckCommands ?? [] },
    { label: t("Lint"), commands: analysis.tooling?.lintCommands ?? [] },
    { label: t("Format check"), commands: analysis.tooling?.formatCommands ?? [] },
    { label: t("Build"), commands: analysis.tooling?.buildCommands ?? [] },
  ];
  const liveStep = chatLiveSteps[chatLiveSteps.length - 1];
  const liveLog = chatLiveLogs[chatLiveLogs.length - 1];
  const liveActivity = (() => {
    if (!chatBusy) return null;
    const receiving = liveLog?.label.startsWith("Receiving response") === true;
    if (liveLog && (!liveStep || receiving || liveLog.level === "model")) {
      const isModel = liveLog.level === "model";
      return {
        label: t(liveLog.label),
        target: isModel
          ? receiving
            ? liveLog.detail ?? ""
            : `${t("Waiting for model response")} · ${waitSeconds}s`
          : liveLog.detail ?? "",
      };
    }
    if (!liveStep) {
      return { label: t("Understanding your request…"), target: `${waitSeconds}s` };
    }
    const target = agentStepTarget(liveStep);
    const labels: Record<string, string> = {
      list_files: t("Listing project files…"),
      search_code: t("Searching the project…"),
      read_file: t("Reading a file…"),
      find_in_file: t("Searching inside a file…"),
      count_matches: t("Counting matches…"),
      json_query: t("Inspecting JSON…"),
      find_symbols: t("Searching symbols…"),
      sqlite_query: t("Querying SQLite…"),
      csv_query: t("Querying CSV…"),
      git_blame: t("Reading git blame…"),
      write_file: t("Editing a file…"),
      replace_in_file: t("Editing a file…"),
      run_command: t("Running a command…"),
      finish: t("Writing the answer…"),
      invalid: t("Thinking…"),
    };
    return { label: labels[liveStep.action] ?? t("Thinking…"), target };
  })();

  useEffect(() => {
    const element = workflowScrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [chatMessages, chatLiveSteps, chatBusy, rightTab, chatLiveLogs]);

  useEffect(() => {
    if (!chatBusy) {
      setWaitSeconds(0);
      return;
    }
    const started = Date.now();
    setWaitSeconds(0);
    const timer = window.setInterval(
      () => setWaitSeconds(Math.floor((Date.now() - started) / 1000)),
      1_000,
    );
    return () => window.clearInterval(timer);
  }, [chatBusy]);

  useEffect(() => {
    setPathOverrides({});
    setDeletedPaths(new Set());
  }, [analysis.createdAt]);

  useEffect(() => {
    if (previewPath && !htmlFiles.includes(previewPath)) {
      setPreviewPath(htmlFiles[0] ?? "");
    }
  }, [analysis.id, htmlFiles, previewPath]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const status = await api.indexStatus(analysis.id);
        if (!cancelled) setIndexStatus(status);
      } catch {
        // index status is optional
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [analysis.id, analysis.createdAt]);

  useEffect(() => {
    setExpanded(new Set(collectFolderPaths(tree, 50)));
    setOpenTabs([]);
    setActiveFile(null);
    setContents({});
    setSavedContents({});
    setTestResult(null);
    setTestGenResult(null);
    setAnalysisStale(false);
    setError(null);
    setMessage(null);
    setTestDiscovery(null);
    setLivePreviewUrl("");
    setPreviewPath(
      analysis.files.find((file) => file.path === "index.html")?.path ??
        analysis.files.find((file) => /(^|\/)index\.html?$/i.test(file.path))?.path ??
        analysis.files.find((file) => /\.html?$/i.test(file.path))?.path ??
        "",
    );
    setPreviewKey((value) => value + 1);
    api
      .tests(analysis.id)
      .then((discovery) => {
        setTestDiscovery(discovery);
        setTestCommand(discovery.commands[0] ?? "");
      })
      .catch(() => setTestDiscovery(null));
    const pending = pendingOpenFileRef.current;
    pendingOpenFileRef.current = null;
    if (pending) {
      void openFile(pending, true);
      return;
    }
    const initial =
      analysis.files.find((file) =>
        /(^|\/)(public\/index|index|main|app|server|bootstrap|artisan|manage)\.(php|py|ts|tsx|js|jsx)$/i.test(
          file.path,
        ),
      ) ?? analysis.files[0];
    if (initial) {
      void openFile(initial.path);
      setRightTab("preview");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis.id, analysis.createdAt]);

  useEffect(() => {
    if (!modelPickerOpen) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") setModelPickerOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [modelPickerOpen]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveFile();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFile, contents]);

  useEffect(() => {
    if (!consoleOpen || bottomTab !== "jobs") return;
    const tick = async () => {
      if (jobsTickRef.current) return;
      jobsTickRef.current = true;
      try {
        await refreshJobs();
      } finally {
        jobsTickRef.current = false;
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 2000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consoleOpen, bottomTab, analysis.id]);

  function openSettings(tab: SettingsTab, addModel = false) {
    setSettingsTab(tab);
    setSettingsModelsAdd(addModel);
    setSettingsOpen(true);
  }

  async function openFile(filePath: string, force = false) {
    setPendingLine(null);
    setActiveFile(filePath);
    setRightTab(filePath);
    setOpenTabs((current) => (current.includes(filePath) ? current : [...current, filePath]));
    if (!force && contents[filePath] !== undefined) return;
    const token = ++requestRef.current;
    setFileLoading(true);
    setError(null);
    try {
      const result = await api.fileContent(analysis.id, filePath);
      if (token !== requestRef.current) return;
      setContents((current) => ({ ...current, [filePath]: result.content }));
      setSavedContents((current) => ({ ...current, [filePath]: result.content }));
    } catch (requestError) {
      if (token === requestRef.current) {
        setError(requestError instanceof Error ? requestError.message : t("Could not open the file"));
      }
    } finally {
      if (token === requestRef.current) setFileLoading(false);
    }
  }

  async function openFileAt(filePath: string, line?: number) {
    await openFile(filePath);
    if (line && line > 0) setPendingLine(line);
  }

  function closeTab(filePath: string) {
    setOpenTabs((current) => {
      const next = current.filter((path) => path !== filePath);
      if (activeFile === filePath) {
        const fallback = next[next.length - 1] ?? null;
        setActiveFile(fallback);
        setRightTab(fallback ?? "preview");
      }
      return next;
    });
  }

  function startRename(filePath: string) {
    setRenameDraft(filePath);
    setFileAction({ type: "rename", path: filePath });
  }

  function startDelete(filePath: string) {
    setFileAction({ type: "delete", path: filePath });
  }

  async function formatActiveFile() {
    if (!activeFile || formatting) return;
    setFormatting(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.formatFile(analysis.id, activeFile);
      if (result.command === undefined || result.exitCode !== 0) {
        setError(result.stderr || result.stdout || t("No formatter was detected for this file type."));
        return;
      }
      setContents((current) => ({ ...current, [result.filePath]: result.content }));
      setSavedContents((current) => ({ ...current, [result.filePath]: result.content }));
      setMessage(
        result.formatted
          ? t("Formatted {path}", { path: result.filePath })
          : t("{path} was already formatted", { path: result.filePath }),
      );
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("Could not format the file."));
    } finally {
      setFormatting(false);
    }
  }

  async function applyRename() {
    if (!fileAction || fileActionBusy) return;
    const from = fileAction.path;
    const to = renameDraft.trim().replace(/^\/+/, "");
    if (!to || to === from) {
      setFileAction(null);
      return;
    }
    setFileActionBusy(true);
    setError(null);
    try {
      const result = await api.renamePath(analysis.id, from, to);
      const remap = (value: string) =>
        value === from || value.startsWith(`${from}/`) ? result.to + value.slice(from.length) : value;
      setOpenTabs((current) => current.map(remap));
      setActiveFile((current) => (current ? remap(current) : current));
      setRightTab((current) => (current === "preview" ? current : remap(current)));
      setContents((current) => {
        const next: Record<string, string> = {};
        for (const [key, value] of Object.entries(current)) next[remap(key)] = value;
        return next;
      });
      setSavedContents((current) => {
        const next: Record<string, string> = {};
        for (const [key, value] of Object.entries(current)) next[remap(key)] = value;
        return next;
      });
      setPathOverrides((current) => ({ ...current, [from]: result.to }));
      setAnalysisStale(true);
      setMessage(t("Renamed to {path}", { path: result.to }));
      setFileAction(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("Could not rename the path"));
    } finally {
      setFileActionBusy(false);
    }
  }

  async function applyDelete() {
    if (!fileAction || fileActionBusy) return;
    const target = fileAction.path;
    setFileActionBusy(true);
    setError(null);
    try {
      await api.deletePath(analysis.id, target);
      const isUnder = (value: string) => value === target || value.startsWith(`${target}/`);
      setOpenTabs((current) => current.filter((path) => !isUnder(path)));
      if (activeFile && isUnder(activeFile)) {
        setActiveFile(null);
        setRightTab("preview");
      }
      setContents((current) => {
        const next = { ...current };
        for (const key of Object.keys(next)) if (isUnder(key)) delete next[key];
        return next;
      });
      setSavedContents((current) => {
        const next = { ...current };
        for (const key of Object.keys(next)) if (isUnder(key)) delete next[key];
        return next;
      });
      setDeletedPaths((current) => new Set([...current, target]));
      setAnalysisStale(true);
      setMessage(t("Deleted {path}", { path: target }));
      setFileAction(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("Could not delete the path"));
    } finally {
      setFileActionBusy(false);
    }
  }

  async function saveFile() {
    if (!activeFile || saving) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const content = contents[activeFile] ?? "";
      const written = await api.writeFile(analysis.id, activeFile, content);
      let finalContent = content;
      let formatNote = "";
      setAnalysisStale(true);

      if (autoFormat) {
        const formatted = await api.formatFile(analysis.id, activeFile).catch(() => null);
        if (!formatted || formatted.command === undefined) {
          formatNote = t("No formatter was detected.");
        } else if (formatted.exitCode === 0) {
          finalContent = formatted.content;
          setContents((current) => ({ ...current, [activeFile]: formatted.content }));
          setSavedContents((current) => ({ ...current, [activeFile]: formatted.content }));
          formatNote = formatted.formatted ? t("Formatted on save.") : "";
        } else {
          setError(
            t("Saved, but formatting failed: {message}", {
              message: formatted.stderr || formatted.stdout || t("unknown formatter error"),
            }),
          );
        }
      }

      setSavedContents((current) => ({ ...current, [activeFile]: finalContent }));
      setMessage(
        `${written.backupPath
          ? t("Saved. A local backup was created before writing.")
          : t("Saved.")}${formatNote ? ` ${formatNote}` : ""}`,
      );
      if (autoSyntax && activeFile) {
        void runSyntaxCheck(activeFile);
      }
      const typecheck = analysis.tooling?.typecheckCommands?.[0];
      if (autoCheck && typecheck) {
        void runCheck(typecheck);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("Could not save the file"));
    } finally {
      setSaving(false);
    }
  }

  function flushCheckOutput() {
    if (checkFlushRef.current != null) {
      window.clearTimeout(checkFlushRef.current);
      checkFlushRef.current = null;
    }
    setCheckOutput(checkOutputRef.current);
  }

  function pushCheckOutput(chunk: string) {
    checkOutputRef.current += chunk;
    if (checkFlushRef.current == null) {
      checkFlushRef.current = window.setTimeout(() => {
        checkFlushRef.current = null;
        setCheckOutput(checkOutputRef.current);
      }, 80);
    }
  }

  function stopCheck() {
    checkAbortRef.current?.abort();
  }

  async function runSyntaxCheck(filePath = activeFile, openPanel = false) {
    if (!filePath || syntaxBusy) return;
    setSyntaxBusy(true);
    setError(null);
    try {
      const result = await api.checkSyntax(analysis.id, filePath);
      if (!result.supported && !openPanel) return;
      if (openPanel || !result.ok) {
        setCheckCommand(result.command ?? "syntax check");
        setCheckOutput(
          result.output ||
            (result.ok ? t("No syntax errors.") : t("Syntax check failed.")),
        );
        setCheckResult({
          command: result.command ?? "syntax check",
          cwd: ".",
          exitCode: result.exitCode,
          stdout: result.output,
          stderr: "",
          durationMs: 0,
          timedOut: false,
          truncated: false,
        });
        setBottomTab("checks");
        setConsoleOpen(true);
      }
      if (!result.ok) setError(result.output || t("Syntax check failed."));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("Syntax check failed."));
    } finally {
      setSyntaxBusy(false);
    }
  }

  async function scanDuplicates() {
    if (duplicationBusy) return;
    setDuplicationBusy(true);
    setError(null);
    try {
      const report = await api.scanDuplications(analysis.id, 6);
      setDuplication(report);
      setBottomTab("checks");
      setConsoleOpen(true);
      setMessage(
        t("{blocks} duplicate blocks · {lines} duplicated lines", {
          blocks: report.blocks.length,
          lines: report.duplicatedLines,
        }),
      );
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : t("Duplication scan failed."),
      );
    } finally {
      setDuplicationBusy(false);
    }
  }

  async function runCheck(command: string) {
    const trimmed = command.trim();
    if (!trimmed || checkBusy) return;
    setBottomTab("checks");
    setConsoleOpen(true);
    setCheckBusy(true);
    setCheckCommand(trimmed);
    setCheckOutput("");
    setCheckResult(null);
    checkOutputRef.current = "";
    setError(null);
    const controller = new AbortController();
    checkAbortRef.current = controller;
    try {
      await api.runCommandStream(
        analysis.id,
        trimmed,
        { timeoutMs: 10 * 60_000 },
        (event) => {
          if (event.type === "stdout" || event.type === "stderr") {
            pushCheckOutput(event.chunk);
          } else if (event.type === "exit") {
            setCheckResult(event.result);
          } else if (event.type === "error") {
            setError(event.message);
            pushCheckOutput(`\n${event.message}\n`);
          }
        },
        controller.signal,
      );
    } catch (requestError) {
      if (controller.signal.aborted) {
        pushCheckOutput(`\n${t("Stopped by the user.")}\n`);
      } else {
        setError(requestError instanceof Error ? requestError.message : t("Check failed to start"));
      }
    } finally {
      checkAbortRef.current = null;
      setCheckBusy(false);
      flushCheckOutput();
    }
  }

  function updateTerminal(id: string, patch: Partial<TerminalSession>) {
    setTerminals((current) => current.map((terminal) => (terminal.id === id ? { ...terminal, ...patch } : terminal)));
  }

  function flushTerminalOutput(id: string) {
    if (terminalFlushRef.current[id] != null) {
      window.clearTimeout(terminalFlushRef.current[id] ?? undefined);
      terminalFlushRef.current[id] = null;
    }
    updateTerminal(id, { output: terminalOutputRef.current[id] ?? "" });
  }

  function pushTerminalOutput(id: string, chunk: string) {
    terminalOutputRef.current[id] = (terminalOutputRef.current[id] ?? "") + chunk;
    if (terminalFlushRef.current[id] == null) {
      terminalFlushRef.current[id] = window.setTimeout(() => {
        terminalFlushRef.current[id] = null;
        updateTerminal(id, { output: terminalOutputRef.current[id] ?? "" });
      }, 80);
    }
  }

  function newTerminal() {
    const session = createTerminalSession();
    setTerminals((current) => [...current, session]);
    setActiveTerminalId(session.id);
  }

  async function newShellTerminal() {
    const session = createTerminalSession(undefined, "shell");
    setTerminals((current) => [...current, session]);
    setActiveTerminalId(session.id);
    setBottomTab("terminal");
    setConsoleOpen(true);
    try {
      const info = await api.terminals.create(analysis.id);
      updateTerminal(session.id, { serverId: info.id, shellStatus: "running" });
    } catch (requestError) {
      updateTerminal(session.id, { shellStatus: "exited" });
      setError(
        requestError instanceof Error ? requestError.message : t("Could not start the interactive shell."),
      );
    }
  }

  function closeTerminal(id: string) {
    if (agentTerminalRef.current === id) agentTerminalRef.current = null;
    const session = terminals.find((terminal) => terminal.id === id);
    if (session?.kind === "shell" && session.serverId) {
      void api.terminals.close(analysis.id, session.serverId).catch(() => {
        // session may already be gone
      });
    }
    terminalAbortRef.current[id]?.abort();
    terminalAbortRef.current[id] = null;
    setTerminals((current) => {
      const next = current.filter((terminal) => terminal.id !== id);
      if (next.length === 0) {
        const fresh = createTerminalSession();
        setActiveTerminalId(fresh.id);
        return [fresh];
      }
      setActiveTerminalId((active) => (active === id ? next[next.length - 1].id : active));
      return next;
    });
  }

  function stopTerminal(id: string) {
    const session = terminals.find((terminal) => terminal.id === id);
    if (session?.kind === "shell" && session.serverId) {
      void api.terminals.interrupt(analysis.id, session.serverId).catch((error: unknown) => {
        setError(error instanceof Error ? error.message : t("Could not interrupt the interactive shell."));
      });
      return;
    }
    terminalAbortRef.current[id]?.abort();
  }

  function rememberCommand(command: string) {
    const trimmed = command.trim();
    if (!trimmed) return;
    setCommandHistory((current) => {
      const next = [trimmed, ...current.filter((item) => item !== trimmed)].slice(0, 50);
      localStorage.setItem(`cie:studio-command-history:${analysis.id}`, JSON.stringify(next));
      return next;
    });
    commandHistoryIndexRef.current = -1;
  }

  function toggleCommandFavorite(command: string) {
    const trimmed = command.trim();
    if (!trimmed) return;
    setCommandFavorites((current) => {
      const next = current.includes(trimmed)
        ? current.filter((item) => item !== trimmed)
        : [trimmed, ...current].slice(0, 30);
      localStorage.setItem(`cie:studio-command-favorites:${analysis.id}`, JSON.stringify(next));
      return next;
    });
  }

  function navigateCommandHistory(direction: 1 | -1) {
    if (commandHistory.length === 0 || !activeTerminal) return;
    const nextIndex = Math.max(
      -1,
      Math.min(commandHistory.length - 1, commandHistoryIndexRef.current + direction),
    );
    commandHistoryIndexRef.current = nextIndex;
    updateTerminal(activeTerminal.id, {
      command: nextIndex < 0 ? "" : commandHistory[nextIndex],
    });
  }

  function appendAgentTerminal(step: AiAgentStep) {
    if (step.action !== "run_command") return;
    let id = agentTerminalRef.current;
    if (!id) {
      const session = createTerminalSession(t("Agent"));
      id = session.id;
      agentTerminalRef.current = id;
      setTerminals((current) => [...current, session]);
    }
    const command = typeof step.args.command === "string" ? step.args.command : "";
    const chunk = `$ ${command}\n${step.observation}\n\n`;
    terminalOutputRef.current[id] = `${terminalOutputRef.current[id] ?? ""}${chunk}`;
    updateTerminal(id, { output: terminalOutputRef.current[id], command, result: null });
  }

  async function runCommand(nextCommand?: string, terminalId?: string) {
    const id = terminalId ?? activeTerminalId;
    const session = terminals.find((terminal) => terminal.id === id);
    if (!session || session.busy) return;
    const trimmed = (nextCommand ?? session.command).trim();
    if (!trimmed) return;
    rememberCommand(trimmed);
    updateTerminal(id, { command: trimmed, output: "", result: null, busy: true });
    setBottomTab("terminal");
    setError(null);
    terminalOutputRef.current[id] = "";
    const controller = new AbortController();
    terminalAbortRef.current[id] = controller;
    try {
      await api.runCommandStream(
        analysis.id,
        trimmed,
        { timeoutMs: 10 * 60_000 },
        (event) => {
          if (event.type === "stdout" || event.type === "stderr") {
            pushTerminalOutput(id, event.chunk);
          } else if (event.type === "exit") {
            updateTerminal(id, { result: event.result });
          } else if (event.type === "error") {
            setError(event.message);
            pushTerminalOutput(id, `\n${event.message}\n`);
          }
        },
        controller.signal,
      );
    } catch (requestError) {
      if (controller.signal.aborted) {
        pushTerminalOutput(id, `\n${t("Stopped by the user.")}\n`);
      } else {
        setError(requestError instanceof Error ? requestError.message : t("Command failed to start"));
      }
    } finally {
      terminalAbortRef.current[id] = null;
      updateTerminal(id, { busy: false });
      flushTerminalOutput(id);
    }
  }

  async function buildIndex() {
    try {
      const status = await api.buildIndex(analysis.id);
      setIndexStatus(status);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("Could not start the index build."));
    }
  }

  async function runIndexSearch(nextQuery = indexQuery) {
    const query = nextQuery.trim();
    if (!query) return;
    setIndexSearchBusy(true);
    try {
      const result = await api.searchIndex(analysis.id, query, 30);
      setIndexResults(result.results);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("Index search failed."));
    } finally {
      setIndexSearchBusy(false);
    }
  }

  async function refreshJobs() {
    try {
      const result = await api.processes.list(analysis.id);
      setJobs(result.jobs);
      for (const job of result.jobs) {
        const read = await api.processes.read(analysis.id, job.id, jobOffsetsRef.current[job.id] ?? 0);
        if (read.output) {
          jobOffsetsRef.current[job.id] = read.offset;
          setJobOutputs((current) => ({
            ...current,
            [job.id]: (current[job.id] ?? "") + read.output,
          }));
        }
      }
    } catch (requestError) {
      setJobError(requestError instanceof Error ? requestError.message : t("Could not load background jobs."));
    }
  }

  async function startBackgroundCommand(commandText?: string) {
    const text = (commandText ?? activeTerminal?.command ?? "").trim();
    if (!text) return;
    rememberCommand(text);
    setJobError(null);
    try {
      const job = await api.processes.start(analysis.id, text);
      setJobs((current) => [job, ...current]);
      jobOffsetsRef.current[job.id] = 0;
      setJobOutputs((current) => ({ ...current, [job.id]: "" }));
      setBottomTab("jobs");
      setConsoleOpen(true);
    } catch (requestError) {
      setJobError(requestError instanceof Error ? requestError.message : t("Could not start background job."));
    }
  }

  async function stopJob(jobId: string) {
    try {
      const job = await api.processes.stop(analysis.id, jobId);
      setJobs((current) => current.map((item) => (item.id === jobId ? job : item)));
    } catch (requestError) {
      setJobError(requestError instanceof Error ? requestError.message : t("Could not stop background job."));
    }
  }

  async function removeJob(jobId: string) {
    try {
      await api.processes.remove(analysis.id, jobId);
      setJobs((current) => current.filter((item) => item.id !== jobId));
      setJobOutputs((current) => {
        const next = { ...current };
        delete next[jobId];
        return next;
      });
    } catch (requestError) {
      setJobError(requestError instanceof Error ? requestError.message : t("Could not remove background job."));
    }
  }

  async function inspectPreview() {
    if (browserCheckBusy) return;
    const target = effectivePreviewPath || htmlFiles[0] || "index.html";
    setBrowserCheckBusy(true);
    setBrowserCheckError(null);
    try {
      const result = await api.browserCheck(analysis.id, {
        path: target,
        mobile: false,
        screenshot: true,
      });
      setBrowserCheck(result);
      setBottomTab("checks");
      setConsoleOpen(true);
    } catch (requestError) {
      setBrowserCheckError(
        requestError instanceof Error ? requestError.message : t("Browser check failed."),
      );
    } finally {
      setBrowserCheckBusy(false);
    }
  }

  async function checkGame() {
    if (browserCheckBusy) return;
    setBrowserCheckBusy(true);
    setBrowserCheckError(null);
    try {
      const result = await api.gameCheck(analysis.id, {
        path: effectivePreviewPath || htmlFiles[0] || "index.html",
        url: livePreviewUrl || undefined,
        screenshot: true,
      });
      setBrowserCheck(result.check);
      setGameEngine(result.engine);
      setBottomTab("checks");
      setConsoleOpen(true);
    } catch (requestError) {
      setBrowserCheckError(
        requestError instanceof Error ? requestError.message : t("Game check failed."),
      );
    } finally {
      setBrowserCheckBusy(false);
    }
  }

  async function runTests(command = testCommand) {
    if (testBusy) return;
    const trimmed = command.trim();
    if (!trimmed) return;
    setTestCommand(trimmed);
    setTestBusy(true);
    setError(null);
    setTestResult(null);
    setTestOutput("");
    const controller = new AbortController();
    testAbortRef.current = controller;
    let result: TestRunResult | null = null;
    try {
      await api.runTestsStream(
        analysis.id,
        trimmed,
        { timeoutSeconds: testTimeout },
        (event) => {
          if (event.type === "output") {
            setTestOutput((current) => `${current}${event.chunk}`.slice(-240_000));
          } else if (event.type === "done") {
            result = event.result;
          } else if (event.type === "error") {
            setError(event.message);
          }
        },
        controller.signal,
      );
      if (result) setTestResult(result);
    } catch (requestError) {
      if (controller.signal.aborted) {
        setMessage(t("Test run stopped."));
      } else {
        setError(requestError instanceof Error ? requestError.message : t("Test run failed to start"));
      }
    } finally {
      testAbortRef.current = null;
      setTestBusy(false);
    }
  }

  function stopTests() {
    testAbortRef.current?.abort();
  }

  function testFailuresPrompt(): string {
    if (!testResult) return "";
    const output = `${testResult.stdout}\n${testResult.stderr}`.trim();
    const failures = testResult.failures
      .slice(0, 12)
      .map((failure) => {
        const location = failure.file
          ? ` (${failure.file}${failure.line ? `:${failure.line}` : ""})`
          : "";
        return `- ${failure.name}${location}${failure.message ? `: ${failure.message}` : ""}`;
      })
      .join("\n");
    return [
      `Tests failed. Command: ${testResult.command}`,
      `Summary: ${testResult.summary.passed} passed, ${testResult.summary.failed} failed, ${testResult.summary.skipped} skipped.`,
      failures ? `Failures:\n${failures}` : "",
      `Output (tail):\n${output.slice(-4000)}`,
      "Find the root cause, fix the code, and rerun the tests.",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  async function generateTests() {
    if (!active || !activeFile || testGenBusy) return;
    setTestGenBusy(true);
    setError(null);
    setTestGenResult(null);
    try {
      const result = await api.ai.generateTests(
        analysis.id,
        activeFile,
        testDiscovery?.framework,
        testGenInstruction.trim(),
        active.provider,
        active.model,
      );
      setTestGenResult(result);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("AI test generation failed"));
    } finally {
      setTestGenBusy(false);
    }
  }

  async function decidePermission(decision: AiPermissionDecision) {
    if (!permissionRequest) return;
    const request = permissionRequest;
    setPermissionBusy(true);
    try {
      await api.ai.resolvePermission(analysis.id, request.requestId, decision);
      if (decision === "always") {
        if (request.kind === "write") setAgentAllowWrite(true);
        else setAgentAllowCommands(true);
      }
      setPermissionQueue((queue) => queue.filter((item) => item.requestId !== request.requestId));
    } catch (requestError) {
      setPermissionQueue((queue) => queue.filter((item) => item.requestId !== request.requestId));
      setError(
        requestError instanceof Error
          ? requestError.message
          : t("Could not send the permission decision."),
      );
    } finally {
      setPermissionBusy(false);
    }
  }

  async function refreshAgentFiles(paths: string[]) {
    if (paths.length === 0) return;
    setAnalysisStale(true);
    const refreshed = await Promise.all(
      paths.map(async (changedPath) => {
        const file = await api.fileContent(analysis.id, changedPath).catch(() => null);
        return file ? ([changedPath, file] as const) : null;
      }),
    );
    setContents((current) => {
      const next = { ...current };
      for (const entry of refreshed) if (entry) next[entry[0]] = entry[1].content;
      return next;
    });
    setSavedContents((current) => {
      const next = { ...current };
      for (const entry of refreshed) if (entry) next[entry[0]] = entry[1].content;
      return next;
    });
    setOpenTabs((current) => [...new Set([...current, ...paths])]);
  }

  async function summarizeFullProject() {
    if (!active || summaryBusy) return;
    setSummaryBusy(true);
    setChatError(null);
    try {
      const result = await api.ai.summary(
        analysis.id,
        active.provider,
        active.model,
        false,
        locale,
      );
      const sections = [
        result.summary,
        result.architecture ? `${t("Architecture")}\n${result.architecture}` : "",
        result.keyFlows.length > 0 ? `${t("Key flows")}\n${result.keyFlows.map((flow) => `- ${flow}`).join("\n")}` : "",
        result.entryPoints.length > 0 ? `${t("Entry points")}\n${result.entryPoints.map((entry) => `- ${entry}`).join("\n")}` : "",
        result.risks.length > 0 ? `${t("Risks")}\n${result.risks.map((risk) => `- ${risk}`).join("\n")}` : "",
      ].filter(Boolean);
      setChatMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: sections.join("\n\n"),
          evidence: result.evidence.map((item) => ({ path: item.path, startLine: item.startLine })),
          tokenUsage: result.tokenUsage,
          provider: active?.provider,
          model: active?.model,
        },
      ]);
    } catch (requestError) {
      setChatError(requestError instanceof Error ? requestError.message : t("Project summary failed"));
    } finally {
      setSummaryBusy(false);
    }
  }

  function serializeChatMessages(messages: StudioChatMessage[]) {
    return messages
      .slice(-40)
      .map(({ role, content, evidence, tokenUsage, logs, plan, planPath, mode, provider, model, taskQueue, intent }) => ({
        role,
        content,
        evidence,
        tokenUsage,
        logs: logs?.slice(-150),
        plan,
        planPath,
        mode,
        provider,
        model,
        taskQueue,
        intent,
      }));
  }

  function persistChatMessages(tabId: string, messages: StudioChatMessage[]) {
    if (!tabId) return;
    try {
      localStorage.setItem(
        `cie:studio-chat:${analysis.id}:${tabId}`,
        JSON.stringify(serializeChatMessages(messages)),
      );
    } catch {
      // storage may be unavailable
    }
  }

  function createChatTab() {
    if (chatBusy) return;
    const at = new Date().toISOString();
    const tab: StudioChatTab = {
      id: `chat-${Date.now()}`,
      title: t("New chat"),
      createdAt: at,
      updatedAt: at,
    };
    persistChatMessages(activeChatId, chatMessages);
    skipChatSaveRef.current = true;
    setChatTabs((current) => [...current, tab]);
    setActiveChatId(tab.id);
    setChatMessages([]);
    setChatInput("");
    setChatError(null);
    setChatRetryQuestion(null);
    chatHydratedRef.current = true;
  }

  function switchChatTab(tabId: string) {
    if (chatBusy || tabId === activeChatId) return;
    const tab = chatTabs.find((item) => item.id === tabId);
    if (!tab) return;
    persistChatMessages(activeChatId, chatMessages);
    skipChatSaveRef.current = true;
    setActiveChatId(tabId);
    let messages: StudioChatMessage[] = [];
    try {
      const raw = localStorage.getItem(`cie:studio-chat:${analysis.id}:${tabId}`);
      const parsed = JSON.parse(raw ?? "[]") as StudioChatMessage[];
      messages = Array.isArray(parsed) ? parsed.slice(-40) : [];
    } catch {
      messages = [];
    }
    setChatMessages(messages);
    setChatInput("");
    setChatError(null);
    setChatRetryQuestion(null);
    chatHydratedRef.current = true;
  }

  function closeChatTab(tabId: string) {
    if (chatBusy) return;
    const remaining = chatTabs.filter((tab) => tab.id !== tabId);
    try {
      localStorage.removeItem(`cie:studio-chat:${analysis.id}:${tabId}`);
    } catch {
      // ignore storage failures
    }
    if (remaining.length === 0) {
      const at = new Date().toISOString();
      const tab: StudioChatTab = {
        id: `chat-${Date.now()}`,
        title: t("New chat"),
        createdAt: at,
        updatedAt: at,
      };
      setChatTabs([tab]);
      setActiveChatId(tab.id);
      setChatMessages([]);
      return;
    }
    setChatTabs(remaining);
    if (tabId === activeChatId) {
      const index = chatTabs.findIndex((tab) => tab.id === tabId);
      const next = remaining[Math.min(Math.max(0, index - 1), remaining.length - 1)];
      setActiveChatId(next.id);
      let messages: StudioChatMessage[] = [];
      try {
        const raw = localStorage.getItem(`cie:studio-chat:${analysis.id}:${next.id}`);
        const parsed = JSON.parse(raw ?? "[]") as StudioChatMessage[];
        messages = Array.isArray(parsed) ? parsed.slice(-40) : [];
      } catch {
        messages = [];
      }
      setChatMessages(messages);
    }
  }

  function clearActiveChat() {
    persistChatMessages(activeChatId, []);
    setChatMessages([]);
    setChatTabs((current) =>
      current.map((tab) => (tab.id === activeChatId ? { ...tab, title: t("New chat") } : tab)),
    );
  }

  async function updateQueueTask(taskId: string, patch: Parameters<typeof api.tasks.update>[2]) {
    try {
      const result = await api.tasks.update(analysis.id, taskId, patch);
      setTaskQueue(result.queue);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("Could not update the task."));
    }
  }

  async function deleteQueueTask(taskId: string) {
    try {
      const result = await api.tasks.remove(analysis.id, taskId);
      setTaskQueue(result.queue);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("Could not delete the task."));
    }
  }

  async function moveQueueTask(taskId: string, direction: "up" | "down") {
    if (!taskQueue) return;
    const order = taskQueue.tasks.map((task) => task.id);
    const index = order.indexOf(taskId);
    const target = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target], order[index]];
    try {
      const result = await api.tasks.reorder(analysis.id, order);
      setTaskQueue(result.queue);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("Could not reorder the tasks."));
    }
  }

  async function askProject(
    question = chatInput,
    appendUser = true,
    runOptions: {
      retryFailed?: boolean;
      skipClarify?: boolean;
      workspaceMode?: AiWorkspaceMode;
      provider?: AiProviderId;
      model?: string;
    } = {},
  ) {
    const modeForRun = runOptions.workspaceMode ?? studioMode;
    if (!active || (!question.trim() && !attachment) || chatBusy) return;
    const runProvider = runOptions.provider ?? active.provider;
    const runModel = runOptions.model ?? active.model;
    const baseText = question.trim();
    const text = attachment
      ? `${baseText}${baseText ? "\n\n" : ""}Ek dosya: ${attachment.path}`
      : baseText;
    const userMessage = { role: "user" as const, content: text };
    let history = chatMessages.map((message) => ({ role: message.role, content: message.content }));
    if (appendUser) {
      setChatMessages((current) => [...current, userMessage]);
      setChatInput("");
      setAttachment(null);
    } else {
      const last = chatMessages[chatMessages.length - 1];
      if (last?.role === "user" && last.content === text) {
        history = chatMessages.slice(0, -1).map((message) => ({ role: message.role, content: message.content }));
      }
    }
    setClarification(null);
    setModelNotice(null);
    lastIntentRef.current = null;
    setIntentOpenIndex(null);
    setChatBusy(true);
    setChatError(null);
    setChatRetryQuestion(null);
    agentStopRequestedRef.current = false;
    setChatLiveSteps([]);
    setChatLiveLogs([]);
    setChatLivePlan(null);
    setChatLiveAnswer("");
    chatLiveLogsRef.current = [];
    setError(null);
    setPermissionQueue([]);
    setPermissionBusy(false);
    const controller = new AbortController();
    agentAbortRef.current = controller;
    const liveSteps: AiAgentStep[] = [];
    const holder: { result: AiAgentResult | null } = { result: null };
    const useTaskLoop = true;
    if (useTaskLoop) setTaskQueue(null);

    const handleEvent = (event: AiAgentEvent) => {
      if (event.type === "step") {
        liveSteps.push(event.step);
        setChatLiveSteps([...liveSteps]);
        appendAgentTerminal(event.step);
      } else if (event.type === "log") {
        chatLiveLogsRef.current = [...chatLiveLogsRef.current, event.entry].slice(-200);
        setChatLiveLogs(chatLiveLogsRef.current);
      } else if (event.type === "permission") {
        setPermissionQueue((queue) => [...queue, event.request]);
        setPermissionBusy(false);
      } else if (event.type === "intent") {
        lastIntentRef.current = event.intent;
      } else if (event.type === "clarify") {
        setClarification({ request: event.request, original: text });
      } else if (event.type === "model") {
        setModelNotice({ from: event.from, to: event.to, reason: event.reason });
      } else if (event.type === "task") {
        setTaskQueue(event.queue);
      } else if (event.type === "token") {
        setChatLiveAnswer((current) => current + event.text);
      } else if (event.type === "done") {
        holder.result = event.result;
        if (event.result.taskQueue) setTaskQueue(event.result.taskQueue);
      } else if (event.type === "error") {
        setChatError(event.message);
      }
    };

    try {
      if (useTaskLoop) {
        await api.tasks.loopStream(
          analysis.id,
          text,
          {
            activeFile: activeFile ?? undefined,
            provider: runProvider,
            model: runModel,
            allowWrite: modeForRun === "build" ? agentAllowWrite : false,
            allowCommands: modeForRun === "build" ? agentAllowCommands : false,
            language: locale,
            maxTasks: modeForRun === "build" ? 12 : 1,
            maxMinutes: modeForRun === "build" ? 45 : 15,
            workspaceMode: modeForRun,
            retryFailed: runOptions.retryFailed === true,
            clarified: runOptions.skipClarify === true,
            history: history.slice(-8),
          },
          handleEvent,
          controller.signal,
        );
      } else {
        await api.ai.agentStream(
          analysis.id,
          text,
          {
            mode: "auto",
            history,
            activeFile: activeFile ?? undefined,
            provider: runProvider,
            model: runModel,
            allowWrite: modeForRun === "build" ? agentAllowWrite : false,
            allowCommands: modeForRun === "build" ? agentAllowCommands : false,
            language: locale,
            workspaceMode: modeForRun,
            clarified: runOptions.skipClarify === true,
          },
          handleEvent,
          controller.signal,
        );
      }
    } catch (requestError) {
      if (controller.signal.aborted && agentStopRequestedRef.current) {
        holder.result = {
          instruction: text,
          summary: t("Stopped by the user."),
          steps: liveSteps,
          changedFiles: [],
          ranCommands: [],
          stoppedReason: "aborted",
          provider: runProvider,
          model: runModel,
          createdAt: new Date().toISOString(),
        };
      } else if (controller.signal.aborted) {
        // The browser connection dropped (screen lock, sleep, reload). The run
        // keeps going on the server, so do not report it as a user stop.
        const queue = await api.tasks.get(analysis.id).catch(() => null);
        if (queue?.queue) setTaskQueue(queue.queue);
        setChatError(
          t(
            "Connection lost. The task is still running on the server; progress will refresh automatically.",
          ),
        );
      } else {
        setChatError(requestError instanceof Error ? requestError.message : t("Project chat failed"));
        setChatRetryQuestion(text);
      }
    } finally {
      agentAbortRef.current = null;
    }

    if (holder.result) {
      const result = holder.result;
      setChatMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: result.summary,
          evidence:
            result.usage?.contextFiles?.map((item) => ({ path: item.path, startLine: item.startLine })) ?? [],
          steps: result.steps,
          logs: result.logs?.slice(-150),
          tokenUsage: result.tokenUsage,
          costUsd: result.costUsd,
          plan: result.plan,
          planPath: result.planPath,
          mode: modeForRun,
          provider: result.provider,
          model: result.model,
          taskQueue: result.taskQueue,
          intent: lastIntentRef.current ?? undefined,
        },
      ]);
      if (result.changedFiles.length > 0) {
        await refreshAgentFiles(result.changedFiles);
        setRightTab(result.changedFiles[0]);
        if (useTaskLoop) {
          window.setTimeout(() => onRescan(), 500);
        }
      }
    }
    setChatLiveSteps([]);
    setChatLiveLogs([]);
    setChatLivePlan(null);
    setChatLiveAnswer("");
    chatLiveLogsRef.current = [];
    setChatBusy(false);
  }
  async function uploadAsset(file: File) {
    if (assetBusy) return;
    if (file.size > 15_000_000) {
      setError(t("Asset is too large (maximum 15 MB)."));
      return;
    }
    setAssetBusy(true);
    setError(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => reject(reader.error ?? new Error("Could not read the file."));
        reader.readAsDataURL(file);
      });
      const dataBase64 = dataUrl.split(",")[1] ?? "";
      const safeName = file.name.replace(/[^\w.\-]+/g, "-") || "asset.bin";
      const uploaded = await api.uploadAsset(analysis.id, `assets/${safeName}`, dataBase64);
      setMessage(
        t("Uploaded {path} ({size} KB). Ask the agent to read, search or summarize it.", {
          path: uploaded.filePath,
          size: Math.max(1, Math.round(uploaded.bytes / 1024)),
        }),
      );
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : t("Could not upload the asset."),
      );
    } finally {
      setAssetBusy(false);
      if (assetInputRef.current) assetInputRef.current.value = "";
    }
  }

  async function attachTaskFile(file: File) {
    if (assetBusy) return;
    if (file.size > 15_000_000) {
      setError(t("File is too large (maximum 15 MB)."));
      return;
    }
    setAssetBusy(true);
    setError(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => reject(reader.error ?? new Error("Could not read the file."));
        reader.readAsDataURL(file);
      });
      const dataBase64 = dataUrl.split(",")[1] ?? "";
      const safeName = file.name.replace(/[^\w.\-]+/g, "-") || "attachment.bin";
      const uploaded = await api.uploadAsset(analysis.id, `assets/${safeName}`, dataBase64);
      setAttachment({ path: uploaded.filePath, name: file.name, bytes: uploaded.bytes });
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : t("Could not attach the file."),
      );
    } finally {
      setAssetBusy(false);
      if (taskFileInputRef.current) taskFileInputRef.current.value = "";
    }
  }

  async function createNewFile() {
    const path = newFileDraft.trim().replace(/^\/+/, "");
    if (!path || newFileBusy) return;
    setNewFileBusy(true);
    setError(null);
    try {
      const template = FILE_TEMPLATES.find((item) => item.id === newFileTemplate);
      const content = template?.content ?? "";
      const created = await api.createFile(analysis.id, path);
      if (content) {
        await api.writeFile(analysis.id, created.filePath, content);
      }
      pendingOpenFileRef.current = created.filePath;
      setContents((current) => ({ ...current, [created.filePath]: content }));
      setSavedContents((current) => ({ ...current, [created.filePath]: content }));
      setOpenTabs((current) => [...new Set([...current, created.filePath])]);
      setActiveFile(created.filePath);
      setNewFileOpen(false);
      setNewFileDraft("");
      setNewFileTemplate("empty");
      setMessage(t("Created {path}", { path: created.filePath }));
      onRescan();
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : t("Could not create the file."),
      );
    } finally {
      setNewFileBusy(false);
    }
  }

  async function createTestFile() {
    if (!testGenResult || saving) return;
    setSaving(true);
    setError(null);
    try {
      await api.writeFile(analysis.id, testGenResult.testFilePath, testGenResult.content);
      setContents((current) => ({ ...current, [testGenResult.testFilePath]: testGenResult.content }));
      setSavedContents((current) => ({ ...current, [testGenResult.testFilePath]: testGenResult.content }));
      setOpenTabs((current) =>
        current.includes(testGenResult.testFilePath)
          ? current
          : [...current, testGenResult.testFilePath],
      );
      setActiveFile(testGenResult.testFilePath);
      setAnalysisStale(true);
      setMessage(t("Test file created. Rescan to include it in the graph and test discovery."));
      setTestGenResult(null);
      setTestGenInstruction("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("Could not create the test file"));
    } finally {
      setSaving(false);
    }
  }

  const testGenDiff = useMemo(
    () => (testGenResult ? diffLines("", testGenResult.content) : []),
    [testGenResult],
  );

  function startResize(side: "left" | "right", event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const container = studioRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const startX = event.clientX;
    const startLeft = leftWidth;
    const startRight = rightWidth;
    const minLeft = 140;
    const minCenter = 200;
    const minRight = 180;
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    setResizing(side);
    try {
      handle.setPointerCapture(pointerId);
    } catch {
      // pointer capture is best-effort
    }

    const onMove = (moveEvent: PointerEvent) => {
      if (side === "left") {
        const maxLeft = Math.min(rect.width * 0.45, rect.width - startRight - minCenter);
        setLeftWidth(Math.max(minLeft, Math.min(maxLeft, startLeft + moveEvent.clientX - startX)));
      } else {
        const maxRight = Math.min(rect.width * 0.8, rect.width - startLeft - minCenter);
        setRightWidth(Math.max(minRight, Math.min(maxRight, startRight - (moveEvent.clientX - startX))));
      }
    };
    const onUp = () => {
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
      setResizing(null);
      try {
        handle.releasePointerCapture(pointerId);
      } catch {
        // already released
      }
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("blur", onUp);
      setLeftWidth((value) => {
        localStorage.setItem("cie:studio-left-width", String(value));
        return value;
      });
      setRightWidth((value) => {
        localStorage.setItem("cie:studio-right-width", String(value));
        return value;
      });
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onUp);
  }

  return (
    <div
      ref={studioRef}
      className={`code-studio ${chatExpanded ? "chat-expanded" : ""} ${
        previewFullscreen ? "preview-fullscreen" : ""
      } ${
        leftWidth <= 155 ? "sidebar-collapsed" : ""
      } ${resizing ? "is-resizing" : ""}`}
      style={{ "--studio-left": `${leftWidth}px`, "--studio-right": `${rightWidth}px` } as CSSProperties}
    >
      <aside className="code-studio-sidebar">
        <div className="code-studio-side-head">
          <div>
            <span className="studio-eyebrow">{t("Code Studio")}</span>
            <strong>{analysis.projectName}</strong>
          </div>
          <div className="studio-side-head-actions">
            <span className="studio-write-pill">{t("Write mode")}</span>
            <button
              className="icon-button subtle"
              onClick={() => setLeftWidth(leftWidth <= 155 ? 252 : 150)}
              title={leftWidth <= 155 ? t("Open project tree") : t("Collapse project tree")}
            >
              {leftWidth <= 155 ? <PanelLeftOpen size={12} /> : <PanelLeftClose size={12} />}
            </button>
          </div>
        </div>
        {onLoadRecent && onRemoveRecent ? (
          <div className="studio-project-switch">
            <ProjectSwitcher
              analysis={analysis}
              recent={recent}
              onLoadRecent={onLoadRecent}
              onRemoveRecent={onRemoveRecent}
            />
          </div>
        ) : null}
        {onOpenProject ? (
          <button className="studio-open-project" onClick={onOpenProject}>
            <FolderOpen size={12} /> {t("Open or create project")}
          </button>
        ) : null}
        <div className="studio-side-tabs">
          <button className={sidebarTab === "files" ? "is-active" : ""} onClick={() => setSidebarTab("files")}>
            <Folder size={12} /> {t("Files")}
          </button>
          <button className={sidebarTab === "chat" ? "is-active" : ""} onClick={() => setSidebarTab("chat")}>
            <MessageSquare size={12} /> {t("Chats")}
          </button>
          <button className={sidebarTab === "tools" ? "is-active" : ""} onClick={() => setSidebarTab("tools")}>
            <ListChecks size={12} /> {t("Tools")}
          </button>
          <button className={sidebarTab === "project" ? "is-active" : ""} onClick={() => setSidebarTab("project")}>
            <Info size={12} /> {t("Details")}
          </button>
        </div>

        {sidebarTab === "files" ? (
          <>
            <div className="studio-tree-toolbar">
              <button
                className="studio-tree-new"
                onClick={() => {
                  setNewFileDraft("");
                  setNewFileTemplate("empty");
                  setNewFileOpen(true);
                }}
              >
                <Plus size={10} /> {t("New file")}
              </button>
              <button
                className="studio-tree-icon"
                onClick={() => assetInputRef.current?.click()}
                disabled={assetBusy}
                title={t("Add file (PDF, Word, Excel, JSON, text, image)")}
                aria-label={t("Add file (PDF, Word, Excel, JSON, text, image)")}
              >
                {assetBusy ? <Loader2 size={11} className="spin" /> : <Upload size={11} />}
              </button>
              <input
                ref={assetInputRef}
                type="file"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void uploadAsset(file);
                }}
              />
              <button onClick={() => setExpanded(new Set(collectFolderPaths(tree, 50)))}>
                {t("Expand all")}
              </button>
              <button onClick={() => setExpanded(new Set())}>{t("Collapse all")}</button>
            </div>
            <div className="studio-file-tree">
              <StudioTree
                nodes={tree}
                depth={0}
                expanded={expanded}
                onToggle={(path) =>
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(path)) next.delete(path);
                    else next.add(path);
                    return next;
                  })
                }
                onOpen={(path) => void openFile(path)}
                selected={activeFile}
              />
            </div>
            <div className="studio-side-foot">
              <span>{t("{count} files", { count: analysis.files.length })}</span>
              <span>{analysis.git?.branch ?? t("no Git")}</span>
            </div>
          </>
        ) : sidebarTab === "chat" ? (
          <div className="studio-side-chat">
            <div className="studio-side-chat-head">
              <strong>{t("Conversations")}</strong>
              <button onClick={createChatTab} disabled={chatBusy} title={t("New chat")}>
                <Plus size={10} />
              </button>
            </div>
            <div className="studio-side-chat-list">
              {chatTabs.map((tab) => (
                <div
                  key={tab.id}
                  className={`studio-side-chat-item ${tab.id === activeChatId ? "is-active" : ""}`}
                >
                  <button onClick={() => switchChatTab(tab.id)} disabled={chatBusy} title={tab.title}>
                    <MessageSquare size={9} />
                    <span>
                      {tab.title}
                      <small>{new Date(tab.updatedAt).toLocaleString()}</small>
                    </span>
                  </button>
                  <button
                    onClick={() => closeChatTab(tab.id)}
                    disabled={chatBusy}
                    aria-label={t("Close chat")}
                  >
                    <X size={8} />
                  </button>
                </div>
              ))}
            </div>
            <button className="studio-side-chat-new" onClick={createChatTab} disabled={chatBusy}>
              <Plus size={11} /> {t("New chat")}
            </button>
            <div className="studio-side-chat-preview">
              <span>{t("Active chat")}</span>
              {chatMessages.length === 0 ? (
                <em>{t("No messages yet.")}</em>
              ) : (
                chatMessages.slice(-8).map((message, index) => (
                  <div key={index} className={`is-${message.role}`}>
                    <strong>{message.role === "user" ? t("You") : t("Agent")}</strong>
                    <p>{message.content.replace(/\s+/g, " ").slice(0, 220)}</p>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : sidebarTab === "tools" ? (
          <div className="studio-side-tools">
            <div className="studio-side-chat-head">
              <strong>{t("Project tools")}</strong>
              <button
                onClick={() => {
                  setProjectToolsBusy(true);
                  void api
                    .projectTools(analysis.id)
                    .then(setProjectTools)
                    .catch(() => undefined)
                    .finally(() => setProjectToolsBusy(false));
                }}
                disabled={projectToolsBusy}
                title={t("Refresh")}
              >
                {projectToolsBusy ? <Loader2 size={10} className="spin" /> : <RefreshCw size={10} />}
              </button>
            </div>
            {projectTools && projectTools.tools.length > 0 ? (
              <div className="studio-side-tool-list">
                {projectTools.tools.map((tool) => (
                  <div key={tool.name} className="studio-side-tool">
                    <strong>{tool.name}</strong>
                    <p>{tool.description}</p>
                    <code>{tool.command}</code>
                    <small>
                      {tool.tags.join(" · ")}
                      {tool.lastRunAt ? ` · ${new Date(tool.lastRunAt).toLocaleString()}` : ""}
                    </small>
                  </div>
                ))}
              </div>
            ) : (
              <p className="studio-side-tool-empty">
                {t(
                  "No tools yet. Ask the agent to create one; it will be saved under .cie/agent/tools and can be run with run_project_tool.",
                )}
              </p>
            )}
          </div>
        ) : (
          <div className="studio-project-panel">
            <div className="studio-project-block">
              <span>{t("Project root")}</span>
              <strong>{analysis.projectName}</strong>
              <small>{analysis.rootPath}</small>
            </div>
            <div className="studio-project-stats">
              <span><strong>{analysis.stats.files}</strong> {t("files")}</span>
              <span><strong>{analysis.stats.symbols}</strong> {t("symbols")}</span>
              <span><strong>{analysis.stats.functions}</strong> {t("functions")}</span>
              <span><strong>{analysis.stats.routes}</strong> {t("routes")}</span>
            </div>
            <div className="studio-inventory-grid">
              <span><strong>{inventory.html}</strong> HTML</span>
              <span><strong>{inventory.js}</strong> JS/TS</span>
              <span><strong>{inventory.css}</strong> CSS</span>
              <span><strong>{inventory.php}</strong> PHP</span>
              <span><strong>{inventory.python}</strong> Python</span>
              <span><strong>{inventory.other}</strong> {t("other")}</span>
            </div>
            {analysis.frameworks && analysis.frameworks.length > 0 ? (
              <div className="studio-project-block">
                <span>{t("Frameworks")}</span>
                <div className="ai-chips">
                  {analysis.frameworks.map((framework) => (
                    <code key={framework} className="framework-chip">{framework}</code>
                  ))}
                </div>
              </div>
            ) : null}
            {analysis.tooling ? (
              <>
                <div className="studio-project-block">
                  <span>{t("Ecosystems")}</span>
                  <strong>{analysis.tooling.ecosystems.join(", ") || t("none detected")}</strong>
                  <small>{analysis.tooling.packageManagers.join(", ") || "—"}</small>
                </div>
                <div className="studio-project-block">
                  <span>{t("Tooling")}</span>
                  <strong>{analysis.tooling.testFramework ?? t("No test framework detected")}</strong>
                  <small>{analysis.tooling.testCommands.join(" · ") || t("No test command detected")}</small>
                </div>
                {(analysis.tooling.typecheckCommands ?? []).length > 0 ? (
                  <div className="studio-project-block">
                    <span>{t("Typecheck commands")}</span>
                    <small>{(analysis.tooling.typecheckCommands ?? []).join(" · ")}</small>
                  </div>
                ) : null}
                {analysis.tooling.buildCommands.length > 0 ? (
                  <div className="studio-project-block">
                    <span>{t("Build commands")}</span>
                    <small>{analysis.tooling.buildCommands.join(" · ")}</small>
                  </div>
                ) : null}
                {analysis.tooling.lintCommands.length + analysis.tooling.formatCommands.length > 0 ? (
                  <div className="studio-project-block">
                    <span>{t("Lint & format")}</span>
                    <small>
                      {[...analysis.tooling.lintCommands, ...analysis.tooling.formatCommands].join(" · ")}
                    </small>
                  </div>
                ) : null}
                {analysis.tooling.manifests.length > 0 ? (
                  <div className="studio-project-block">
                    <span>{t("Manifests")}</span>
                    <small>{analysis.tooling.manifests.join(", ")}</small>
                  </div>
                ) : null}
              </>
            ) : null}
            <div className="studio-project-block">
              <span>{t("Search index")}</span>
              <strong>
                {indexStatus?.building
                  ? t("Building…")
                  : indexStatus?.ready
                    ? t("{count} documents", { count: indexStatus.documents })
                    : t("Not indexed")}
              </strong>
              <small>
                {indexStatus?.updatedAt
                  ? `${new Date(indexStatus.updatedAt).toLocaleString()}${
                      indexStatus.stale ? ` · ${t("stale")}` : indexStatus.partial ? ` · ${t("partial")}` : ""
                    }`
                  : t("Build the index for faster local search.")}
              </small>
            </div>
            <div className="studio-project-block">
              <span>{t("Git")}</span>
              <strong>{analysis.git?.branch ?? t("no Git")}</strong>
              <small>{analysis.git?.headSubject ?? ""}</small>
            </div>
            <div className="studio-project-block">
              <span>{t("Tests")}</span>
              <strong>{testDiscovery?.framework ?? t("No test framework detected")}</strong>
              <small>{t("{count} test files", { count: testDiscovery?.testFileCount ?? 0 })}</small>
            </div>
            <button
              className="studio-rescan"
              disabled={!active || summaryBusy}
              onClick={() => void summarizeFullProject()}
            >
              <Sparkles size={12} /> {t("Full project summary")}
            </button>
            <button
              className="studio-rescan"
              disabled={!active}
              onClick={() =>
                void askProject(t("Explain this project using the analyzed graph and key files."))
              }
            >
              <BrainCircuit size={12} /> {t("Explain this project")}
            </button>
            <button className="studio-rescan" onClick={onRescan}>
              <RefreshCw size={12} /> {t("Rescan project analysis")}
            </button>
            <div className="studio-warning">
              <AlertTriangle size={13} />
              <span>
                {t(
                  "Code Studio writes to disk. Every save creates a local backup under ~/.codebase-intelligence-explorer/editor-backups.",
                )}
              </span>
            </div>
          </div>
        )}
      </aside>

            <section className="studio-workflow">
        <div className="studio-workflow-head">
          <div className="studio-workflow-title">
            <span>{t("Agent workspace")}</span>
            <strong>{analysis.projectName}</strong>
          </div>
          <div className="studio-workflow-actions">
            {leftWidth <= 155 ? (
              <button
                className="studio-sidebar-open"
                onClick={() => setLeftWidth(252)}
                title={t("Open project tree")}
              >
                <PanelLeftOpen size={11} /> {t("Files")}
              </button>
            ) : null}
            <button onClick={() => setIndexSearchOpen(true)} title={t("Search the project index")}>
              <Search size={12} /> {t("Search project")}
            </button>
            {active ? (
              <div className="studio-model-wrap">
                <button
                  className="studio-model-trigger compact"
                  onClick={() => {
                    if (modelPickerOpen) setPendingContinue(null);
                    openModelPicker();
                  }}
                  title={`${providerDisplayName(active.provider)} · ${active.model}`}
                >
                  <span className="studio-model-trigger-model">{active.model || t("Select a model")}</span>
                  <span className="studio-model-trigger-provider">
                    {aiSettings?.autoSwitchModels === false
                      ? t("Manual")
                      : modelChain.length > 0
                        ? `${t("Custom")} · ${modelChain.length}`
                        : t("Auto")}
                  </span>
                  <ChevronDown size={11} />
                </button>
                {modelPickerOpen ? (
                  <>
                    <div
                      className="studio-model-backdrop"
                      onClick={() => {
                        setModelPickerOpen(false);
                        setPendingContinue(null);
                      }}
                    />
                    <div className="studio-model-popover" onClick={(event) => event.stopPropagation()}>
                      <div className="studio-model-popover-head">
                        <div className="studio-model-popover-title">
                          <span>{t("Code model")}</span>
                          <strong>{t("Choose a provider and model")}</strong>
                        </div>
                        <button
                          onClick={() => {
                            setModelPickerOpen(false);
                            openSettings("models", true);
                          }}
                        >
                          {t("Add provider")}
                        </button>
                      </div>
                      <div className="studio-model-provider-tabs">
                        {configuredProviders.map((provider) => (
                          <button
                            key={provider.id}
                            className={provider.id === pickerProvider ? "is-active" : ""}
                            onClick={() => {
                              setModelCatalogProvider(provider.id);
                              setModelDraft(provider.model);
                              setModelCatalog([]);
                              void loadModels(provider.id);
                            }}
                          >
                            <span>{provider.name}</span>
                          </button>
                        ))}
                      </div>
                      <div className={`studio-model-picked-row ${modelChain.length === 0 ? "is-auto" : ""}`}>
                        <span className="studio-model-picked-label">{t("Selected")}</span>
                        {modelChain.length === 0 ? (
                          <span className="studio-model-picked-auto">
                            {t("Auto selection")}
                          </span>
                        ) : (
                          modelChain.map((item, index) => (
                            <span
                              key={`${item.provider}::${item.model}`}
                              className="studio-model-picked-chip"
                              title={`${item.provider}/${item.model}`}
                            >
                              <b>{index + 1}</b>
                              <span>
                                {item.provider}/{item.model}
                              </span>
                              <button
                                onClick={() => void removeModelFromChain(index)}
                                disabled={chainBusy}
                                aria-label={t("Remove")}
                              >
                                <X size={9} />
                              </button>
                            </span>
                          ))
                        )}
                        {modelChain.length > 0 ? (
                          <button
                            className="studio-model-picked-clear"
                            onClick={() => void saveModelChain([])}
                            disabled={chainBusy}
                          >
                            {t("Auto")}
                          </button>
                        ) : null}
                      </div>
                      <div className="studio-model-list-head">
                        <span className="studio-model-section-label">
                          {t("Available models")}
                          {modelCatalog.length > 0 ? ` · ${modelCatalog.length}` : ""}
                        </span>
                        <div>
                          <button
                            className="ghost-button"
                            onClick={() => {
                              const provider = modelCatalogProvider ?? active?.provider;
                              if (provider) void loadModels(provider, true);
                            }}
                            disabled={modelCatalogBusy}
                            title={t("Refresh model list")}
                          >
                            {modelCatalogBusy ? <Loader2 size={11} className="spin" /> : <RefreshCw size={11} />}
                          </button>
                        </div>
                      </div>
                      {modelCatalog.length > 0 ? (
                        <div className="studio-model-rows">
                          {modelCatalog.slice(0, 120).map((model) => {
                            const provider = pickerProvider;
                            const selected = isModelSelected(provider, model);
                            const isActive =
                              active?.provider === provider && active?.model === model;
                            return (
                              <div
                                key={model}
                                className={`studio-model-row ${selected ? "is-selected" : ""} ${isActive ? "is-active" : ""}`}
                              >
                                <button
                                  className="studio-model-row-toggle"
                                  onClick={() => {
                                    if (provider) void toggleModelInChain(provider, model);
                                  }}
                                  title={selected ? t("Remove from selected models") : t("Add to selected models")}
                                >
                                  <span className="studio-model-row-check">
                                    {selected ? <Check size={10} /> : <Plus size={10} />}
                                  </span>
                                  <span className="studio-model-row-name">{model}</span>
                                </button>
                                <button
                                  className="studio-model-row-use"
                                  onClick={() => provider && selectCodeModel(provider, model)}
                                  disabled={isActive}
                                >
                                  {isActive ? <Check size={10} /> : null}
                                  {isActive ? t("Active") : t("Use")}
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      ) : pickerProvider === "local" ? (
                        <div className="studio-model-empty">
                          {t("Start Ollama and pull a model; downloaded local models appear here automatically.")}
                        </div>
                      ) : (
                        <div className="studio-model-empty">
                          {t("Fetch the provider model list or type a model id.")}
                        </div>
                      )}
                      <details className="studio-model-advanced">
                        <summary>{t("Advanced: enter a model id")}</summary>
                        <div className="studio-model-input-row">
                          <input
                            value={modelDraft}
                            onChange={(event) => setModelDraft(event.target.value)}
                            placeholder={t("Model id")}
                            spellCheck={false}
                          />
                          <button
                            onClick={() => {
                              const provider = modelCatalogProvider ?? active?.provider;
                              if (provider && modelDraft.trim()) void toggleModelInChain(provider, modelDraft.trim());
                            }}
                            disabled={!modelDraft.trim()}
                          >
                            {t("Add to selected")}
                          </button>
                        </div>
                      </details>
                    </div>
                  </>
                ) : null}
              </div>
            ) : (
              <button className="action-button" onClick={() => openSettings("models")}>
                <Sparkles size={12} /> {t("Configure AI")}
              </button>
            )}
          </div>
        </div>

        {error ? (
          <div className="studio-banner error">
            <AlertTriangle size={12} /> {error}
          </div>
        ) : null}
        {message ? (
          <div className="studio-banner success">
            <CheckCircle2 size={12} /> {message}
          </div>
        ) : null}

        {indexStatus?.building ? (
          <div className="studio-index-banner is-building">
            <Loader2 size={12} className="spin" />
            <span>
              {t("Indexing project…")} {indexStatus.processed}/{indexStatus.total}
            </span>
          </div>
        ) : indexStatus && (!indexStatus.ready || indexStatus.stale || indexStatus.error) ? (
          <div className="studio-index-banner">
            <Database size={12} />
            <span>
              {indexStatus.error
                ? t("Index build failed: {message}", { message: indexStatus.error })
                : indexStatus.ready
                  ? t("The project index is stale. Rebuild it so search sees the latest files.")
                  : t("The project index is not ready. Build it for faster search and better answers.")}
            </span>
            <button onClick={() => void buildIndex()}>{t("Build index")}</button>
          </div>
        ) : null}

        {environmentAlert ? (
          <div className="studio-index-banner environment-banner">
            <Wrench size={12} />
            <span>
              {t("Missing recommended tools: {count}", {
                count: environmentAlert.names.length,
              })}{" "}
              {environmentAlert.names.slice(0, 3).join(", ")}
              {environmentAlert.names.length > 3 ? "…" : ""}
            </span>
            <button
              onClick={() => {
                setEnvironmentAlert(null);
                openSettings("general");
              }}
            >
              {t("Check environment")}
            </button>
          </div>
        ) : null}

        <div className="studio-workflow-log" ref={workflowScrollRef}>
          {chatMessages.length === 0 && !chatBusy ? (
            <div className="studio-workflow-empty">
              <div className="studio-workflow-empty-icon">
                <Bot size={20} />
              </div>
              <strong>{t("One input. The agent handles the rest.")}</strong>
              <span>
                {t(
                  "Ask a question, request an edit, run a command, or build a feature. The agent inspects the project, uses tools, and shows every step.",
                )}
              </span>
              <div className="studio-workflow-quick">
                <button
                  onClick={() => void askProject(t("Explain this project using the analyzed graph and key files."))}
                >
                  <Sparkles size={11} /> {t("Explain this project")}
                </button>
                <button onClick={() => void summarizeFullProject()} disabled={!active || summaryBusy}>
                  {summaryBusy ? <Loader2 size={11} className="spin" /> : <FileCode2 size={11} />}
                  {t("Full project summary")}
                </button>
                <button
                  onClick={() => void askProject(t("Find the main entry points and explain the request flow."))}
                >
                  {t("Main entry points")}
                </button>
              </div>
            </div>
          ) : (
            chatMessages.map((workflowMessage, index) => {
              const hasError =
                workflowMessage.role === "assistant" &&
                (workflowMessage.logs?.some((entry) => entry.level === "error") ?? false);
              const previousUser = [...chatMessages.slice(0, index)]
                .reverse()
                .find((message) => message.role === "user");
              const modelUnavailable =
                workflowMessage.role === "assistant" &&
                /(?:error 410|end of life|no longer available|model .* unavailable)/i.test(
                  workflowMessage.content,
                );
              const failedTasks =
                workflowMessage.taskQueue?.tasks.filter(
                  (task) => task.status === "failed" || task.status === "blocked",
                ) ?? [];
              const canContinue =
                workflowMessage.role === "assistant" &&
                Boolean(workflowMessage.taskQueue) &&
                (failedTasks.length > 0 || workflowMessage.taskQueue?.status === "stopped");
              return (
              <div key={index} className={`studio-workflow-message ${workflowMessage.role}`}>
                <div className="studio-workflow-role">
                  {workflowMessage.role === "user" ? <User size={11} /> : <Bot size={11} />}
                  <span>
                    {workflowMessage.role === "user"
                      ? t("You")
                      : workflowMessage.model ?? t("Agent")}
                  </span>
                  {workflowMessage.intent ? (
                    <div className="studio-intent-wrap">
                      <button
                        className={`studio-intent-trigger ${intentOpenIndex === index ? "is-open" : ""}`}
                        onClick={() =>
                          setIntentOpenIndex(intentOpenIndex === index ? null : index)
                        }
                        title={t("Understood request")}
                        aria-label={t("Understood request")}
                      >
                        <Sparkles size={10} />
                      </button>
                      {intentOpenIndex === index ? (
                        <div className="studio-intent-popover is-inline">
                          <div className="studio-intent-popover-head">
                            <strong>{t("Understood request")}</strong>
                            <button onClick={() => setIntentOpenIndex(null)} aria-label={t("Close")}>
                              <X size={11} />
                            </button>
                          </div>
                          <p>{workflowMessage.intent.understanding}</p>
                          <small>
                            {t("Scope")}: {t(workflowMessage.intent.scope)} · {t("Mode")}:{" "}
                            {t(workflowMessage.intent.mode === "single" ? "Single task" : "Task loop")}
                            {workflowMessage.intent.areas.length > 0
                              ? ` · ${workflowMessage.intent.areas.slice(0, 4).join(", ")}`
                              : ""}
                          </small>
                          <small>
                            {t("Context")}: {workflowMessage.intent.context} · {t("Tools")}:{" "}
                            {["core", ...workflowMessage.intent.toolGroups].join(" + ")}
                          </small>
                          {workflowMessage.intent.approach ? (
                            <small>
                              {t("Approach")}: {workflowMessage.intent.approach}
                            </small>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {workflowMessage.mode ? (
                    <span className={`studio-mode-badge is-${workflowMessage.mode}`}>
                      {workflowMessage.mode === "ask"
                        ? t("Ask")
                        : workflowMessage.mode === "plan"
                          ? t("Plan")
                          : workflowMessage.mode === "research"
                            ? t("Research")
                            : t("Build")}
                    </span>
                  ) : null}
                  {workflowMessage.tokenUsage ? (
                    <span className="studio-token-badge">
                      {formatTokens(workflowMessage.tokenUsage.totalTokens)} {t("tokens")}
                      {workflowMessage.costUsd ? ` · ${formatUsd(workflowMessage.costUsd)}` : ""}
                    </span>
                  ) : null}
                  {workflowMessage.steps && workflowMessage.steps.length > 0 ? (
                    <small>
                      {workflowMessage.steps.length} {t("steps")}
                    </small>
                  ) : null}
                  {hasError && previousUser && !modelUnavailable ? (
                    <button
                      className="studio-chat-retry"
                      onClick={() => void askProject(previousUser.content, false, { skipClarify: true })}
                      disabled={chatBusy}
                    >
                      <RefreshCw size={9} /> {t("Retry")}
                    </button>
                  ) : null}
                  {hasError ? (
                    <button
                      className="studio-chat-retry"
                      onClick={() => setModelPickerOpen(true)}
                    >
                      {t("Switch model")}
                    </button>
                  ) : null}
                </div>
                {workflowMessage.role === "assistant" && workflowMessage.plan ? (
                  <AgentPlanCard
                    plan={workflowMessage.plan}
                    allowWrite={effectiveAllowWrite}
                    allowCommands={effectiveAllowCommands}
                  />
                ) : null}
                {workflowMessage.role === "assistant" && workflowMessage.planPath ? (
                  <div className="studio-plan-result">
                    <div className="studio-plan-result-head">
                      <ListChecks size={14} />
                      <div>
                        <strong>{t("Plan saved")}</strong>
                        <code>{workflowMessage.planPath}</code>
                      </div>
                    </div>
                    <div className="studio-plan-result-actions">
                      <button
                        onClick={() => void openFile(workflowMessage.planPath ?? "")}
                        title={t("Open plan")}
                      >
                        <FileCode2 size={12} /> {t("Open plan")}
                      </button>
                      <button
                        className="primary-button"
                        disabled={chatBusy}
                        onClick={() => {
                          setStudioMode("build");
                          void askProject(
                            `Execute this plan:\n\n${workflowMessage.content}`,
                            true,
                            { workspaceMode: "build", skipClarify: true },
                          );
                        }}
                      >
                        <Play size={12} /> {t("Run in Build")}
                      </button>
                    </div>
                  </div>
                ) : null}
                <div className="studio-workflow-text">
                  {workflowMessage.role === "assistant" ? (
                    <CollapsibleAnswer value={workflowMessage.content} />
                  ) : (
                    workflowMessage.content
                  )}
                </div>
                {workflowMessage.role === "assistant" &&
                ((workflowMessage.steps && workflowMessage.steps.length > 0) ||
                  (workflowMessage.evidence && workflowMessage.evidence.length > 0)) ? (
                  <details className="studio-workflow-details" open={hasError ? true : undefined}>
                    <summary>
                      <span>{t("Details")}</span>
                      {workflowMessage.steps && workflowMessage.steps.length > 0 ? (
                        <small>
                          {workflowMessage.steps.length} {t("steps")}
                        </small>
                      ) : null}
                      {workflowMessage.tokenUsage ? (
                        <span className="studio-token-badge">
                          {formatTokens(workflowMessage.tokenUsage.totalTokens)} {t("tokens")}
                          {workflowMessage.costUsd ? ` · ${formatUsd(workflowMessage.costUsd)}` : ""}
                        </span>
                      ) : null}
                    </summary>
                    {workflowMessage.tokenUsage ? (
                      <div className="studio-token-report">
                        <span>
                          {t("Input")} <b>{formatTokens(workflowMessage.tokenUsage.inputTokens)}</b>
                        </span>
                        <span>
                          {t("Output")} <b>{formatTokens(workflowMessage.tokenUsage.outputTokens)}</b>
                        </span>
                        <span>
                          {t("Total")} <b>{formatTokens(workflowMessage.tokenUsage.totalTokens)}</b>
                        </span>
                        {workflowMessage.steps && workflowMessage.steps.length > 1 ? (
                          <span>
                            <b>
                              {formatTokens(
                                Math.round(
                                  workflowMessage.tokenUsage.totalTokens /
                                    workflowMessage.steps.length,
                                ),
                              )}
                            </b>{" "}
                            / {t("step")}
                          </span>
                        ) : null}
                        {workflowMessage.tokenUsage.totalTokens > 120_000 ? (
                          <small>
                            {t(
                              "High usage: most of this is re-sent context. Use a reasoner for planning and a cheaper model for small edits.",
                            )}
                          </small>
                        ) : null}
                      </div>
                    ) : null}
                    {workflowMessage.logs && workflowMessage.logs.length > 0 ? (
                      <details className="studio-workflow-trace">
                        <summary>
                          {t("Trace log")} · {workflowMessage.logs.length}
                        </summary>
                        <div className="studio-trace-log">
                          {workflowMessage.logs.map((entry) => (
                            <div key={entry.id} className={`is-${entry.level}`}>
                              <span>
                                {entry.step ? `#${entry.step} · ` : ""}
                                {new Date(entry.at).toLocaleTimeString()}
                              </span>
                              <strong>{t(entry.label)}</strong>
                              {entry.detail ? <small>{entry.detail}</small> : null}
                            </div>
                          ))}
                        </div>
                      </details>
                    ) : null}
                    {workflowMessage.steps && workflowMessage.steps.length > 0 ? (
                      <div className="studio-workflow-steps">
                        {workflowMessage.steps.map((step) => (
                          <details key={step.index} className={step.ok ? "is-ok" : "is-fail"}>
                            <summary>
                              <span className="studio-agent-step-index">{step.index}</span>
                              <span className="studio-agent-step-action">{step.action}</span>
                              <small>{agentStepTarget(step)}</small>
                              <span className="studio-agent-step-meta">
                                {step.durationMs} ms
                                {step.tokenUsage ? ` · ${formatTokens(step.tokenUsage.totalTokens)} tok` : ""}
                              </span>
                              {step.ok ? <CheckCircle2 size={10} /> : <AlertTriangle size={10} />}
                            </summary>
                            <pre>{step.observation}</pre>
                          </details>
                        ))}
                      </div>
                    ) : null}
                    {workflowMessage.evidence && workflowMessage.evidence.length > 0 ? (
                      <div className="studio-workflow-evidence">
                        {workflowMessage.evidence.slice(0, 8).map((item, evidenceIndex) => (
                          <button
                            key={`${item.path}-${item.startLine ?? 0}-${evidenceIndex}`}
                            onClick={() => void openFile(item.path)}
                            title={item.path}
                          >
                            <FileCode2 size={9} />
                            {item.path}
                            {item.startLine ? `:${item.startLine}` : ""}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </details>
                ) : null}
                {canContinue && workflowMessage.taskQueue ? (
                  <div className="studio-continue">
                    <div className="studio-continue-info">
                      <strong>{t("Task stopped")}</strong>
                      <span>
                        {workflowMessage.taskQueue.tasks.filter((task) => task.status === "done").length}/
                        {workflowMessage.taskQueue.tasks.length} {t("done")}
                        {failedTasks.length > 0
                          ? ` · ${failedTasks.length} ${t("blocked or failed")}`
                          : ""}
                      </span>
                      {failedTasks.length > 0 ? (
                        <small>
                          {failedTasks
                            .slice(0, 2)
                            .map((task) => `${task.id} · ${task.title}`)
                            .join(" · ")}
                        </small>
                      ) : null}
                    </div>
                    <div className="studio-continue-actions">
                      <button
                        className="ghost-button"
                        disabled={chatBusy || !active}
                        onClick={() => {
                          void askProject(workflowMessage.taskQueue!.goal, false, {
                            retryFailed: true,
                            skipClarify: true,
                            workspaceMode: "build",
                          });
                        }}
                      >
                        <Play size={11} /> {t("Continue")}
                        {active ? ` · ${active.model}` : ""}
                      </button>
                      <button
                        className="primary-button"
                        disabled={chatBusy || !active}
                        onClick={() => {
                          setPendingContinue({ goal: workflowMessage.taskQueue!.goal });
                          setModelPickerOpen(true);
                          setModelCatalog([]);
                          if (active) {
                            setModelCatalogProvider(active.provider);
                            void loadModels(active.provider);
                          }
                        }}
                      >
                        <RefreshCw size={11} /> {t("Choose model & continue")}
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
              );
            })
          )}

          {chatBusy ? (
            <div className="studio-workflow-live">
              {chatLiveAnswer ? (
                <div className="studio-live-answer">
                  <MarkdownText value={chatLiveAnswer} />
                </div>
              ) : null}
              {taskQueue && taskQueue.tasks.length > 0 ? (
                <TaskQueueCard
                  queue={taskQueue}
                  defaultOpen
                  onOpenFile={(path) => void openFile(path)}
                  onRetryFailed={() => {
                    if (chatBusy || !taskQueue) return;
                    void askProject(taskQueue.goal, false, { retryFailed: true, skipClarify: true });
                  }}
                  onUpdateTask={updateQueueTask}
                  onDeleteTask={deleteQueueTask}
                  onMoveTask={moveQueueTask}
                />
              ) : null}
              {chatLivePlan ? (
                <AgentPlanCard
                  plan={chatLivePlan}
                  allowWrite={effectiveAllowWrite}
                  allowCommands={effectiveAllowCommands}
                  defaultOpen
                />
              ) : null}
              {chatLiveLogs.length > 0 || chatLiveSteps.length > 0 ? (
                <details className="studio-live-debug">
                  <summary>
                    {t("Debug stream")} · {chatLiveSteps.length} {t("steps")}
                  </summary>
                  <pre>
                    {[
                      ...chatLiveLogs.slice(-60).map((entry) => {
                        const detail = entry.detail ? ` — ${entry.detail}` : "";
                        return `${new Date(entry.at).toLocaleTimeString()} · ${entry.level} · ${entry.label}${detail}`;
                      }),
                      ...chatLiveSteps.map((step) => {
                        const target = agentStepTarget(step);
                        return `#${step.index} ${step.ok ? "ok" : "fail"} · ${step.action}${target ? ` · ${target}` : ""}`;
                      }),
                    ].join("\n")}
                  </pre>
                </details>
              ) : null}
            </div>
          ) : null}

          {chatError ? (
            <div className="studio-ai-inline-error">
              <AlertTriangle size={12} />
              <span>{chatError}</span>
              {chatRetryQuestion ? (
                <button
                  className="studio-chat-retry"
                  onClick={() => void askProject(chatRetryQuestion, false, { skipClarify: true })}
                  disabled={chatBusy}
                >
                  <RefreshCw size={10} /> {t("Retry last message")}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        {modelNotice ? (
          <div className="studio-model-toast" role="status" aria-live="polite">
            <span className="studio-model-toast-icon">
              <RefreshCw size={14} />
            </span>
            <div className="studio-model-toast-body">
              <strong>{t("Model switched automatically")}</strong>
              <span>
                <code>{modelNotice.from.provider}/{modelNotice.from.model}</code>
                <b>→</b>
                <code>{modelNotice.to.provider}/{modelNotice.to.model}</code>
              </span>
              <small>{modelNotice.reason}</small>
            </div>
            <button onClick={() => setModelNotice(null)} aria-label={t("Dismiss")}>
              <X size={12} />
            </button>
          </div>
        ) : null}

        {!chatBusy &&
        taskQueue &&
        (taskQueue.status === "stopped" ||
          taskQueue.tasks.some(
            (task) => task.status === "failed" || task.status === "blocked",
          )) ? (
          <div className="studio-continue is-global">
            <div className="studio-continue-info">
              <strong>{t("Task stopped")}</strong>
              <span>
                {taskQueue.tasks.filter((task) => task.status === "done").length}/
                {taskQueue.tasks.length} {t("done")} ·{" "}
                {taskQueue.tasks.filter((task) => task.status === "failed" || task.status === "blocked").length}{" "}
                {t("blocked or failed")}
              </span>
              <small>{taskQueue.goal}</small>
            </div>
            <div className="studio-continue-actions">
              <button
                className="ghost-button"
                disabled={!active}
                onClick={() => {
                  void askProject(taskQueue.goal, false, {
                    retryFailed: true,
                    skipClarify: true,
                    workspaceMode: "build",
                  });
                }}
              >
                <Play size={11} /> {t("Continue")}
                {active ? ` · ${active.model}` : ""}
              </button>
              <button
                className="primary-button"
                disabled={!active}
                onClick={() => {
                  setPendingContinue({ goal: taskQueue.goal });
                  setModelPickerOpen(true);
                  setModelCatalog([]);
                  if (active) {
                    setModelCatalogProvider(active.provider);
                    void loadModels(active.provider);
                  }
                }}
              >
                <RefreshCw size={11} /> {t("Choose model & continue")}
              </button>
            </div>
          </div>
        ) : null}

        {chatBusy ? (
          <div className="studio-run-status" role="status" aria-live="polite">
            <div className="studio-run-status-orb">
              <span />
              <span />
              <span />
              <Bot size={13} />
            </div>
            <div className="studio-run-status-body">
              <strong>{liveActivity?.label ?? t("Thinking…")}</strong>
              <small>
                {active ? `${active.provider}/${active.model}` : ""}
                {chatLiveSteps.length > 0 ? ` · ${chatLiveSteps.length} ${t("steps")}` : ""}
                {liveTokens > 0 ? ` · ${formatTokens(liveTokens)} tok` : ""}
                {liveActivity?.target ? ` · ${liveActivity.target}` : ""}
              </small>
            </div>
            <div className="studio-run-status-bars" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
              <i />
            </div>
            <button
              className="primary-button is-stop"
              onClick={() => {
                agentStopRequestedRef.current = true;
                agentAbortRef.current?.abort();
              }}
              title={t("Stop agent")}
            >
              <Square size={12} /> {t("Stop")}
            </button>
          </div>
        ) : null}

        <div className={`studio-composer is-${studioMode}`}>
          {taskQueue && taskQueue.tasks.length > 0 && taskPanelOpen ? (
            <div className="studio-composer-task-panel">
              <div className="studio-composer-task-head">
                <strong>{t("Task queue")}</strong>
                <button onClick={() => setTaskPanelOpen(false)} aria-label={t("Close")}>
                  <X size={12} />
                </button>
              </div>
              <TaskQueueCard
                queue={taskQueue}
                defaultOpen
                onOpenFile={(path) => void openFile(path)}
                onRetryFailed={() => {
                  if (!taskQueue) return;
                  setTaskPanelOpen(false);
                  void askProject(taskQueue.goal, false, {
                    retryFailed: true,
                    skipClarify: true,
                    workspaceMode: "build",
                  });
                }}
                onUpdateTask={updateQueueTask}
                onDeleteTask={deleteQueueTask}
                onMoveTask={moveQueueTask}
              />
            </div>
          ) : null}

          {clarification ? (
            <div className="studio-clarify">
              <div className="studio-clarify-head">
                <MessageSquare size={11} />
                <strong>{t(clarification.request.question)}</strong>
              </div>
              <div className="studio-clarify-options">
                {clarification.request.options.map((option) => (
                  <button
                    key={option.id}
                    onClick={() => {
                      const original = clarification.original;
                      setClarification(null);
                      setChatInput("");
                      void askProject(`${original}\n\n${option.instructionSuffix}`, true, {
                        skipClarify: true,
                      });
                    }}
                  >
                    {t(option.label)}
                  </button>
                ))}
              </div>
              <div className="studio-clarify-foot">
                <button
                  onClick={() => {
                    const original = clarification.original;
                    setClarification(null);
                    void askProject(original, true, { skipClarify: true });
                  }}
                >
                  {t("Send as written")}
                </button>
                <button onClick={() => setClarification(null)}>{t("Cancel")}</button>
              </div>
            </div>
          ) : null}

          {attachment ? (
            <div className="studio-attachment-chip">
              <Paperclip size={13} />
              <span>{attachment.name}</span>
              <code>{attachment.path}</code>
              <button onClick={() => setAttachment(null)} aria-label={t("Remove attachment")}>
                <X size={11} />
              </button>
            </div>
          ) : null}

          <div className="studio-composer-input-wrap">
            <textarea
              value={chatInput}
              onChange={(event) => {
                setChatInput(event.target.value);
                if (clarification && event.target.value !== clarification.original) {
                  setClarification(null);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void askProject();
                }
              }}
              placeholder={modePlaceholder}
              rows={3}
            />
            <button
              className="studio-attach-inline"
              onClick={() => taskFileInputRef.current?.click()}
              disabled={assetBusy || chatBusy}
              title={t("Attach a file (PDF, Word, Excel, JSON, text, image)")}
              aria-label={t("Attach a file (PDF, Word, Excel, JSON, text, image)")}
            >
              {assetBusy ? <Loader2 size={15} className="spin" /> : <Paperclip size={15} />}
              <span>{t("File")}</span>
            </button>
            <input
              ref={taskFileInputRef}
              type="file"
              hidden
              accept=".pdf,.doc,.docx,.rtf,.xls,.xlsx,.csv,.json,.txt,.md,.html,.htm,image/*"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void attachTaskFile(file);
              }}
            />
            {chatBusy ? (
              <button
                className="studio-send-button is-stop studio-send-inline"
                onClick={() => {
                  agentStopRequestedRef.current = true;
                  void api.ai.stop(analysis.id).catch(() => undefined);
                  agentAbortRef.current?.abort();
                }}
                title={t("Stop agent")}
              >
                <Square size={16} />
              </button>
            ) : (
              <button
                className="studio-send-button studio-send-inline"
                onClick={() => void askProject()}
                disabled={!active || (!chatInput.trim() && !attachment)}
                title={t("Send")}
              >
                <Send size={18} />
              </button>
            )}
          </div>

          <div className="studio-composer-footer">
            <div className="studio-composer-actions">
              <label className="studio-mode-select">
                <span>{t("Mode")}</span>
                <select
                  value={studioMode}
                  onChange={(event) => {
                    const next = event.target.value as AiWorkspaceMode;
                    setStudioMode(next);
                    setTaskPanelOpen(false);
                  }}
                  disabled={chatBusy}
                  aria-label={t("Mode")}
                >
                  <option value="ask">{t("Ask")}</option>
                  <option value="plan">{t("Plan")}</option>
                  <option value="build">{t("Build")}</option>
                  <option value="research">{t("Research")}</option>
                </select>
              </label>

              {studioMode === "plan" ? (
                <button
                  className="studio-footer-link"
                  onClick={() => void openFile(".cie/agent/PLAN.md")}
                  title={t("Project plan")}
                >
                  <ListChecks size={13} />
                  <span>{t("Project plan")}</span>
                </button>
              ) : null}
              {taskQueue && taskQueue.tasks.length > 0 ? (
                <button
                  className={`studio-composer-task-button ${
                    taskQueue.status === "failed" ? "is-failed" : ""
                  }`}
                  onClick={() => setTaskPanelOpen((value) => !value)}
                  title={t("Open task queue")}
                >
                  <ListChecks size={14} />
                  <span>{t("Task queue")}</span>
                  <b>
                    {taskQueue.tasks.filter((task) => task.status === "done").length}/{taskQueue.tasks.length}
                  </b>
                  {taskQueue.status === "failed" ? <AlertTriangle size={12} /> : null}
                </button>
              ) : null}
              <span className="studio-session-tokens">
                {sessionTokens > 0 ? `${t("Session")} ${formatTokens(sessionTokens)} ${t("tokens")}` : ""}
              </span>
              <button
                className={`studio-loop-toggle ${consoleOpen ? "is-on" : ""}`}
                onClick={() => setConsoleOpen((value) => !value)}
                title={t("Console")}
              >
                <Terminal size={12} /> {t("Console")}
              </button>
              {chatMessages.length > 0 ? (
                <button className="studio-composer-clear" onClick={clearActiveChat}>
                  {t("Clear")}
                </button>
              ) : null}
            </div>
          </div>
        </div>

        {consoleOpen ? (
<div className="studio-bottom">
                <div className="studio-bottom-tabs">
                  <button
                    className={bottomTab === "terminal" ? "is-active" : ""}
                    onClick={() => setBottomTab("terminal")}
                  >
                    <Terminal size={12} /> {t("Terminal")}
                  </button>
                  <button
                    className={bottomTab === "tests" ? "is-active" : ""}
                    onClick={() => setBottomTab("tests")}
                  >
                    <TestTube2 size={12} /> {t("Tests")}
                  </button>
                  <button
                    className={bottomTab === "checks" ? "is-active" : ""}
                    onClick={() => setBottomTab("checks")}
                  >
                    <CheckCheck size={12} /> {t("Checks")}
                  </button>
                  <button
                    className={bottomTab === "jobs" ? "is-active" : ""}
                    onClick={() => setBottomTab("jobs")}
                  >
                    <Play size={12} /> {t("Background")}
                    {jobs.some((job) => job.status === "running") ? (
                      <span className="studio-job-count">
                        {jobs.filter((job) => job.status === "running").length}
                      </span>
                    ) : null}
                  </button>
                  <span className="studio-bottom-spacer" />
                  <button
                    onClick={() => setConsoleOpen(false)}
                    title={t("Close console")}
                  >
                    <X size={11} /> {t("Close")}
                  </button>
                  {activeTerminal?.result ? (
                    <span className={`studio-exit ${activeTerminal.result.exitCode === 0 ? "ok" : "bad"}`}>
                      {t("exit")} {activeTerminal.result.exitCode ?? "—"} · {activeTerminal.result.durationMs} ms
                    </span>
                  ) : null}
                </div>
  
                {bottomTab === "terminal" ? (
                  <div className="studio-terminal">
                    <div className="studio-terminal-tabs">
                      {terminals.map((terminal) => (
                        <div
                          key={terminal.id}
                          className={`studio-terminal-tab ${
                            terminal.id === activeTerminalId ? "is-active" : ""
                          }`}
                        >
                          <button onClick={() => setActiveTerminalId(terminal.id)}>
                            <Terminal size={9} />
                            {terminal.title}
                            {terminal.busy ? <i /> : null}
                          </button>
                          <button
                            className="studio-terminal-tab-close"
                            onClick={() => closeTerminal(terminal.id)}
                            aria-label={t("Close terminal")}
                          >
                            <X size={8} />
                          </button>
                        </div>
                      ))}
                      <button className="studio-terminal-new" onClick={newTerminal} title={t("New terminal")}>
                        <Plus size={11} />
                      </button>
                      <button
                        className="studio-terminal-new studio-terminal-new-shell"
                        onClick={() => void newShellTerminal()}
                        title={t("New interactive shell")}
                      >
                        <Terminal size={10} />
                      </button>
                    </div>
                    {activeTerminal?.kind === "shell" ? (
                      <div className="studio-shell-panel">
                        <div className="studio-shell-head">
                          <span>
                            <Terminal size={10} /> {t("Interactive shell")}
                            <code>{analysis.rootPath}</code>
                          </span>
                          <button
                            onClick={() => activeTerminal && stopTerminal(activeTerminal.id)}
                            title={t("Send Ctrl+C")}
                          >
                            <Square size={10} /> {t("Ctrl+C")}
                          </button>
                          <button onClick={() => activeTerminal && closeTerminal(activeTerminal.id)}>
                            {t("Close shell")}
                          </button>
                        </div>
                        {activeTerminal.serverId ? (
                          <ShellTerminalView
                            projectId={analysis.id}
                            sessionId={activeTerminal.serverId}
                            onExit={() =>
                              activeTerminal &&
                              updateTerminal(activeTerminal.id, { shellStatus: "exited" })
                            }
                            onError={(message) => setError(message)}
                          />
                        ) : (
                          <div className="studio-shell-loading">
                            <Loader2 size={13} className="spin" /> {t("Starting shell…")}
                          </div>
                        )}
                      </div>
                    ) : (
                      <>
                    <div className="studio-terminal-cwd" title={analysis.rootPath}>
                      <Terminal size={10} />
                      <span>{t("Working directory")}</span>
                      <code>{analysis.rootPath}</code>
                    </div>
                    <div className="studio-command-row">
                      <span>$</span>
                      <input
                        value={activeTerminal?.command ?? ""}
                        onChange={(event) =>
                          activeTerminal &&
                          updateTerminal(activeTerminal.id, { command: event.target.value })
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            void runCommand();
                          } else if (event.key === "ArrowUp") {
                            event.preventDefault();
                            navigateCommandHistory(1);
                          } else if (event.key === "ArrowDown") {
                            event.preventDefault();
                            navigateCommandHistory(-1);
                          }
                        }}
                        placeholder={t("Type a command and press Enter…")}
                        spellCheck={false}
                      />
                      {activeTerminal?.busy ? (
                        <button
                          className="is-stop"
                          onClick={() => activeTerminal && stopTerminal(activeTerminal.id)}
                          title={t("Stop command")}
                        >
                          <Square size={12} /> {t("Stop")}
                        </button>
                      ) : (
                        <button
                          onClick={() => void runCommand()}
                          disabled={!activeTerminal?.command.trim()}
                        >
                          <Play size={12} /> {t("Run")}
                        </button>
                      )}
                      <button
                        onClick={() => void startBackgroundCommand()}
                        disabled={!activeTerminal?.command.trim()}
                        title={t("Run in background")}
                      >
                        <Play size={11} /> {t("Background")}
                      </button>
                    </div>
                    <div className="studio-command-tools">
                      <button
                        className={commandHistoryOpen ? "is-active" : ""}
                        onClick={() => setCommandHistoryOpen((value) => !value)}
                        title={t("Command history")}
                      >
                        <History size={9} /> {t("History")}
                        {commandHistory.length > 0 ? <small>{commandHistory.length}</small> : null}
                      </button>
                      <button
                        onClick={() =>
                          activeTerminal && toggleCommandFavorite(activeTerminal.command)
                        }
                        disabled={!activeTerminal?.command.trim()}
                        title={t("Toggle favorite command")}
                      >
                        <Star
                          size={9}
                          className={
                            activeTerminal?.command.trim() &&
                            commandFavorites.includes(activeTerminal.command.trim())
                              ? "is-favorite"
                              : ""
                          }
                        />
                        {t("Favorite")}
                      </button>
                      <span>{t("Use ↑ / ↓ for history")}</span>
                    </div>
                    {commandHistoryOpen ? (
                      <div className="studio-command-history">
                        {commandFavorites.length > 0 ? (
                          <>
                            <span className="studio-command-history-label">
                              <Star size={8} /> {t("Favorites")}
                            </span>
                            {commandFavorites.map((item) => (
                              <div key={`favorite-${item}`} className="studio-command-history-row">
                                <button
                                  className="studio-command-history-run"
                                  onClick={() => {
                                    if (!activeTerminal) return;
                                    setCommandHistoryOpen(false);
                                    void runCommand(item, activeTerminal.id);
                                  }}
                                  title={t("Run command")}
                                >
                                  <Play size={8} />
                                  <code>{item}</code>
                                </button>
                                <button
                                  className="studio-command-history-star is-favorite"
                                  onClick={() => toggleCommandFavorite(item)}
                                  title={t("Remove favorite")}
                                >
                                  <Star size={8} />
                                </button>
                              </div>
                            ))}
                          </>
                        ) : null}
                        <span className="studio-command-history-label">
                          <History size={8} /> {t("Recent commands")}
                        </span>
                        {commandHistory.length === 0 ? (
                          <em>{t("No commands yet.")}</em>
                        ) : (
                          commandHistory.slice(0, 12).map((item) => (
                            <div key={`history-${item}`} className="studio-command-history-row">
                              <button
                                className="studio-command-history-run"
                                onClick={() => {
                                  if (!activeTerminal) return;
                                  setCommandHistoryOpen(false);
                                  void runCommand(item, activeTerminal.id);
                                }}
                                title={t("Run command")}
                              >
                                <Play size={8} />
                                <code>{item}</code>
                              </button>
                              <button
                                className={`studio-command-history-star ${
                                  commandFavorites.includes(item) ? "is-favorite" : ""
                                }`}
                                onClick={() => toggleCommandFavorite(item)}
                                title={t("Toggle favorite command")}
                              >
                                <Star size={8} />
                              </button>
                            </div>
                          ))
                        )}
                      </div>
                    ) : null}
                    {devCommands.length > 0 ? (
                      <div className="studio-dev-commands">
                        <span>
                          <Server size={9} /> {t("Dev server")}
                        </span>
                        {devCommands.map((suggestion) => (
                          <button
                            key={suggestion.command}
                            className={suggestion.purpose === "install" ? "is-install" : ""}
                            onClick={() => void startBackgroundCommand(suggestion.command)}
                            title={`${suggestion.command} · ${t("Runs in the background")}`}
                          >
                            {suggestion.purpose === "install" ? <Download size={8} /> : <Play size={8} />}
                            {t(suggestion.label)}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    <div className="studio-quick-commands">
                      {quickCommands.map((quick) => (
                        <button
                          key={quick}
                          onClick={() => void runCommand(quick)}
                          disabled={activeTerminal?.busy}
                        >
                          {quick}
                        </button>
                      ))}
                      <span>{t("Commands run in the project root. Long commands can be stopped.")}</span>
                      {activeTerminal?.output ? (
                        <button
                          onClick={() => {
                            if (!activeTerminal) return;
                            terminalOutputRef.current[activeTerminal.id] = "";
                            updateTerminal(activeTerminal.id, { output: "", result: null });
                          }}
                        >
                          {t("Clear")}
                        </button>
                      ) : null}
                    </div>
                    <pre className="studio-terminal-output">
                      {activeTerminal?.output ||
                        (activeTerminal?.busy
                          ? t("Running…")
                          : activeTerminal?.result
                            ? t("No output.")
                            : t("No command output yet."))}
                    </pre>
                      </>
                    )}
                  </div>
                ) : bottomTab === "tests" ? (
                  <div className="studio-tests-panel">
                    <div className="studio-tests-head">
                      <div>
                        <strong>{testDiscovery?.framework ?? t("No test framework detected")}</strong>
                        <span>
                          {t("{count} test files", { count: testDiscovery?.testFileCount ?? 0 })}
                        </span>
                      </div>
                      <div className="studio-test-head-actions">
                        <button
                          className="studio-test-timeout"
                          onClick={() => openSettings("editor")}
                          title={t("Test timeout")}
                        >
                          <Settings2 size={10} /> {t("{minutes} min", { minutes: testTimeout / 60 })}
                        </button>
                        {testBusy ? (
                          <button className="primary-button is-stop" onClick={stopTests}>
                            <Square size={12} /> {t("Stop")}
                          </button>
                        ) : (
                          <button
                            className="primary-button"
                            onClick={() => void runTests()}
                            disabled={!testCommand.trim()}
                          >
                            <Play size={12} /> {t("Run tests")}
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="studio-test-commands">
                      {(testDiscovery?.commands ?? []).map((commandItem) => (
                        <button
                          key={commandItem}
                          className={testCommand === commandItem ? "is-active" : ""}
                          onClick={() => setTestCommand(commandItem)}
                        >
                          {commandItem}
                        </button>
                      ))}
                      {testDiscovery && testDiscovery.commands.length === 0 ? (
                        <span>{t("No test command detected.")}</span>
                      ) : null}
                    </div>
  
                    {(testDiscovery?.testFiles.length ?? 0) > 0 ? (
                      <details className="studio-test-files">
                        <summary>{t("Browse test files")}</summary>
                        <div>
                          {testDiscovery?.testFiles.map((file) => (
                            <button key={file} onClick={() => void openFile(file)} title={file}>
                              {file}
                            </button>
                          ))}
                        </div>
                      </details>
                    ) : null}

                    {testResult ? (
                      <div className="studio-test-result">
                        <div className="studio-test-summary">
                          <span className="is-pass">{testResult.summary.passed} {t("passed")}</span>
                          <span className="is-fail">{testResult.summary.failed} {t("failed")}</span>
                          <span className="is-skip">{testResult.summary.skipped} {t("skipped")}</span>
                          <span className="is-total">{testResult.summary.total} {t("total")}</span>
                          {!testResult.parsed ? <em>{t("Summary not parsed")}</em> : null}
                          {testResult.summary.failed > 0 ? (
                            <button
                              className="studio-test-fix"
                              onClick={() => void askProject(testFailuresPrompt(), true, { skipClarify: true })}
                              disabled={chatBusy}
                            >
                              <WandSparkles size={11} /> {t("Fix failures with agent")}
                            </button>
                          ) : null}
                        </div>
                        {testResult.failures.length > 0 ? (
                          <div className="studio-test-failures">
                            {testResult.failures.slice(0, 24).map((failure, index) => (
                              <button
                                key={`${failure.name}-${index}`}
                                onClick={() => failure.file && void openFileAt(failure.file, failure.line)}
                                title={failure.message}
                              >
                                <span>{failure.name}</span>
                                {failure.file ? (
                                  <small>
                                    {failure.file}
                                    {failure.line ? `:${failure.line}` : ""}
                                  </small>
                                ) : null}
                              </button>
                            ))}
                          </div>
                        ) : null}
                        <pre className="studio-test-output">
                          {testOutput ||
                            `${testResult.stdout}${testResult.stderr ? `\n${testResult.stderr}` : ""}`}
                        </pre>
                        <span className="studio-test-time">
                          {t("exit")} {testResult.exitCode ?? "—"} · {testResult.durationMs} ms
                          {testResult.timedOut ? ` · ${t("timed out")}` : ""}
                        </span>
                      </div>
                    ) : testBusy ? (
                      <pre className="studio-test-output is-live">
                        {testOutput || t("Running tests…")}
                      </pre>
                    ) : (
                      <div className="studio-test-empty">
                        <TestTube2 size={18} />
                        <span>
                          {testDiscovery?.hasTests
                            ? t("Run the detected test command to see pass/fail results.")
                            : t("No test files were detected. You can generate a new test file with AI.")}
                        </span>
                      </div>
                    )}
  
                    <div className="studio-test-generate">
                      <div className="studio-test-generate-head">
                        <strong>{t("Generate tests with AI")}</strong>
                        <span>{activeFile ?? t("Select a source file first")}</span>
                      </div>
                      <div className="studio-test-generate-row">
                        <input
                          value={testGenInstruction}
                          onChange={(event) => setTestGenInstruction(event.target.value)}
                          placeholder={t("Optional: focus on edge cases, validation, or a specific function.")}
                        />
                        <button
                          className="action-button"
                          onClick={() => void generateTests()}
                          disabled={!active || !activeFile || testGenBusy}
                        >
                          {testGenBusy ? <Loader2 size={12} className="spin" /> : <WandSparkles size={12} />}
                          {t("Generate tests")}
                        </button>
                      </div>
                      {testGenResult ? (
                        <div className="studio-test-gen-result">
                          <div className="studio-test-gen-meta">
                            <strong>{testGenResult.testFilePath}</strong>
                            <span>{testGenResult.explanation}</span>
                          </div>
                          <div className="studio-diff studio-test-gen-diff">
                            {testGenDiff.map((part, partIndex) => (
                              <div key={partIndex} className="is-add">
                                {part.value
                                  .split("\n")
                                  .filter((line, lineIndex, lines) => lineIndex < lines.length - 1 || line.length > 0)
                                  .map((line, lineIndex) => (
                                    <div key={lineIndex} className="studio-diff-line">
                                      <span>+</span>
                                      {line}
                                    </div>
                                  ))}
                              </div>
                            ))}
                          </div>
                          <div className="studio-test-gen-actions">
                            <button className="action-button primary" onClick={() => void createTestFile()} disabled={saving}>
                              <Save size={12} /> {t("Create test file")}
                            </button>
                            <button className="action-button" onClick={() => setTestGenResult(null)}>
                              {t("Discard")}
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : bottomTab === "checks" ? (
                  <div className="studio-checks-panel">
                    <div className="studio-checks-head">
                      <div>
                        <strong>{t("Quality checks")}</strong>
                        <span>
                          {analysis.tooling
                            ? t("Detected from project manifests")
                            : t("No tooling profile detected")}
                        </span>
                      </div>
                      <button
                        className="studio-check-settings"
                        onClick={() => openSettings("editor")}
                        title={t("Check settings")}
                      >
                        <Settings2 size={10} /> {t("Check settings")}
                      </button>
                    </div>
                    <div className="studio-check-groups">
                      {checkGroups.map((group) =>
                        group.commands.length > 0 ? (
                          <div key={group.label} className="studio-check-group">
                            <span>{group.label}</span>
                            {group.commands.map((command) => (
                              <button
                                key={command}
                                onClick={() => void runCheck(command)}
                                disabled={checkBusy}
                                title={command}
                              >
                                {command}
                              </button>
                            ))}
                          </div>
                        ) : null,
                      )}
                    </div>
                    <div className="studio-check-actions">
                      <button
                        onClick={() => void runSyntaxCheck(undefined, true)}
                        disabled={!activeFile || syntaxBusy}
                        title={activeFile ?? t("Open a file first")}
                      >
                        {syntaxBusy ? <Loader2 size={10} className="spin" /> : <CheckCheck size={10} />}
                        {t("Syntax check active file")}
                      </button>
                      <button onClick={() => void scanDuplicates()} disabled={duplicationBusy}>
                        {duplicationBusy ? <Loader2 size={10} className="spin" /> : <Copy size={10} />}
                        {t("Scan code duplication")}
                      </button>
                      <button
                        onClick={() => void inspectPreview()}
                        disabled={browserCheckBusy || !effectivePreviewPath}
                        title={effectivePreviewPath || t("No HTML preview found")}
                      >
                        {browserCheckBusy ? <Loader2 size={10} className="spin" /> : <Eye size={10} />}
                        {t("Inspect preview")}
                      </button>
                      <button
                        onClick={() => void checkGame()}
                        disabled={browserCheckBusy || (!effectivePreviewPath && !livePreviewUrl)}
                        title={t("Check canvas, FPS and game controls")}
                      >
                        {browserCheckBusy ? <Loader2 size={10} className="spin" /> : <Gamepad2 size={10} />}
                        {t("Check game")}
                      </button>
                    </div>
                    {browserCheckError ? (
                      <div className="studio-ai-inline-error">
                        <AlertTriangle size={12} /> {browserCheckError}
                      </div>
                    ) : null}
                    {browserCheck ? (
                      <div className={`studio-browser-check ${browserCheck.ok ? "is-ok" : "is-fail"}`}>
                        <div className="studio-browser-check-head">
                          <strong>
                            {browserCheck.ok ? <CheckCircle2 size={11} /> : <AlertTriangle size={11} />}
                            {browserCheck.ok ? t("Preview check passed") : t("Preview check found problems")}
                          </strong>
                          <span>
                            {gameEngine ? `${gameEngine} · ` : ""}
                            {browserCheck.metrics.title || browserCheck.path} · {browserCheck.metrics.viewport.width}×
                            {browserCheck.metrics.viewport.height} · {browserCheck.metrics.buttons} {t("buttons")} ·{" "}
                            {browserCheck.metrics.inputs} {t("inputs")}
                            {browserCheck.metrics.canvases > 0
                              ? ` · ${browserCheck.metrics.canvases} canvas${
                                  browserCheck.metrics.fps ? ` · ${browserCheck.metrics.fps} fps` : ""
                                }`
                              : ""}
                          </span>
                          <button onClick={() => setBrowserCheck(null)}>{t("Clear")}</button>
                        </div>
                        <div className="studio-browser-check-steps">
                          {browserCheck.steps.map((step) => (
                            <div key={step.index} className={step.ok ? "is-ok" : "is-fail"}>
                              <span>{step.index}</span>
                              <strong>{step.action}</strong>
                              <small>{step.detail}</small>
                            </div>
                          ))}
                        </div>
                        {browserCheck.consoleErrors.length > 0 || browserCheck.pageErrors.length > 0 ? (
                          <pre className="studio-browser-check-errors">
                            {[...browserCheck.consoleErrors, ...browserCheck.pageErrors].join("\n")}
                          </pre>
                        ) : null}
                        {browserCheck.metrics.horizontalOverflow ? (
                          <div className="studio-browser-check-warning">
                            {t("Horizontal overflow detected at this viewport.")}
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    <div className="studio-project-tools">
                      <div className="studio-project-tools-head">
                        <strong>
                          <ListChecks size={10} /> {t("Project tools")}
                        </strong>
                        <span>
                          {projectTools?.tools.length ?? 0} {t("saved")}
                        </span>
                        <button
                          onClick={() => {
                            setProjectToolsBusy(true);
                            void api
                              .projectTools(analysis.id)
                              .then(setProjectTools)
                              .catch(() => undefined)
                              .finally(() => setProjectToolsBusy(false));
                          }}
                          disabled={projectToolsBusy}
                        >
                          {projectToolsBusy ? <Loader2 size={9} className="spin" /> : <RefreshCw size={9} />}
                          {t("Refresh")}
                        </button>
                      </div>
                      {projectTools && projectTools.tools.length > 0 ? (
                        <div className="studio-project-tools-list">
                          {projectTools.tools.map((tool) => (
                            <div key={tool.name}>
                              <strong>{tool.name}</strong>
                              <p>{tool.description}</p>
                              <code>{tool.command}</code>
                              <small>
                                {tool.tags.join(" · ")} · {tool.successCount}✓ / {tool.failureCount}✕
                              </small>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p>
                          {t(
                            "No saved tools yet. Scripts added under .cie/agent/tools are auto-registered and can be reused by run_project_tool.",
                          )}
                        </p>
                      )}
                    </div>

                    {checkBusy ? (
                      <div className="studio-check-running">
                        <Loader2 size={11} className="spin" />
                        <code>{checkCommand}</code>
                        <button onClick={stopCheck} className="is-stop">
                          <Square size={10} /> {t("Stop")}
                        </button>
                      </div>
                    ) : null}
                    {duplicationBusy ? (
                      <div className="studio-check-running">
                        <Loader2 size={11} className="spin" />
                        <code>{t("Scanning duplicated blocks…")}</code>
                      </div>
                    ) : duplication ? (
                      <div className="studio-duplication-panel">
                        <div className="studio-duplication-summary">
                          <strong>{t("Duplication")}</strong>
                          <span>
                            {duplication.blocks.length} {t("blocks")} · {duplication.duplicatedLines}{" "}
                            {t("duplicated lines")}
                          </span>
                          <button onClick={() => setDuplication(null)}>{t("Clear")}</button>
                        </div>
                        <div className="studio-duplication-list">
                          {duplication.blocks.slice(0, 20).map((block) => (
                            <details key={block.hash}>
                              <summary>
                                {block.lines} {t("lines")} · {block.occurrences.length}{" "}
                                {t("occurrences")}
                              </summary>
                              <pre>{block.sample}</pre>
                              <div className="studio-duplication-locations">
                                {block.occurrences.map((occurrence) => (
                                  <button
                                    key={`${occurrence.path}-${occurrence.startLine}`}
                                    onClick={() => void openFile(occurrence.path)}
                                    title={occurrence.path}
                                  >
                                    {occurrence.path}:{occurrence.startLine}-{occurrence.endLine}
                                  </button>
                                ))}
                              </div>
                            </details>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    <div className="studio-check-output-head">
                      <span>{t("Output")}</span>
                      {checkResult ? (
                        <span className={`studio-exit ${checkResult.exitCode === 0 ? "ok" : "bad"}`}>
                          {t("exit")} {checkResult.exitCode ?? "—"} · {checkResult.durationMs} ms
                        </span>
                      ) : null}
                      {checkOutput ? (
                        <button
                          onClick={() => {
                            checkOutputRef.current = "";
                            setCheckOutput("");
                            setCheckResult(null);
                          }}
                        >
                          {t("Clear")}
                        </button>
                      ) : null}
                    </div>
                    <pre className="studio-check-output">
                      {checkOutput ||
                        (checkBusy
                          ? t("Running…")
                          : checkResult
                            ? t("No output.")
                            : t("Select a check to run."))}
                    </pre>
                  </div>
                ) : bottomTab === "jobs" ? (
                  <div className="studio-jobs-panel">
                    <div className="studio-jobs-head">
                      <div>
                        <strong>{t("Background jobs")}</strong>
                        <span>
                          {jobs.filter((job) => job.status === "running").length} {t("running")}
                        </span>
                      </div>
                      <button onClick={() => void refreshJobs()}>{t("Refresh")}</button>
                    </div>
                    {jobError ? (
                      <div className="studio-ai-inline-error">
                        <AlertTriangle size={12} /> {jobError}
                      </div>
                    ) : null}
                    {jobs.length === 0 ? (
                      <div className="studio-task-empty">
                        <Play size={16} />
                        <span>{t("No background jobs. Start one from the Terminal tab.")}</span>
                      </div>
                    ) : (
                      <div className="studio-jobs-list">
                        {jobs.map((job) => {
                          const running = job.status === "running";
                          const ended = job.endedAt ? new Date(job.endedAt).getTime() : Date.now();
                          const duration = Math.max(0, ended - new Date(job.startedAt).getTime());
                          return (
                            <details key={job.id} className={`studio-job ${running ? "is-running" : ""}`} open={running}>
                              <summary>
                                <span className={`studio-job-dot is-${job.status}`} />
                                <code>{job.command}</code>
                                <small>{job.status}</small>
                                {job.pid ? <small>PID {job.pid}</small> : null}
                                <small>{Math.round(duration / 1000)}s</small>
                                {(running ? job.urls : undefined)?.map((url) => (
                                  <a
                                    key={url}
                                    className="studio-job-url"
                                    href={url}
                                    target="_blank"
                                    rel="noreferrer"
                                    onClick={(event) => event.stopPropagation()}
                                    title={t("Open local URL")}
                                  >
                                    {url.replace(/^https?:\/\//, "")} <ExternalLink size={8} />
                                  </a>
                                ))}
                                <span className="studio-job-actions">
                                  {running ? (
                                    <button
                                      onClick={(event) => {
                                        event.preventDefault();
                                        void stopJob(job.id);
                                      }}
                                    >
                                      {t("Stop")}
                                    </button>
                                  ) : (
                                    <button
                                      onClick={(event) => {
                                        event.preventDefault();
                                        void removeJob(job.id);
                                      }}
                                    >
                                      {t("Remove")}
                                    </button>
                                  )}
                                </span>
                              </summary>
                              <pre>{jobOutputs[job.id] || job.output || t("No output yet.")}</pre>
                            </details>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
        ) : null}
      </section>

      <section className="studio-right-panel">
        <div className="studio-right-tabs">
          <button
            className={rightTab === "preview" ? "is-active" : ""}
            onClick={() => setRightTab("preview")}
          >
            <Eye size={11} /> {t("Preview")}
          </button>
          {openTabs.map((filePath) => (
            <div key={filePath} className={`studio-right-tab ${rightTab === filePath ? "is-active" : ""}`}>
              <button
                onClick={() => {
                  setActiveFile(filePath);
                  setRightTab(filePath);
                }}
                title={filePath}
              >
                {filePath.split("/").pop()}
                {contents[filePath] !== savedContents[filePath] ? <i /> : null}
              </button>
              <button
                className="studio-right-tab-close"
                onClick={() => closeTab(filePath)}
                aria-label={t("Close")}
              >
                <X size={9} />
              </button>
            </div>
          ))}
          {rightTab !== "preview" && activeFile ? (
            <>
              <button
                className="studio-right-icon"
                onClick={() => void formatActiveFile()}
                disabled={formatting}
                title={t("Format file")}
              >
                {formatting ? <Loader2 size={11} className="spin" /> : <Wand2 size={11} />}
              </button>
              <button
                className="studio-right-icon"
                onClick={() => startRename(activeFile)}
                title={t("Rename or move")}
              >
                <Pencil size={11} />
              </button>
              <button
                className="studio-right-icon is-danger"
                onClick={() => startDelete(activeFile)}
                title={t("Delete file")}
              >
                <Trash2 size={11} />
              </button>
            </>
          ) : null}
          {rightTab !== "preview" ? (
            <button
              className="studio-right-save"
              onClick={() => void saveFile()}
              disabled={!dirty || saving}
            >
              {saving ? <Loader2 size={11} className="spin" /> : <Save size={11} />}
              {t("Save")}
            </button>
          ) : null}
        </div>

        <div className="studio-right-body">
          {rightTab === "preview" ? (
            <div className="studio-right-preview">
              <div className="studio-preview-head">
                <span className="studio-preview-title">
                  <Eye size={11} /> {t("Preview")}
                </span>
                {livePreviewUrls.length > 0 ? (
                  <div className="studio-live-preview-tabs">
                    {livePreviewUrls.map((url) => (
                      <button
                        key={url}
                        className={livePreviewUrl === url ? "is-active" : ""}
                        onClick={() => setLivePreviewUrl(url)}
                        title={url}
                      >
                        <Server size={9} /> {url.replace(/^https?:\/\//, "")}
                      </button>
                    ))}
                    {livePreviewUrl ? (
                      <button onClick={() => setLivePreviewUrl("")} title={t("Static preview")}>
                        {t("Static")}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                <button
                  className="icon-button subtle"
                  onClick={() => setPreviewKey((value) => value + 1)}
                  title={t("Refresh preview")}
                >
                  <RefreshCw size={11} />
                </button>
              </div>
              {livePreviewUrl ? (
                <iframe
                  key={`${livePreviewUrl}-${previewKey}`}
                  className="studio-preview-frame"
                  src={livePreviewUrl}
                  title={t("Live dev server preview")}
                  sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals"
                />
              ) : activeFile && isImagePreviewPath(activeFile) ? (
                <div className="studio-image-preview">
                  <img
                    src={`/api/projects/${analysis.id}/preview/${activeFile
                      .split("/")
                      .map(encodeURIComponent)
                      .join("/")}`}
                    alt={activeFile}
                  />
                  <small>{activeFile}</small>
                </div>
              ) : htmlFiles.length > 0 && effectivePreviewPath ? (
                <>
                  <select
                    className="studio-preview-select"
                    value={effectivePreviewPath}
                    onChange={(event) => setPreviewPath(event.target.value)}
                  >
                    {htmlFiles.slice(0, 200).map((file) => (
                      <option key={file} value={file}>
                        {file}
                      </option>
                    ))}
                  </select>
                  <iframe
                    key={`${effectivePreviewPath}-${previewKey}`}
                    className="studio-preview-frame"
                    src={`/api/projects/${analysis.id}/preview/${effectivePreviewPath
                      .split("/")
                      .map(encodeURIComponent)
                      .join("/")}`}
                    title={t("Web preview")}
                    sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
                  />
                </>
              ) : activeFile ? (
                <div className="studio-file-preview">
                  <div className="studio-file-preview-head">
                    <span>{activeFile}</span>
                    <small>{t("{count} lines", { count: activeContent.split("\n").length })}</small>
                  </div>
                  <pre>{activeContent}</pre>
                </div>
              ) : (
                <div className="studio-preview-empty">
                  <FileCode2 size={18} />
                  <span>
                    {htmlFiles.length === 0
                      ? t("No HTML page was found for a web preview.")
                      : t("Open a file to preview its contents.")}
                  </span>
                </div>
              )}
              <button
                className="studio-preview-fullscreen-button"
                onClick={() => setPreviewFullscreen((value) => !value)}
                title={previewFullscreen ? t("Exit full screen") : t("Full screen preview")}
                aria-label={previewFullscreen ? t("Exit full screen") : t("Full screen preview")}
              >
                {previewFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
            </div>
          ) : activeFile ? (
            <div className="studio-right-editor">
<div className="studio-editor">
          {activeFile ? (
            <>
              <div className="studio-editor-meta">
                <span>{activeFile}</span>
                <span>
                  {activeLanguage || t("text")} · {t("line count", { count: activeContent.split("\n").length })}
                </span>
              </div>
              <div className="studio-editor-scroll">
                <CodeMirror
                  value={activeContent}
                  height="100%"
                  theme={oneDark}
                  extensions={[languageExtension(activeFile), lspExtensions]}
                  onCreateEditor={(view) => {
                    editorViewRef.current = view;
                  }}
                  onChange={(value) =>
                    setContents((current) => ({ ...current, [activeFile]: value }))
                  }
                  basicSetup={{
                    lineNumbers: true,
                    foldGutter: true,
                    highlightActiveLine: true,
                    bracketMatching: true,
                    autocompletion: true,
                  }}
                />
              </div>
            </>
          ) : (
            <div className="studio-editor-empty">
              <Code2 size={24} />
              <span>{t("Select a file from the project tree to start editing.")}</span>
            </div>
          )}
          {fileLoading ? (
            <div className="studio-file-loading">
              <Loader2 size={14} className="spin" /> {t("Opening file…")}
            </div>
          ) : null}
        </div>
            </div>
          ) : (
            <div className="studio-editor-empty">
              <Code2 size={24} />
              <span>{t("Select a file from the project tree to start editing.")}</span>
            </div>
          )}
          {fileLoading ? (
            <div className="studio-file-loading">
              <Loader2 size={14} className="spin" /> {t("Opening file…")}
            </div>
          ) : null}
        </div>
      </section>
      <div
        className="studio-resize-handle is-left"
        onPointerDown={(event) => startResize("left", event)}
        title={t("Drag to resize project panel")}
      >
        <GripVertical size={12} />
      </div>
      <div
        className="studio-resize-handle is-right"
        onPointerDown={(event) => startResize("right", event)}
        title={t("Drag to resize preview panel")}
      >
        <GripVertical size={12} />
      </div>
      {newFileOpen ? (
        <div
          className="modal-backdrop"
          onMouseDown={() => {
            if (!newFileBusy) setNewFileOpen(false);
          }}
        >
          <div className="file-action-modal" onMouseDown={(event) => event.stopPropagation()}>
            <h3>{t("New file")}</h3>
            <label>{t("Template")}</label>
            <select
              value={newFileTemplate}
              onChange={(event) => {
                const template = FILE_TEMPLATES.find((item) => item.id === event.target.value);
                setNewFileTemplate(event.target.value);
                if (template?.path) setNewFileDraft(template.path);
              }}
            >
              {FILE_TEMPLATES.map((template) => (
                <option key={template.id} value={template.id}>
                  {t(template.label)}
                </option>
              ))}
            </select>
            <label>{t("Project-relative path")}</label>
            <input
              value={newFileDraft}
              onChange={(event) => setNewFileDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void createNewFile();
              }}
              placeholder={t("src/example.rs")}
              spellCheck={false}
              autoFocus
            />
            <small>
              {t("Folders are created automatically. Syntax highlighting follows the file extension.")}
            </small>
            {newFileTemplate === "env" ? (
              <small className="file-action-warning">
                {t("Real .env and key files are blocked. This creates a safe env.example template instead.")}
              </small>
            ) : null}
            <div className="file-action-actions">
              <button
                className="ghost-button"
                onClick={() => setNewFileOpen(false)}
                disabled={newFileBusy}
              >
                {t("Cancel")}
              </button>
              <button
                className="primary-button"
                onClick={() => void createNewFile()}
                disabled={newFileBusy || !newFileDraft.trim()}
              >
                {newFileBusy ? <Loader2 size={12} className="spin" /> : <Plus size={12} />}
                {t("Create file")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {fileAction ? (
        <div
          className="modal-backdrop"
          onMouseDown={() => {
            if (!fileActionBusy) setFileAction(null);
          }}
        >
          <div className="file-action-modal" onMouseDown={(event) => event.stopPropagation()}>
            <h3>{fileAction.type === "rename" ? t("Rename or move") : t("Delete file")}</h3>
            <code>{fileAction.path}</code>
            {fileAction.type === "rename" ? (
              <>
                <label>{t("New project-relative path")}</label>
                <input
                  value={renameDraft}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void applyRename();
                  }}
                  spellCheck={false}
                  autoFocus
                />
                <small>
                  {t("Parent folders are created automatically. The old path is moved, not copied.")}
                </small>
              </>
            ) : (
              <p>{t("This removes the file from disk. This action cannot be undone.")}</p>
            )}
            <div className="file-action-actions">
              <button className="ghost-button" onClick={() => setFileAction(null)} disabled={fileActionBusy}>
                {t("Cancel")}
              </button>
              <button
                className={fileAction.type === "delete" ? "primary-button is-danger" : "primary-button"}
                onClick={() =>
                  fileAction.type === "rename" ? void applyRename() : void applyDelete()
                }
                disabled={fileActionBusy}
              >
                {fileActionBusy ? (
                  <Loader2 size={12} className="spin" />
                ) : fileAction.type === "rename" ? (
                  <Pencil size={12} />
                ) : (
                  <Trash2 size={12} />
                )}
                {fileAction.type === "rename" ? t("Rename / move") : t("Delete")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {indexSearchOpen ? (
        <div className="modal-backdrop" onMouseDown={() => setIndexSearchOpen(false)}>
          <div className="index-search-modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="index-search-head">
              <div>
                <span>{t("Project index")}</span>
                <strong>{t("Search file contents, symbols and past answers")}</strong>
              </div>
              <button className="icon-button" onClick={() => setIndexSearchOpen(false)} aria-label={t("Close")}>
                <X size={15} />
              </button>
            </div>
            <div className="index-search-row">
              <Search size={13} />
              <input
                value={indexQuery}
                onChange={(event) => setIndexQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void runIndexSearch();
                }}
                placeholder={t("Search the project…")}
                autoFocus
                spellCheck={false}
              />
              <button onClick={() => void runIndexSearch()} disabled={indexSearchBusy || !indexQuery.trim()}>
                {indexSearchBusy ? <Loader2 size={12} className="spin" /> : <Search size={12} />}
                {t("Search")}
              </button>
            </div>
            {!indexStatus?.ready ? (
              <div className="index-search-empty">
                {t("The index is not ready. Build it from the header, then search instantly.")}
              </div>
            ) : indexResults.length === 0 ? (
              <div className="index-search-empty">{t("No index results yet.")}</div>
            ) : (
              <div className="index-search-results">
                {indexResults.map((hit) => (
                  <button
                    key={hit.id}
                    className="index-search-result"
                    onClick={() => {
                      if (hit.path) {
                        void openFile(hit.path);
                        setIndexSearchOpen(false);
                      }
                    }}
                    disabled={!hit.path}
                  >
                    <span className={`index-hit-kind is-${hit.kind}`}>{hit.kind}</span>
                    <span className="index-hit-main">
                      <strong>{hit.title}</strong>
                      {hit.path ? (
                        <small>
                          {hit.path}
                          {hit.line ? `:${hit.line}` : ""}
                        </small>
                      ) : null}
                      {hit.snippet || hit.answer ? (
                        <em>{(hit.snippet || hit.answer || "").slice(0, 220)}</em>
                      ) : null}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}
      <AgentPermissionDialog
        request={permissionRequest}
        busy={permissionBusy}
        onDecide={(decision) => void decidePermission(decision)}
      />
      <SettingsScreen
        open={settingsOpen}
        initialTab={settingsTab}
        modelsAddMode={settingsModelsAdd}
        projectId={analysis.id}
        projectName={analysis.projectName}
        projectRoot={analysis.rootPath}
        aiSettings={aiSettings}
        onSettingsSaved={onSettingsSaved}
        agentAllowWrite={agentAllowWrite}
        onAgentAllowWriteChange={setAgentAllowWrite}
        agentAllowCommands={agentAllowCommands}
        onAgentAllowCommandsChange={setAgentAllowCommands}
        autoFormat={autoFormat}
        onAutoFormatChange={setAutoFormat}
        autoSyntax={autoSyntax}
        onAutoSyntaxChange={setAutoSyntax}
        autoCheck={autoCheck}
        onAutoCheckChange={setAutoCheck}
        testTimeout={testTimeout}
        onTestTimeoutChange={setTestTimeout}
        onRescan={onRescan}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
