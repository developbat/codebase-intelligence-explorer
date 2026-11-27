import assert from "node:assert/strict";
import test from "node:test";
import {
  allToolSpecs,
  renderAgentToolCatalog,
  suggestToolsForInstruction,
  toolGroupsFor,
  validateToolArgs,
} from "./ai/toolRegistry";

test("tool registry drives group-filtered catalogs", () => {
  const catalog = renderAgentToolCatalog(false, true, false, ["core", "edit"]);
  assert.match(catalog, /"action":"replace_in_file"/);
  assert.match(catalog, /"action":"read_symbol"/);
  assert.match(catalog, /"action":"finish"/);
  assert.doesNotMatch(catalog, /"action":"web_fetch"/);
  assert.doesNotMatch(catalog, /"action":"read_document"/);
  assert.doesNotMatch(catalog, /"action":"run_command"/);
});

test("full catalog exposes every group when no filter is provided", () => {
  const catalog = renderAgentToolCatalog(false, true, false);
  assert.match(catalog, /"action":"web_fetch"/);
  assert.match(catalog, /"action":"read_document"/);
  assert.match(catalog, /"action":"write_file"/);
  assert.match(catalog, /"action":"load_skill"/);
  assert.match(catalog, /"action":"search_skills"/);
});

test("read-only catalogs hide writes and commands but keep notes", () => {
  const readOnly = renderAgentToolCatalog(true, false, false);
  assert.doesNotMatch(readOnly, /"action":"write_file"/);
  assert.doesNotMatch(readOnly, /"action":"run_command"/);
  assert.doesNotMatch(readOnly, /"action":"delete_file"/);
  assert.doesNotMatch(readOnly, /"action":"delegate_research"/);

  const notes = renderAgentToolCatalog(true, false, false, ["notes"]);
  assert.match(notes, /"action":"save_note"/);
});

test("approval and destructive metadata are rendered", () => {
  const needsApproval = renderAgentToolCatalog(false, false, false);
  assert.match(needsApproval, /write_file[\s\S]*requires user approval/);
  assert.match(needsApproval, /run_command[\s\S]*requires user approval/);
  assert.match(needsApproval, /run_background[\s\S]*requires user approval/);
  assert.match(needsApproval, /delete_file[\s\S]*always requires confirmation/);
  assert.match(needsApproval, /rename_path[\s\S]*always requires confirmation/);

  const approved = renderAgentToolCatalog(false, true, true);
  assert.doesNotMatch(approved, /write_file[^\n]*requires user approval/);
  assert.doesNotMatch(approved, /run_command[^\n]*requires user approval/);
});

test("argument schemas accept path aliases and reject missing/typed values", () => {
  assert.equal(validateToolArgs("read_file", { file: "src/app.ts" }), null);
  assert.match(validateToolArgs("read_file", { startLine: 1 }) ?? "", /allowed shape/);
  assert.match(validateToolArgs("read_file", { path: 3 }) ?? "", /path must be string/);
  assert.equal(validateToolArgs("write_file", { path: "a.ts", content: "x" }), null);
  assert.match(validateToolArgs("run_command", {}) ?? "", /requires one of: command/);
  assert.equal(validateToolArgs("run_background", { command: "node server.js" }), null);
  assert.match(validateToolArgs("run_background", {}) ?? "", /requires one of: command/);
  assert.match(validateToolArgs("stop_background", {}) ?? "", /requires one of: jobId/);
  assert.equal(validateToolArgs("find_duplicates", { path: "assets" }), null);
  assert.equal(validateToolArgs("storage_summary", { top: 5 }), null);
  assert.equal(validateToolArgs("create_reminder", { title: "Send report" }), null);
  assert.equal(validateToolArgs("list_reminders", {}), null);
  assert.match(validateToolArgs("create_calendar_event", { title: "Review" }) ?? "", /requires one of: start/);
});

test("capability suggestions follow the request and selected groups", () => {
  const game = suggestToolsForInstruction("oyunu oyna ve test et", ["core", "browser"]);
  assert.ok(game.includes("browser_check") || game.includes("run_test_scenario"));
  const color = suggestToolsForInstruction("rename button color to red", ["core", "edit"]);
  assert.ok(
    color.includes("apply_mapped_changes") ||
      color.includes("extract_entities") ||
      color.includes("list_colors"),
  );
  const web = suggestToolsForInstruction("fetch the release page", ["web"]);
  assert.ok(web.includes("web_fetch"));
  assert.equal(web.includes("write_file"), false);
});

test("every tool action is unique and grouped", () => {
  const actions = allToolSpecs().map((tool) => tool.action);
  assert.equal(new Set(actions).size, actions.length);
  assert.ok(toolGroupsFor("write_file").includes("edit"));
  assert.ok(toolGroupsFor("browser_check").includes("browser"));
  assert.ok(toolGroupsFor("load_skill").includes("core"));
  assert.ok(toolGroupsFor("search_skills").includes("skills"));
  for (const tool of allToolSpecs()) {
    assert.ok(tool.description.length > 0);
    assert.ok(tool.whenToUse.length > 0);
    assert.ok(tool.example.includes('"action"'));
  }
});


test("replace_in_file accepts an empty replacement and common aliases", () => {
  assert.equal(validateToolArgs("replace_in_file", { path: "a.js", find: "x", replace: "" }), null);
  assert.equal(
    validateToolArgs("replace_in_file", { file: "a.js", oldText: "x", newText: "y" }),
    null,
  );
  assert.match(
    validateToolArgs("replace_in_file", { path: "a.js", find: "x" }) ?? "",
    /requires one of: replace/,
  );
});
