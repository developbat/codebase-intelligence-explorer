# Code Studio — Structure and Working Guide

This document explains **how Code Studio works step by step**: project opening,
modes, permissions, intent analysis, task planning, tool execution, extraction,
editing, verification, and where each piece lives.

It is intentionally editor-focused. For the wider product see `README.md`; for
the capability checklist see `docs/YETENEK-DURUMU.md`; for architecture notes see
`docs/MIMARI.md` and `docs/AGENT-FIRST.md`.

Last updated: 2026-11-24

---

## 1. Quick map

| Area | Main files |
|---|---|
| App shell, project switching, product tabs | `web/src/App.tsx` |
| Code Studio UI, chat, editor, permissions | `web/src/components/CodeStudio.tsx` |
| Project switcher | `web/src/components/ProjectSwitcher.tsx` |
| Settings, approvals, write/command permissions | `web/src/components/SettingsScreen.tsx` |
| UI preferences (`agentAllowWrite`, `agentAllowCommands`) | `web/src/lib/prefs.ts` |
| HTTP API and streaming routes | `server/src/index.ts` |
| Intent classification | `server/src/ai/intent.ts` |
| Task queue, planner, task loop | `server/src/ai/loop.ts` |
| Agent tools, prompts, extraction/change gates | `server/src/ai/service.ts` |
| Generic entity extraction | `server/src/extractors.ts` |
| Project map / agent context | `server/src/projectMap.ts`, `.cie/agent/` |
| Project analysis and scanner | `server/src/analyzer.ts`, `server/src/scanner.ts` |
| Shared API types | `shared/ai.ts`, `shared/tasks.ts`, `shared/intent.ts` |
| Evaluation runners | `server/src/evalAsk.ts`, `evalStages.ts`, `evalChange.ts` |

---

## 2. Opening a project

1. `App.tsx` loads the recent project list and the last project id.
2. `loadRecent(project)` requests the saved analysis (`api.project`).
3. A request token (`projectRequestRef`) ensures that a slow older load/rescan
   cannot overwrite the project the user switched to afterwards.
4. `applyAnalysis()` sets the active analysis and resets the graph/editor
   selection.
5. Code Studio is mounted with `key={analysis.id}`. A project switch therefore
   remounts it: old chat tabs, editor tabs, task panels and file contents do not
   leak into the new project.
6. The project switcher closes immediately; a loading overlay is shown while the
   saved analysis is fetched.

**Important:** clicking a project during an in-flight load must not be silently
ignored. `loadRecent` only blocks during a full new analysis (`busy ===
"analyze"`), not during another load.

---

## 3. Modes and permissions

Modes are stored per project in `localStorage` (`cie:studio-mode:<projectId>`).

| Mode | UI label | Writes | Purpose |
|---|---|---|---|
| Ask | `ASK · READ-ONLY` | blocked | questions, lookups, lists |
| Plan | `PLAN · READ-ONLY` | blocked | planning only |
| Build | `WRITE MODE` | allowed by pre-approval | edit, run, test |
| Research | `RESEARCH · READ-ONLY` | blocked | web/document research |

The mode pill in the Code Studio sidebar is clickable: it switches between Build
and Ask; Plan/Research switch to Build when clicked. The old static “Write mode”
label on the app breadcrumb/status bar was removed; the selected product tab already communicates the workspace. The project name alone is shown.

The composer also shows a permission chip:

- `Writes: auto-approved`
- `Writes: ask each time`
- `Writes blocked: read-only`

The chip opens **Settings → General approvals** when write permission is
relevant. The actual pre-approval keys are:

- `cie:agent-write` (`agentAllowWrite`)
- `cie:agent-commands` (`agentAllowCommands`)

Writes always create timestamped local backups. Delete/rename always require a
fresh confirmation.

### Agent notes vs project edits

In Ask/Plan/Research the agent may still write its **own notes** under
`.cie/agent/`:

- `PROJECT_MAP.md`
- `context.md`
- `context-digest.md`
- `TASKS.md`
- `PLAN.md`
- `runs/*.json`

These are not project changes. The read-only warning is only about source/project
files. Internal notes are excluded from the “this request changes the project”
decision.

---

