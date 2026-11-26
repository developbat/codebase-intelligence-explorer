import type { AgentToolGroup } from "../../../shared/intent";

/**
 * Single source of truth for the agent tool surface.
 *
 * A tool is more than an example string: it declares which capability family
 * it belongs to, whether it needs a write/command approval, whether it is
 * destructive, and the arguments it requires. New built-in tools can be added
 * here without touching the prompt builder. Project/generated tools can be
 * layered on top of this list later with the same shape.
 */
export interface JsonSchema {
  type?: "object" | "array" | "string" | "number" | "boolean" | "integer";
  required?: string[];
  properties?: Record<string, JsonSchema>;
  anyOf?: JsonSchema[];
  items?: JsonSchema;
  enum?: Array<string | number | boolean>;
  description?: string;
}

export interface AgentToolSpec {
  action: string;
  groups: AgentToolGroup[];
  example: string;
  description: string;
  whenToUse: string;
  permission?: "write" | "command";
  destructive?: boolean;
  /** Only exposed in Build mode, but never needs a write approval. */
  writeModeOnly?: boolean;
  note?: string;
  extraExamples?: string[];
  /** Preferred schema for generated/third-party tools; JSON Schema subset. */
  inputSchema?: JsonSchema;
  args?: {
    /** Each inner array is a group of aliases; at least one key is required. */
    required?: string[][];
    types?: Record<string, "string" | "number" | "boolean" | "array" | "object">;
  };
}

