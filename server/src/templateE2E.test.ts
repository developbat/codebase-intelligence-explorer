import assert from "node:assert/strict";
import test from "node:test";
import { listProjectTemplates } from "./scaffold";
import { TEMPLATE_E2E_CASES } from "./templateE2E";

test("template e2e matrix covers every scaffold template", () => {
  const templates = listProjectTemplates();
  assert.equal(TEMPLATE_E2E_CASES.length, templates.length);
  assert.deepEqual(
    new Set(TEMPLATE_E2E_CASES.map((item) => item.id)),
    new Set(templates.map((template) => template.id)),
  );
  for (const testCase of TEMPLATE_E2E_CASES) {
    assert.ok(testCase.expected.length > 0, `${testCase.id} has no expected files`);
    assert.ok(testCase.category, `${testCase.id} has no category`);
  }
});

test("template e2e matrix has commands for runnable templates", () => {
  const byId = new Map(TEMPLATE_E2E_CASES.map((item) => [item.id, item]));
  for (const id of ["react-vite", "node-express", "expo-mobile", "phaser-game", "three-scene"]) {
    const testCase = byId.get(id as never);
    assert.ok(testCase?.install, `${id} should install dependencies`);
    assert.ok(testCase?.verify?.length, `${id} should have a verification command`);
  }
  assert.ok(byId.get("python-fastapi")?.server);
  assert.ok(byId.get("php-web")?.server);
  assert.ok(byId.get("canvas-game")?.browser);
  assert.ok(byId.get("pwa-mobile")?.browser);
  assert.equal(byId.get("blank")?.category, "blank");
});
