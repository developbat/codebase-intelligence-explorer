import type { IntentAnalysis } from "../../../shared/intent";
import { isPureRecentWorkQuestion, isRecentWorkQuestion } from "./workState";

const META_QUESTION =
  /\b(?:sen|siz)\b[\s\S]{0,80}\b(?:nesin|kimsin|ne yapabilirsin|neler yapabilirsin|nasıl çalışıyorsun|yetkinlik|özellik|what are you|who are you|what can you do|capabilities)\b|^(?:ne yapabilirsin|neler yapabilirsin|kimsin|nesin|sen|you)\b|\b(?:hafızan|hafıza|memory)\b|\b(?:what can you do|who are you|what are you|capabilities)\b/i;

const PROJECT_QUESTION =
  /\b(?:proje|project|kod|code|dosya|file|fonksiyon|function|sınıf|class|modül|module|mimari|architecture|component|bileşen|api|route|rota|test|hata|bug|değişken|variable|veri|data|veritabanı|database|arayüz|ui|hud|css|layout|tasarım|design|erişilebilirlik|accessibility|a11y|kontrast|contrast|aria|renk|color)\w*\b/i;

const ACTION_VERBS =
  /(?<![\p{L}\p{N}_])(?:ekle|ekley|düzelt|duzelt|değiştir|degistir|kaldır|kaldir|sil|oluştur|olustur|güncelle|guncelle|taşı|tasi|patlat|kır|kir|gizle|göster|goster|boya|renklendir|çalıştır|calistir|test et|add|fix|change|remove|create|build|implement|update|run|delete|move|hide|show)\w*/iu;

const RESEARCH_SIGNAL =
  /\b(?:web|internet|haber|google|search the web|güncel bilgi|latest news|current price|hava durumu|bugün|today)\b/i;

const SKILL_SIGNALS: { slug: string; pattern: RegExp }[] = [
  { slug: "root-cause-debugging", pattern: /\b(?:hata|bug|error|crash|çalışmıyor|calismiyor|broken|root cause)\w*\b/i },
  { slug: "security-audit", pattern: /\b(?:güvenlik|guvenlik|security|secret|auth|yetki)\w*\b/i },
  { slug: "accessibility-audit", pattern: /\b(?:erişilebilirlik|erisilebilirlik|accessibility|a11y|kontrast|contrast|aria)\w*\b/i },
  { slug: "test-writer", pattern: /\b(?:test|pytest|vitest|jest|coverage)\w*\b/i },
  { slug: "code-review", pattern: /\b(?:review|incele|kod incele|code review)\w*\b/i },
];

const WRITE_ACTIONS = new Set(["create", "update", "remove", "move", "run"]);

/** Requests that need a local utility tool rather than a read-only answer. */
const UTILITY_TOOL_SIGNAL =
  /(?:aynı|ayni|duplicate|kopya|mükerrer|mukerrer).{0,30}(?:dosya|file).{0,24}(?:var mı|var mi|find|bul|kontrol|check)|(?:disk|depolama|storage).{0,24}(?:kullanım|kullanim|usage|dolu|space|alan|analiz)|(?:hatırlat|hatirlat|reminder).{0,30}(?:ekle|oluştur|olustur|listele|göster|goster|neler|var mı|var mi|tamamla|add|create|list|show)|(?:takvim|calendar).{0,30}(?:ekle|oluştur|olustur|etkinlik|event|toplantı|toplanti|add|create)|(?:dosya|file).{0,24}(?:listesi|listele|list|göster|show)/i;

export type ChatQuestionKind = "meta" | "recent-work" | "project" | "general";
export type ChatMode = ChatQuestionKind | "action" | "research";

export interface ChatPlan {
  mode: ChatMode;
  needsModel: boolean;
  needsProjectContext: boolean;
  needsTools: boolean;
  needsResearch: boolean;
  promptId: string;
  skillSlugs: string[];
  reason: string;
}

