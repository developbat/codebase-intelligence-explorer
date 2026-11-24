import assert from "node:assert/strict";
import test from "node:test";
import type { IntentAnalysis } from "../../shared/intent";
import { actionPlanInstruction, resolveActionPlan } from "./ai/actions";

const intent = (kind: IntentAnalysis["kind"]): IntentAnalysis => ({
  kind,
  understanding: "test",
  language: "tr",
  needsClarification: false,
  scope: "small",
  mode: "single",
  areas: [],
  verification: "none",
  context: "project",
  history: "none",
  toolGroups: [],
  approach: "",
  needsExhaustiveEvidence: false,
  assumptions: [],
});

test("resolves action classes for list, edit, locate, explain, verify and run", () => {
  assert.equal(
    resolveActionPlan("bana uygulamadaki buton listesini getir", intent("analyze")).action,
    "list",
  );
  const edit = resolveActionPlan("PLAY AGAIN butonunu RESTART yap", intent("edit"));
  assert.equal(edit.action, "edit");
  assert.equal(edit.needsWrite, true);
  assert.equal(
    resolveActionPlan("create_app nerede tanımlı?", intent("analyze")).action,
    "locate",
  );
  assert.equal(resolveActionPlan("bu projeyi açıkla", intent("analyze")).action, "explain");
  const site = resolveActionPlan("siteyi incele", intent("analyze"));
  assert.equal(site.action, "verify");
  assert.equal(site.needsBrowser, true);
  const verify = resolveActionPlan("testleri çalıştır", intent("analyze"));
  assert.equal(verify.action, "verify");
  assert.equal(verify.needsCommand, true);
  assert.equal(resolveActionPlan("uygulamayı çalıştır", intent("run")).action, "run");
});

test("handles scaffold and project tools", () => {
  assert.equal(resolveActionPlan("yeni bir proje oluştur", intent("scaffold")).action, "scaffold");
  assert.equal(
    resolveActionPlan("check-links adında bir proje aracı oluştur", intent("edit")).action,
    "tool",
  );
});

test("action instructions match the selected action", () => {
  const list = resolveActionPlan("list all buttons", intent("analyze"));
  assert.match(actionPlanInstruction(list), /extract_entities/);
  const verify = resolveActionPlan("run the tests", intent("analyze"));
  assert.match(actionPlanInstruction(verify), /successful command/);
  const locate = resolveActionPlan("where is create_app defined?", intent("analyze"));
  assert.match(actionPlanInstruction(locate), /file:line/);
});