## 4. One request, step by step

```text
User message
  → Code Studio composer
  → POST /api/projects/:id/ai/loop/stream
  → intent analysis
  → task queue (usually one task for simple questions)
  → task instruction
  → work brief (list vs change vs edit)
  → agent loop with tools
  → gates and verification
  → finish summary
  → UI chat + task queue + persisted notes/reports
```

### 4.1 UI → API

`CodeStudio.askProject()` sends the instruction and mode to the task-loop stream.
It passes:

- `workspaceMode` (`ask` / `plan` / `build` / `research`)
- `allowWrite` and `allowCommands` only when the mode is Build
- active file, provider/model, language, history, budgets

On a project switch, the component is remounted (`key={analysis.id}`), so the
request and stream state belong to the current project only.

### 4.2 Intent analysis

`server/src/ai/intent.ts` classifies the request:

- `kind`: `question` / `edit` / `run` / `scaffold` / `analyze`
- `scope`: trivial/small/medium/large
- `mode`: single/loop
- `context`: none/focused/project
- `needsExhaustiveEvidence`
- areas, approach, assumptions

The intent is shown in the UI plan card. It is **not** the final action
decision; it is an input.

#### Project mismatch guard

If the request mentions a UI/game/button and the active project has no
HTML/JS/CSS interface, the intent is replaced with a project-switch
clarification:

- recent projects with a UI are offered as one-click options;
- the current project can still be searched (“Search this project anyway”);
- asking whether **this project** has a UI (for example “projede buton var mı?”)
  is treated as a current-project audit and is not redirected.

Choosing a project option in the UI calls `onOpenProjectWithPrompt`, which loads
that project and reruns the original request. Candidate projects come from
`listRecent()`, and the detection logic is shared in `shared/projectMatch.ts`.

#### Action planner

After intent resolution, a deterministic action planner chooses one explicit
action before tools:

| Action | Used for | Gates |
|---|---|---|
| `explain` | explanation questions | read-only |
| `locate` | where/defined questions | search + focused reads |
| `list` | complete inventories | `extract_entities` + complete-list gate |
| `edit` | code/asset changes | focused edit + verification |
| `verify` | test/typecheck/build requests | command/browser evidence, no edits |
| `run` | execute app/command | command + real output |
| `scaffold` | new project/skeleton | create + dependency/build verification |
| `tool` | project tools/skills | create/reuse tool + run it |

The action is derived from the **original user goal** (`workBriefText`), not
the task-loop wrapper. It is added to the plan card (`LIST`, `LOCATE`, `VERIFY`,
…) and injected into the prompt with action-specific instructions. It does not
replace intent; intent supplies scope/areas/verification, action supplies the
expected work shape.

### 4.3 Task queue

`server/src/ai/loop.ts` creates or reuses a task queue:

- simple questions/edit requests: one task (`intentTask`)
- larger goals: `planProjectTasks`

Each task has title, detail, acceptance, effort, role, budgets, dependencies and
verification.

### 4.4 Task instruction and work brief

The task loop wraps the task in `taskInstruction()` (context, acceptance,
evidence rules, verification). This wrapper contains generic wording such as
“field/control change” and “run browser_check when visual”.

Because of that, the work brief is resolved from the **original user goal**
(`current.title`), not from the wrapper:

```ts
workBriefSource = options.workBriefText ?? instruction
workBrief = resolveWorkBrief(workBriefSource)
```

`resolveWorkBrief` in `server/src/extractors.ts` decides:

- `extract` → a complete list/audit request
- `change` → an edit/update/replace request
- `null` → neither (normal question, location, explanation)

It handles Turkish/English, negation (“değiştirme, sadece listele”), location
questions (“nerede?”) and compound requests (“listele ve ekle” → change).

### 4.5 Write detection

`taskLooksLikeWrite()` uses a **title-first** rule:

- inspection/list/show/analyze titles are not writes;
- explicit edit verbs (`add`, `update`, `fix`, `ekle`, `oluştur`, …) are writes;
- model-generated detail text is only a fallback.

This prevents plan wording such as “create a complete list” from turning a
read-only question into a project edit.

### 4.5.1 Extraction cache