const TOOL_SPECS: AgentToolSpec[] = [
  // Core project navigation
  {
    action: "list_files",
    groups: ["core"],
    example: '{"action":"list_files","args":{"path":"src","limit":80}}',
    description: "List files under a project-relative folder.",
    whenToUse: "Use for a bounded folder inventory; use project_search for content search.",
  },
  {
    action: "search_code",
    groups: ["core"],
    example: '{"action":"search_code","args":{"query":"login handler","limit":15}}',
    description: "Search source text across the project.",
    whenToUse: "Use when you need literal text hits and project_search is unavailable or too broad.",
    args: { required: [["query"]], types: { query: "string" } },
  },
  {
    action: "read_file",
    groups: ["core"],
    example: '{"action":"read_file","args":{"path":"src/app.ts","startLine":1,"endLine":200}}',
    description: "Read a file or a focused line range.",
    whenToUse: "Read only the range you need; prefer read_symbol for a known symbol.",
    inputSchema: {
      type: "object",
      anyOf: [
        { required: ["path"] },
        { required: ["file"] },
        { required: ["filePath"] },
        { required: ["target"] },
        { required: ["filename"] },
      ],
      properties: {
        path: { type: "string" },
        file: { type: "string" },
        filePath: { type: "string" },
        startLine: { type: "number" },
        endLine: { type: "number" },
      },
    },
  },
  {
    action: "read_symbol",
    groups: ["core"],
    example: '{"action":"read_symbol","args":{"path":"src/app.ts","line":142}}',
    description: "Read the enclosing function, method or class for a line or name.",
    whenToUse: "Use after a search hit when the target is a symbol, instead of reading the whole file.",
    args: { required: [["path", "name"]], types: { path: "string", name: "string", line: "number" } },
  },
  {
    action: "find_in_file",
    groups: ["core"],
    example: '{"action":"find_in_file","args":{"path":"src/app.ts","query":"login","contextLines":2,"limit":10}}',
    description: "Find matching lines inside one file with context.",
    whenToUse: "Use before reading a large file to locate the exact line range.",
    args: {
      required: [["path", "file", "filePath", "target"], ["query"]],
      types: { path: "string", query: "string" },
    },
  },
  {
    action: "diagnostics",
    groups: ["core"],
    example: '{"action":"diagnostics","args":{"path":"src/app.ts"}}',
    description: "Return language-server diagnostics for a file.",
    whenToUse: "Use after an edit or when the user asks about editor errors.",
    args: { required: [["path", "file", "filePath"]], types: { path: "string" } },
  },
  {
    action: "lsp_hover",
    groups: ["core"],
    example: '{"action":"lsp_hover","args":{"path":"src/app.ts","line":42,"character":10}}',
    description: "Read the language-server hover at a source position.",
    whenToUse: "Use when a type or signature is unclear.",
  },
  {
    action: "lsp_completion",
    groups: ["core"],
    example: '{"action":"lsp_completion","args":{"path":"src/app.ts","line":42,"character":10}}',
    description: "Read language-server completions at a source position.",
    whenToUse: "Use when the exact API name is unknown.",
  },
  {
    action: "list_items",
    groups: ["core"],
    example: '{"action":"list_items","args":{"path":"data/items.html","limit":100}}',
    description: "Extract repeated list items from markup or text.",
    whenToUse: "Use for a page list when extract_entities has no matching kind.",
  },
  {
    action: "count_matches",
    groups: ["core"],
    example: '{"action":"count_matches","args":{"path":"src","query":"TODO","limit":20}}',
    description: "Count literal matches across files.",
    whenToUse: "Use for exact count questions; do not count raw occurrences when JSON has a length field.",
  },
  {
    action: "list_colors",
    groups: ["core"],
    example: '{"action":"list_colors","args":{"path":"styles.css"}}',
    description: "List colors in a stylesheet.",
    whenToUse: "Use before a color mapping; extract_entities(kind=color) is the preferred audit.",
  },
  {
    action: "extract_entities",
    groups: ["core"],
    example: '{"action":"extract_entities","args":{"kind":"button"}}',
    description: "Extract a complete, code-referenced entity table.",
    whenToUse: "Use for complete lists/audits: buttons, inputs, links, functions, classes, routes, imports, colors, env, assets, documents, markdown, files.",
    extraExamples: [
      '{"action":"extract_entities","args":{"kind":"input","scope":["index.html"]}}',
      '{"action":"extract_entities","args":{"kind":"function","scope":["src"]}}',
      '{"action":"extract_entities","args":{"kind":"route"}}',
      '{"action":"extract_entities","args":{"kind":"color","scope":["styles.css"]}}',
      '{"action":"extract_entities","args":{"kind":"asset"}}',
      '{"action":"extract_entities","args":{"kind":"document"}}',
    ],
    args: { required: [["kind"]], types: { kind: "string", scope: "array" } },
  },
  {
    action: "audit_content",
    groups: ["core"],
    example: '{"action":"audit_content","args":{}}',
    description: "Audit asset references, broken local links and Markdown hierarchy.",
    whenToUse: "Use for content/asset audits instead of manually reading every file.",
  },
  {
    action: "create_document",
    groups: ["edit"],
    example:
      '{"action":"create_document","args":{"path":"reports/summary.xlsx","format":"xlsx","rows":[["name","value"],["alpha","1"]]}}',
    description: "Create xlsx, csv, tsv, docx, pdf, md, json, html or txt output.",
    whenToUse: "Use when the user asks for a document or spreadsheet output; verify it with read_document.",
    extraExamples: [
      '{"action":"create_document","args":{"path":"reports/notes.docx","format":"docx","content":"Hello"}}',
    ],
    permission: "write",
    args: {
      required: [["path", "file", "filePath", "target"]],
      types: { path: "string", format: "string", rows: "array", sheets: "array", content: "string" },
    },
  },
  {
    action: "create_zip",
    groups: ["edit"],
    example: '{"action":"create_zip","args":{"path":"reports/bundle.zip","entries":["README.md","reports/notes.docx"]}}',
    description: "Create a zip archive from files or folders.",
    whenToUse: "Use when the user asks for an archive; verify the entries afterward.",
    permission: "write",
    args: { required: [["path"], ["entries", "files", "paths"]], types: { path: "string", entries: "array" } },
  },
  {
    action: "apply_mapped_changes",
    groups: ["edit"],
    example: '{"action":"apply_mapped_changes","args":{"kind":"color","scope":["styles.css"],"mapping":{"#22d3ee":"#ff5c8a"}}}',
    description: "Apply a simultaneous color/text mapping across files.",
    whenToUse: "Use for color/theme swaps and repeated text replacements; prefer dryRun for multi-file mappings.",
    extraExamples: [
      '{"action":"apply_mapped_changes","args":{"kind":"text","mapping":{"PLAY AGAIN":"RESTART"}}}',
      '{"action":"apply_mapped_changes","args":{"kind":"color","dryRun":true,"mapping":{"#fff":"#000","#000":"#fff"}}}',
    ],
    permission: "write",
    args: { required: [["mapping"]], types: { kind: "string", mapping: "object", scope: "array" } },
  },
  {
    action: "undo_change",
    groups: ["edit"],
    example: '{"action":"undo_change","args":{"path":"styles.css"}}',
    description: "Restore the latest editor backup for a file.",
    whenToUse: "Use when a mapped change or edit was wrong.",
    permission: "write",
    args: { required: [["path", "file", "filePath", "target", "filename"]], types: { path: "string" } },
  },
  {
    action: "json_query",
    groups: ["core"],
    example: '{"action":"json_query","args":{"path":"package.json","pointer":"scripts"}}',
    description: "Read a JSON pointer or array length.",
    whenToUse: "Use for structured JSON data instead of reading the whole file.",
    args: { required: [["path", "file", "filePath"], ["pointer"]], types: { path: "string", pointer: "string" } },
  },
  {
    action: "find_symbols",
    groups: ["core"],
    example: '{"action":"find_symbols","args":{"query":"UserService","kind":"class","limit":20}}',
    description: "Find symbols by name and kind across languages.",
    whenToUse: "Use before reading files when a class/function name is known.",
    args: { required: [["query"]], types: { query: "string", kind: "string" } },
  },
  {
    action: "sqlite_query",
    groups: ["core"],
    example: '{"action":"sqlite_query","args":{"path":"data/app.db","query":"SELECT name FROM sqlite_schema"}}',
    description: "Run a read-only SQLite query.",
    whenToUse: "Use for local database schema/data questions.",
    args: { required: [["path", "file", "filePath", "target"], ["query"]], types: { path: "string", query: "string" } },
  },
  {
    action: "csv_query",
    groups: ["core"],
    example: '{"action":"csv_query","args":{"path":"data/users.csv","columns":["name","email"],"limit":10}}',
    description: "Filter and inspect CSV/TSV data.",
    whenToUse: "Use for tabular data instead of reading the whole file.",
    args: { required: [["path", "file", "filePath"]], types: { path: "string", columns: "array" } },
  },
  {
    action: "git_blame",
    groups: ["git"],
    example: '{"action":"git_blame","args":{"path":"src/app.ts","startLine":10,"endLine":25}}',
    description: "Read line-level Git blame.",
    whenToUse: "Use when the user asks why/when a line changed.",
    args: { required: [["path", "file", "filePath", "target", "filename"]], types: { path: "string" } },
  },
  {
    action: "git_info",
    groups: ["git"],
    example: '{"action":"git_info","args":{"operation":"status"}}',
    description: "Inspect Git status, diff, log, branches or remotes.",
    whenToUse: "Use before a Git report or commit.",
  },
  {
    action: "browser_check",
    groups: ["browser"],
    example:
      '{"action":"browser_check","args":{"path":"index.html","steps":[{"action":"fill","selector":"#task-input","value":"Test"},{"action":"click","selector":"#add-task"},{"action":"expectText","selector":"#task-list","text":"Test"}]}}',
    description:
      "Drive the real preview or a running dev server in a browser and assert UI state. Use `url` for a live server (for example http://127.0.0.1:8501); `path` is only for a static project file. A URL placed in `path` is treated as `url`. For keyboard/canvas games use a pressKeys step (for example keys: [\"3\",\"0\",\"*\",\"1\",\"Enter\"]) followed by expectText on the score/HUD.",
    whenToUse: "Use for UI/game behavior, clicks, forms and console errors; prefer DOM-visible checks over unknown globals.",
    inputSchema: {
      type: "object",
      required: ["steps"],
      properties: {
        steps: {
          type: "array",
          description:
            "Ordered browser steps. Each step needs action plus selector/value/text as appropriate.",
          items: {
            type: "object",
            required: ["action"],
            properties: {
              action: {
                type: "string",
                enum: [
                  "click",
                  "fill",
                  "press",
                  "expectText",
                  "expectValue",
                  "expectVisible",
                  "expectCount",
                  "expectStable",
                  "waitForText",
                  "waitForSelector",
                  "pressKeys",
                  "reload",
                  "eval",
                  "storageGet",
                ],
              },
              selector: {
                type: "string",
                description: "Project page selector, e.g. #play or body. Required for click/fill/expect*/waitForSelector.",
              },
              value: {
                type: "string",
                description:
                  "Value for fill/press/eval/expectValue. For eval this is the JavaScript expression (aliases expression/code/script are accepted).",
              },
              text: {
                type: "string",
                description: "Expected text for expectText/waitForText.",
              },
              key: { type: "string", description: "localStorage key for storageGet." },
              count: { type: "number", description: "Expected element count for expectCount." },
              keys: {
                type: "array",
                items: { type: "string" },
                description:
                  "pressKeys: keys in order, e.g. [\"3\",\"0\",\"*\",\"1\",\"Enter\"]. Uses public keyboard events on the real page.",
              },
              durationMs: { type: "number", description: "expectStable sample window." },
              maxChanges: { type: "number", description: "expectStable allowed value changes." },
              timeoutMs: { type: "number" },
            },
          },
        },
        path: {
          type: "string",
          description: "Project-relative static file (for example index.html). Do not put a server URL here.",
        },
        url: {
          type: "string",
          description: "Local dev-server URL, for example http://127.0.0.1:8501.",
        },
      },
    },
  },
  {
    action: "run_test_scenario",
    groups: ["browser", "skills"],
    example: '{"action":"run_test_scenario","args":{"name":"comedy-events"}}',
    description: "Run a saved browser scenario under .cie/agent/scenarios.",
    whenToUse: "Use before writing a new scenario when a matching saved test exists.",
    args: { required: [["name", "path"]], types: { name: "string" } },
  },
  {
    action: "game_check",
    groups: ["browser"],
    example: '{"action":"game_check","args":{"path":"index.html","steps":[{"action":"expectVisible","selector":"canvas"}]}}',
    description: "Run a game-specific browser check with canvas/FPS metrics.",
    whenToUse: "Use for canvas games; combine with expectStable for HUD/timers.",
    args: { required: [["steps"]], types: { steps: "array" } },
  },
  {
    action: "graphic_check",
    groups: ["browser"],
    example: '{"action":"graphic_check","args":{"path":"assets/report.svg","expectText":"Weekly progress"}}',
    description: "Validate dimensions, colors and labels of a generated graphic.",
    whenToUse: "Use after create_graphic or when the user asks for visual verification.",
    args: { required: [["path", "file", "filePath", "target", "filename"]], types: { path: "string" } },
  },
  {
    action: "create_graphic",
    groups: ["media"],
    example:
      '{"action":"create_graphic","args":{"path":"assets/report.svg","kind":"bar","title":"Weekly progress","data":[{"label":"Mon","value":4},{"label":"Tue","value":7}]}}',
    description: "Generate an SVG/PNG chart or graphic.",
    whenToUse: "Use when the user asks for a chart, diagram or generated asset.",
    permission: "write",
    args: { required: [["path", "file", "filePath", "target"], ["data"]], types: { path: "string", kind: "string", data: "array" } },
  },
  {
    action: "web_fetch",
    groups: ["web"],
    example: '{"action":"web_fetch","args":{"url":"https://example.com","maxChars":8000}}',
    description: "Fetch a public web page as text.",
    whenToUse: "Use for external documentation or research; cite the URL.",
    args: { required: [["url"]], types: { url: "string" } },
  },
  {
    action: "read_document",
    groups: ["document"],
    example: '{"action":"read_document","args":{"path":"docs/spec.pdf","pageStart":1,"pageEnd":20}}',
    description: "Read PDF, Word, Excel, CSV/TSV, text, JSON, HTML or OCR images.",
    whenToUse: "Use for attachments and office documents instead of reading binary bytes.",
    extraExamples: [
      '{"action":"read_document","args":{"path":"data/report.xlsx","sheet":"Sheet1"}}',
      '{"action":"read_document","args":{"path":"assets/screenshot.png","ocr":true,"lang":"eng"}}',
    ],
    args: { required: [["path", "file", "filePath"]], types: { path: "string" } },
  },
  {
    action: "search_document",
    groups: ["document"],
    example: '{"action":"search_document","args":{"path":"docs/spec.pdf","query":"deadline"}}',
    description: "Search inside a document.",
    whenToUse: "Use when a document is large and only a specific fact is needed.",
    args: { required: [["path", "file", "filePath", "target"], ["query"]], types: { path: "string", query: "string" } },
  },
  {
    action: "project_search",
    groups: ["core"],
    example: '{"action":"project_search","args":{"query":"unchecked tasks deadline","limit":15}}',
    description: "Search the project index, symbols and text together.",
    whenToUse: "Use as the first search for a new request.",
    args: { required: [["query"]], types: { query: "string" } },
  },
  {
    action: "search_conversations",
    groups: ["core"],
    example: '{"action":"search_conversations","args":{"query":"what the user asked earlier","limit":5}}',
    description: "Search indexed earlier conversation turns.",
    whenToUse: "Use only when the recent history is insufficient.",
    args: { required: [["query"]], types: { query: "string" } },
  },
  {
    action: "list_notes",
    groups: ["notes"],
    example: '{"action":"list_notes","args":{}}',
    description: "List saved research notes.",
    whenToUse: "Use at the start of research when prior notes may exist.",
  },
  {
    action: "read_note",
    groups: ["notes"],
    example: '{"action":"read_note","args":{"path":".cie/agent/notes/research.md"}}',
    description: "Read a saved research note.",
    whenToUse: "Use when a matching note was found.",
    args: { required: [["path", "file", "filePath", "target", "filename"]], types: { path: "string" } },
  },
  {
    action: "search_notes",
    groups: ["notes"],
    example: '{"action":"search_notes","args":{"query":"previous research","limit":10}}',
    description: "Search saved research notes.",
    whenToUse: "Use before repeating prior research.",
    args: { required: [["query"]], types: { query: "string" } },
  },
  {
    action: "list_skills",
    groups: ["skills"],
    example: '{"action":"list_skills","args":{}}',
    description: "List enabled/disabled skills and keys.",
    whenToUse: "Use when the capability index is insufficient.",
  },
  {
    action: "load_skill",
    groups: ["core", "skills"],
    example: '{"action":"load_skill","args":{"key":"project:project-cie:ui-review"}}',
    description: "Load a skill's full instructions for this run.",
    whenToUse: "Use when a task clearly matches an entry in the capability index.",
    args: { required: [["key"]], types: { key: "string" } },
  },
  {
    action: "preview_skill_source",
    groups: ["skills"],
    example: '{"action":"preview_skill_source","args":{"source":"owner/repo","ref":"main"}}',
    description: "Preview a GitHub/local skill source before installing.",
    whenToUse: "Use before install_skill.",
    args: { required: [["source"]], types: { source: "string" } },
  },
  {
    action: "check_toolchains",
    groups: ["tools"],
    example: '{"action":"check_toolchains","args":{}}',
    description: "Check installed development toolchains.",
    whenToUse: "Use when a command/tool may be missing.",
  },
  {
    action: "rescan_project",
    groups: ["core"],
    example: '{"action":"rescan_project","args":{}}',
    description: "Refresh the project graph/index.",
    whenToUse: "Use when PROJECT_MAP reports missing code files or analysis is stale.",
  },
  {
    action: "list_project_tools",
    groups: ["skills"],
    example: '{"action":"list_project_tools","args":{}}',
    description: "List saved reusable project tools.",
    whenToUse: "Use before creating a new script; reuse an existing tool when possible.",
  },
  {
    action: "list_mobile_devices",
    groups: ["mobile"],
    example: '{"action":"list_mobile_devices","args":{}}',
    description: "List iOS simulators and Android emulators.",
    whenToUse: "Use before mobile automation.",
  },

  // Writes / edits
  {
    action: "write_file",
    groups: ["edit"],
    example: '{"action":"write_file","args":{"path":"src/new-file.ts","content":"complete file content, max ~12k chars"}}',
    description: "Write a complete file.",
    whenToUse: "Use for a new file or a complete rewrite; use append_text for a large tail block.",
    permission: "write",
    note: "for larger files write the first part, then append_text",
    args: {
      required: [["path", "file", "filePath", "target"], ["content", "text", "code"]],
      types: { path: "string", content: "string" },
    },
  },
  {
    action: "replace_in_file",
    groups: ["edit"],
    example: '{"action":"replace_in_file","args":{"path":"src/app.ts","find":"exact existing snippet","replace":"replacement snippet"}}',
    description: "Replace one exact existing snippet.",
    whenToUse: "Use for a small precise edit; read the exact range first.",
    permission: "write",
    args: {
      required: [
        ["path", "file", "filePath", "target"],
        ["find", "search", "old", "oldText", "old_string", "oldString", "from"],
        ["replace", "replacement", "new", "newText", "new_string", "newString", "to", "with"],
      ],
      types: { path: "string", find: "string", replace: "string" },
    },
  },
  {
    action: "replace_many",
    groups: ["edit"],
    example: '{"action":"replace_many","args":{"path":"src/app.ts","edits":[{"find":"first exact snippet","replace":"first replacement"},{"find":"second exact snippet","replace":"second replacement"}]}}',
    description: "Apply several exact replacements in one file.",
    whenToUse: "Use for multiple small edits in the same file.",
    permission: "write",
    args: { required: [["path"], ["edits"]], types: { path: "string", edits: "array" } },
  },
  {
    action: "append_text",
    groups: ["edit"],
    example: '{"action":"append_text","args":{"path":"css/styles.css","content":"/* new self-contained section */\\n.new-rule { display: block; }"}}',
    description: "Append a self-contained block without reading the whole file.",
    whenToUse: "Use for a new CSS section, HTML block or tail helper.",
    permission: "write",
    note: "append without reading the whole file",
    args: { required: [["path", "file", "filePath", "target"], ["content", "text", "code"]], types: { path: "string", content: "string" } },
  },
  {
    action: "rename_path",
    groups: ["edit"],
    example: '{"action":"rename_path","args":{"path":"src/old.ts","newPath":"src/new.ts"}}',
    description: "Rename or move a file/folder.",
    whenToUse: "Use only when the user explicitly asks to rename/move.",
    permission: "write",
    destructive: true,
    args: { required: [["path", "file", "filePath", "target"], ["newPath", "to"]], types: { path: "string", newPath: "string" } },
  },
  {
    action: "delete_file",
    groups: ["edit"],
    example: '{"action":"delete_file","args":{"path":"src/obsolete.ts"}}',
    description: "Delete a file or empty folder.",
    whenToUse: "Use only when the user explicitly asks to delete.",
    permission: "write",
    destructive: true,
    args: { required: [["path", "file", "filePath", "target", "filename"]], types: { path: "string" } },
  },
  {
    action: "format_file",
    groups: ["edit"],
    example: '{"action":"format_file","args":{"path":"src/app.ts"}}',
    description: "Format one file with the detected formatter.",
    whenToUse: "Use after a manual edit when formatting is requested or available.",
    permission: "write",
    args: { required: [["path", "file", "filePath", "target", "filename"]], types: { path: "string" } },
  },
  {
    action: "run_command",
    groups: ["command"],
    example: '{"action":"run_command","args":{"command":"npm test","cwd":"."}}',
    description: "Run a project command with a permission handshake.",
    whenToUse: "Use for tests, build, typecheck, lint or an explicit user command.",
    permission: "command",
    args: { required: [["command"]], types: { command: "string" } },
  },
  {
    action: "run_project_tool",
    groups: ["command"],
    example: '{"action":"run_project_tool","args":{"name":"ui-check","input":{"url":"http://localhost:3000"}}}',
    description: "Run a saved project tool/script with optional JSON input.",
    whenToUse: "Use a saved .cie/agent/tools script instead of recreating it; pass input when the manifest declares a schema.",
    permission: "command",
    note: "runs a saved project tool/script; input is exposed as CIE_TOOL_INPUT",
    args: { required: [["name"]], types: { name: "string", input: "object" } },
  },
  {
    action: "delegate_research",
    groups: ["web"],
    example: '{"action":"delegate_research","args":{"goal":"specific read-only question to investigate"}}',
    description: "Run a compact read-only research subagent.",
    whenToUse: "Use for a broad read-only investigation that would otherwise fill this context.",
    writeModeOnly: true,
    args: { required: [["goal"]], types: { goal: "string" } },
  },
  {
    action: "placeholder_asset",
    groups: ["media"],
    example: '{"action":"placeholder_asset","args":{"path":"assets/player.svg","kind":"sprite","width":128,"height":128,"label":"player"}}',
    description: "Create placeholder images, sprites, sounds or spritesheets.",
    whenToUse: "Use when a runnable asset placeholder is needed before real art.",
    extraExamples: [
      '{"action":"placeholder_asset","args":{"path":"assets/icon.png","kind":"icon","format":"png","width":1024,"height":1024,"label":"App"}}',
      '{"action":"placeholder_asset","args":{"path":"assets/beep.wav","kind":"sound","durationMs":500,"frequency":660}}',
      '{"action":"placeholder_asset","args":{"path":"assets/loop.wav","kind":"music","durationMs":4000,"frequency":220,"loop":true}}',
      '{"action":"placeholder_asset","args":{"path":"assets/sheet.png","kind":"spritesheet","format":"png","width":512,"height":512,"fps":8}}',
    ],
    permission: "write",
    args: { required: [["path", "file", "filePath", "target"], ["kind"]], types: { path: "string", kind: "string" } },
  },
  {
    action: "save_note",
    groups: ["notes"],
    example: '{"action":"save_note","args":{"title":"Research: topic","content":"notes with sources","tags":["research"],"sources":["https://example.com"]}}',
    description: "Save a durable research note under .cie/agent/notes.",
    whenToUse: "Use when the user asks for research notes or a reusable report.",
    permission: "write",
    note: "saves under .cie/agent/notes",
    args: { required: [["title"], ["content"]], types: { title: "string", content: "string" } },
  },
  {
    action: "create_project_tool",
    groups: ["tools"],
    example: '{"action":"create_project_tool","args":{"name":"check-links","language":"js","description":"Validate links","whenToUse":"Use before shipping a static page.","inputSchema":{"type":"object","required":["url"],"properties":{"url":{"type":"string"}}},"timeoutMs":60000,"code":"// read JSON from process.env.CIE_TOOL_INPUT"}}',
    description: "Create a reusable project tool script with an optional input manifest and timeout.",
    whenToUse: "Use when a check will be run more than once or needs typed input.",
    permission: "write",
    note: "saves under .cie/agent/tools; supports inputSchema, whenToUse and timeoutMs",
    args: { required: [["name"], ["code"]], types: { name: "string", code: "string", inputSchema: "object" } },
  },
  {
    action: "create_skill",
    groups: ["skills"],
    example: '{"action":"create_skill","args":{"name":"my-workflow","description":"When to use it","body":"instructions","enable":true}}',
    description: "Create a project skill under .cie/skills.",
    whenToUse: "Use when a repeatable workflow should become a reusable capability.",
    permission: "write",
    note: "creates .cie/skills/<name>/SKILL.md",
    args: { required: [["name"], ["description"], ["body"]], types: { name: "string", body: "string" } },
  },
  {
    action: "run_skill_script",
    groups: ["skills", "command"],
    example: '{"action":"run_skill_script","args":{"skill":"code-review","path":"scripts/check.py","args":[]}}',
    description: "Run one listed skill script with approval.",
    whenToUse: "Use only when a skill explicitly requires its script and the user approves.",
    permission: "command",
    note: "runs one listed skill script; requires user approval",
    args: { required: [["skill"], ["path"]], types: { skill: "string", path: "string" } },
  },
  {
    action: "git_commit",
    groups: ["git"],
    example: '{"action":"git_commit","args":{"message":"feat: change","stageAll":true}}',
    description: "Stage and commit changes.",
    whenToUse: "Use only when the user explicitly asks to commit.",
    permission: "write",
    note: "stages and commits; never pushes",
    args: { required: [["message"]], types: { message: "string" } },
  },
  {
    action: "http_request",
    groups: ["web"],
    example: '{"action":"http_request","args":{"method":"POST","url":"https://api.example.com/items","headers":{"Content-Type":"application/json"},"body":"{\\"name\\":\\"demo\\"}"}}',
    description: "Make an explicit HTTP request with approval.",
    whenToUse: "Use only when the user requests an API call or upload.",
    permission: "command",
    note: "explicit network request; requires approval",
    args: { required: [["url"]], types: { url: "string", method: "string" } },
  },
  {
    action: "git_push",
    groups: ["git"],
    example: '{"action":"git_push","args":{"remote":"origin","branch":"main","setUpstream":true}}',
    description: "Push commits to a remote.",
    whenToUse: "Use only when the user explicitly asks to push.",
    permission: "write",
    destructive: true,
    args: { required: [["remote", "branch"]] },
  },
  {
    action: "git_create_branch",
    groups: ["git"],
    example: '{"action":"git_create_branch","args":{"name":"feature/x","checkout":true}}',
    description: "Create and optionally check out a branch.",
    whenToUse: "Use when the user asks for a feature branch.",
    permission: "write",
    args: { required: [["name"]], types: { name: "string" } },
  },
  {
    action: "git_remote",
    groups: ["git"],
    example: '{"action":"git_remote","args":{"name":"origin","url":"git@github.com:owner/repo.git"}}',
    description: "Add or update a Git remote.",
    whenToUse: "Use only when the user asks to configure a remote.",
    permission: "write",
  },
  {
    action: "compress_video",
    groups: ["media"],
    example: '{"action":"compress_video","args":{"path":"assets/demo.mp4","maxWidth":1280,"crf":28,"preset":"medium"}}',
    description: "Compress a video with ffmpeg.",
    whenToUse: "Use when the user asks to shrink a video asset.",
    permission: "command",
    args: { required: [["path", "file", "filePath", "target", "filename"]], types: { path: "string" } },
  },
  {
    action: "convert_document",
    groups: ["document"],
    example: '{"action":"convert_document","args":{"path":"docs/spec.pdf","outputPath":"notes/spec.md","format":"md"}}',
    description: "Convert a document to another format.",
    whenToUse: "Use when the user asks for a converted document.",
    permission: "write",
    args: { required: [["path", "file", "filePath", "target"], ["outputPath", "to"]], types: { path: "string", outputPath: "string" } },
  },
  {
    action: "transform_image",
    groups: ["document"],
    example: '{"action":"transform_image","args":{"path":"assets/photo.jpg","outputPath":"assets/photo-small.jpg","maxDimension":1200,"format":"jpeg","quality":82}}',
    description: "Resize/convert an image.",
    whenToUse: "Use when the user asks for an optimized image asset.",
    permission: "write",
    args: { required: [["path", "file", "filePath", "target"], ["outputPath", "to"]], types: { path: "string", outputPath: "string" } },
  },
  {
    action: "search_skills",
    groups: ["skills"],
    example: '{"action":"search_skills","args":{"query":"ui design"}}',
    description: "Search the public skills.sh catalog for installable skills.",
    whenToUse: "Use when the user asks for a skill or a capability is missing; preview and install only with explicit approval.",
    args: { required: [["query"]], types: { query: "string", owner: "string", limit: "number" } },
  },
  {
    action: "install_skill",
    groups: ["skills"],
    example: '{"action":"install_skill","args":{"source":"owner/repo","ref":"main","skills":["skill-folder"],"scope":"project","enable":true}}',
    description: "Install skill packs from GitHub or a local folder.",
    whenToUse: "Use when the user asks to add a reusable capability.",
    permission: "write",
    note: "install SKILL.md packs; scripts are never executed",
    args: { required: [["source"]], types: { source: "string", skills: "array" } },
  },
  {
    action: "set_skill_enabled",
    groups: ["skills"],
    example: '{"action":"set_skill_enabled","args":{"key":"project:project-cie:my-skill","enabled":true}}',
    description: "Enable or disable a skill.",
    whenToUse: "Use when a capability should be available/removed for later runs.",
    permission: "write",
    args: { required: [["key"], ["enabled"]], types: { key: "string", enabled: "boolean" } },
  },
  {
    action: "remove_skill",
    groups: ["skills"],
    example: '{"action":"remove_skill","args":{"key":"project:project-cie:my-skill"}}',
    description: "Remove an installed skill.",
    whenToUse: "Use only when the user explicitly asks to remove a skill.",
    permission: "write",
    destructive: true,
    args: { required: [["key"]], types: { key: "string" } },
  },
  {
    action: "boot_mobile_device",
    groups: ["mobile"],
    example: '{"action":"boot_mobile_device","args":{"platform":"ios","id":"SIMULATOR-UDID"}}',
    description: "Boot a simulator/emulator.",
    whenToUse: "Use before mobile automation.",
    permission: "command",
  },
  {
    action: "mobile_screenshot",
    groups: ["mobile"],
    example: '{"action":"mobile_screenshot","args":{"platform":"ios","id":"SIMULATOR-UDID"}}',
    description: "Capture a mobile device screenshot.",
    whenToUse: "Use to verify a mobile screen.",
    permission: "command",
  },
  {
    action: "open_mobile_url",
    groups: ["mobile"],
    example: '{"action":"open_mobile_url","args":{"platform":"android","id":"emulator-5554","url":"http://localhost:8081"}}',
    description: "Open a URL on a mobile device.",
    whenToUse: "Use to launch a web/dev build on a device.",
    permission: "command",
  },
  {
    action: "mobile_logs",
    groups: ["mobile"],
    example: '{"action":"mobile_logs","args":{"platform":"android","id":"emulator-5554","limit":200}}',
    description: "Read mobile device logs.",
    whenToUse: "Use when debugging a mobile app.",
    permission: "command",
  },
  {
    action: "install_mobile_app",
    groups: ["mobile"],
    example: '{"action":"install_mobile_app","args":{"platform":"android","id":"emulator-5554","path":"build/app.apk"}}',
    description: "Install a mobile app build.",
    whenToUse: "Use after building the app.",
    permission: "command",
  },
  {
    action: "launch_mobile_app",
    groups: ["mobile"],
    example: '{"action":"launch_mobile_app","args":{"platform":"android","id":"emulator-5554","target":"com.example.app"}}',
    description: "Launch an installed mobile app.",
    whenToUse: "Use after installing the app.",
    permission: "command",
  },
  {
    action: "mobile_check",
    groups: ["mobile"],
    example: '{"action":"mobile_check","args":{"platform":"android","id":"emulator-5554","boot":true,"screenshot":true,"logs":true,"openUrl":"http://localhost:8081"}}',
    description: "One-shot boot/open/screenshot/log mobile check.",
    whenToUse: "Use for a compact mobile smoke test.",
    permission: "command",
  },
  {
    action: "install_toolchain",
    groups: ["tools"],
    example: '{"action":"install_toolchain","args":{"id":"godot"}}',
    description: "Install a development toolchain with approval.",
    whenToUse: "Use only when the user asks to install a missing tool.",
    permission: "command",
    note: "brew/snap/choco install; requires user approval",
    args: { required: [["id"]], types: { id: "string" } },
  },
];

