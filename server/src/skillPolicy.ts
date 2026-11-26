import type { IntentAnalysis } from "../../shared/intent";

/**
 * Short, underspecified edit/scaffold/run requests get the requirements-first
 * skill even when the intent analyst did not select it. The decision uses the
 * structured intent spec, not language-specific words.
 */
export function shouldForceRequirementsFirst(
  goalText: string,
  intent:
    | Pick<IntentAnalysis, "kind" | "confidence" | "behaviors" | "ambiguities">
    | undefined,
  microEdit = false,
): boolean {
  if (microEdit || !intent) return false;
  if (intent.kind !== "edit" && intent.kind !== "scaffold" && intent.kind !== "run") return false;
  return (
    (intent.confidence ?? 0.5) < 0.8 ||
    (intent.behaviors?.length ?? 0) > 1 ||
    (intent.ambiguities?.length ?? 0) > 0
  );
}
