import fs from "node:fs/promises";
import path from "node:path";

const BUILTIN_VERSION = "3";

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

## 6. Save the scenario

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
