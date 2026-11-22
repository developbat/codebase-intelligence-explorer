<p align="center">
  <img src="web/public/cbe.png" alt="Codebase Intelligence Explorer logo" width="104" height="104" />
</p>

<h1 align="center">Codebase Intelligence Explorer</h1>

<p align="center">
  <strong>Read-only code intelligence for TypeScript/JavaScript, PHP, and Python — plus a write-enabled Code Studio with a real editor, command runner, AI edits, and explicit save/backup workflow.</strong>
</p>

https://github.com/user-attachments/assets/829e9909-0953-4df4-bc12-10c14cf7dcc6

<p align="center">
  <a href="https://github.com/developbat/codebase-intelligence-explorer/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/developbat/codebase-intelligence-explorer/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://www.typescriptlang.org/"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white" /></a>
  <a href="https://react.dev/"><img alt="React" src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black" /></a>
  <a href="https://nodejs.org/"><img alt="Node" src="https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white" /></a>
  <a href="https://vitejs.dev/"><img alt="Vite" src="https://img.shields.io/badge/Vite-5-646CFF?logo=vite&logoColor=white" /></a>
  <a href="https://threejs.org/"><img alt="Three.js" src="https://img.shields.io/badge/Three.js-0.170-000000?logo=three.js&logoColor=white" /></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
</p>

<p align="center">
  <a href="#2-quick-start">Quick start</a> ·
  <a href="#1-what-is-in-the-product">Features</a> ·
  <a href="#4-architecture">Architecture</a> ·
  <a href="#5-api">API</a> ·
  <a href="#9-tests">Tests</a>
</p>

> **Two products, one local project.** **Intelligence** is read-only by design. **Code Studio** writes only after an explicit **Save** or **Apply & save**, keeps local backups, and never runs commands automatically.

The UI is **English by default** and ships with Turkish, German, French, Spanish, Portuguese, Russian, Chinese, and Japanese. AI answers follow the selected UI language.

---

## 1. What is in the product?

### Static analysis engine

- **Read-only scanning:** source files are read; the analysis engine has no write, delete, move, or execute path.
- **TypeScript Compiler API:** real AST, symbols, types, imports, and call resolution for TypeScript and JavaScript.
- **PHP and Python parser layer:** Lezer-based parsing for classes, interfaces, traits, enums, functions, methods, imports, calls, and framework routes without requiring a PHP or Python runtime.
- **File-level language coverage:** 100+ source, config and documentation extensions — including Go, Rust, Java, Kotlin, C#, F#, VB, C/C++, Objective-C, Ruby, Swift, Scala, Dart, Elixir, Erlang, Clojure, Haskell, OCaml, Perl, Julia, Crystal, Nim, Zig, Solidity, Lua, R, PowerShell, shell, SQL, Vue, Svelte, Astro, HTML/CSS, GraphQL, Protobuf, JSON, YAML, TOML, XML, Markdown and Dockerfile/Makefile — appear in the file map and Git impact views with a real language label. TS/JS use the TypeScript AST, PHP/Python use Lezer, and the remaining code languages use a lightweight symbol parser with basic inferred call edges.
- **Static HTML site analysis:** HTML pages become static GET routes; page title, description, headings, script/style imports, and page-to-page links are extracted. Framework detection reports **Static HTML**.
- **Symbol extraction:** functions, methods, classes, interfaces, type aliases, enums, arrow functions, nested functions, and CommonJS exports.
- **Knowledge graph:** files, folders, classes, functions, routes, database objects, events, packages, and their relationships.
- **Evidence and certainty:** every relationship carries source evidence and is marked `confirmed`, `inferred`, or `unresolved`.
- **Low-noise unresolved handling:** JS/TS builtins, TypeScript utility types, external package declarations, and local runtime values such as state setters do not create false unresolved nodes. PHP/Python resolution is syntax-based, so unresolved-node noise is suppressed there.
- **Call-site inspection:** a genuine unresolved target lists the source locations that produced it, shows a surrounding preview, and can jump to the caller.
- **Project profile without AI:** detects the stack, file/symbol/function/route counts, likely entry points, largest modules, and sample routes directly from the scan.

### Framework and architecture adapters (MVP 2)

- **Routes**
  - Express / Fastify / Koa / Hono style `app.get("/path", handler)`
  - NestJS `@Controller`, `@Get`, `@Post`, `@Put`, `@Patch`, `@Delete`, `@All`
  - Next.js Pages API, App Router `route.ts`, and `page.tsx` file-system routes
  - Laravel `Route::get(...)` and custom router `$router->get(...)` registrations
  - Flask `@app.route(...)`, FastAPI `@app.get(...)` / `@router.post(...)`
- **Databases**
  - Prisma `schema.prisma` models, `@@map`, and model relations
  - TypeORM `@Entity` and Sequelize `@Table`
  - Prisma-style client calls (`prisma.order.findMany()`)
  - Raw SQL reads/writes (`SELECT`, `INSERT`, `UPDATE`, `DELETE`)
- **Events**
  - `emit` / `publish` and `on` / `subscribe` style calls
  - NestJS `@OnEvent` and `@EventPattern`
- **Architecture view:** routes → controllers → services, database access, model relations, and events.
- **Framework detection:** Next.js, NestJS, Express, Fastify, Koa, Hono, React, Vue, Svelte, Prisma, TypeORM, Sequelize, Drizzle, Vitest, Jest, Laravel, Symfony, WordPress, CodeIgniter, Flask, FastAPI, Django, SQLAlchemy, Celery, and Pydantic. Manifest and marker-file heuristics also recognize Laravel, Symfony, WordPress, Django, and Python web layouts without a `.json` manifest.

### Git change intelligence

- Branch, HEAD, subject, dirty state captured at analysis time.
- **Last commit and recent history:** the Changes view always shows the current branch, shortened HEAD, last commit subject/author/date, and the most recent commits—even when the working tree is clean.
- **Commit graph:** a Git-style commit tree with branch/merge lanes, paginated 20 commits at a time. **Load older commits** walks backwards through history without loading everything at once.
- **Commit detail:** click a commit to inspect its metadata, file/line totals, changed files, per-file diff, and impact on the current analyzed graph.
- **Changed-file tree:** commit details rebuild the project folder hierarchy for that commit, with added/modified/deleted/renamed markers.
- **Show on map:** highlight all changed files from a commit, or a single file, directly on the 2D map. Changed nodes show an accent badge until the highlight is cleared.
- Changes since analysis: working tree, commits since the saved HEAD, and only files whose content really changed.
- Unified diff viewer, including synthetic diffs for untracked files.
- Structural diff: added, removed, and changed symbols and edge counts per file.
- Impact analysis: direct/transitive callers, importers, affected routes, and related tests.
- Change graph and changed-file strip.
- **Read-only Git usage:** only `status`, `diff`, `log`, `show`, `rev-parse`, and `rev-list`. No checkout, commit, reset, or write command.

### Optional AI layer (MVP 3)