const BY_ACTION = new Map(TOOL_SPECS.map((spec) => [spec.action, spec]));

export const FINISH_TOOL_SPEC: AgentToolSpec = {
  action: "finish",
  groups: ["core"],
  example: '{"action":"finish","args":{"summary":"final answer, plan, or change summary"}}',
  description: "Finish and return the final answer/change summary.",
  whenToUse: "Use as soon as the requested work is actually complete and evidenced.",
};

export function toolSpec(action: string): AgentToolSpec | undefined {
  if (action === "finish") return FINISH_TOOL_SPEC;
  return BY_ACTION.get(action);
}

export function toolGroupsFor(action: string): AgentToolGroup[] {
  return toolSpec(action)?.groups ?? ["core"];
}

export function allToolSpecs(): AgentToolSpec[] {
  return [...TOOL_SPECS, FINISH_TOOL_SPEC];
}

function validateJsonSchema(
  value: unknown,
  schema: JsonSchema,
  label: string,
): string | null {
  if (schema.enum && !schema.enum.includes(value as string | number | boolean)) {
    return `${label} must be one of: ${schema.enum.join(", ")}.`;
  }
  if (schema.anyOf && schema.anyOf.length > 0) {
    const match = schema.anyOf.some((candidate) => validateJsonSchema(value, candidate, label) === null);
    if (!match) return `${label} does not match any allowed shape.`;
  }
  if (schema.type) {
    const actual = Array.isArray(value) ? "array" : typeof value;
    if (schema.type === "integer") {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return `${label} must be an integer.`;
      }
    } else if (actual !== schema.type) {
      return `${label} must be ${schema.type}, got ${actual}.`;
    }
  }
  if (
    (schema.type === "object" || schema.required || schema.properties) &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (record[key] === undefined || record[key] === null || record[key] === "") {
        return `${label} requires ${key}.`;
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (record[key] === undefined) continue;
      const error = validateJsonSchema(record[key], child, `${label}.${key}`);
      if (error) return error;
    }
  }
  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    for (let index = 0; index < value.length; index += 1) {
      const error = validateJsonSchema(value[index], schema.items, `${label}[${index}]`);
      if (error) return error;
    }
  }
  return null;
}

