import { BUILTIN_TOOL_HANDLERS } from "./builtins";
import { DOCUMENT_TOOL_HANDLERS } from "./documents";
import { GIT_TOOL_HANDLERS } from "./gitTools";
import { MOBILE_TOOL_HANDLERS } from "./mobile";
import { RESEARCH_TOOL_HANDLERS } from "./research";
import { SKILL_TOOL_HANDLERS } from "./skills";
import type { AgentToolContext, AgentToolResult } from "./types";

const HANDLERS = {
  ...BUILTIN_TOOL_HANDLERS,
  ...SKILL_TOOL_HANDLERS,
  ...RESEARCH_TOOL_HANDLERS,
  ...DOCUMENT_TOOL_HANDLERS,
  ...GIT_TOOL_HANDLERS,
  ...MOBILE_TOOL_HANDLERS,
};

export function registeredToolActions(): string[] {
  return Object.keys(HANDLERS);
}

export async function runRegisteredTool(
  action: string,
  context: AgentToolContext,
): Promise<AgentToolResult | null> {
  const handler = HANDLERS[action];
  if (!handler) return null;
  return handler(context);
}