- **Providers:** OpenAI, Anthropic Claude, DeepSeek, OpenRouter, Google Gemini, NVIDIA NIM, xAI Grok, plus any number of **named custom OpenAI-compatible providers**. For a custom provider you enter a name, base URL (or the full `/chat/completions` URL), API key, model ids, and an optional model-list URL. Keys are stored locally in a 0600 file.
- **Model settings:** API key, base URL, model, test connection, fetch model list, default provider/model.
- **AI symbol analysis:** purpose, business steps, inputs, outputs, side effects, risks, uncertainties, and evidence.
- **AI scope summaries:** file, folder, and package responsibilities/dependencies.
- **AI project summary:** plain-language architecture narrative, key flows, entry points, and architectural risks.
- **AI business flows:** discovers end-to-end flows by following routes, calls, database access, and events.
- **AI change review:** severity, category, file/line, description, and suggested fix from the real Git diff.
- **AI codebase chat:** graph-guided Q&A with source evidence.
- **AI unresolved-target classification:** builtin, external package, dynamic dispatch, callback, string-based registration, or missed local function.
- **Language-aware answers:** every AI flow uses the selected UI language.
- **Language parsing boundary:** generic-language symbols and call edges are structural (regex/brace/indent based) and not semantically type-resolved. TS/JS use the TypeScript AST; PHP/Python use Lezer. Generic assets are served by the preview server but binary files are not added to the text index.
- **Honest boundaries:** AI output is labeled as interpretation, cached by provider/model/source hash/language, and kept visually separate from static facts.
- **Local key handling:** keys are stored in `~/.codebase-intelligence-explorer/ai-settings.json` with `0600` permissions and are never returned to the browser.
- **Token visibility:** AI panels show context size and estimated input tokens.

### Search and scale (MVP 4)

- **Local vector search:** TF-IDF sparse vectors over symbols, files, routes, database objects, and events; cosine similarity ranking. The index is cached per analysis fingerprint.
- **Semantic sidebar matches:** result score, snippet, and direct navigation.
- **File watcher:** starts when the UI opens a project. Changes are debounced, re-analyzed in the background, saved, and announced over SSE. The UI shows a “Reload analysis” banner.
- **Hash-based reuse:** unchanged files and AI caches remain valid after a change.
- **Function clustering:** group functions by file for large call graphs and drill into a file.

### 3D Explorer (MVP 5)

- **Three.js + React Three Fiber** scene, lazy-loaded as a separate chunk.
- Same node/edge identities as 2D, search, Git impact, and the inspector.
- **Four layout algorithms:** Hybrid (default), Hierarchical, Clustered, and Force-directed.
- **Hybrid layout:** the project sits on a central layered platform; top-level modules become architectural platform blocks arranged around it; nested folders become smaller blocks, files become glass cards, and functions become small components attached to their file.
- **Hierarchical layout:** project → module → folder → file → function levels descend in 3D space.
- **Clustered layout:** modules are grouped as architectural blocks with their files arranged flat on each platform.
- **Force-directed layout:** a local 3D force simulation for exploring call and dependency networks (220-node focused subset).
- **Zoom-based LOD:** the scene starts with modules only and reveals folders, files, and functions as you zoom in. Selecting a node also reveals its next layer.
- **Edge semantics:** imports, calls, routes, and data flows keep their certainty styling; selecting a node distinguishes outgoing calls (turquoise), incoming calls (orange), unresolved links (dashed), and dims unrelated nodes.
- **Flow-first labels:** by default only the selected node and its flow neighbors show labels. A **Labels → All labels** toggle reveals every label when you want the full map. The label control stays outside the layout popover so it is never covered.
- **Collapsible layout menu:** the layout selector appears large when 3D opens, then collapses into a compact **Layout: Hybrid** button. Click it to reopen the four layout choices.
- **Right-side navigation pad:** smoothly animated free movement — forward/back along the current view direction, strafe left/right, vertical up/down, zoom in/out, and camera reset. Movement always starts from the current camera position, even after orbiting with the mouse.
- **Interaction-only animation:** a larger, high-contrast light packet travels along selected call edges. There is no ambient flashing or constant scene motion.
- **Technical workspace:** no stars. A subtle perspective grid, translucent module platforms, neon selection outlines, low ambient light, and distance-faded links replace the space background.
- **Consistent palette:** project, module/folder, file, function, route, database, and event colors follow the fixed UI palette; certainty is communicated through line style, not node color.
- **Performance:** full-project graph capped at 1,000 nodes / 3,000 edges; visible layers are filtered by LOD, edges are aggregated to visible ancestors, and the Force layout uses a focused 220-node subset.
- **Stay in 3D:** clicking a node selects it and reveals its next layer without switching to 2D. Use the explicit **Open selected item in 2D** button when you want to leave the 3D scene.
- Orbit, pan, zoom, click-to-inspect.
- Labels show the entity name only; type is conveyed by color, shape, the legend, and the inspector.
- The sidebar button toggles between **3D** and **2D** in place.
- Legend, layered HUD, and inspector integration.

### Data and business flows

- **Data flow explorer (static):** starting from a route or function, follows `ROUTES_TO`, `CALLS`, `READS_FROM`, `WRITES_TO`, and event edges forward through the graph. Default depth is 2, adjustable to 1–3. Steps carry `F1`/`F2`/`F3` badges, and the subtitle reports calls, reads, writes, and events. The view is explicitly labeled as a static estimate and capped at 260 nodes.
- **Business flow explorer (AI):** the AI layer follows real routes, controllers, services, database access, and events, then returns flows with steps, confidence, risks, and source file/line links. Results are cached and clearly labeled as AI interpretation rather than static proof.
- **One Flows view:** switch between **Data flow** and **Business flow** from the toolbar without leaving the view.

### Focus, impact, and dependency heatmap

- **Focus mode:** select any function, class, file, folder, or route and focus on it; the map shows the selected node, its parent context, and its 1–3 step neighborhood. **Exit focus** restores the normal view.
- **Impact analysis:** a dedicated view traverses reverse calls, imports, routes, and data relationships. Impact depth is configurable (1–3), impacted nodes carry `D1`/`D2`/`D3` badges, and the view is capped at 350 nodes for performance.
- **Dependency heatmap:** ranks the top 180 structural hotspots by weighted call, import, route, and data relationships. Node color runs from blue (cold) to red (hot), with a heat-score badge and a cold→hot legend. This is structural degree, not runtime performance.
- **Graph-wide depth controls:** focus and impact views share a compact depth selector in the toolbar.

### Code Studio (write-enabled)

