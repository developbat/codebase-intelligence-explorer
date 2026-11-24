import { registeredToolActions, runRegisteredTool } from "./registry";
import { TRY_TOOL_HANDLERS } from "./tryTools";
import type { AgentToolContext, AgentToolResult } from "./types";

export function tryableToolActions(): string[] {
  return [...new Set([...registeredToolActions(), ...Object.keys(TRY_TOOL_HANDLERS)])];
}

export async function runTryTool(
  action: string,
  context: AgentToolContext,
): Promise<AgentToolResult | null> {
  const registered = await runRegisteredTool(action, context);
  if (registered) return registered;
  const handler = TRY_TOOL_HANDLERS[action];
  return handler ? handler(context) : null;
}
