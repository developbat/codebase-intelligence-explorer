import type { IntentAnalysis } from "../../shared/intent";

const DETAIL_TERMS =
  /(?:acceptance|kabul|verify|doğrula|dogrula|test|must|should|only|never|without|değiştirme|degistirme|bozma|koru|regression)/i;

/**
 * Short, underspecified edit/scaffold/run requests get the requirements-first
 * skill even when the intent analyst did not select it. Verification-only and
 * read-only questions keep their normal profile.
 */
export function shouldForceRequirementsFirst(
  goalText: string,
  intent: Pick<IntentAnalysis, "kind"> | undefined,
  microEdit = false,
): boolean {
  if (microEdit || !intent) return false;
  if (intent.kind !== "edit" && intent.kind !== "scaffold" && intent.kind !== "run") return false;
  const goal = goalText.trim();
  return goal.length > 0 && goal.length < 160 && !DETAIL_TERMS.test(goal);
}

export { DETAIL_TERMS };
