import assert from "node:assert/strict";
import test from "node:test";
import type { AnalysisResult } from "../../shared/types";
import { parseIntentResponse } from "./ai/intent";

const analysis = {
  projectName: "demo",
  rootPath: "/tmp/demo",
  files: [
    { path: "index.html" },
    { path: "css/styles.css" },
    { path: "js/script.js" },
  ],
  stats: { files: 3, folders: 2 },
  languages: { html: 1, css: 1, javascript: 1 },
  frameworks: ["Static HTML"],
  tooling: { testCommands: [], typecheckCommands: [], buildCommands: [] },
} as unknown as AnalysisResult;

test("intent JSON is parsed into a clarification with options", () => {
  const intent = parseIntentResponse(
    `\`\`\`json
    {
      "kind": "edit",
      "understanding": "Görev formuna detay alanı eklenecek",
      "language": "tr",
      "needsClarification": true,
      "question": "Görev detayı nasıl çalışsın?",
      "options": [
        { "label": "Çok satırlı alan", "suffix": "Netleştirme: textarea ekle." },
        { "label": "Panel", "suffix": "Netleştirme: detay paneli ekle." }
      ],
      "scope": "small",
      "mode": "single",
      "areas": ["index.html", "css/styles.css"],
      "verification": "browser",
      "assumptions": ["Static HTML"]
    }
    \`\`\``,
    analysis,
    "görev detayı ekle",
  );
  assert.equal(intent.kind, "edit");
  assert.equal(intent.needsClarification, true);
  assert.equal(intent.question, "Görev detayı nasıl çalışsın?");
  assert.equal(intent.options?.length, 2);
  assert.equal(intent.options?.[0].id, "opt-1");
  assert.equal(intent.scope, "small");
  assert.equal(intent.mode, "single");
  assert.deepEqual(intent.areas, ["index.html", "css/styles.css"]);
  assert.equal(intent.verification, "browser");
});

test("already clarified requests never ask again", () => {
  const intent = parseIntentResponse(
    JSON.stringify({
      kind: "edit",
      understanding: "Add a multiline detail field",
      language: "en",
      needsClarification: true,
      question: "Which field?",
      options: [{ label: "Detail", suffix: "Add detail." }],
      scope: "small",
      mode: "single",
      areas: [],
      verification: "browser",
    }),
    analysis,
    "add task detail",
    true,
  );
  assert.equal(intent.needsClarification, false);
  assert.equal(intent.question, undefined);
});

test("unsafe and invented areas are removed", () => {
  const intent = parseIntentResponse(
    JSON.stringify({
      kind: "edit",
      understanding: "Change CSS",
      needsClarification: false,
      scope: "small",
      mode: "single",
      areas: ["css/styles.css", "../secret", "/etc/passwd", ".git/config"],
      verification: "browser",
    }),
    analysis,
    "change CSS",
  );
  assert.deepEqual(intent.areas, ["css/styles.css"]);
});

test("invalid replies throw so the caller can retry", () => {
  assert.throws(() => parseIntentResponse("not json", analysis, "x"), /JSON/i);
});

test("document checkbox operations are preserved", () => {
  const intent = parseIntentResponse(
    JSON.stringify({
      kind: "analyze",
      understanding: "list unchecked",
      needsClarification: false,
      scope: "trivial",
      mode: "single",
      areas: [],
      verification: "none",
      approach: "search for unchecked markers and collect every match",
      needsExhaustiveEvidence: true,
    }),
    analysis,
    "list remaining tasks",
  );
  assert.match(intent.approach, /unchecked markers/);
  assert.equal(intent.needsExhaustiveEvidence, true);
});

test("context, history and tool groups are parsed", () => {
  const intent = parseIntentResponse(
    JSON.stringify({
      kind: "edit",
      understanding: "change a color",
      needsClarification: false,
      scope: "small",
      mode: "single",
      areas: [],
      verification: "browser",
      context: "focused",
      history: "extended",
      toolGroups: ["edit", "browser", "unknown-group"],
    }),
    analysis,
    "change color",
  );
  assert.equal(intent.context, "focused");
  assert.equal(intent.history, "extended");
  assert.deepEqual(intent.toolGroups, ["edit", "browser"]);
});

test("missing context fields fall back to project and recent", () => {
  const intent = parseIntentResponse(
    JSON.stringify({
      kind: "question",
      understanding: "explain the project",
      needsClarification: false,
      scope: "small",
      mode: "single",
      areas: [],
      verification: "none",
    }),
    analysis,
    "explain",
  );
  assert.equal(intent.context, "project");
  assert.equal(intent.history, "recent");
  assert.deepEqual(intent.toolGroups, []);
});

test("run/preview requests override a project-switch clarification", () => {
  const intent = parseIntentResponse(
    JSON.stringify({
      kind: "analyze",
      understanding: "show the interface",
      language: "tr",
      needsClarification: true,
      question: "Hangi projeyi kullanayım?",
      options: [{ label: "neon-escape", suffix: "neon-escape projesine geç." }],
      scope: "small",
      mode: "single",
      areas: [],
      verification: "none",
      context: "focused",
      history: "recent",
      toolGroups: [],
      approach: "",
      needsExhaustiveEvidence: false,
      assumptions: [],
    }),
    analysis,
    "arayüzü aktif et önizleme de göster",
  );
  assert.equal(intent.kind, "run");
  assert.equal(intent.needsClarification, false);
  assert.equal(intent.verification, "browser");
  assert.ok(intent.toolGroups.includes("command"));
  assert.ok(intent.toolGroups.includes("browser"));
});
