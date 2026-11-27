import assert from "node:assert/strict";
import test from "node:test";
import { classifyChatQuestion, isChatQuestion, planChat } from "./ai/chatIntent";

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

test("capability gate narrows model, context, tools and research", () => {
  const meta = planChat("sen tam olarak nesin, hafızan var mı?");
  assert.equal(meta.mode, "meta");
  assert.equal(meta.needsProjectContext, false);
  assert.equal(meta.needsTools, false);
  assert.equal(meta.promptId, "chat.meta");

  const recent = planChat("son ne yaptık?");
  assert.equal(recent.mode, "recent-work");
  assert.equal(recent.needsModel, false);
  assert.equal(recent.needsTools, false);

  const code = planChat("game.js içindeki move fonksiyonu nasıl çalışıyor?");
  assert.equal(code.mode, "project");
  assert.equal(code.needsProjectContext, true);
  assert.equal(code.needsTools, false);
  assert.equal(code.promptId, "chat.answer");

  const debugging = planChat("bu hatanın kök nedenini açıkla");
  assert.equal(debugging.mode, "project");
  assert.ok(debugging.skillSlugs.includes("root-cause-debugging"));

  assert.equal(planChat("aynı dosyadan var mı?").mode, "action");
  assert.equal(planChat("disk kullanımı ne kadar?").mode, "action");
  assert.equal(planChat("hatırlatıcılarım neler?").mode, "action");
  assert.equal(planChat("bu QR kodu oluştur").mode, "action");
  assert.equal(planChat("İstanbul hava durumu nasıl?").mode, "action");
  assert.equal(planChat("şu an saat kaç?").mode, "action");

  const action = planChat("duvar patlatma özelliği ekle");
  assert.equal(action.mode, "action");
  assert.equal(action.needsTools, true);

  const research = planChat("web'de güncel DeepSeek fiyatlarını araştır");
  assert.equal(research.mode, "research");
  assert.equal(research.needsResearch, true);
  assert.equal(research.needsTools, true);
  assert.equal(research.promptId, "chat.research");

  const general = planChat("merhaba");
  assert.equal(general.mode, "general");
  assert.equal(general.needsTools, false);
});