- **Two products, one project session:** switch between **Intelligence** (read-only analysis) and **Code Studio** from the topbar without reopening the project.
- **Real code editor:** CodeMirror 6 with deep support for TS/JS, Python and PHP, plus syntax modes for 50+ more languages and formats. Tabs, folding, bracket matching and autocomplete.
- **Explicit save model:** no autosave. Every save writes through a path-validated server endpoint and creates a timestamped backup under `~/.codebase-intelligence-explorer/editor-backups/`.
- **Command runner:** run user-entered commands in the project root, with quick commands for `npm test`, `pytest`, `php artisan test`, and PHPUnit. Output streams live over NDJSON, commands can run for up to 10 minutes, and a Stop button cancels the process. Exit code, duration, timeout, and truncation are returned.
- **AI single-file edit:** select a file, describe the change, and review the generated line diff before **Apply & save** or **Discard**. Small files use full-file replacement; files above 24 KB use surgical find/replace edits. Hard limit is 120 KB. No automatic apply.
- **Code model picker:** every configured provider/key, including named custom providers, is available in Code Studio. Pick a provider, type a model id, fetch the provider model list, or open AI settings to add keys/models. The choice is stored locally for Code Studio.
- **Resizable three-column studio:** the project tree, editor, and preview panel can be resized with drag handles. Left and center keep minimum widths; the preview can grow up to 80% of the workspace. Widths persist locally.
- **Persistent project index:** a local MiniSearch index stores file contents, symbols, routes, project metadata, README/manifests, and past conversations. It is built automatically after analysis and reused across restarts.
- **Incremental index:** saves update the file document immediately; renames/deletes update the index; external file changes trigger a debounced re-analysis and index rebuild while the project watcher is connected.
- **Index status:** the header shows Indexed / Indexing / Build index. If the index is missing or stale, a banner offers a one-click build.
- **Index search:** a Search modal searches file contents, symbols and past answers, with line numbers and match-centered snippets.
- **Conversation memory:** finished agent/chat answers are recorded per project; existing local chat history is imported once, so repeated questions can reuse earlier answers.
- **Markdown answers:** assistant answers render headings, lists, tables, code blocks, links and blockquotes instead of raw `**`/`###` text.
- **Collapsible details:** each answer keeps only the result visible; the full trace log, steps, file evidence and token breakdown live under a single collapsed **Details** control.
- **Streaming agent responses:** OpenAI-compatible providers stream tokens into the live trace, so the activity card shows received characters while the model is still generating.
- **Provider diagnostics:** empty completions include the provider finish reason; reasoning-only responses fall back to `reasoning_content`. A retired model (HTTP 410 / end of life) stops immediately and offers Switch model without a pointless retry. Failed runs auto-open Details.
- **Live agent trace:** while the agent works, the activity card animates the current phase and streams a live log: model thinking, plan received, file tree scan, search, file read, match count, JSON inspection, tool completion and result evaluation.
- **Center agent workspace:** one input drives the agent. The center column shows the full workflow history: prompts, tool calls, command output, file edits, evidence, and the final answer. A live activity card above the input animates what the agent is doing right now (understanding, listing, reading, searching, counting, inspecting JSON, editing, running a command, writing the answer).
- **Console drawer:** Terminal and Tests live in a collapsible console under the workflow, so the center stays focused on the task history.
- **Multiple terminals:** the Terminal tab supports any number of independent command tabs, each with its own command, live output, exit status and Stop button.
- **Interactive shell:** a real PTY shell (xterm.js + Python `pty.fork`) opens in the project root with stdin, Enter/arrow keys, Ctrl+C, ANSI colors, 5,000-line scrollback and live window resizing.
- **Command history and favorites:** the last 50 commands are stored per project. Use ↑/↓ in the command input, open the History panel to re-run a command, and star favorites for one-click reuse.
- **One-click dependencies:** when `node_modules`, `.venv` or `vendor` is missing, the Terminal shows an **Install dependencies** action that runs the detected npm/pnpm/yarn/bun, pip or Composer install in the background with live output.
- **Dev servers:** detected project commands (`npm run dev`, `php artisan serve`, `python3 manage.py runserver`, `bin/rails server`, `mix phx.server`, …) can be started in one click. Background jobs stream stdout/stderr, show PID/status/duration, expose detected local URLs as clickable links, and can be stopped or removed. Jobs and PTY sessions are cleaned up when the server stops.
- **Token budget:** every AI request records real provider token usage (with a character-based estimate when a provider omits the usage block). Each agent step shows its tokens, each finished answer shows a token badge, the composer shows the session total, and the **Settings → Usage** tab breaks usage down by model and day for the project (today, last 7 days, all time).
- **Prompt + send inputs:** the file-edit and project-task modes use a single input with a send button (Enter sends, Shift+Enter adds a line). There is no separate "generate" button.
- **Prompt manager:** edit all 16 system prompts (agent, edit, task, review, summary, tests, analysis, chat) from **Settings → Prompts**. Project overrides take precedence over global overrides; defaults stay untouched, with versioning, variable chips, token estimate, preview, **default diff**, **version history** (last 20, preserved across reset, restore into the editor) and reset. Prompt versions are part of AI cache keys.
- **Plan preview:** before the first tool call the agent emits a `plan` event with intent (question/explain/edit/multi-file/run/scaffold), risk, scope, write/command needs, verification command and a step checklist. The live plan card is open; the same plan is kept, collapsed, in the finished answer. It is informational — actual writes and commands still go through the permission handshake. If the user denies a permission, a new read-only fallback plan replaces it and the agent explains what was blocked.
- **Task queue / long-running agent:** a **Task loop** toggle turns a goal into a persistent ordered queue under `.cie/agent/` (`tasks.json`, `TASKS.md`, `context.md`). A planner model decomposes the goal, each task runs sequentially with the appropriate role/model, the agent verifies its work, and the loop continues until the queue is complete or you press Stop. The live **Task queue** card shows every task, model, result and verification command.
- **Research subagent:** `delegate_research` runs a read-only research agent for broad investigation and returns only a compact summary with evidence, keeping the main agent's context small.
- **Model health:** the agent records tool-protocol and empty-response failures per provider/model. **Auto-pick** and task fallback de-prioritize models with repeated protocol failures, so a bad fast model is not retried forever.
- **Agent roles:** **Settings → Agents** assigns separate providers/models to **main** (normal/hard coding), **planner** (task decomposition), **fast** (small mechanical work) and **reviewer**. **Auto-pick models** chooses roles from cached model lists; it does not hit the network every time.
- **Model catalog:** **Settings → Model catalog** imports a JSON model/agent catalog from a file, pasted JSON or a JSON URL (Aibender-style exports work; HTML pages are rejected). Models carry provider, context, input/output price, speed and role hints. Auto-pick and task fallback use the catalog roles/prices when available; import never installs API keys and never silently overwrites role choices.
- **Live dev preview:** running background dev servers expose local URLs as **Preview** tabs, so Vite, Expo web and game dev servers can be inspected inside the app instead of only in an external browser.
- **Cached model lists:** provider model lists are stored after an explicit **Update model list** action and reused across sessions. Model pickers are searchable, show the last update time, and auto-pick/role configuration works offline from the cache.
- **Agent-first workflow:** the agent runs an autonomous tool loop (`/ai/agent`): list files, search, read, find in file, count matches, inspect JSON, write, replace, run commands, and finish.
- **Agentic Q&A:** questions are answered by the same agent. It searches, reads, counts and inspects JSON instead of stopping when the preloaded context is incomplete. Steps stream live and the final answer cites files and lines.
- **No dead-end answers:** when the step limit is reached, the agent runs a final evidence-only synthesis call, so you get a grounded answer or a precise statement of what is missing.
- **Edits and multi-file tasks:** the unified agent handles both. The direct `/ai/edit` and `/ai/task` endpoints remain available for API clients that want a single review-first proposal.
- **Efficient agent loop:** model turns are counted separately from tool actions, so native multi-call replies execute all queued actions without burning extra turns. Repeated file reads and identical read-only tool calls return a short “already executed” note instead of doing the work again. The seed includes an index-derived edit map with existing pattern files and suggested service/controller paths. Small edits automatically use a focused fast profile.
- **Automatic typecheck gate:** before accepting `finish`, the agent runs the detected typecheck/build command (for example `npx tsc --noEmit`). It uses the permission handshake when commands are not pre-approved, caches the result for the current file signature so the check is not repeated, feeds failures back to the agent to fix, and writes the typecheck result into the final summary. A finish that still reports pending work is rejected while turns remain.
- **Tool-protocol recovery:** the agent understands its JSON action protocol plus `<tool_call>` and provider-native DSML blocks. Native multi-call replies are queued and executed in order. Tool-call markup is stripped from the transcript and can never leak into the final answer.
- **Games and mobile:** the **Canvas game** template creates a dependency-free HTML5 arcade game with score, timer, touch input and restart. The **Mobile PWA** template is installable, offline-capable and mobile-first. The **Expo mobile** template is React Native + Expo + TypeScript with `web`, `ios` and `android` scripts. Games/PWAs use the static preview and `browser_check`; Expo/React Native dev servers appear as live preview tabs.
- **Game check:** `game_check` detects Canvas/Phaser/Three.js, measures canvas size and FPS, runs interaction steps and writes a screenshot. The Checks panel exposes **Check game** next to **Inspect preview**.
- **Game engines:** **Canvas**, **Phaser 3** (score, timer, pointer input, restart), **Three.js** (responsive WebGL scene, lights, animation) and **Godot 4** (main scene, score, timer, pointer input, restart) templates. Phaser/Three/Vite templates typecheck and build; Godot is a structural project skeleton because the Godot runtime is not installed on this machine. `browser_check` can also target a running localhost dev URL, so Vite/Phaser/Three apps are tested against the real dev server.
- **Image preview:** SVG, PNG, JPEG, GIF, WebP and icon files open as rendered images in the right Preview panel instead of raw source.
- **Preview Inspector:** **Checks → Inspect preview** opens the project page in headless Chrome and reports page errors, console errors, resource errors, broken images, horizontal overflow, element counts and a screenshot. `browser_check` can also target a running localhost dev server URL. The `browser_check` agent tool runs fill/click/press/expect/reload/localStorage steps, so the agent can verify UI behavior instead of claiming it. It uses local Chrome/Chromium (set `CIE_CHROME_PATH` if auto-detection fails).
- **Toolchain management:** Settings → General → **Toolchains** detects Node, Python, PHP, Go, Rust, Xcode simctl, adb/emulator, CocoaPods, Flutter, Dart and Godot. Missing SDKs show a platform-specific install command; the panel and the agent (`check_toolchains` / `install_toolchain`) can run it with explicit approval.
- **Native tool-call recovery:** streaming providers that emit native `tool_calls` instead of JSON actions are converted back into the JSON action protocol, so the run does not fail and restart on another model.
- **Output continuation:** long chat answers and final agent summaries detect provider output-limit stops (`finish_reason`, `stop_reason`, `MAX_TOKENS`, or output tokens at the token budget), continue the answer with a “continue exactly where you stopped” call, merge overlapping chunks, and return one combined answer. Provider limits differ, so no per-model table is required. Task-loop task summaries are no longer sliced to 240/360 characters; the queue shows the full text in a scrollable area.
- **Visible model switching:** an automatic switch opens a clear modal with the old provider/model, the new provider/model and the reason. It does not reflow the chat. **Settings → General → Model behavior → Automatic model switching** controls it (on by default); when off, the run stops with a clear message.
- **Visible model switching:** when the loop switches models, the chat shows a persistent banner with the old and new provider/model and the reason, and the composer displays the effective model for that run. **Settings → General → Model behavior → Automatic model switching** controls this behavior (on by default); when off, the run stops with a clear message instead of switching.
- **Cheap fallback preference:** when a model is lost, alternate selection prefers flash/mini/free/deepseek/ling-style models before main/reviewer models, so later tasks do not inherit an expensive fallback.
- **Unavailable-model preflight:** a provider error such as HTTP 410 / end-of-life marks the model unavailable in model health and the task loop switches to a working fast/cheap model before executing the task. Model/protocol retries preserve the original task effort and role instead of upgrading simple work to a heavier standard run.
- **Task-loop safeguards:** plans prefer 1-3 tasks and no separate inspection task; inspection tasks can finish without edits and no longer fail on “next step” wording; failed tasks block their dependents instead of leaving them pending; standard/simple/hard runs are capped at 12/8/18 turns (inspection 6); after the final write warning, further read-only tools are rejected and two rejections stop the run; browser checks are capped at two per task; fallbacks prefer fast/cheap models instead of reviewer/planner models.
- **Composer attachment:** the paperclip button in the chat composer uploads PDF/Word/Excel/JSON/text/image files to `assets/` and adds the path to the next task. The composer textarea is larger, Console sits beside the session/model row, and the task-loop toggle was removed in favor of the clearer task queue badge (`1/1`).
- **Deterministic document stats:** attached documents are pre-extracted into the task context with line/word/heading/link and checked/unchecked checkbox counts, and `read_document` returns the same stats even when the text excerpt is truncated. This prevents “count” questions from depending on a model scanning a long file.
- **Document tools:** `read_document` extracts text from PDF (pdftotext, OCR fallback), Word/DOCX (textutil or XML), Excel XLS/XLSX (SheetJS), CSV, JSON, HTML and text, and runs OCR on images through tesseract. `search_document` searches extracted content with line snippets. `convert_document` writes the extracted content as text/Markdown/JSON/CSV, and `transform_image` resizes or converts images with `sips` without an AI call. Upload files from Code Studio → Files → the add-file button; they are stored under `assets/`.
- **HTTP requests:** `http_request` sends GET/POST/PUT/PATCH/DELETE with custom headers and a string/JSON body, returns status, selected headers and a bounded response body. External URLs are public-only; localhost is opt-in with `allowLocalhost` and an explicit approval.
- **Web research and notes:** `web_fetch` reads a public http(s) page with SSRF/private-host blocking, size/time limits and readable-text extraction. Research can be saved under `.cie/agent/notes` with `save_note`, then found again with `list_notes`, `read_note` and `search_notes`.
- **Reusable agent capabilities:** `create_project_tool` writes a JS/TS/Python/shell helper under `.cie/agent/tools`; `run_project_tool` runs it later. `create_skill` writes a project `SKILL.md` pack under `.cie/skills` and enables it, so workflows can be created and reused.
- **Git tools:** `git_info` (status/diff/log/branches/remotes), `git_commit` (stage + commit), `git_create_branch`, `git_remote` and `git_push` are available to the agent. Push always asks for a fresh confirmation.
- **Video compression:** `compress_video` uses ffmpeg/ffprobe to resize and re-encode a project video, reports before/after size and dimensions, and requires command approval. ffmpeg/ffprobe are in the toolchain inventory.
- **Model-based intent:** before planning, one small fast-model call reads the request in any language, including typos. It returns a compact intent object: restated goal, kind (edit/question/run/scaffold/analyze), scope (trivial/small/medium/large), execution mode (single task or task loop), likely project files, verification type and assumptions. If the request is genuinely ambiguous it asks a product/behavior question with concrete options — never “which files should I inspect?”. The intent probe costs roughly 1–1.5k tokens and prevents wrong multi-hundred-thousand-token runs.
- **Token discipline:** the small intent probe decides single vs loop and scope; a clarification request stops before any coding work. If an attempt burns its step limit without editing, the retry keeps the same model, switches to the fast profile and adds an edit-first note instead of paying for an alternate model. Agents get a write reminder after several read-only turns, a final-turn warning, and seeded context is capped. If an attempt burns its step limit without editing, the retry keeps the same model, switches to the fast profile and adds an edit-first note instead of paying for an alternate model. Task cards show per-task token usage.
- **Server-owned agent runs:** task loops and agent runs keep going when the browser disconnects (screen lock, sleep, reload). Live events are streamed while connected and the task queue is polled/refreshed afterward. The Stop button now calls a server stop endpoint instead of relying on a closed connection. A stopped/bocked queue exposes **Continue remaining tasks**, which retries blocked and pending work without replanning.
- **Model health thresholds:** protocol/empty failure limits and penalty weight are configurable in Settings → Agents.
- **Unified mobile check:** `mobile_check` selects a simulator/emulator, optionally boots it, captures a screenshot, reads logs and opens a URL in one tool. Sprite sheets also generate animation metadata JSON, and `placeholder_asset` supports looping music placeholders.
- **Mobile devices:** Settings → **Devices** shows iOS Simulator and Android emulator/device status via `xcrun`, `adb` and `emulator`; devices can be booted, screenshotted and logged from the panel. The agent can call `list_mobile_devices`, `boot_mobile_device`, `mobile_screenshot`, `open_mobile_url`, `mobile_logs` (logcat / simctl log), `install_mobile_app`, `launch_mobile_app` and the combined `mobile_check`.
- **Graphic verification:** `graphic_check` validates generated SVG/PNG graphics: dimensions, text labels, colors, shape counts and PNG pixel samples. It is read-only and available to the agent.
- **Graphics generation:** `create_graphic` produces deterministic **bar, line, pie, flow and illustration** graphics as SVG or PNG. Charts accept `{label,value}` data; flows accept ordered step labels. Generated images open directly in the Preview panel.
- **Placeholder assets:** `placeholder_asset` creates deterministic SVG or PNG icons, sprites, sprite sheets, backgrounds, buttons and splash images, plus looping music/sound WAV files. Sprite sheets also generate animation metadata JSON (`frameWidth`, `rows`, `fps`, `idle/walk/run/jump`).
- **Localized multi-edit:** `replace_many` applies several exact find/replace edits to one file with a single permission prompt and one write, avoiding full-file rewrites. Task history is also compacted into `.cie/agent/context-digest.md` for cheaper continuation.
- **Reusable project tools:** scripts under `.cie/agent/tools/` (JS, TS, Python, shell, PHP, Ruby) are auto-registered with an inferred command. The agent sees them in its seed and can call `list_project_tools` / `run_project_tool` to reuse a check instead of recreating it. The Checks panel lists saved tools with success/failure counts.
- **Agent tools:** list files, search file contents, read files, find inside a file, extract list items, count matches, inspect JSON paths and array lengths, **find symbols by name/kind across every supported language**, run read-only SQLite queries, inspect CSV/TSV data, read git blame, write or replace file contents, run build/test commands, and finish. For list requests the agent pre-extracts matching card/item names from the best index hit and enumerates them instead of returning only a count. Each tool call is shown with its observation, duration, and success state.
- **Agent seed context:** before the first step the agent receives ranked files, matching symbols with line numbers, route samples, uncommitted Git changes, and the active file.
- **Skills (P1):** **Settings → Skills** discovers `SKILL.md` packs from the project (`.cie/skills`, `.agents/skills`, `.claude/skills`, `.cursor/skills`) and global OpenCode/Claude/Cursor/agent folders. Preview the instructions, file list and script warnings, then enable a skill for this project. Only enabled skills are injected into the agent and chat system prompt, with project-over-global precedence and limits of 5 skills, 6,000 characters each and 20,000 total. Skill text is marked as untrusted reference data and the user request always wins; scripts are never executed. **Add from GitHub** installs `SKILL.md` packs from `owner/repo`, a GitHub URL or a local folder into project (`.cie/skills`) or global storage, writes a `skills-lock.json` registry with the source/ref/hash, and supports update and remove. Archive extraction strips the GitHub root folder, follows pax long paths, rejects path traversal, and never runs install scripts.
- **Top bar:** Settings and a green database index status live in the top bar. Project opening/switching lives in the left sidebar; New project and Rescan were removed from the top bar.
- **Settings memory:** Settings lists are cached in memory with stale-while-revalidate (toolchains 60s, devices 15s, skills/tools 30-60s, usage 15s, pricing 5min, model health 30s). Reopening Settings shows the last result immediately instead of rebuilding the list; manual **Refresh** bypasses the cache. Toolchain checks also have a 45s server cache (`?refresh=1` forces it), and the last open Settings tab is remembered in localStorage.
- **Settings screen:** one tabbed screen for **General** (language, project, toolchains, general approvals), **Devices** (simulators/emulators), **Models** (providers, cached model lists, connection checks), **Agents** (main/planner/fast/reviewer roles and auto-pick), **Model catalog** (JSON model/agent import), **Editor & tests** (format/syntax/typecheck on save, test timeout), **Usage** (token report), **Prompts** (prompt manager) and **Skills** (project/global skill discovery, preview, enable/disable, GitHub install/update/remove). The center workflow is reduced to Search, Settings and Console; permissions, model editing, usage and prompts no longer clutter the composer.
- **Agent permissions:** file writes and command execution have separate pre-approval checkboxes in **Settings → General → General approvals**. When a permission is not pre-approved, the agent pauses and asks **Allow once / Always allow / Deny** with the target, size and a short preview. “Always allow” approves that action type for the rest of the run and turns on the matching pre-approval toggle. Delete and rename always require a fresh confirmation and cannot be remembered. Writes create backups. Commands start in the project root and a destructive-command denylist blocks things like `sudo`, `git push`, `git reset --hard`, disk formatting, and `curl | sh`. The agent stops after 16 model turns (14 for the fast profile), 40 actions, 10 writes, or 5 commands.
- **Live streams:** agent steps and terminal stdout/stderr appear as they happen over NDJSON. Stop buttons abort the model request and terminate running commands.
- **Binary assets:** the project toolbar can upload images, icons, fonts and other binary files up to 15 MB under `assets/`. The preview server serves common image/font MIME types. Secret paths (`.env`, private keys, `.git`) are rejected.
- **Safe config templates:** New file offers `env.example`, `config.example.json`, `config.example.yaml` and `config.example.toml` templates. Real `.env` files, private keys and Git internals cannot be created or written from the editor.
- **Any-language editor:** syntax modes for TypeScript/JavaScript/JSX, PHP, Python, Go, Rust, Java, Kotlin, C#, F#, VB, C/C++, Objective-C, Ruby, Swift, Scala, Dart, shell, PowerShell, Lua, R, Julia, Perl, Haskell, OCaml, Elixir, Erlang, Clojure, Crystal, Nim, Zig, Solidity, Groovy, D, Fortran, Pascal, COBOL, Tcl, Verilog/VHDL, HTML, CSS/SCSS/Sass/Less/Stylus, SQL, JSON, XML, Markdown, YAML, TOML, HCL/Terraform, Nix, Protobuf, LaTeX, CMake, Dockerfile, Makefile and more. A **New file** button creates a file at any project-relative path; highlighting follows the extension.
- **New project wizard:** **New project → Create new** picks a parent folder, validates the project name and generates a runnable skeleton from thirteen templates: Static HTML, React + Vite (TypeScript), Node + Express (TypeScript), Python FastAPI, PHP, Blank, Canvas game, Phaser game, Three.js 3D scene, Godot 4 game, Mobile PWA, Expo mobile (React Native + TypeScript) and Flutter mobile (Dart). The project is analyzed immediately and opens in Code Studio. An optional starter brief is placed in the composer; you can press Send yourself or enable **Start the task loop automatically after creation** to plan and build the brief immediately.
- **Fast project switching:** the Code Studio sidebar includes the same project switcher as the Intelligence explorer, with recent projects, search, active marker, and removal.
- **Terminal working directory:** the Terminal panel shows the exact project root where commands run.
- **Sidebar:** the left panel has **Files**, **Chats** and **Details** tabs and can be closed completely; a **Files** button in the workspace header reopens it. Project Details shows the root, file/symbol/function/route totals, HTML/JS/CSS/PHP/Python inventory, frameworks, Git state, test discovery, full AI project summary, and rescan.
- **Collapsible tree:** the project tree can be collapsed to free space; a Files button reopens it.
- **Right code + preview panel:** the right column is a tabbed panel with **one Preview tab** plus open file tabs. Preview shows the selected HTML page through the read-only preview endpoint; when the project has no HTML page, it falls back to a read-only view of the active file. Clicking a file in the tree opens it as a code tab with CodeMirror, dirty marker, Save, and close.
- **Quality checks:** a Checks tab runs detected typecheck, lint, format-check, and build commands with live output and Stop. The optional “Format file on save”, “Run syntax check after save” and “Run typecheck after save” toggles live in **Settings → Editor & tests**.
- **Syntax check:** per-file syntax checking for JavaScript, Python, PHP, Ruby, shell, JSON, Go, Rust, C/C++, Objective-C, Lua, Perl, PowerShell, Zig, Solidity, XML, YAML, TOML, R, Nix and Elixir when the checker is installed; TypeScript/JSX and JVM/.NET files use the project typecheck/build check.
- **Code duplication scan:** a local 6-line window scanner reports duplicated blocks across the project, with occurrence counts, sample snippets and clickable file:line locations.
- **Format file:** the right-panel toolbar can format the active file through the project’s detected or configured formatter (Prettier, dprint, gofmt, rustfmt, black/ruff, php-cs-fixer, dart format, clang-format, mix format, scalafmt, rubocop/standardrb, zig fmt, crystal tool format, nixfmt, terraform fmt, cmake-format, ocamlformat, swift-format, taplo, buf) and refresh the editor. An optional **Format file on save** toggle formats the file immediately after saving and updates the editor to the formatted content.
- **File actions:** rename or move a file from the right-panel tab bar, and delete files with an explicit confirmation. Renaming creates parent folders; deleting is limited to files and empty directories.
- **Agent file tools:** the agent can rename/move (`rename_path`) and delete (`delete_file`) when write permission is enabled.
- **Unified input:** one composer replaces the old Ask/Edit/Task/Agent tabs; the legacy AI panel and mode-specific edit/task UI were removed. The agent decides whether the request is a question, an edit, a command, or a multi-file task, subject to the write/command permission handshake. Chat/workflow history is persisted per project in local storage.
- **Full project summary:** the project summary prompt now receives the complete route inventory, HTML page list, JavaScript/TypeScript list, CSS list, and file-type counts.
- **Shared project profile:** one detector reads root manifests and returns ecosystems, package managers, frameworks, test/build/lint/format commands, and manifests. The analyzer, project map, inspector, Code Studio details, AI briefs and the test runner all consume the same profile.
- **Test discovery and runner:** detects Vitest, Jest, Node test, Laravel, PHPUnit, Pytest, Go test, Cargo test, Maven, Gradle, dotnet test, RSpec, Minitest, Swift test, ExUnit, Dart/Flutter test, CTest, sbt, Cabal/Stack, Dune, prove, Julia, EUnit, Clojure, Crystal, Nimble, Zig, Forge/Hardhat, Busted, testthat, Pester, Bats, Deno, Bazel, Make and package.json scripts. Tests stream live output over NDJSON, run with a 2/5/10/20-minute timeout, can be stopped, list discovered test files, and parse passed/failed/skipped totals and failures. Clicking a failure opens the file and scrolls to the reported line, and **Fix failures with agent** sends the failure summary and output tail to the agent.
- **AI test generation:** generates a new test file for the active source file, shows the full file diff, and creates it only after **Create test file**. Existing paths are rejected.
- **Stale-analysis awareness:** after a save or AI apply, Code Studio marks the graph stale and offers a rescan.
- **Separate safety boundary:** Intelligence remains read-only. Code Studio writes only after an explicit user action and stays inside the project root.