export function validateToolArgs(
  action: string,
  args: Record<string, unknown>,
): string | null {
  const spec = toolSpec(action);
  if (spec?.inputSchema) {
    return validateJsonSchema(args, spec.inputSchema, action);
  }
  const schema = spec?.args;
  if (!schema) return null;
  // Deleting a snippet is a valid replace with an empty replacement.
  const allowEmpty =
    action === "replace_in_file"
      ? new Set([
          "replace",
          "replacement",
          "new",
          "newText",
          "new_string",
          "newString",
          "to",
          "with",
        ])
      : new Set<string>();
  for (const aliases of schema.required ?? []) {
    const present = aliases.some((key) => {
      const value = args[key];
      if (value === undefined || value === null) return false;
      if (value === "" && !allowEmpty.has(key)) return false;
      return true;
    });
    if (!present) {
      return `${action} requires one of: ${aliases.join(", ")}.`;
    }
  }
  for (const [key, kind] of Object.entries(schema.types ?? {})) {
    const value = args[key];
    if (value === undefined || value === null) continue;
    const actual = Array.isArray(value) ? "array" : typeof value;
    if (actual !== kind) {
      return `${action} expects ${key} to be ${kind}, got ${actual}.`;
    }
  }
  return null;
}

export interface ProjectToolHint {
  name: string;
  command: string;
  description?: string;
  whenToUse?: string;
  inputSchema?: { required?: string[]; properties?: Record<string, unknown> };
}

