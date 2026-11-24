import type { IntentAnalysis } from "../../../shared/intent";
import type { AiActionKind } from "../../../shared/ai";
import { resolveWorkBrief } from "../extractors";

export interface ActionPlan {
  action: AiActionKind;
  reason: string;
  needsWrite: boolean;
  needsCommand: boolean;
  needsBrowser: boolean;
}

const VERIFY_WORDS =
  /\b(?:test|tests|testleri?|pytest|go test|npm test|typecheck|type check|build|doğrula|dogrula|verify|kontrol et|check)\b/i;
const LOCATE_WORDS =
  /\b(?:nerede|where|hangi dosya|which file|defined|bul|find)\b|tanımlı|tanimli/i;
const EXPLAIN_WORDS =
  /\b(?:nasıl|nasil|neden|niçin|nicin|nedir|açıkla|acikla|anlat|explain|why|how|what)\b/i;
const RUN_WORDS =
  /\b(?:çalıştır|calistir|run|start|başlat|baslat|execute)\b/i;
const UI_WORDS =
  /\b(?:ui|arayüz|arayuz|button|buton|screen|ekran|page|sayfa|css|html|canvas|visual|görsel|gorsel)\b/i;
const TOOL_WORDS =
  /\b(?:project tool|proje aracı|proje araci|skill script|run tool|araç çalıştır|arac calistir)/i;

function actionForIntent(intent: IntentAnalysis | undefined): AiActionKind | null {
  if (!intent) return null;
  if (intent.kind === "scaffold") return "scaffold";
  if (intent.kind === "run") return "run";
  if (intent.kind === "edit") return "edit";
  if (intent.kind === "question" || intent.kind === "analyze") return null;
  return null;
}

export function resolveActionPlan(
  instruction: string,
  intent?: IntentAnalysis,
): ActionPlan {
  const text = instruction.trim();
  const brief = resolveWorkBrief(text);
  const inferred = actionForIntent(intent);
  const needsBrowser = UI_WORDS.test(text);
  const reason = (value: string) => value;

  if (inferred === "scaffold") {
    return {
      action: "scaffold",
      reason: reason("The request is for a new project or project skeleton."),
      needsWrite: true,
      needsCommand: true,
      needsBrowser: false,
    };
  }
  if (TOOL_WORDS.test(text)) {
    return {
      action: "tool",
      reason: reason("The request targets a reusable project tool or skill script."),
      needsWrite: true,
      needsCommand: true,
      needsBrowser: false,
    };
  }
  if (brief?.mode === "extract") {
    return {
      action: "list",
      reason: reason("The request asks for a complete inventory; use the extraction tool and finish with every item."),
      needsWrite: false,
      needsCommand: false,
      needsBrowser: false,
    };
  }
  if (brief?.mode === "change" || inferred === "edit") {
    return {
      action: "edit",
      reason: reason("The request asks for a project change; make the smallest edit and verify it."),
      needsWrite: true,
      needsCommand: VERIFY_WORDS.test(text),
      needsBrowser,
    };
  }
  if (VERIFY_WORDS.test(text) && !EXPLAIN_WORDS.test(text)) {
    return {
      action: "verify",
      reason: reason("The request asks to test or validate; run the detected verification and report the result."),
      needsWrite: false,
      needsCommand: true,
      needsBrowser,
    };
  }
  if (
    inferred === "run" ||
    (RUN_WORDS.test(text) && !VERIFY_WORDS.test(text))
  ) {
    return {
      action: "run",
      reason: reason("The request asks to execute something and report the result."),
      needsWrite: false,
      needsCommand: true,
      needsBrowser,
    };
  }
  if (LOCATE_WORDS.test(text)) {
    return {
      action: "locate",
      reason: reason("The request asks where something is defined; search/read and answer with file:line evidence."),
      needsWrite: false,
      needsCommand: false,
      needsBrowser: false,
    };
  }
  return {
    action: "explain",
    reason: reason("The request asks for an explanation; inspect the relevant code and answer with evidence."),
    needsWrite: false,
    needsCommand: false,
    needsBrowser: false,
  };
}

export function actionPlanInstruction(plan: ActionPlan): string {
  switch (plan.action) {
    case "list":
      return "Action plan: list. This is a complete inventory request. Call extract_entities once with the matching kind, then finish with every item in the user's language. Do not edit files, run shell commands or run browser checks.";
    case "locate":
      return "Action plan: locate. Find the exact symbol/definition with search and focused reads, then answer with file:line evidence. Do not edit files.";
    case "verify":
      return "Action plan: verify. Do not edit files. Run the detected verification command or browser assertion and report the actual result; never claim tests passed without a successful command.";
    case "run":
      return "Action plan: run. Execute the requested command or test in the project root and report the real output/exit code. Do not invent output.";
    case "edit":
      return "Action plan: edit. Inspect the smallest relevant range, apply a focused edit, then run verification and report changed files. Do not rewrite whole files without need.";
    case "scaffold":
      return "Action plan: scaffold. Create the project skeleton, install/declare dependencies, and verify the build or test command.";
    case "tool":
      return "Action plan: project tool. Inspect existing project tools/scripts, create or reuse the right one, then run it and report output.";
    case "explain":
    default:
      return "Action plan: explain. Read the relevant code and answer with clear file:line evidence. Do not edit files.";
  }
}
