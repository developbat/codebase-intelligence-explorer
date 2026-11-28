import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { IntentAnalysis } from "../../shared/intent";
import {
  applyDomainClarification,
  domainPromptFacts,
  matchDomainCards,
  normalizeDomainText,
  pickDomainQuestion,
  prepareDomainBrief,
} from "./ai/domainKnowledge";

function baseIntent(patch: Partial<IntentAnalysis> = {}): IntentAnalysis {
  return {
    kind: "scaffold",
    understanding: "build a game",
    language: "en",
    needsClarification: false,
    scope: "medium",
    mode: "single",
    areas: [],
    verification: "browser",
    context: "project",
    history: "recent",
    toolGroups: ["edit", "browser"],
    approach: "",
    needsExhaustiveEvidence: false,
    assumptions: [],
    ...patch,
  };
}

test("normalizes Turkish text for signal matching", () => {
  assert.equal(normalizeDomainText("SATRANÇ Oyunu"), "satranc oyunu");
  assert.equal(normalizeDomainText("3'lü Eşleştirme"), "3 lu eslestirme");
});

test("matches domain cards from Turkish and English requests", () => {
  const chess = matchDomainCards("satranç oyunu yap");
  assert.equal(chess[0]?.card.id, "chess");

  const puzzle = matchDomainCards("kedili puzzle tasarla");
  assert.equal(puzzle[0]?.card.id, "puzzle");

  const todo = matchDomainCards("todo app yap");
  assert.equal(todo[0]?.card.id, "todo-dashboard");

  const booking = matchDomainCards("randevu sistemi yap");
  assert.equal(booking[0]?.card.id, "booking");

  const platformer = matchDomainCards("platform oyunu yap");
  assert.equal(platformer[0]?.card.id, "platformer");
});

test("does not match unrelated code work", () => {
  assert.deepEqual(matchDomainCards("dosyayı oku ve hatayı açıkla"), []);
});

test("picks the unanswered high-impact question", () => {
  const puzzle = matchDomainCards("kedili puzzle yap")[0]?.card;
  assert.ok(puzzle);
  assert.equal(pickDomainQuestion(puzzle, "kedili puzzle yap")?.id, "mechanic");
  assert.equal(
    pickDomainQuestion(puzzle, "3'lü eşleştirme kedili puzzle yap")?.id,
    "scope",
  );
});

test("forces a card question for a new build", () => {
  const match = matchDomainCards("satranç oyunu yap")[0];
  const intent = applyDomainClarification(baseIntent(), "satranç oyunu yap", match, "tr");
  assert.equal(intent.needsClarification, true);
  assert.match(intent.question ?? "", /kime karşı/i);
  assert.equal(intent.options?.length, 3);
  assert.ok(intent.assumptions.some((item) => item.startsWith("Domain: Chess")));
});

test("does not force a card question after clarification or for an edit", () => {
  const match = matchDomainCards("satranç oyunu yap")[0];
  assert.equal(
    applyDomainClarification(baseIntent(), "satranç oyunu yap", match, "en", true)
      .needsClarification,
    false,
  );
  assert.equal(
    applyDomainClarification(
      baseIntent({ kind: "edit", scope: "small" }),
      "satrançta rok kuralını düzelt",
      match,
      "en",
    ).needsClarification,
    false,
  );
  assert.equal(
    applyDomainClarification(
      baseIntent({ kind: "edit", scope: "small" }),
      "make the chess board blue",
      match,
      "en",
    ).needsClarification,
    false,
  );
  assert.equal(
    applyDomainClarification(
      baseIntent({ kind: "edit", scope: "large" }),
      "add a full chess game to the app",
      match,
      "en",
    ).needsClarification,
    true,
  );
  assert.equal(
    applyDomainClarification(
      baseIntent({ kind: "question", scope: "small" }),
      "satranç nasıl oynanır",
      match,
      "en",
    ).needsClarification,
    false,
  );
});

test("prompt facts carry rules and verification", () => {
  const match = matchDomainCards("satranç oyunu yap")[0];
  assert.ok(match);
  const facts = domainPromptFacts(match);
  assert.match(facts, /Core rules/);
  assert.match(facts, /castling/i);
  assert.match(facts, /Verification checklist/);
});

test("writes a reusable brief once", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-domain-"));
  try {
    const first = await prepareDomainBrief(root, "make a chess game");
    assert.ok(first);
    assert.equal(first.relPath, ".cie/agent/knowledge/chess.md");
    assert.equal(first.wrote, true);
    const file = path.join(root, first.relPath);
    const content = await fs.readFile(file, "utf8");
    assert.match(content, /# Chess domain brief/);
    assert.match(content, /## Verification checklist/);
    assert.match(content, /castling/i);

    await fs.writeFile(file, "# edited by the user\n", "utf8");
    const second = await prepareDomainBrief(root, "make a chess game");
    assert.ok(second);
    assert.equal(second.wrote, false);
    assert.equal(await fs.readFile(file, "utf8"), "# edited by the user\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