### Project profile, full tree, and guided tour

- **Project profile:** the inspector opens with a non-AI overview: detected stack, counts, likely entry points, largest modules, and sample routes.
- **Full project tree by default:** every folder branch is expanded when a project opens. Expand-all and collapse-all buttons are always available.
- **Full-tree 2D view:** the Files view shows the complete folder/file hierarchy in one graph instead of only direct children. The toolbar toggles between **Full tree** and **Direct children**.
- **Up navigation:** in 2D, a back/up control in the topbar and toolbar walks from a file → its folder → parent folder → project universe. Breadcrumb parent links remain clickable.
- **Inspector back stack:** clicking a member or relationship inside the right inspector pushes the previous selection; the **Back** button in the inspector header returns to that exact earlier list/detail, including multi-level drill-down.
- **Guided tour:** the help button in the topbar starts a short tour through opening a project, view tabs, the tree, the graph, the inspector, Git changes, AI setup, and 3D.
- **Guided showcase / promo mode:** the **Demo** button runs an automated 75–90 second tour of the current project with English captions: project profile, tree, call graph, architecture, Git history, commit detail, map highlighting, 3D layouts, and saved-project switching. Pause, skip, exit, and replay controls are included. Screen recording is started externally.

### Project selection

- **Always-visible project switcher:** the active project sits at the top of the sidebar. Open the dropdown to filter and switch between saved analyses without scrolling through the project tree.
- **Home screen saved projects:** when no project is open, the home screen lists saved analyses as icon cards with file/symbol counts and delete actions, so returning to a previous project does not require browsing again.
- **Saved-analysis memory:** each project keeps its own cached analysis, keyed by the project root path. Switching opens that saved graph instantly; it does **not** trigger a new analysis. New Project always analyzes, and Rescan refreshes the current project.
- **Project icons:** the app looks for local favicons/logos (`favicon`, `icon`, `logo`, `apple-touch-icon`) in common locations. Projects without an image fall back to a language-colored initial.
- Manual full path.
- **Browse…** folder browser with:
  - Home, Desktop, Documents, Downloads, Volumes, Root shortcuts
  - Breadcrumbs, parent navigation, hidden-folder toggle
  - Folder filter and manual path entry
  - Local filesystem directory listing only; no file content is read by the browser API
