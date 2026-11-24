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
label on the app breadcrumb/status bar was replaced with **Agent workspace**.

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

### 4.9 Persistence

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
useful for labels and repeated tokens.

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
npx tsc -p tsconfig.json --noEmit
npm run build
```

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

- Color inventory is stylesheet-focused; JS canvas/inline HTML colors can be a
  later extension.
- Mapped changes do not yet support cyclic swaps (`#fff ↔ #000`) safely.
- Cross-language extraction fixtures can be expanded (Python/Go/RN/Laravel/CIE).
- A post-intent action planner (`explain` / `locate` / `list` / `edit` /
  `verify`) can make tool selection even more explicit.
- Read-map/diff and tool/claim stages are still queued.