`extractEntities` keeps an in-memory LRU-ish cache (max 32 entries) keyed by:

```text
projectId | analysis.createdAt | kind | scope | query | limit
```

- Repeated identical extractions return `fromCache: true` without re-reading
  files.
- Any agent write, mapped change, undo or rescan calls
  `invalidateExtractionCache(projectId)` through `invalidateReadCaches()`.
- A watcher/rescan creates a new `analysis.createdAt`, so old entries are
  naturally bypassed.
- The tool log distinguishes “Entities extracted” from “Entities extracted from
  cache”.
- A second, **file-content cache** (path + mtime + size) avoids re-reading
  unchanged files when a request-level result must be recomputed.
- Writes invalidate only request-cache entries whose extracted items include the
  changed file; unrelated cached extractions remain valid until the next
  rescan/analysis timestamp change.

### 4.6 Extraction profile

When the work brief is `extract(sth)`:

- the task runs in the read-only profile;
- `allowWrite` and `allowCommands` are false;
- the task instruction does not ask for context-digest reads, grep, `list_items`
  or `browser_check`;
- the agent is told to call `extract_entities` once and finish with every item;
- the extraction tool response says “complete list ready, call finish now”.

`extract_entities` supports:

`color`, `input`, `button`, `link`, `function`, `class`, `component`, `env`,
`todo`, `route`, `import`, `selector`, `asset`, `document`, `markdown`, `file`,
`text`

Inputs/buttons created with `document.createElement` are included, not only
static HTML/JSX.

### 4.7 Gates

The agent loop applies these guards before executing an action:

| Gate | Effect |
|---|---|
| extraction-required | a list request must call `extract_entities` before reads/search |
| complete-list | after a complete extraction, only `finish` is allowed |
| mapped-verified | after a verified mapped change, extra reads are limited |
| read budget | repeated reads without an edit are stopped |
| inspection budget | diagnosis stops after sufficient evidence |
| progress/token guards | 300k without code change, 500k read-only, 900k working |

For list tasks the complete-list gate is the important one: the model cannot
keep reading/counting after the extractor returned the list. If it ignores the
gate twice, the fallback answer is built directly from the extractor result.

### 4.8 Finish and verification

On `finish` the loop checks, among others:

- summary is not a plan/next-step note;
- no missing required items in an exhaustive list;
- mapped changes really removed old values;
- UI changes have real-page verification when required;
- syntax/typecheck/test/build checks when applicable;
- no remaining work/blockers unless explicitly reported.

`browser_check` is required for **visual/runtime UI changes**, not for static
lists. A static list is proven by `extract_entities`; running a browser for it is
wasted work.

For project verification:

- Python tests using `unittest` are detected as
  `python3 -m unittest discover -s tests -q`; otherwise `pytest -q` is used.
  If a project has `.venv/bin/python` or `venv/bin/python`, the command is
  prefixed with that interpreter (for example
  `./.venv/bin/python -m pytest -q`).
- Go changes in a multi-module repository use the nearest `go.mod` directory
  (`cd <module> && go test ./...`) when no root `go.mod` exists.
- Node/React Native projects use the detected `npm test` / `npx tsc --noEmit`
  commands.
- Verification summaries use the generic **Verification** label, not
  “Typecheck”, because the command may be a test or build command.

### 4.9 Read map and claim audit

Every content read is recorded in a run-level **read map**:

- `read_file`: file + line range
- `read_symbol`: file + symbol range/name
- `find_in_file`, `search_code`, `count_matches`: file/line hits
- `diagnostics`, `lsp_hover`, `lsp_completion`, `list_items`, `git_blame`

The map survives write-cache invalidation and is returned as `AiAgentResult.readMap`.
The chat **Details** section shows a clickable **Read map** with tool, range and
symbol evidence.

At finish, `auditClaims()` checks the summary against tool evidence:

- “fixed/applied/changed” requires at least one changed file (unless read-only);
- “verified/tested/passed” requires a successful verification command, test
  command, browser assertion, completed extraction or verified mapped change;
- “read FILE” requires that file in the read map;
- “browser verified” requires a real browser check with assertions.

An unsupported claim rejects the finish with an actionable observation. A second
attempt gets an explicit **Evidence warning** instead of looping forever.

