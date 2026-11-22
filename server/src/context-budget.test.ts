import assert from "node:assert/strict";
import test from "node:test";
import { agentToolCatalog, resolveToolGroups, selectHistory } from "./ai/service";
import type { IntentAnalysis } from "../../shared/intent";

const editIntent: IntentAnalysis = {
  kind: "edit",
  understanding: "change a button color",
  language: "tr",
  needsClarification: false,
  scope: "small",
  mode: "single",
  areas: ["css/styles.css"],
  verification: "browser",
  context: "focused",
  history: "recent",
  toolGroups: ["browser"],
  approach: "search the stylesheet",
  needsExhaustiveEvidence: false,
  assumptions: [],
};

test("intent groups add mandatory edit and browser families", () => {
  const groups = resolveToolGroups(editIntent, "change the button color");
  assert.ok(groups.includes("edit"));
  assert.ok(groups.includes("browser"));
  assert.equal(groups.includes("command"), false);
  assert.equal(groups.includes("document"), false);
});

test("run and verification commands request the command family", () => {
  const runGroups = resolveToolGroups({ ...editIntent, kind: "run" }, "run the tests");
  assert.ok(runGroups.includes("command"));
  const testGroups = resolveToolGroups(
    { ...editIntent, verification: "test" },
    "change the button color",
  );
  assert.ok(testGroups.includes("command"));
});

test("attachments request the document family", () => {
  const groups = resolveToolGroups(
    { ...editIntent, kind: "analyze", verification: "none", toolGroups: [] },
    "list remaining tasks\n\nEk dosya: assets/tasks.md",
  );
  assert.ok(groups.includes("document"));
});

test("tool catalog keeps core tools and finish but drops unrelated groups", () => {
  const catalog = agentToolCatalog(false, true, false, ["core", "edit"]);
  assert.match(catalog, /"action":"replace_in_file"/);
  assert.match(catalog, /"action":"read_symbol"/);
  assert.match(catalog, /"action":"finish"/);
  assert.doesNotMatch(catalog, /"action":"web_fetch"/);
  assert.doesNotMatch(catalog, /"action":"read_document"/);
  assert.doesNotMatch(catalog, /"action":"run_command"/);
});

test("no intent keeps the full catalog for direct agent callers", () => {
  const catalog = agentToolCatalog(false, true, false);
  assert.match(catalog, /"action":"web_fetch"/);
  assert.match(catalog, /"action":"read_document"/);
  assert.match(catalog, /"action":"write_file"/);
});

test("history modes control how much conversation is sent", () => {
  const history = Array.from({ length: 10 }, (_, index) => ({
    role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `message-${index}-${"x".repeat(2_000)}`,
  }));
  assert.equal(selectHistory(history, "none").length, 0);
  assert.equal(selectHistory(history, "recent").length, 4);
  assert.equal(selectHistory(history, "extended").length, 8);
  assert.equal(selectHistory(history, "recent")[0].content.length, 800);
  assert.equal(selectHistory(history, "extended")[0].content.length, 1_200);
});