- App icon: `web/public/cbe.png`. If a local `docs/cbe.png` exists, the dev server syncs it automatically and triggers a full reload.

### Internationalization

Included locales:

| Code | Language |
|---|---|
| `en` | English |
| `tr` | Turkish |
| `de` | German |
| `fr` | French |
| `es` | Spanish |
| `pt` | Portuguese |
| `ru` | Russian |
| `zh` | Simplified Chinese |
| `ja` | Japanese |

- Locale dictionaries live in `web/src/i18n/locales/`.
- Missing keys fall back to English; new keys/languages can be added incrementally.
- Date/number formatting uses the selected locale.
- The selected language is persisted.
- AI prompts explicitly instruct the provider to answer in the selected language while preserving identifiers, paths, JSON keys, and enum values.

---

## 2. Quick start

### Requirements

- **Node.js 18+** and npm
- **Git** (optional, for the Changes / review workflow)
- A modern Chromium, Firefox, or Safari browser
- No database server is required

### Install and run

```bash
git clone https://github.com/developbat/codebase-intelligence-explorer.git
cd codebase-intelligence-explorer
npm install
npm run dev
```

Open **http://localhost:5173**.

1. Click **Open Project** (or **Browse…**) and choose a TypeScript/JavaScript, PHP, or Python project folder.
2. Or click **Open sample project** to explore `fixtures/sample-app`.
3. Use the **active project card** at the top of the sidebar to switch between saved analyses. Switching opens the cached graph instantly; it does not rescan.
4. Switch between **Intelligence** (read-only analysis) and **Code Studio** (editor, commands, AI edit) from the topbar product switcher.
5. Use **Universe**, **Files**, **Calls**, **Architecture**, **Changes**, **Impact**, **Heatmap**, **Flows**, and **3D** from the sidebar.
6. All tree branches are expanded by default; use the chevrons to expand or collapse everything. The help button starts a guided tour.
7. Select any node to inspect it and highlight its direct connections. In 2D, **Up** walks from file → folder → project. In 3D, selection stays in 3D; use **Open selected item in 2D** for an explicit handoff.
8. Open **AI setup** to connect an optional provider.

