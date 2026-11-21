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