const TOOL_ALIASES: Record<string, string[]> = {
  browser_check: [
    "site", "website", "sayfa", "page", "incele", "inspect", "audit", "denetle",
    "ui", "arayüz", "arayuz", "ekran", "button", "buton", "test", "doğrula",
    "dogrula", "verify", "login", "giriş", "giris", "form",
  ],
  run_test_scenario: ["test", "senaryo", "scenario", "doğrula", "dogrula", "verify", "site", "incele"],
  game_check: ["oyun", "game", "canvas"],
  run_command: ["çalıştır", "calistir", "run", "start", "başlat", "baslat", "test", "build", "server", "sunucu"],
  create_document: ["excel", "xlsx", "csv", "rapor", "report", "docx", "pdf", "belge", "document", "spreadsheet"],
  project_search: ["hata", "error", "nerede", "where", "ara", "search", "bul", "find"],
  find_in_file: ["hata", "error", "nerede", "where", "dosya", "file", "oku", "read"],
  read_file: ["oku", "read", "dosya", "file", "kod", "source"],
  extract_entities: ["buton", "button", "listele", "list", "say", "count", "renk", "color", "route", "input"],
  audit_content: ["asset", "link", "markdown", "içerik", "icerik", "content", "audit", "denetle"],
};

const SUGGESTION_STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "your", "please",
  "bir", "bu", "şu", "ile", "için", "olan", "ve", "veya", "gibi", "daha", "çok",
  "the", "a", "an", "to", "of", "in", "on", "it", "is", "are", "be", "do", "does",
]);

