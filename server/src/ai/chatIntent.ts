import type { IntentAnalysis } from "../../../shared/intent";
import { isRecentWorkQuestion } from "./workState";

const META_QUESTION =
  /\b(?:sen|siz)\b[\s\S]{0,80}\b(?:nesin|kimsin|ne yapabilirsin|neler yapabilirsin|nasıl çalışıyorsun|yetkinlik|özellik|what are you|who are you|what can you do|capabilities)\b|^(?:ne yapabilirsin|neler yapabilirsin|kimsin|nesin|sen|you)\b|\b(?:hafızan|hafıza|memory)\b|\b(?:what can you do|who are you|what are you|capabilities)\b/i;

const PROJECT_QUESTION =
  /\b(?:proje|project|kod|code|dosya|file|fonksiyon|function|sınıf|class|modül|module|mimari|architecture|component|bileşen|api|route|rota|test|hata|bug|değişken|variable|veri|data|veritabanı|database)\w*\b/i;

const WRITE_ACTIONS = new Set(["create", "update", "remove", "move", "run"]);

export type ChatQuestionKind = "meta" | "recent-work" | "project" | "general";

export function classifyChatQuestion(
  instruction: string,
  intent?: Pick<IntentAnalysis, "normalizedRequest" | "behaviors" | "context">,
): ChatQuestionKind {
  const text = [
    instruction,
    intent?.normalizedRequest,
    ...(intent?.behaviors ?? []).flatMap((behavior) => [
      behavior.target,
      behavior.details,
      behavior.acceptance,
    ]),
  ]
    .filter(Boolean)
    .join("\n");
  if (META_QUESTION.test(text)) return "meta";
  if (isRecentWorkQuestion(instruction, intent)) return "recent-work";
  if (intent?.context === "project" || PROJECT_QUESTION.test(text)) return "project";
  return "general";
}

/**
 * Questions and explanations stay in the chat channel even when the intent
 * model labels them "edit". Only an explicit write/run/verify behavior or an
 * exhaustive evidence request is allowed to enter the Code Studio loop.
 */
export function isChatIntent(
  intent: IntentAnalysis,
  instruction: string,
): boolean {
  if (intent.needsExhaustiveEvidence) return false;
  const behaviors = intent.behaviors ?? [];
  if (behaviors.some((behavior) => WRITE_ACTIONS.has(behavior.action))) {
    return false;
  }
  if (intent.kind === "question" || intent.kind === "analyze") return true;
  if (
    intent.kind === "edit" &&
    behaviors.length > 0 &&
    behaviors.every((behavior) => behavior.action === "other" || behavior.action === "verify")
  ) {
    return (
      /\?/.test(instruction) ||
      /\b(?:nasıl|neden|niçin|ne yapar|açıkla|anlat|incele|analiz|explain|how|why|what does|walk.*through|describe|review|analy[sz]e)\b/i.test(
        instruction,
      )
    );
  }
  return false;
}

export const isChatQuestion = isChatIntent;
