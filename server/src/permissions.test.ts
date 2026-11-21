import assert from "node:assert/strict";
import test from "node:test";
import type { AiAgentPermissionRequest } from "../../shared/ai";
import {
  cancelRunPermissions,
  pendingPermissionCount,
  requestPermission,
  resolvePermission,
} from "./ai/permissions";
import { agentToolCatalog } from "./ai/service";

function capture(): { seen: AiAgentPermissionRequest[]; onRequest: (request: AiAgentPermissionRequest) => void } {
  const seen: AiAgentPermissionRequest[] = [];
  return { seen, onRequest: (request) => seen.push(request) };
}

test("permission broker supports once, always and deny", async () => {
  const once = capture();
  const oncePromise = requestPermission(
    {
      runId: "run-1",
      projectId: "project-1",
      kind: "write",
      tool: "write_file",
      target: "src/a.ts",
      detail: "1 line",
      preview: "export const a = 1;",
    },
    { onRequest: once.onRequest },
  );
  assert.equal(pendingPermissionCount(), 1);
  assert.equal(once.seen[0].canAlways, true);
  assert.equal(once.seen[0].destructive, false);
  assert.equal(resolvePermission("project-1", once.seen[0].requestId, "once"), true);
  assert.equal(await oncePromise, "once");
  assert.equal(pendingPermissionCount(), 0);
  assert.equal(resolvePermission("project-1", once.seen[0].requestId, "once"), false);

  const always = capture();
  const alwaysPromise = requestPermission(
    { runId: "run-2", projectId: "project-1", kind: "command", tool: "run_command", target: "npm test" },
    { onRequest: always.onRequest },
  );
  assert.equal(resolvePermission("project-1", always.seen[0].requestId, "always"), true);
  assert.equal(await alwaysPromise, "always");

  const denied = capture();
  const deniedPromise = requestPermission(
    { runId: "run-3", projectId: "project-1", kind: "write", tool: "write_file", target: "src/b.ts" },
    { onRequest: denied.onRequest },
  );
  assert.equal(resolvePermission("project-1", denied.seen[0].requestId, "deny"), true);
  assert.equal(await deniedPromise, "deny");
});

test("permission broker rejects other projects and scopes destructive actions", async () => {
  const destructive = capture();
  const pending = requestPermission(
    {
      runId: "run-4",
      projectId: "project-1",
      kind: "write",
      tool: "delete_file",
      target: "src/old.ts",
      destructive: true,
    },
    { onRequest: destructive.onRequest },
  );
  assert.equal(destructive.seen[0].destructive, true);
  assert.equal(destructive.seen[0].canAlways, false);
  assert.equal(resolvePermission("project-2", destructive.seen[0].requestId, "deny"), false);
  assert.equal(pendingPermissionCount(), 1);
  assert.equal(resolvePermission("project-1", destructive.seen[0].requestId, "deny"), true);
  assert.equal(await pending, "deny");
});

test("permission broker denies on abort, timeout and cancelled runs", async () => {
  const aborted = capture();
  const controller = new AbortController();
  const abortPromise = requestPermission(
    { runId: "run-5", projectId: "project-1", kind: "write", tool: "write_file" },
    { onRequest: aborted.onRequest, signal: controller.signal },
  );
  controller.abort();
  assert.equal(await abortPromise, "deny");

  const timedOut = capture();
  const timeoutPromise = requestPermission(
    { runId: "run-6", projectId: "project-1", kind: "command", tool: "run_command" },
    { onRequest: timedOut.onRequest, timeoutMs: 20 },
  );
  assert.equal(await timeoutPromise, "deny");

  const cancelled = capture();
  const cancelPromise = requestPermission(
    { runId: "run-7", projectId: "project-1", kind: "write", tool: "write_file" },
    { onRequest: cancelled.onRequest },
  );
  assert.equal(cancelRunPermissions("run-7"), 1);
  assert.equal(await cancelPromise, "deny");
  assert.equal(pendingPermissionCount(), 0);
});

test("agent tool catalog marks approval requirements and hides writes in read-only mode", () => {
  const needsApproval = agentToolCatalog(false, false, false);
  assert.match(needsApproval, /write_file[\s\S]*requires user approval/);
  assert.match(needsApproval, /run_command[\s\S]*requires user approval/);
  assert.match(needsApproval, /delete_file[\s\S]*always requires confirmation/);
  assert.match(needsApproval, /rename_path[\s\S]*always requires confirmation/);

  const approved = agentToolCatalog(false, true, true);
  assert.doesNotMatch(approved, /write_file[\s\S]*requires user approval/);
  assert.doesNotMatch(approved, /run_command[\s\S]*requires user approval/);

  const readOnly = agentToolCatalog(true, false, false);
  assert.doesNotMatch(readOnly, /write_file/);
  assert.doesNotMatch(readOnly, /run_command/);
  assert.doesNotMatch(readOnly, /delete_file/);
});
