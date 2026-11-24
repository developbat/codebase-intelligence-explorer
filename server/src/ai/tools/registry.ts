import { BUILTIN_TOOL_HANDLERS } from "./builtins";
import type { AgentToolContext, AgentToolResult } from "./types";

export function registeredToolActions(): string[] {
  return Object.keys(BUILTIN_TOOL_HANDLERS);
}

export async function runRegisteredTool(
  action: string,
  context: AgentToolContext,
): Promise<AgentToolResult | null> {
  const handler = BUILTIN_TOOL_HANDLERS[action];
  if (!handler) return null;
  return handler(context);
}