### 4.10 Extraction table UI

When `extract_entities` runs, the last extraction is returned as
`AiAgentResult.extraction` and rendered under the assistant answer:

- kind/total/unique/truncated header,
- table with localized column labels,
- clickable rows that open the file at the extracted line,
- **Copy CSV**, **Download CSV**, **Copy Markdown**, **Download Markdown**,
- first 50 rows by default, “Show all” for larger lists.

CSV/Markdown generation is shared in `shared/extraction.ts`, so exports match
the API extraction data. The chat serializer also persists `extraction`,
`readMap` and `changeReport` with the conversation.

### 4.11 Content inventory (assets and Markdown)

The right panel **Assets** tab and the `audit_content` tool share
`server/src/contentInventory.ts`:

- disk asset inventory (images, fonts, audio, video),
- references from HTML/CSS/JS/TS/Vue/Svelte/PHP/Markdown,
- **broken references** (local file missing),
- **unreferenced assets**,
- Markdown heading hierarchy warnings (starts below h1, level jumps, multiple
  h1).

Dynamic JavaScript references are reported as a note rather than a hard
failure. Clicking an item opens the source file/line.

### 4.12 Preview, documents and archives

Preview is selected by the active file type:

- HTML → iframe (static/live server)
- images/PDF → binary preview (`application/pdf` included)
- Markdown → rendered `MarkdownText`
- JSON → formatted JSON viewer with object/array summary
- other files → source preview

The agent uses tools, not dedicated UI buttons, for documents:

- `read_document` — PDF, Word (`doc`/`docx`/`rtf`), Excel (`xls`/`xlsx`), CSV/TSV,
  text, JSON, HTML, images with OCR
- `csv_query` — structured CSV filters/counts
- `create_document` — xlsx, csv, tsv, docx, pdf, md, txt, json, html
- `create_zip` — archive selected files/folders
- `search_document` — search inside a document

Generated `.pdf` files are listed as assets and can be previewed in the right
panel. Excel/Word outputs are read back with `read_document`; they are not
rendered as rich previews yet. The external `pdf-editor`, `json-viewer.html` and
`md-viewer.html` tools are not required because native JSON/Markdown/PDF
preview and document read/write tools cover the common path.

Terminal output has an inline search filter; arbitrary log search can also use
`grep` in the terminal.

### 4.13 Capabilities, prompts and providers

**Skills/capabilities.** Installed skills are enabled by default. The agent
receives a compact capability index (key, name, description and allowed tools)
instead of every full skill body. When a task matches, it calls
`load_skill` with the key; the full instructions are returned for that run
only. `@skill-name` forces one skill for a run. Disabling a skill removes it
from the index. Settings → Skills uses a single page scroll, so long lists and
the skill body are reachable without a nested scroll trap.

**Prompts.** Defaults and global overrides apply to every project. The prompt
manager now opens on **All projects** unless the selected prompt already has a
project override; **This project** is an explicit local override. This avoids
the impression that every prompt is project-specific by default.

**Providers.** Model providers keeps one list; the green **Local model
provider** entry opens its content on the right with installed models, model
folder discovery and a compatible-model catalog (name, approximate size,
description, download). **Add custom provider** is the green action below the
list and explains that any OpenAI-compatible endpoint (hosted, private gateway,
LM Studio, vLLM or Ollama) can be added. Built-in provider buttons still open
their configuration on the right.

**Workspace copy.** Capability-limiting marketing/status strings such as
“source code is never modified or executed” were removed. Intelligence
explores the graph; Code Studio can edit, run, test, preview and verify the
same project. Mode-specific read-only labels (Ask/Plan/Research) remain because
they describe an explicit user-selected mode.

**Home and new-chat density.** The saved-project list fills the sidebar and
scrolls instead of ending in a clipped note. New chat tabs show only the agent
icon and one-line guidance; the full intro and quick actions stay on the first
chat tab of a project.

### 4.13.1 Prompt-driven tool selection

