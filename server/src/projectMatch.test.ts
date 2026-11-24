import assert from "node:assert/strict";
import test from "node:test";
import {
  detectProjectMismatch,
  projectHasUi,
  projectSummaryHasUi,
  requestIsCurrentProjectScope,
  requestIsRunPreview,
  requestMentionsUi,
} from "../../shared/projectMatch";

test("detects UI requests and current-project audits", () => {
  assert.equal(requestMentionsUi("bana oyundaki butonların listesini getir"), true);
  assert.equal(requestMentionsUi("list all buttons in the app"), true);
  assert.equal(requestMentionsUi("add a canvas screen"), true);
  assert.equal(requestMentionsUi("where is AddTodoDataUseCase defined?"), false);

  assert.equal(requestIsCurrentProjectScope("projede buton var mı?"), true);
  assert.equal(requestIsCurrentProjectScope("does this project have a UI?"), true);
  assert.equal(requestIsCurrentProjectScope("bana oyundaki butonları getir"), false);
});

test("detects UI projects without treating API-only projects as UI", () => {
  assert.equal(projectHasUi({ files: [{ path: "index.html" }] }), true);
  assert.equal(projectHasUi({ files: [{ path: "src/App.tsx" }] }), true);
  assert.equal(projectHasUi({ files: [{ path: "resources/views/home.blade.php" }] }), true);
  assert.equal(projectHasUi({ frameworks: ["Laravel"] }), true);
  assert.equal(projectHasUi({ frameworks: ["React Native"] }), true);
  assert.equal(projectHasUi({ languages: { HTML: 4, CSS: 2 } }), true);
  assert.equal(projectHasUi({ files: [{ path: "app/main.py" }], frameworks: ["FastAPI"] }), false);
  assert.equal(projectHasUi({ files: [{ path: "main.go" }], frameworks: ["Go"] }), false);
  assert.equal(projectSummaryHasUi({ frameworks: ["Express"], languages: { TypeScript: 12 } }), false);
});

test("flags a UI request on an API project but not a current-project audit", () => {
  const api = { files: [{ path: "app/main.py" }], frameworks: ["FastAPI"] };
  assert.deepEqual(detectProjectMismatch("bana oyundaki butonları getir", api), {
    mismatch: true,
    uiRequest: true,
    hasUi: false,
  });
  assert.equal(detectProjectMismatch("projede buton var mı?", api).mismatch, false);
  const web = { files: [{ path: "index.html" }] };
  assert.equal(detectProjectMismatch("bana oyundaki butonları getir", web).mismatch, false);
});

test("run/preview requests stay on the active Python UI project", async () => {
  const instruction = "arayüzü aktif et önizleme de göster";
  assert.equal(requestIsRunPreview(instruction), true);
  assert.equal(requestIsCurrentProjectScope(instruction), true);
  assert.equal(projectHasUi({ frameworks: ["Streamlit"] }), true);
  assert.equal(projectHasUi({ files: [{ path: "app.py" }] }), true);
  assert.equal(projectHasUi({ files: [{ path: "notebook.ipynb" }] }), true);

  const { projectMismatchClarification } = await import("./ai/intent");
  const intent = {
    kind: "analyze" as const,
    understanding: "activate the interface",
    language: "tr",
    needsClarification: false,
    question: undefined,
    options: [],
    scope: "small" as const,
    mode: "single" as const,
    areas: [],
    verification: "none" as const,
    context: "focused" as const,
    history: "recent" as const,
    toolGroups: [],
    approach: "",
    needsExhaustiveEvidence: false,
    assumptions: [],
  };
  const analysis = {
    id: "api",
    projectName: "todo-api",
    files: [{ path: "app/main.py" }],
    frameworks: ["FastAPI"],
    languages: { Python: 74 },
  } as unknown as Parameters<typeof projectMismatchClarification>[2];
  const recent = [
    {
      id: "game",
      projectName: "neon-escape",
      rootPath: "/tmp/neon-escape",
      frameworks: ["Static HTML"],
      languages: { HTML: 4, CSS: 2 },
    },
  ] as unknown as Parameters<typeof projectMismatchClarification>[3];

  assert.equal(projectMismatchClarification(intent, instruction, analysis, recent), null);
});

test("builds a project-switch clarification for UI requests on API projects", async () => {
  const { projectMismatchClarification } = await import("./ai/intent");
  const intent = {
    kind: "analyze" as const,
    understanding: "list buttons",
    language: "tr",
    needsClarification: true,
    question: "Neyin listesini istiyorsunuz?",
    options: [
      { id: "opt-1", label: "Bu projedeki butonlar", instructionSuffix: "Bu projede ara." },
      { id: "opt-2", label: "Başka bir oyun projesi", instructionSuffix: "Yol belirteceğim." },
    ],
    scope: "small" as const,
    mode: "single" as const,
    areas: [],
    verification: "none" as const,
    context: "focused" as const,
    history: "none" as const,
    toolGroups: [],
    approach: "",
    needsExhaustiveEvidence: true,
    assumptions: [],
  };
  const analysis = {
    id: "api",
    projectName: "todo-api",
    files: [{ path: "app/main.py" }],
    frameworks: ["FastAPI"],
    languages: { Python: 74 },
  } as unknown as Parameters<typeof projectMismatchClarification>[2];
  const recent = [
    {
      id: "game",
      projectName: "neon-escape",
      rootPath: "/tmp/neon-escape",
      frameworks: ["Static HTML"],
      languages: { HTML: 4, CSS: 2 },
    },
    {
      id: "api2",
      projectName: "cart-api",
      rootPath: "/tmp/cart-api",
      frameworks: ["Express"],
      languages: { TypeScript: 12 },
    },
  ] as unknown as Parameters<typeof projectMismatchClarification>[3];

  const clarified = projectMismatchClarification(intent, "bana oyundaki butonları getir", analysis, recent);
  assert.ok(clarified);
  assert.equal(clarified?.needsClarification, true);
  assert.ok(clarified?.question?.includes("todo-api"));
  assert.ok(clarified?.options?.some((option) => option.projectId === "game"));
  assert.ok(clarified?.options?.some((option) => option.id === "search-anyway"));
  assert.ok(!clarified?.options?.some((option) => /Başka bir oyun/i.test(option.label)));
  assert.ok(clarified?.options?.some((option) => /Bu projedeki butonlar/i.test(option.label)));

  assert.equal(
    projectMismatchClarification(intent, "projede buton var mı?", analysis, recent),
    null,
  );
  assert.equal(
    projectMismatchClarification(
      intent,
      "bana oyundaki butonları getir",
      { ...analysis, files: [{ path: "index.html" }] } as unknown as Parameters<
        typeof projectMismatchClarification
      >[2],
      recent,
    ),
    null,
  );
});
