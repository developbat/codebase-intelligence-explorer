import crypto from "node:crypto";
import type {
  AiAgentPermissionRequest,
  AiPermissionDecision,
  AiPermissionKind,
} from "../../../shared/ai";

interface PermissionInput {
  runId: string;
  projectId: string;
  kind: AiPermissionKind;
  tool: string;
  target?: string;
  detail?: string;
  preview?: string;
  previewKind?: "diff" | "text";
  destructive?: boolean;
  canAlways?: boolean;
}

interface PendingPermission {
  request: AiAgentPermissionRequest;
  projectId: string;
  settle: (decision: AiPermissionDecision) => void;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

const pending = new Map<string, PendingPermission>();

export function requestPermission(
  input: PermissionInput,
  options: {
    onRequest: (request: AiAgentPermissionRequest) => void;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<AiPermissionDecision> {
  const destructive = input.destructive === true;
  const request: AiAgentPermissionRequest = {
    requestId: `perm_${crypto.randomUUID()}`,
    runId: input.runId,
    kind: input.kind,
    tool: input.tool,
    target: input.target,
    detail: input.detail,
    preview: input.preview,
    previewKind: input.previewKind,
    destructive,
    canAlways: destructive ? false : input.canAlways !== false,
    createdAt: new Date().toISOString(),
  };

  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const settle = (decision: AiPermissionDecision): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      pending.delete(request.requestId);
      resolve(decision);
    };

    const onAbort = (): void => settle("deny");

    if (options.signal?.aborted) {
      resolve("deny");
      return;
    }

    timer = setTimeout(() => settle("deny"), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    pending.set(request.requestId, { request, projectId: input.projectId, settle });
    try {
      options.onRequest(request);
    } catch {
      settle("deny");
    }
  });
}

export function resolvePermission(
  projectId: string,
  requestId: string,
  decision: AiPermissionDecision,
): boolean {
  const entry = pending.get(requestId);
  if (!entry) return false;
  if (entry.projectId !== projectId) return false;
  entry.settle(decision);
  return true;
}

export function cancelRunPermissions(runId: string, decision: AiPermissionDecision = "deny"): number {
  let cancelled = 0;
  for (const entry of [...pending.values()]) {
    if (entry.request.runId !== runId) continue;
    entry.settle(decision);
    cancelled += 1;
  }
  return cancelled;
}

export function pendingPermissionCount(): number {
  return pending.size;
}

export function pendingPermissions(): AiAgentPermissionRequest[] {
  return [...pending.values()].map((entry) => entry.request);
}