### Production build

```bash
npm run build
npm start
```

The production UI and API are served at **http://127.0.0.1:4317**.

### CLI

```bash
npm run analyze -- /absolute/path/to/project
npm run analyze -- fixtures/sample-app
```

---

## 3. Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Vite UI + analysis API (5173 / 4317) |
| `npm run dev:server` | API only |
| `npm run build` | Typecheck + production UI build |
| `npm start` | Production UI + API |
| `npm test` | Static analysis, MVP 2, Git, and AI service tests |
| `npm run typecheck` | TypeScript checks |
| `npm run analyze -- <path>` | Analyze from the CLI |

---

## 4. Architecture

```text
web/
  public/cbe.png                 App icon / favicon / manifest icon
  src/
    App.tsx                      Shell, views, dialogs, SSE updates
    api.ts                       Typed local API client
    i18n/                        Provider + en/tr/de/fr/es/pt/ru/zh/ja dictionaries
    lib/
      viewGraph.ts               Universe / files / calls / architecture / changes / 3D views
      threeGraph.ts              Full-project 3D graph (layered LOD source)
      threeLayout.ts             Hybrid / hierarchical / clustered / force 3D layouts
      layout.ts                  ELK layered layout + radial universe layout
      ai.ts                      Active provider selection
      constants.ts               Colors and labels
    components/
      Sidebar.tsx                Tree, search, semantic results
      ProjectSwitcher.tsx        Always-visible saved-project switcher
      ProjectIcon.tsx            Local project icon with fallback
      GraphCanvas.tsx            React Flow 2D map, fit, focus, edge evidence
      EntityNode.tsx             Custom graph node rendering
      Universe3D.tsx             React Three Fiber 3D explorer
      Inspector.tsx              Entity details, source, Git diff, AI panels
      ProjectProfile.tsx         Non-AI stack/counts/entry-point inference
      GitSummary.tsx             Branch, HEAD, last commit, recent history
      GitHistory.tsx             Paginated Git commit graph
      GitCommitDialog.tsx        Commit file tree, diff, and graph impact
      BusinessFlowPanel.tsx      AI business-flow explorer with source steps
      CodeStudio.tsx             CodeMirror editor, tabs, terminal, AI edit
      TourButton.tsx             driver.js guided tour
      ShowcaseDemo.tsx           Automated promo tour with captions and controls
      SourcePreview.tsx          Read-only highlighted source
      GitDiffView.tsx            Unified diff viewer
      FolderBrowserDialog.tsx    Filesystem folder picker
      AiSettingsDialog.tsx       Provider/model/API key setup
      AiSymbolPanel.tsx          Function/class AI analysis
      AiScopePanel.tsx           File/folder/package AI summary
      AiProjectSummary.tsx       Architecture narrative
      AiFlowsDialog.tsx          Business-flow discovery
      AiReviewDialog.tsx         AI code review
      AiUnresolvedInvestigation.tsx
      AiChatDrawer.tsx           Project Q&A
server/src/
  scanner.ts                     Read-only scan, ignore rules, secret filtering
  analyzer.ts                    AST, symbols, calls, routes, databases, events
  languages.ts                   PHP/Python Lezer parsing, imports, calls, routes
  icons.ts                       Safe local favicon/logo discovery
  editor.ts                      Safe file read/write, backups, command runner
  tests.ts                       Test discovery, test run parsing, failures
  git.ts                         Read-only Git status/log/diff
  changes.ts                     Structural diff + impact analysis
  search.ts                      Local TF-IDF vector index and ranking
  watcher.ts                     Chokidar watcher + SSE refresh stream
  fsbrowse.ts                    Directory-only browser API
  store.ts                       JSON analysis/recent cache
  ai/
    settings.ts                  Provider/model/key persistence (0600)
    providers.ts                 OpenAI-compatible, Anthropic, Gemini adapters
    service.ts                   Symbol/scope/project/flow/review/chat/unresolved AI
  index.ts                       Local HTTP API
shared/
  types.ts                       Graph, Git, change, search, folder contracts
  ai.ts                          Provider catalog, AI result contracts, languages
fixtures/sample-app/             End-to-end sample order project
```

