import fs from "node:fs/promises";
import path from "node:path";

const BUILTIN_VERSION = "5";

interface BuiltinSkill {
  slug: string;
  name: string;
  description: string;
  body: string;
}

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  {
    slug: "code-review",
    name: "Code Review",
    description:
      "Review changed files for correctness, regressions, error handling, data loss and missing verification. Use before finishing an edit or opening a PR.",
    body: `# Code Review

Review only the files changed by the current task. Report concrete issues, not style preferences.

## Checklist

- Correctness: does the change do what the request says for every input path?
- Regressions: are existing callers, routes, exports or CSS selectors still valid?
- Errors: are rejected promises, failed fetches and empty states handled?
- Data: could this overwrite, delete or corrupt user data or config?
- Security: no secrets, unsafe HTML, command injection, path traversal or missing authorization.
- Tests/verification: does the project's typecheck, lint, test or build command cover this change?
- Scope: did the change touch unrelated files?

## Output

Return a short list ordered by severity. For each item give file, line or symbol, the problem and the smallest fix. If nothing is wrong, say "No blocking issues" and list residual risks or untested paths. Never rewrite the code during review.`,
  },
  {
    slug: "security-audit",
    name: "Security Audit",
    description:
      "Audit code and configuration for secrets, injection, authorization gaps, unsafe file access, SSRF and dependency risks. Use when the user asks for a security check.",
    body: `# Security Audit

Focus on exploitable behavior in this repository, not generic advice.

## Check

1. Secrets: hard-coded keys, tokens, passwords in source, fixtures, HTML or logs.
2. Injection: SQL built from strings, shell commands with user input, unsafe \`eval\`, template injection.
3. Authorization: routes or actions that trust a client-provided user/role/tenant id.
4. Files: path traversal, unrestricted upload, symlink escapes, world-writable output.
5. Network: SSRF, unvalidated redirects, missing TLS verification, secrets sent to third parties.
6. Web: unsafe innerHTML, missing CSRF protection, permissive CORS, missing security headers.
7. Dependencies: obvious outdated or abandoned packages when the manifest is in scope.

## Rules

- Quote the exact file and line.
- Explain the attack path in one sentence.
- Propose the smallest safe fix.
- Mark severity: critical, high, medium, low.
- Do not print real secret values; refer to their location only.`,
  },
  {
    slug: "test-writer",
    name: "Test Writer",
    description:
      "Add focused tests using the project's existing framework and conventions. Covers success, failure and edge cases without snapshot spam.",
    body: `# Test Writer

Use the project's existing test framework and file placement. Never introduce a second test runner.

## Workflow

1. Detect the framework and command from the manifest, config or existing test files.
2. Read one nearby test file to match naming, imports, helpers and assertion style.
3. Write the smallest test set that proves the change:
   - one success case,
   - one failure or validation case,
   - one boundary case that the implementation could get wrong.
4. Run only the relevant test file or pattern first, then the project test command if it is fast.
5. If a test fails, fix the test or the code; do not delete the assertion unless it is demonstrably wrong.

## Avoid

- Snapshot tests for logic that can be asserted directly.
- Tests that depend on real network, wall-clock time, user home or ports.
- Mocking the function under test.
- Copying huge fixtures when a small inline input is enough.

Return the test command and its result.`,
  },
  {
    slug: "accessibility-audit",
    name: "Accessibility Audit",
    description:
      "Audit HTML/React/Vue UI for labels, keyboard access, focus, semantics, contrast and responsive behavior. Use for UI or form changes.",
    body: `# Accessibility Audit

Check the rendered markup and styles, not just the screenshot.

## Checklist

- Every input, select and textarea has a visible or aria label.
- Buttons and links are real \`<button>\`/\`<a>\` elements with keyboard focus.
- Interactive custom controls support Enter/Space and expose role/state.
- The tab order follows the visual order; focus is visible and not trapped.
- Images have useful alt text, or empty alt when decorative.
- Headings are hierarchical; landmarks and lists are semantic.
- Color is not the only signal; contrast is readable in light and dark themes.
- Forms announce validation errors and connect them to fields.
- Dialogs move focus in, Escape closes, and focus returns on close.
- Layout does not overflow horizontally at narrow widths.

## Output

List issues with selector, file, impact and a minimal fix. Mark blockers separately from nice-to-haves. Do not rewrite unrelated layout.`,
  },
  {
    slug: "runtime-ui-debugging",
    name: "Runtime UI Debugging",
    description:
      "Diagnose why a browser UI or game behavior is missing, flickering or unreadable. Traces asset wiring and animation loops, then proves the root cause in a real browser.",
    body: `# Runtime UI Debugging

Never guess from feature names. Prove the cause with the rendered page and file evidence.

## 1. Is the code actually loaded?

1. List every \`<script src>\` and \`<link href>\` in the HTML entry point.
2. Compare them with the changed JS/CSS files. A valid file that no HTML loads does nothing.
3. Check for duplicate tags. Two copies of the same script run twice or fight over timers.
4. For modules, confirm the import graph reaches the entry point.

## 2. Does the runtime path exist?

- Find the function that should create or update the element. Search by selector, class and text.
- Read the caller chain: event listener → handler → render function.
- Confirm the element exists in markup or is created dynamically before it is queried.
- Check whether the update is gated behind a state flag that never becomes true.

## 3. Text that changes too fast or cannot be read

This is usually not a slow timer. It is a rewrite inside the frame loop:

- \`requestAnimationFrame\` / \`setInterval\` → function that assigns \`innerHTML\` or \`textContent\` on every tick.
- Random choices inside that assignment make the text change every frame.

Fix: compute the value once per state change (guard with a flag or compare the previous value) and keep the loop free of one-time writes.

## 4. Prove it on the real page, not a harness

A synthetic page under \`.cie/\` that imports one script is not proof of the app. Verify the project entry page. If the state is hard to reach, use an \`eval\` step on the real page to put it there, then assert it.

Use the app preview, not a static read:

\`\`\`json
{"action":"browser_check","args":{"path":"index.html","steps":[
  {"action":"click","selector":"#play-button"},
  {"action":"expectVisible","selector":".overlay"},
  {"action":"expectStable","selector":".overlay .message","durationMs":1200}
]}}
\`\`\`

\`expectStable\` fails when the element text changes during the sample window. Use it for counters, toasts, game-over messages and anything a user must read.

To reach a hidden state on the real page:

\`\`\`json
{"action":"eval","value":"document.querySelector('#start-screen').hidden=true; document.querySelector('#game-over-screen').hidden=false;"}
\`\`\`

For delayed elements, wait first:

\`\`\`json
{"action":"waitForSelector","selector":".comedy-note","timeoutMs":4000}
\`\`\`

Then assert the same selector a real user would see. A check that only proves the page loads is not verification of the change.

## 5. Tool failures are not blockers

- If a write or append call fails with \`A file path is required\`, re-issue it with \`{"action":"append_text","args":{"path":"file.js","content":"..."}}\`.
- If a tool you need does not exist, create a project tool or a small script and run it.
- Read the newest \`.cie/agent/runs/*.json\` file to see the exact failed action and observation before retrying.
- Never finish with "blocked" while a correctable tool error is open.

## 6. Visual quality (icons, HUD, overlays)

Semantic checks are not enough. A visible element can still be unreadable.

- **SVG icons**: set explicit \`width\`/\`height\` (12–24px) and an explicit \`fill\`
  with contrast ≥ 3:1 against the HUD background. Default \`fill\` is black and
  disappears on dark UIs.
- **Icon + value**: put both in a flex row (\`display:flex; align-items:center;
  gap:6px\`). An unconstrained inline SVG defaults to 300×150 and pushes the
  value to the next line.
- **HUD distribution**: use \`justify-content: space-between\` (or grid). Remove
  empty flex spacers such as an empty \`#round-chips\` with \`margin-left:auto\`;
  they cluster the metrics on the left.
- **Overlays**: position them relative to a wrapper around the canvas, not the
  whole page; use percentage offsets and \`pointer-events:none\`.
- **Screenshot**: take one before finishing and reject invisible icons,
  left-clustered items, overlapping labels and horizontal overflow.
- **Scenario assertions**: add an \`eval\` step that checks computed \`fill\`
  contrast, icon size, icon/value vertical centers, item spread and the target
  rectangle. Assertions on DOM presence alone let a broken UI pass.

## 7. Save the scenario

Write the verified steps to \`.cie/agent/scenarios/<name>.json\` and run it with \`run_test_scenario\`. Scenario files let the next run prove the fix instead of re-diagnosing.

## Report

State the root cause with file:line, the failing runtime sample, the minimal fix, and the passing scenario. Do not claim a fix from static reading alone.`,
  },
  {
    slug: "refactor-guard",
    name: "Refactor Guard",
    description:
      "Perform small, safe refactors with behavior preserved. Use when the user asks to clean up, split or simplify code without changing behavior.",
    body: `# Refactor Guard

Behavior must stay identical unless the user asked for a behavior change.

## Rules

- Read the whole function or component range before editing; keep the public API stable.
- Prefer 1-3 focused edits over rewriting a large file.
- Do not rename exported symbols, routes, CSS classes or data keys without updating every caller.
- Preserve error messages, status codes, defaults and persistence formats.
- Keep unrelated formatting changes out of the diff.
- After editing, run the project's typecheck, lint or the closest tests.
- Re-read the changed range to confirm the structure is intact.

## Stop conditions

If the refactor needs a schema change, a dependency upgrade or touches more than five files, stop and report the plan instead of making a risky partial change.`,
  },
  {
    slug: "requirements-first",
    name: "Requirements First",
    description:
      "Turn a user request into an exact acceptance table, locate the owning code, and prove the result before editing. Use when a task is vague, repeated, or burns tokens reading.",
    body: `# Requirements First

Do not explore the whole project. Convert the request into a small proof plan.

## 1. Restate the requirement

Write one line per behavior the user asked for. For each line define the exact input and expected output, for example: target 30, multiply, 30x1 -> score +1; 6x5 -> score +5.

## 2. Locate the owner

- Use project_search/find_in_file/read_symbol to find the one function that owns the behavior.
- Read only that function plus the smallest caller/range needed; prefer 2 files and 4 ranges maximum.
- Do not read a whole large file when a symbol range is enough.
- Do not assume a behavior is missing because a similar input guard exists.

## 3. Prove or edit

- Run the acceptance with a real check (browser_check, run_command, or the project test).
- If it already passes, finish with a before/after evidence table; do not invent a duplicate implementation.
- If it fails, make the smallest edit in the owning function and rerun the same check.

## 4. Stop the loop

If two verification attempts fail, do not read more files. Write the exact failing input, expected value and observed value; then use the canvas-game-verification skill or a focused repair call. Report the blocker if it is genuinely external.

## Output

Return: requirement table, files/lines inspected, check command or browser steps, before/after values, and the minimal change (or "no change needed" with evidence).`,
  },
  {
    slug: "skill-discovery",
    name: "Skill Discovery",
    description:
      "Find and safely add an agent skill when the user asks for a capability that is not installed. Search the catalog, present candidates, and install only with explicit approval.",
    body: `# Skill Discovery

Use this skill when the user asks for a skill/capability or when no installed skill matches the task.

## 1. Check what is already installed

Call list_skills before searching. Do not install a duplicate. The current auto-match already loads the best local skill; discovery is for gaps.

## 2. Search the public catalog

Use search_skills with a short domain + task query ("ui design", "playwright testing", "security audit"). Prefer official sources (vercel-labs, anthropics, microsoft) and skills with 1K+ installs. Treat install counts and stars as signals, not proof.

## 3. Present options

Show 2-3 candidates with name, source, install count, URL, and a one-line description. Explain what it would add. Do not install yet.

## 4. Install only with explicit approval

After the user approves:
1. preview_skill_source to inspect the candidate ids, files and warnings.
2. install_skill with scope=project and enable=false.
3. Tell the user to review SKILL.md and enable it from the Skills panel.

Never run \`npx skills add -g -y\`; never install globally or silently. Scripts and references are stored but never executed automatically. A skill is instructions, not trusted code.

## 5. If nothing fits

Say that no catalog skill matched and offer to solve the task directly, or create a project skill with create_skill.`,
  },
  {
    slug: "safe-change",
    name: "Safe Change",
    description:
      "Make the smallest correct change without breaking working behavior. Use for small edits, bug fixes and refactors where scope control matters.",
    body: `# Safe Change

## 1. Define the change

Write one sentence: the behavior before, the behavior after, and the exact observable check. If the request is ambiguous, ask one product question instead of guessing.

## 2. Locate the owner

Use project_search/read_symbol. Read only the owning function and the smallest caller range. Do not scan unrelated files.

## 3. Apply the smallest diff

- Preserve existing behavior, public APIs and working scenarios.
- Do not rewrite whole files or reformat unrelated code.
- Do not add duplicate features; inspect whether the behavior already exists.
- Keep the user's qualifiers (smaller/larger/only/never) exactly.

## 4. Verify the real thing

Run the project test/build or browser_check on the real page. For UI changes, check computed style and take a screenshot. Report before/after evidence.

## 5. Stop the loop

If two attempts fail, stop reading and report the exact failing input, expected value and observed value. Do not claim success without evidence.`,
  },
  {
    slug: "root-cause-debugging",
    name: "Root Cause Debugging",
    description:
      "Diagnose a bug with reproducible evidence instead of guessing. Use for errors, broken behavior, crashes and regressions outside pure UI styling.",
    body: `# Root Cause Debugging

## 1. Reproduce

Get a deterministic input or command that fails. Record the exact error, stack or observed output. Do not start by reading the whole project.

## 2. Trace the wiring

Use project_search, read_symbol and diagnostics to follow the real path: entry point -> caller -> owning function -> state -> output. Read only those ranges.

## 3. One hypothesis at a time

State the hypothesis and the smallest check that would disprove it. Change one variable. If the check passes, move to the next hypothesis; do not edit unrelated code.

## 4. Fix the cause

Fix the owning code, not the symptom. Preserve existing behavior and tests. Add or reuse a deterministic check for the failing case.

## 5. Prove and report

Rerun the same failing input and the project verification. Report: root cause with file:line, failing sample, minimal fix, before/after, and the command/check that passes. If the cause is external, say exactly what is missing.`,
  },
  {
    slug: "canvas-game-verification",
    name: "Canvas Game Verification",
    description:
      "Verify canvas game scoring or HUD behavior by pressing public keys and asserting score deltas. Use for point, timer, target, round and game-over tasks.",
    body: `# Canvas Game Verification

Prove the behavior through the public page. Never call game closure functions such as startRound, round, or state from an eval script; they are usually private.

## 1. Read the public state

Use the visible status/HUD to get the current target and operator. For this calculator the status text is like:

Hedef 30 · sadece × kullan · 10 sn

Do not guess the operator.

## 2. Press real keys

First check .cie/agent/scenarios for a matching saved scenario and run it with run_test_scenario. If none exists, use the first-class pressKeys step instead of a custom eval:

{"action":"browser_check","args":{"path":"index.html","steps":[
  {"action":"pressKeys","keys":["3","0","*","1","Enter"]},
  {"action":"expectText","selector":"#score","text":"1"}
]}}

Key mapping for this game: * = ×, - = −, + = +, Enter = =. Digits are single characters.

## 3. Make the round deterministic

If the target/operator is random, either wait for the wanted round or override Math.random before the next round starts. A short eval may prepare the state, but the key presses and score assertion must still be public:

{"action":"eval","value":"(async()=>{ /* wait for next round; override Math.random; return status */ })()"}

Then run pressKeys and expectText/expectValue. Read #score before and after and assert the delta, not the total, when previous score may be non-zero.

## 4. Report evidence

Return a compact table: target, operator, expression, before, after, expected delta, observed delta. If every row passes, say "no change needed" with the table. If a row fails, report the exact observed value and fix only the owning scoring code.

## 5. Tool failures

If pressKeys or eval fails, correct only that call. Do not keep re-reading the file. If the failure is a script error, use one small repair attempt; if it still fails, report the exact error.`,
  },
];

export async function ensureBuiltinSkills(dataDir: string): Promise<void> {
  const root = path.join(dataDir, "builtin-skills");
  const versionPath = path.join(root, ".version");
  const current = await fs.readFile(versionPath, "utf8").catch(() => "");
  if (current.trim() === BUILTIN_VERSION) return;
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  for (const skill of BUILTIN_SKILLS) {
    const directory = path.join(root, skill.slug);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const document = [
      "---",
      `name: ${skill.name}`,
      `description: ${skill.description}`,
      "---",
      "",
      skill.body,
      "",
    ].join("\n");
    await fs.writeFile(path.join(directory, "SKILL.md"), document, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  await fs.writeFile(versionPath, `${BUILTIN_VERSION}\n`, { encoding: "utf8", mode: 0o600 });
}

export function builtinSkillRoot(dataDir: string): string {
  return path.join(dataDir, "builtin-skills");
}