The deterministic action planner maps natural language to capability families
before the model runs. Site inspection phrases such as `siteyi incele` set
`action=verify`, add the `browser` group, select `agent.site`, and cap the run at
10 turns. The prompt requires real selectors (read the entry HTML or a saved
scenario first), non-empty `eval.value`, runtime/console evidence and
`audit_content`. `npm run eval:tools` validates eight prompt → action/group/tool
suggestion cases, including site inspection, list, test, run, file read, Excel
output and error location.

### 4.13.2 Chat Studio research and web search

Chat Studio uses a concise research prompt: user language first, current date,
no self-introduction or capability-disclaimer list, and no long refusal when
live data is missing. With **Web search** enabled it searches news/current
questions through Google News RSS, optional Google Custom Search (`GOOGLE_CSE_API_KEY`
+ `GOOGLE_CSE_ID`) and a DuckDuckGo HTML fallback. Results become numbered,
collapsed Sources details with a provider badge; the answer body uses `[1]`
style references without raw URLs. Each assistant message has a Copy action.
Capability questions (`neler yapıyorsun?`) are detected before search, answered
from a local capability brief only for that request, and never go to a search
provider. `GET /api/web/search` exposes the same chain.

### 4.14 Tool registry and capability metadata

`server/src/ai/toolRegistry.ts` is the single source of truth for the built-in
agent surface. Each `AgentToolSpec` declares:

- `action`, capability `groups`, catalog `example`
- `description` and `whenToUse`
- `permission` (`write` / `command`) and `destructive`
- optional argument schema (required aliases and primitive types)
- `writeModeOnly` for tools that are only exposed in Build mode

`agentToolCatalog` renders the group-filtered list from this registry instead of
a hand-maintained array. `validateToolArgs` runs before the action switch and
returns a precise error for missing/typed arguments. Schemas support the simple
alias form and a JSON Schema subset (`type`, `required`, `properties`, `anyOf`,
`items`, `enum`). Project tools under `.cie/agent/tools` are appended as
`run_project_tool` examples when command access is allowed.

Project tool manifests can add `whenToUse`, `inputSchema` and `timeoutMs` in
`.cie/agent/tools.json`. `run_project_tool` validates `input`/`CIE_TOOL_INPUT`
against the schema, pins the working directory to the project root, applies the
declared timeout and still goes through the command permission handshake.
Handler execution is therefore bounded by schema, cwd, timeout and approval;
full OS-level network/FS sandboxing remains a later hardening step.

Handler modules live in `server/src/ai/tools/` (`types.ts`, `builtins.ts`,
`registry.ts`). `runRegisteredTool` is called before the legacy switch.
Forty-two actions are modular across `documents.ts`, `research.ts`,
`skills.ts`, `gitTools.ts`, `gitWriteTools.ts`, `writeTools.ts`, `mobile.ts`,
`mobileActions.ts` and `builtins.ts`. The remaining 35 core read/edit/browser
actions have try-only adapters in `tryTools.ts`; they do not replace the agent
switch, so read-map/cache/counter behavior is unchanged during real runs while
the playground can exercise all 77 non-finish actions. Try execution adds a 120s timeout, a safe env for project tools, and
localStorage history (last 20). `suggestToolsForInstruction` scores capability
hints from the instruction and selected groups; the result is logged and added
to the task context. `GET /api/projects/:id/tool-registry` exposes built-in and
project metadata to the UI; **Settings → Tools** renders the built-in registry.
Handlers already migrated to `ai/tools` are marked `tryable`; the UI opens a JSON
args editor and calls `POST /api/projects/:id/tools/try`. Write/command tools
require an explicit user confirmation for the try. Project tools expose a
separate **Try** form driven by `inputSchema` and call `/tools/run`.

Test-only verification tasks skip both the edit-wiring and remaining-work finish
guards, and “eksik ... yok” style summaries are not treated as incomplete
wiring.

### 4.15 Verification flow and task visibility

**Verification profile.** A goal whose action is `run` or `verify` (for example
“oyunu oyna ve test et”) selects the compact `agent.test` prompt. It prefers an
existing `.cie/agent/scenarios` scenario, caps the run at 12 model turns, skips
the project map and full skill bodies, and reads at most two source files only
after a check fails. An eval `ReferenceError` is treated as a wrong assumption;
the agent must switch to DOM-visible checks or report the blocker instead of
repeating the same step. Test-only summaries such as “proje dosyalarında
değişiklik yapılmadı” are accepted by the finish guard.

