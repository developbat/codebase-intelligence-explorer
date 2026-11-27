import assert from "node:assert/strict";
import test from "node:test";
import { isPureRecentWorkQuestion, isRecentWorkQuestion, renderRecentWorkAnswer } from "./ai/workState";

test("recent-work questions are recognized in Turkish and English", () => {
  assert.equal(isRecentWorkQuestion("son ne yaptık?"), true);
  assert.equal(isRecentWorkQuestion("neler değişti, son durum ne?"), true);
  assert.equal(isRecentWorkQuestion("what did we do last?"), true);
  assert.equal(isRecentWorkQuestion("summarize the recent work"), true);
});

test("recent-work detection uses the normalized intent when the wording is indirect", () => {
  assert.equal(
    isRecentWorkQuestion("devam?", {
      normalizedRequest: "Summarize what was last changed in the game.",
      behaviors: [
        {
          id: "b1",
          action: "other",
          surface: "other",
          target: "recent work summary",
          details: "",
          acceptance: "",
        },
      ],
    }),
    true,
  );
});

test("normal project questions are not treated as recent-work summaries", () => {
  assert.equal(isRecentWorkQuestion("maze nasıl çalışıyor?"), false);
  assert.equal(isRecentWorkQuestion("how does the wall-breaking code work?"), false);
  assert.equal(isRecentWorkQuestion("bu projede kaç dosya var?"), false);
});

test("recent-work answer reports the latest task, including blocked attempts", () => {
  const history = [
    {
      goal: "duvarları patlat",
      status: "failed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:10:00.000Z",
      tasks: [
        {
          id: "task-1",
          title: "Build: duvarları patlat",
          detail: "",
          status: "blocked",
          effort: "standard",
          role: "main",
          dependsOn: [],
          attempts: 2,
          changedFiles: ["game.js"],
          commands: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:10:00.000Z",
          resultSummary: "Token cap reached after the verification gate.",
        },
      ],
    },
  ] as never;
  const answer = renderRecentWorkAnswer(null, history, "tr");
  assert.match(answer, /Son görev/);
  assert.match(answer, /duvarları patlat/);
  assert.match(answer, /game\.js/);
  assert.match(answer, /blocked/);
});

test("only a pure work-summary question takes the zero-model path", () => {
  assert.equal(isPureRecentWorkQuestion("son ne yaptık?"), true);
  assert.equal(isPureRecentWorkQuestion("what did we do last?"), true);
  assert.equal(isPureRecentWorkQuestion("son ne yaptık? şimdi duvar ekle"), false);
  assert.equal(isPureRecentWorkQuestion("how does the maze work?"), false);
});
