import assert from "node:assert/strict";
import test from "node:test";
import { detectClarification } from "../../shared/clarification";

test("ambiguous time requests ask before spending model tokens", () => {
  const request = detectClarification("görevlere saat ekleme özelliği ekle");
  assert.ok(request);
  assert.match(request.question, /saat/i);
  assert.deepEqual(
    request.options.map((option) => option.id),
    ["creation", "due", "timer", "assume"],
  );
  assert.match(request.options[1].instructionSuffix, /hatırlatma/i);
});

test("qualified time requests and clear edits are not interrupted", () => {
  assert.equal(detectClarification("görevlere bitiş saati ekle"), null);
  assert.equal(detectClarification("görev oluşturulma saatini göster"), null);
  assert.equal(detectClarification("arka planı siyah yap"), null);
  assert.equal(detectClarification("fix the null check in order.service.ts"), null);
});

test("one-word edit requests ask for the missing object", () => {
  const request = detectClarification("ekle");
  assert.ok(request);
  assert.match(request.question, /Neyi/i);
  assert.equal(detectClarification("ekle", { askMode: true }), null);
});

test("already clarified instructions and questions are not asked again", () => {
  assert.equal(
    detectClarification(
      "görevlere saat ekleme özelliği ekle\n\nNetleştirme: Görev oluşturulduğu andaki saat kaydedilsin.",
    ),
    null,
  );
  assert.equal(detectClarification("saat nasıl eklenir?"), null);
});

test("task detail field requests ask for the field shape before coding", () => {
  const request = detectClarification("görev eklemeye bir alan daha ekleyelim görev detayı.");
  assert.ok(request);
  assert.match(request.question, /detay/i);
  assert.deepEqual(
    request.options.map((option) => option.id),
    ["textarea", "panel", "both", "assume"],
  );
  assert.equal(detectClarification("görev detayı için textarea ekle"), null);
});

test("generic add-field requests ask which field is meant", () => {
  const request = detectClarification("forma bir alan daha ekleyelim");
  assert.ok(request);
  assert.match(request.question, /Hangi alan/i);
  assert.deepEqual(
    request.options.map((option) => option.id),
    ["detail", "priority", "label", "due", "assume"],
  );
});
