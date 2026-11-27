import assert from "node:assert/strict";
import test from "node:test";
import { classifyChatQuestion, isChatQuestion } from "./ai/chatIntent";

function intent(overrides: Record<string, unknown> = {}) {
  return {
    kind: "question",
    understanding: "",
    language: "tr",
    needsClarification: false,
    scope: "trivial",
    mode: "single",
    areas: [],
    verification: "none",
    context: "project",
    history: "recent",
    toolGroups: [],
    behaviors: [
      {
        id: "b1",
        action: "other",
        surface: "other",
        target: "answer the question",
        details: "",
        acceptance: "",
      },
    ],
    constraints: [],
    ambiguities: [],
    confidence: 0.9,
    approach: "",
    needsExhaustiveEvidence: false,
    assumptions: [],
    ...overrides,
  } as never;
}

test("chat questions are classified before the task loop", () => {
  assert.equal(classifyChatQuestion("sen tam olarak nesin?"), "meta");
  assert.equal(classifyChatQuestion("ne yapabilirsin, hafızan var mı?"), "meta");
  assert.equal(classifyChatQuestion("son ne yaptık?"), "recent-work");
  assert.equal(
    classifyChatQuestion("move fonksiyonu nasıl çalışıyor?"),
    "project",
  );
  assert.equal(classifyChatQuestion("merhaba"), "general");
});

test("only read-only questions stay in chat", () => {
  assert.equal(isChatQuestion(intent(), "bu proje ne yapıyor?"), true);
  assert.equal(isChatQuestion(intent(), "son ne yaptık?"), true);
  assert.equal(
    isChatQuestion(
      intent({
        behaviors: [
          {
            id: "b1",
            action: "update",
            surface: "game",
            target: "duvar patlat",
            details: "",
            acceptance: "",
          },
        ],
      }),
      "duvar patlatma ekle",
    ),
    false,
  );
  assert.equal(
    isChatQuestion(intent({ needsExhaustiveEvidence: true }), "tüm dosyaları listele"),
    false,
  );
  assert.equal(isChatQuestion(intent({ kind: "edit" }), "kodu düzelt"), false);
});

test("an explanatory edit-labeled request still stays in chat", () => {
  assert.equal(
    isChatQuestion(
      intent({
        kind: "edit",
        behaviors: [
          {
            id: "b1",
            action: "other",
            surface: "game",
            target: "move function",
            details: "read and explain",
            acceptance: "explanation cites code",
          },
        ],
      }),
      "game.js içindeki move fonksiyonu nasıl çalışıyor? açıkla",
    ),
    true,
  );
  assert.equal(
    isChatQuestion(
      intent({ kind: "edit" }),
      "game.js içindeki move fonksiyonunu düzelt",
    ),
    false,
  );
});