export function suggestToolsForInstruction(
  instruction: string,
  groups?: readonly AgentToolGroup[],
  limit = 8,
): string[] {
  const allowed = groups ? new Set(groups) : null;
  const tokens = [
    ...new Set(
      instruction
        .toLowerCase()
        .match(/[a-z0-9çğıöşü_]{3,}/g) ?? [],
    ),
  ].filter((token) => !SUGGESTION_STOPWORDS.has(token));
  if (tokens.length === 0 && !allowed) return [];
  const lowerInstruction = instruction.toLowerCase();
  const scored: { action: string; score: number; seed: number }[] = [];
  const seeds = ["project_search", "read_file", "find_in_file"];
  for (const spec of TOOL_SPECS) {
    if (allowed && !spec.groups.some((group) => group === "core" || allowed.has(group))) {
      continue;
    }
    const haystack = `${spec.action} ${spec.description} ${spec.whenToUse} ${spec.groups.join(" ")}`.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (spec.action.includes(token)) score += 6;
      if (haystack.includes(token)) score += 2;
      if (token.length > 4 && haystack.includes(token.slice(0, token.length - 1))) score += 1;
    }
    for (const alias of TOOL_ALIASES[spec.action] ?? []) {
      if (lowerInstruction.includes(alias)) score += 5;
    }
    if (score > 0) {
      scored.push({ action: spec.action, score, seed: seeds.includes(spec.action) ? 1 : 0 });
    }
  }
  const picked = scored
    .sort((a, b) => b.score - a.score || b.seed - a.seed)
    .slice(0, Math.max(1, limit))
    .map((entry) => entry.action);
  if (picked.length === 0) return allowed ? [] : seeds.slice(0, 2);
  return picked;
}

