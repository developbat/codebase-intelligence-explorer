import assert from "node:assert/strict";
import test from "node:test";
import type { AnalysisResult } from "../../shared/types";
import { intentNeedsConfirmation, parseIntentResponse, shouldRequestIntentConfirmation } from "./ai/intent";

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


test("explicit remove/keep instructions become edits instead of clarification requests", () => {
  const instruction =
    "üst HUD'daki İşlem göstergesini kaldır. Canvas içindeki yinelenen HEDEF yazısını kaldır. Hedef ve puan tek bir üst barda kalsın; Süre çipi aynı barda kalsın. Operatör butonu vurgusunu ve alt giriş alanını bozma. Gerçek sayfada doğrula.";
  const intent = parseIntentResponse(
    JSON.stringify({
      kind: "analyze",
      understanding: instruction,
      needsClarification: true,
      question: "HUD’da hangi öğeleri kaldırmak istediğinizi netleştirir misiniz?",
      options: [
        {
          label: "İşlem göstergesini kaldır, hedef ve puanı tek üst bar",
          suffix: "İşlem göstergesini kaldır, hedef ve puanı tek üst bar’da tut.",
        },
        {
          label: "İşlem göstergesini kaldır, hedef ve puanı ayrı üst bar",
          suffix: "İşlem göstergesini kaldır, hedef ve puanı ayrı üst bar’da tut.",
        },
      ],
      scope: "small",
      mode: "single",
      areas: ["index.html"],
      verification: "browser",
    }),
    analysis,
    instruction,
  );
  assert.equal(intent.kind, "edit");
  assert.equal(intent.needsClarification, false);
});

test("intent selects at most three unique skill slugs", () => {
  const intent = parseIntentResponse(
    JSON.stringify({
      kind: "edit",
      understanding: "Fix the HUD icons",
      language: "en",
      needsClarification: false,
      scope: "small",
      mode: "single",
      areas: ["index.html"],
      verification: "browser",
      toolGroups: ["edit", "browser"],
      skills: ["runtime-ui-debugging", "RUNTIME-UI-DEBUGGING", "safe-change", "root-cause-debugging", "extra"],
      approach: "Inspect the HUD and verify computed style.",
    }),
    analysis,
    "fix the HUD icons",
  );
  assert.deepEqual(intent.skills, [
    "runtime-ui-debugging",
    "safe-change",
    "root-cause-debugging",
  ]);
});

test("parses the structured intent spec", () => {
  const intent = parseIntentResponse(
    JSON.stringify({
      kind: "edit",
      understanding: "HUD ikonlarını 20px yap ve hedefi beyaz yap",
      language: "tr",
      normalizedRequest: "Set HUD icons to 20px and make the target white.",
      behaviors: [
        {
          id: "b1",
          action: "update",
          surface: "ui",
          target: "HUD icons",
          details: "20px",
          acceptance: "icon size is 20px",
        },
        {
          id: "b2",
          action: "update",
          surface: "ui",
          target: "target",
          details: "white",
          acceptance: "target color is white",
        },
      ],
      constraints: ["do not change the scoring"],
      ambiguities: [],
      confidence: 0.92,
      scope: "small",
      mode: "single",
      areas: ["index.html"],
      verification: "browser",
    }),
    analysis,
    "HUD ikonlarını 20px yap ve hedefi beyaz yap",
  );
  assert.equal(intent.normalizedRequest, "Set HUD icons to 20px and make the target white.");
  assert.equal(intent.behaviors?.length, 2);
  assert.equal(intent.behaviors?.[1]?.surface, "ui");
  assert.deepEqual(intent.constraints, ["do not change the scoring"]);
  assert.equal(intent.confidence, 0.92);
});

test("low-confidence and fallback intents require confirmation", () => {
  const fallback = {
    kind: "edit" as const,
    confidence: 0.45,
    behaviors: [
      {
        id: "b1",
        action: "update" as const,
        surface: "other" as const,
        target: "şimdi oyunda bir kaç değişiklik yapmak istiyorum",
        details: "",
        acceptance: "",
      },
    ],
    assumptions: ["Intent analyst could not parse its reply; proceeding with one focused task."],
  };
  const fallbackResult = intentNeedsConfirmation(
    fallback as never,
    "bir kaç değişiklik yap: maz üret ve duvarları patlat",
  );
  assert.equal(fallbackResult.needed, true);
  assert.match(fallbackResult.reason, /fell back|fallback/i);

  const lowConfidence = intentNeedsConfirmation(
    { kind: "edit", confidence: 0.55, behaviors: [], assumptions: [] } as never,
    "make the screen nicer",
  );
  assert.equal(lowConfidence.needed, true);
  assert.match(lowConfidence.reason, /confidence/i);
});

test("confirmation is skipped for confident single behavior and questions", () => {
  const single = intentNeedsConfirmation(
    {
      kind: "edit",
      confidence: 0.92,
      behaviors: [
        {
          id: "b1",
          action: "update",
          surface: "ui",
          target: "button color",
          details: "blue",
          acceptance: "button is blue",
        },
      ],
      assumptions: [],
    } as never,
    "butonu mavi yap",
  );
  assert.equal(single.needed, false);

  const question = intentNeedsConfirmation(
    { kind: "question", confidence: 0.4, behaviors: [], assumptions: [] } as never,
    "bu proje ne yapıyor?",
  );
  assert.equal(question.needed, false);
});

test("a multi-part signal with one collapsed behavior requires confirmation", () => {
  const result = intentNeedsConfirmation(
    {
      kind: "edit",
      confidence: 0.9,
      behaviors: [
        {
          id: "b1",
          action: "update",
          surface: "other",
          target: "the game",
          details: "",
          acceptance: "",
        },
      ],
      assumptions: [],
    } as never,
    "oyunda birkaç değişiklik yap; maz üret ve duvarları patlat",
  );
  assert.equal(result.needed, true);
  assert.match(result.reason, /several changes|one behavior/i);
});

test("endpoint confirmation gate suppresses resume, retry and explicit confirmation", () => {
  const intent = {
    kind: "edit",
    confidence: 0.45,
    behaviors: [],
    assumptions: ["Intent analyst could not parse its reply; proceeding with one focused task."],
  } as never;
  assert.equal(
    shouldRequestIntentConfirmation({ intent, instruction: "birkaç değişiklik yap" }).needed,
    true,
  );
  assert.equal(
    shouldRequestIntentConfirmation({ intent, instruction: "birkaç değişiklik yap", resuming: true }).needed,
    false,
  );
  assert.equal(
    shouldRequestIntentConfirmation({ intent, instruction: "birkaç değişiklik yap", retryFailed: true }).needed,
    false,
  );
  assert.equal(
    shouldRequestIntentConfirmation({ intent, instruction: "birkaç değişiklik yap", confirmed: true }).needed,
    false,
  );
  assert.equal(
    shouldRequestIntentConfirmation({ intent, instruction: "birkaç değişiklik yap", clarified: true }).needed,
    false,
  );
  assert.equal(
    shouldRequestIntentConfirmation({ intent, instruction: "birkaç değişiklik yap", replan: true }).needed,
    false,
  );
});