function chatText(
  instruction: string,
  intent?: Pick<IntentAnalysis, "normalizedRequest" | "behaviors" | "context">,
): string {
  return [
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
}

export function classifyChatQuestion(
  instruction: string,
  intent?: Pick<IntentAnalysis, "normalizedRequest" | "behaviors" | "context">,
): ChatQuestionKind {
  const text = chatText(instruction, intent);
  if (META_QUESTION.test(text)) return "meta";
  if (isRecentWorkQuestion(instruction, intent)) return "recent-work";
  if (intent?.context === "project" || PROJECT_QUESTION.test(text)) return "project";
  return "general";
}

/**
 * The capability gate: decide whether a message needs a model, project context,
 * agent tools or a research capability before spending tokens.
 */
export function planChat(
  instruction: string,
  intent?: Pick<IntentAnalysis, "normalizedRequest" | "behaviors" | "context" | "kind" | "needsExhaustiveEvidence">,
): ChatPlan {
  const text = chatText(instruction, intent);
  const kind = classifyChatQuestion(instruction, intent);
  const hasWriteBehavior = (intent?.behaviors ?? []).some((behavior) =>
    WRITE_ACTIONS.has(behavior.action),
  );
  const explanatoryQuestion =
    /^(?:nasıl|nasil|neden|niçin|nicin|ne|ne zaman|nerede|kim|how|why|what|where|when|who)\b/i.test(
      instruction.trim(),
    ) ||
    (/\b(?:nasıl|nasil|how)\b/i.test(instruction) &&
      !/\b(?:lütfen|lutfen|please|can you|could you|would you)\b/i.test(instruction));
  const actionRequest =
    hasWriteBehavior ||
    UTILITY_TOOL_SIGNAL.test(text) ||
    (ACTION_VERBS.test(text) && !explanatoryQuestion);

  if (kind === "recent-work") {
    return {
      mode: "recent-work",
      needsModel: !isPureRecentWorkQuestion(instruction),
      needsProjectContext: false,
      needsTools: false,
      needsResearch: false,
      promptId: "chat.work",
      skillSlugs: [],
      reason: "Recent-work summary can be answered from task records.",
    };
  }

  if (kind === "meta") {
    return {
      mode: "meta",
      needsModel: true,
      needsProjectContext: false,
      needsTools: false,
      needsResearch: false,
      promptId: "chat.meta",
      skillSlugs: [],
      reason: "Assistant identity/capability question.",
    };
  }

  if (actionRequest) {
    return {
      mode: "action",
      needsModel: true,
      needsProjectContext: true,
      needsTools: true,
      needsResearch: false,
      promptId: "agent.auto",
      skillSlugs: [],
      reason: "Write/run behavior or an explicit action request.",
    };
  }

  if (RESEARCH_SIGNAL.test(text) && !PROJECT_QUESTION.test(text)) {
    return {
      mode: "research",
      needsModel: true,
      needsProjectContext: false,
      needsTools: true,
      needsResearch: true,
      promptId: "chat.research",
      skillSlugs: [],
      reason: "Web/current-information research capability is required.",
    };
  }

  if (kind === "project") {
    return {
      mode: "project",
      needsModel: true,
      needsProjectContext: true,
      needsTools: false,
      needsResearch: false,
      promptId: "chat.answer",
      skillSlugs: SKILL_SIGNALS.filter((signal) => signal.pattern.test(text))
        .map((signal) => signal.slug)
        .slice(0, 1),
      reason: "Project/code explanation; context retrieval is server-side.",
    };
  }

  return {
    mode: "general",
    needsModel: true,
    needsProjectContext: false,
    needsTools: false,
    needsResearch: false,
    promptId: "chat.general",
    skillSlugs: [],
    reason: "General conversation.",
  };
}

/**
 * Questions and explanations stay in the chat channel. Action and research
 * plans leave chat for the Code Studio/research loop.
 */
export function isChatIntent(
  intent: IntentAnalysis,
  instruction: string,
): boolean {
  if (intent.needsExhaustiveEvidence) return false;
  const plan = planChat(instruction, intent);
  return plan.mode !== "action" && plan.mode !== "research";
}

export const isChatQuestion = isChatIntent;