export function renderAgentToolCatalog(
  readOnly: boolean,
  writeApproved: boolean,
  commandsApproved: boolean,
  groups?: readonly AgentToolGroup[],
  projectTools?: ProjectToolHint[],
): string {
  const allowed = groups ? new Set(groups) : null;
  const approval = (spec: AgentToolSpec): string => {
    if (spec.destructive) return "  // always requires confirmation";
    if (spec.permission === "write" && !writeApproved) return "  // requires user approval";
    if (spec.permission === "command" && !commandsApproved) return "  // requires user approval";
    return "";
  };
  const lines: string[] = [];
  for (const spec of TOOL_SPECS) {
    const readOnlyNotes = readOnly && spec.action === "save_note" && allowed?.has("notes");
    if (readOnly && spec.permission && !readOnlyNotes) continue;
    if (readOnly && spec.writeModeOnly) continue;
    if (allowed) {
      const permitted = spec.groups.some((group) => group === "core" || allowed.has(group));
      if (!permitted) continue;
    }
    if (spec.writeModeOnly && readOnly) continue;
    const suffix = spec.note ? `  // ${spec.note}` : "";
    for (const example of [spec.example, ...(spec.extraExamples ?? [])]) {
      lines.push(`- ${example}${readOnlyNotes ? "" : approval(spec)}${suffix}`);
    }
  }
  if (!readOnly && projectTools && projectTools.length > 0) {
    const commandAllowed =
      !allowed || allowed.has("command") || allowed.has("core");
    if (commandAllowed) {
      lines.push("Saved project tools (run with run_project_tool):");
      for (const tool of projectTools.slice(0, 20)) {
        const labelParts = [tool.description || tool.command, tool.whenToUse]
          .filter(Boolean)
          .map((value) => String(value).replace(/\s+/g, " ").slice(0, 140));
        const required = tool.inputSchema?.required?.filter(Boolean) ?? [];
        const label = [
          ...labelParts,
          required.length > 0 ? `input required: ${required.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join(" · ");
        lines.push(
          `- {"action":"run_project_tool","args":{"name":"${tool.name}"}}  // ${label}`,
        );
      }
    }
  }
  lines.push(`- ${FINISH_TOOL_SPEC.example}`);
  return lines.join("\n");
}