### Analysis flow

1. **Scanner** builds a file tree and filters build output, dependencies, caches, lockfiles, and secret files.
2. **TypeScript program** parses TypeScript/JavaScript with project `tsconfig` support; the Lezer layer parses `.php` and `.py` files.
3. **Symbol extraction** records names, ranges, signatures, parameters, return types, exports, and source hashes.
4. **Semantic resolution** links calls to real declarations through the TypeScript checker; PHP/Python links are import- and name-based and marked `inferred`.
5. **Framework adapters** add routes, controllers, database objects, relations, queries, and events.
6. **Knowledge graph** stores nodes/edges with evidence and certainty.
7. **Views** consume the same graph identities: 2D, 3D, inspector, Git impact, search, AI context.

---

## 5. API

| Endpoint | Purpose |
|---|---|
| `POST /api/analyze` | Analyze `{ "path": "..." }` |
| `GET /api/recent` | Recent analyses |
| `GET /api/projects/:id` | Stored analysis |
| `GET /api/projects/:id/icon` | Local project favicon/logo, if present |
| `POST /api/projects/:id/rescan` | Re-analyze |
| `DELETE /api/projects/:id` | Remove cached analysis |
| `GET /api/projects/:id/source` | Read-only source range |
| `GET /api/projects/:id/file` | Full file content for Code Studio |
| `GET /api/projects/:id/preview/*` | Read-only static HTML/CSS/JS/asset preview |
| `PUT /api/projects/:id/file` | Path-validated write with local backup |
| `POST /api/projects/:id/run` | Run a user command in the project root |
| `POST /api/projects/:id/run/stream` | Stream command stdout/stderr live with cancellation |
| `GET/POST /api/projects/:id/processes` | List or start background jobs |
| `GET/DELETE /api/projects/:id/processes/:jobId` | Read incremental output or stop a background job |
| `GET /api/projects/:id/usage` | Token usage totals by model and day |
| `GET /api/prompts` | List agent prompts with project overrides |
| `PUT/DELETE /api/prompts/:id` | Save or reset a global/project prompt override |
| `GET /api/projects/:id/index/status` | Persistent search-index status |
| `POST /api/projects/:id/index/build` | Start a background index build |
| `GET /api/projects/:id/index/search` | Search indexed files, symbols and conversations |
| `POST /api/projects/:id/conversations/import` | Import existing chat history into the index |
| `GET /api/projects/:id/tests` | Discover test framework and test files |
| `POST /api/projects/:id/tests/run` | Run tests and parse summary/failures |
| `POST /api/projects/:id/tests/stream` | Stream test output (NDJSON), stop, timeout and final parsed result |
| `POST /api/projects/:id/search` | Local vector search |
| `GET /api/projects/:id/events` | SSE watcher stream |
| `GET /api/projects/:id/git` | Branch, HEAD, changed files, commits |
| `GET /api/projects/:id/git/commits` | Paginated commit graph (`limit`, `skip`) |
| `GET /api/projects/:id/git/commits/:hash` | Commit detail: files, stats, graph impact |
| `GET /api/projects/:id/git/commits/:hash/diff` | File diff inside a commit |
| `GET /api/projects/:id/git/diff` | Unified diff against a base |
| `POST /api/projects/:id/changes` | Re-analyze + structural diff + impact |
| `GET /api/fs/list` | Directory-only folder browser |
| `GET/PUT /api/ai/settings` | Public AI settings / update config |
| `POST /api/ai/test` | Test provider connection |
| `GET /api/ai/models` | Fetch provider model list |
| `POST /api/projects/:id/ai/symbol` | Explain a real symbol |
| `POST /api/projects/:id/ai/scope` | File/folder/package summary |
| `POST /api/projects/:id/ai/summary` | Project architecture narrative |
| `POST /api/projects/:id/ai/flows` | Discover business flows |
| `POST /api/projects/:id/ai/review` | Review pending changes |
| `POST /api/projects/:id/ai/unresolved` | Classify an unresolved target |
| `POST /api/projects/:id/ai/chat` | Graph-grounded Q&A |
| `POST /api/projects/:id/ai/edit` | Single-file AI edit proposal with diff review |
| `POST /api/projects/:id/ai/agent` | Autonomous agent loop with file and command tools |
| `POST /api/projects/:id/ai/agent/stream` | Streaming agent loop (NDJSON) with `mode: ask` for read-only Q&A |
| `POST /api/projects/:id/agent/permissions/:requestId` | Resolve an agent permission request (`once`, `always`, `deny`) |
| `POST /api/projects/:id/ai/tests` | Generate a new test file proposal |
| `GET /api/health` | Health check |