**In-app live browser.** The **Live test** panel exposes a persisted **Live
view** toggle; it only controls frame display, not tool availability. It passes
`liveBrowser` through the task loop and agent stream; `browser_check`,
`game_check` and `run_test_scenario` run in a headless Playwright page and stream
JPEG frames at ~4 fps through `GET /api/projects/:id/live-browser` into both the
right-panel Live test tab and an inline preview card in the agent chat. The
stream waits briefly for the page, survives the log-before-page race, ends on
Stop/abort, and keeps the last frame. An explicit `visible: true` still opens a
separate Chrome window for debugging. Chat Studio uses the same animated robot
orb while thinking.

**Context and cache budgets.** File content, extraction results and AI results
use entry + byte caps (300 files / 16M chars, 32 extractions / 12M chars, 120 AI
entries / 2M chars). The agent logs a compact **Context plan** and warns above
30k chars; older observations are clamped and compacted after six turns.

**Task queue UI.** The queue no longer draws a percentage bar. The summary and
task rows show `done/total`, live step count, tokens and attempts. Each task has
a collapsible **What the agent understood** block built from its intent,
approach, likely areas, assumptions and acceptance criterion. The Plan card
shows `plan.summary` (the agent's understanding), `plan.reason` and the ordered
steps; the run strip shows the current activity.

### 4.16 Persistence

- Project analysis: application data directory (project id based).
- Agent notes: `<project>/.cie/agent/`.
- Task runs/logs: `.cie/agent/runs/`.
- UI chat tabs: `localStorage` per project (`cie:studio-chat-tabs:<id>`).
- Eval reports: `fixtures/agent-eval/reports/` (gitignored).
- Work reports: `docs/reports/` (gitignored, see below).

---

## 5. List/audit workflow (example: buttons)

User: “bana uygulamadaki buton listesini getir”

1. Intent: `analyze`, `single`, exhaustive evidence.
2. Work brief: `extract(button)`.
3. Read-only task profile; commands/writes disabled.
4. `extract_entities(kind="button")` scans static markup **and** JS-created
   buttons.
5. The tool returns file, line, id/name and text.
6. Complete-list gate blocks further reads.
7. Finish summary lists every item in the user’s language.

Measured on a temporary neon-escape copy:

| Metric | Before | After |
|---|---:|---:|
| Tokens | 205k | ~11.9k (intent + task) |
| Steps | 19 | 2 |
| Browser checks | 4 | 0 |
| Shell commands | 4 | 0 |
| Result | 6 buttons | 6 buttons |

The 6 buttons are `sound-toggle`, `play-button`, `restart-button`, `move-left`,
`move-right`, and the JS-created `fire-button`.

---

## 6. Change workflow (example: color/button color)

1. Work brief: `change(color)`.
2. `extract_entities(kind="color")` identifies current values.
3. `apply_mapped_changes` applies a mapping such as
   `{"#22d3ee":"#ff5c8a"}` file by file, with one permission prompt per file.
4. The tool verifies that old values are gone and reports remaining occurrences.
5. `replace_many` is the fallback for localized multi-edits; color changes via
   `replace_many` are also verified.
6. After verification, extra reads are limited; finish with changed files and
   verification.
7. For visual changes, `browser_check`/`run_test_scenario` on the real entry page
   is still the expected proof.

`apply_mapped_changes` supports `kind=color` and `kind=text`. Text mapping is
used for button labels, import paths, environment keys and repeated tokens; it
targets every file containing the exact old value and verifies that the old
value is gone afterwards.

Mappings are applied in one simultaneous pass:

- swaps such as `#fff ↔ #000` are safe;
- the permission prompt shows a line-level before/after preview;
- `dryRun: true` returns the same preview without writing;
- `undo_change` (agent) or the **Undo** button in Changes restores the latest
  editor backup for a file. Backup filenames include a random suffix so rapid
  consecutive writes cannot overwrite each other.

### 6.1 Change report and run output (right panel)

The right panel has three views:

- **Preview** — static/live web preview or file preview.
- **Run** — latest command output (manual Terminal command or agent
  `run_command`). Shows command, working directory, exit code, duration and
  stdout/stderr. For code-only projects it opens automatically after a run.
- **Changes** — change report after an agent edit:
  - changed files, additions/deletions and status;
  - added/removed/changed symbols and edge counts;
  - impacted nodes, routes and tests;
  - per-file Git diff when the project is a Git repository.

The report is computed at agent finish from the **run's baseline analysis**, not
from the possibly watcher-refreshed stored analysis. Internal paths such as
`.cie/` are excluded.

### 6.2 Project dependency installs

When a project has `requirements.txt` and no virtualenv, the terminal suggestions
include:

```bash
python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
```

For `fastapi-pydiator-master`, `requirements.txt` already lists `pytest==8.0.0`.
After the venv is created, verification commands use
`./.venv/bin/python -m pytest -q`. Do not install Python packages into the
system interpreter (PEP 668 blocks it on this machine). If tests still fail on
missing packages, treat that as an install blocker, not as a code failure.

---

## 7. Chat and project switching behavior

- Chat tabs are project-scoped.
- Clicking a conversation persists the current one and loads the selected one.
- While an agent run is active, switching conversations is blocked **with a
  visible notice** (“stop the running agent first”), not a silent no-op.
- On project switch, Code Studio remounts; old chats/files/tasks are gone.
- A project load cannot be overwritten by an older load/rescan.

---

## 8. Tests and evaluations

```bash
npm test               # unit/integration tests
npm run eval:ask       # read-only code understanding/list checks
npm run eval:stages    # intent + planning stages
npm run eval:change    # temp-copy change workflow
npm run eval:extract   # deterministic extraction golden matrix
npm run eval:verify    # scratch Python/Go/Node test+run checks
npx tsc -p tsconfig.json --noEmit
npm run build
```

`eval:verify` creates fresh Python (unittest), Go and Node projects in a temp
folder, confirms the detected test command fails on buggy code, fixes it, reruns
the test and runs the app for a real stdout result.

`eval:extract` runs the golden matrix in
`fixtures/agent-eval/extraction.json` against real project analyses (no model
tokens): exact/minimum totals, uniqueness, truncation and required
file/line/name/path/color items across neon-escape, CBE, sample, CIE, Laravel,
Python, Go and React Native.

Evaluation output is written to `fixtures/agent-eval/reports/` (gitignored).
Do not use a synthetic `.cie/agent` harness as proof for a real app; use the real
entry page for browser checks.

---

## 9. Documentation and work reports

- `structure.md` (this file): editor workflow and architecture.
- `docs/YETENEK-DURUMU.md`: capability checklist and next queue.
- `docs/MIMARI.md`, `docs/AGENT-FIRST.md`: architecture/design notes.
- `docs/reports/`: working reports (gitignored).
- `fixtures/agent-eval/reports/`: machine-readable eval reports (gitignored).

When a workflow changes, update **this file** and `docs/YETENEK-DURUMU.md`, then
write a dated report under `docs/reports/`.

Reports should contain:

1. What was requested.
2. What was observed (numbers, failures, screenshots if relevant).
3. Root cause.
4. Changes made (file paths).
5. Test/evidence results.
6. Known limitations and next queue.

---

## 10. Change checklist

Before committing:

- [ ] `npx tsc -p tsconfig.json --noEmit`
- [ ] `npm test`
- [ ] relevant `eval:*` runner
- [ ] `npm run build`
- [ ] no temp projects or test artifacts left in fixtures
- [ ] no user project files modified during verification
- [ ] `structure.md` and `docs/YETENEK-DURUMU.md` updated
- [ ] work report written under `docs/reports/`

---

## 11. Known limits / next queue

- Color inventory now covers stylesheets, inline HTML, JS/TS canvas colors,
  JSON/YAML/TOML themes and common mobile/PHP color literals.
- Mapped changes do not yet support cyclic swaps (`#fff ↔ #000`) safely.
- Cross-language extraction fixtures can be expanded (Python/Go/RN/Laravel/CIE).
- A post-intent action planner (`explain` / `locate` / `list` / `edit` /
  `verify`) can make tool selection even more explicit.
- Read-map/diff and tool/claim stages are still queued.
