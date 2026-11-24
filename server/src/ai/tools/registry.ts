import { BUILTIN_TOOL_HANDLERS } from "./builtins";
import { DOCUMENT_TOOL_HANDLERS } from "./documents";
import { GIT_TOOL_HANDLERS } from "./gitTools";
import { GIT_WRITE_TOOL_HANDLERS } from "./gitWriteTools";
import { MOBILE_TOOL_HANDLERS } from "./mobile";
import { MOBILE_ACTION_HANDLERS } from "./mobileActions";
import { RESEARCH_TOOL_HANDLERS } from "./research";
import { WRITE_TOOL_HANDLERS } from "./writeTools";
import { SKILL_TOOL_HANDLERS } from "./skills";
import type { AgentToolContext, AgentToolResult } from "./types";

const HANDLERS = {
  ...BUILTIN_TOOL_HANDLERS,
  ...SKILL_TOOL_HANDLERS,
  ...RESEARCH_TOOL_HANDLERS,
  ...DOCUMENT_TOOL_HANDLERS,
  ...GIT_TOOL_HANDLERS,
  ...GIT_WRITE_TOOL_HANDLERS,
  ...WRITE_TOOL_HANDLERS,
  ...MOBILE_TOOL_HANDLERS,
  ...MOBILE_ACTION_HANDLERS,
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