All endpoints bind to `127.0.0.1`.

---

## 6. Git workflow

1. Analyze a project. The analysis stores the current Git HEAD and file hashes.
2. Open **Changes** to see changed files since that snapshot.
3. Click **Analyze changes** to:
   - re-analyze the current working tree
   - compare old/new symbols and edges
   - compute direct/transitive impact
   - find affected routes and tests
4. Inspect a changed file in the Inspector: Git diff + structural changes.
5. Click **AI review** to review the actual diff.
6. The watcher can also refresh the stored analysis in the background; use the banner to reload the UI.

Git is strictly read-only.

---

## 7. AI setup

1. Open the sparkles / **AI setup** control.
2. Select a provider.
3. Enter API key, base URL, and model.
4. Use **Fetch models** and **Test connection** as needed.
5. Check **Use this provider and model as default**.

Provider defaults and model suggestions are in `shared/ai.ts`. Custom OpenAI-compatible endpoints (for example a local Ollama server) are supported.

### Privacy

- Keys are stored locally with `0600` permissions and masked in API responses.
- Source excerpts are sent only for the specific AI request you trigger.
- AI panels show the context size/tokens and the files sent.
- AI output is always labeled as interpretation, not static proof.

### Language handling

Every AI request carries the selected UI locale. The server appends an explicit instruction such as “Write every human-readable string value in German” while keeping code identifiers, file paths, JSON keys, and enum values unchanged. The language is part of the cache key, so switching languages does not reuse an answer in the old language.

---

## 8. Security model

- **Intelligence:** read-only project access.
- **Code Studio:** path-validated writes only after an explicit user action.
- Every Code Studio save creates a timestamped local backup first.
- Commands are user-entered and never run automatically.
- AI edit proposals are never applied without user approval.
- `.env`, keys, certificates, and secret files excluded before reading.
- Source preview cannot escape the project root; symlinks re-validated with `realpath`.
- Git uses argument arrays, never a shell.
- Folder browser lists directories only.
- AI keys never returned to the browser.
- No provider is contacted unless configured and explicitly requested.
- No code execution, shell execution, or write path in the analyzer.

---

## 9. Tests

```bash
npm test
```

Current coverage (8 tests):

1. Fixture call graph and evidence.
2. CommonJS `require()` / `exports.x`.
3. Secret and `node_modules` exclusion.
4. MVP 2 adapters: NestJS/Express routes, Prisma relations, ORM queries, events.
5. Git status, diff, commits since analysis, commit graph/detail/diff, structural diff, impact.
6. AI service: real source prompt, structured result, cache, language instruction, grounded chat, single-file AI edit.
7. Code Studio: safe write, backup, command runner, path sandbox.
8. Test discovery and runner: framework detection, summary parsing, failure extraction.

Manual browser verification covers folder browsing, all views, PHP/Python projects, the guided tour, the project profile, Git last-commit history and commit detail, 3D hybrid/hierarchical/clustered/force layouts, 3D LOD selection, 2D up navigation, semantic search, Git changes, AI panels, Code Studio editor/terminal/tests, and language switching.

---

## 10. Current status

| Area | Status |
|---|---|
| MVP 1 — static map, symbols, call graph | ✅ |
| MVP 2 — routes, ORM, DB, events, architecture | ✅ |
| MVP 3 — AI providers, symbol/scope/project/flow/review/chat, languages | ✅ core |
| MVP 4 — local vector search, watcher, clustering, hash reuse | ✅ core |
| MVP 5 — 3D project explorer | ✅ core |
| 3D hybrid / hierarchical / clustered / force layouts | ✅ |
| 3D zoom LOD + aggregated edges + interaction-only flow animation | ✅ |
| 3D stays active while inspecting; explicit 2D handoff | ✅ |
| 3D navigation pad + flow-only labels toggle | ✅ |
| Smooth 3D free movement + collapsible layout menu | ✅ |
| 2D up / parent navigation | ✅ |
| Inspector back stack for previous list/detail | ✅ |
| Focus mode + Impact analysis + Dependency heatmap | ✅ |
| Static data flow + AI business flow explorer | ✅ |
| Code Studio: editor, save + backups, command runner | ✅ |
| AI single-file edit with diff review and explicit apply | ✅ |
| Code Studio model picker for all configured providers | ✅ |
| Large-file AI edits via surgical find/replace (120 KB cap) | ✅ |
| Test discovery + parsed test runner | ✅ |
| Code Studio project-details tab, collapsible tree, preview panel | ✅ |
| Full-screen AI panel + persisted chat history | ✅ |
| Static HTML site routes + page metadata + asset links | ✅ |
| AI test file generation with explicit create | ✅ |
| Multi-file patch studio / agent test loop | ⏳ next |
| PHP / Python symbol, import, call, and route support | ✅ core |
| Git last commit + recent history in Changes | ✅ |
| Git commit graph, pagination, commit detail, diffs | ✅ |
| Highlight commit-changed files on the 2D map | ✅ |
| Full-tree Files view and expanded tree by default | ✅ |
| Non-AI project profile | ✅ |
| Guided tour | ✅ |
| Automated 75–90s promo showcase with English captions | ✅ |
| Always-visible project switcher + saved-analysis memory | ✅ |
| Project icon discovery with language fallback | ✅ |
| File-level map for many additional languages | ✅ files only |
| Symbol-level support for every language | ⏳ TS/JS, PHP, Python today |
| Folder browser | ✅ |
| English UI + 9 languages | ✅ core translations with English fallback |
| Desktop packaging | ⏳ local web app |
| SQLite store | ⏳ JSON cache |
| OS keychain | ⏳ 0600 local file |

### Remaining / future work

- **Symbol-level parsers for more languages:** Go, Rust, Java, Kotlin, C#, C/C++, Ruby, Swift, and others currently appear as file-level nodes only. TS/JS, PHP, and Python have symbol/call/route extraction today.
- **More PHP/Python framework adapters:** Laravel routes and Flask/FastAPI decorators are covered; deeper Django, Symfony, and WordPress route/ORM conventions are next.
- **Cross-language call resolution:** calls between different runtimes (for example PHP → JavaScript or Python → SQL) are not resolved as typed symbols.
- **Deeper PHP/Python precision:** classes, functions, methods, imports, calls, and common framework routes are detected, but resolution is syntax-based rather than type-checked. Dynamic dispatch, dependency-injection bindings, and generated code may remain unresolved or inferred.
- **Neural embeddings** and provider-backed vector search (the current index is local TF-IDF, not a neural embedding model).
- **True streaming** AI responses, cancellation, and precise provider-specific cost estimates (tokens are shown today).
- **Fully incremental parser**; the watcher triggers a safe full re-analysis, while file hashes and AI caches prevent unnecessary AI work.
- **Full translations** for every string in every new language (menus/core screens are translated; missing keys fall back to English).
- **InstancedMesh batching for very large 3D scenes:** the current renderer uses LOD, edge aggregation, and per-node meshes for accurate hover/selection; instancing is the next step beyond 1,000 nodes.
- **3D streaming for very large projects:** current LOD reveals deeper layers by zoom and selection, but the full 3D graph is still capped at 1,000 nodes / 3,000 edges.
- **Desktop shell** (Tauri/Electron) and OS keychain integration.
- **SQLite migration** for very large projects.
- **More language adapters** (Go, Java, C#, Rust, etc.).
- **Benchmarks** on very large repositories and accessibility polish.

---

## License

Released under the [MIT License](LICENSE).

<p align="center">
  Built for developers who want to understand a codebase before touching it.
</p>
