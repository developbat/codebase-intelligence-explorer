import type { AnalysisResult } from "../../../shared/types";
import type { IntentBehaviorSurface } from "../../../shared/intent";
import { matchDomainCards, type DomainMatch } from "./domainKnowledge";

export type RequestFrameAction = "build" | "edit" | "run" | "analyze" | "question";

export interface RequestFrame {
  action: RequestFrameAction;
  /** What the user wants built/changed, in canonical terms. */
  deliverable: string;
  surface: IntentBehaviorSurface;
  domain?: DomainMatch;
  /** Required user preferences such as a cat theme; never domain rules. */
  extras: string[];
  constraints: string[];
  language: string;
  newBuild: boolean;
  emptyProject: boolean;
  mentionsUi: boolean;
}

const BUILD_VERB =
  /\b(yap|yapar|yapalim|yapalım|olustur|oluştur|tasarla|gelistir|geliştir|kur|uret|üret|build|create|design|implement|develop|make|scaffold|prototype)\b/i;
const EDIT_VERB =
  /\b(ekle|kaldir|kaldır|sil|guncelle|güncelle|degistir|değiştir|tasi|taşı|duzelt|düzelt|yenile|fix|add|remove|delete|update|change|move|rename|replace|improve)\b/i;
const RUN_VERB = /\b(calistir|çalıştır|baslat|başlat|run|start|test et|build et)\b/i;
const QUESTION_START =
  /^\s*(ne|neden|nasil|nasıl|nicin|niçin|ne zaman|nerede|kim|what|why|how|where|when|who)\b/i;
const CREATION_NOUN =
  /\b(oyun|oyunu|uygulama|uygulamasi|uygulaması|site|sitesi|app|game|dashboard|panel|form|api|bot|sistem|sistemi|tool|arac|araç|puzzle)\b/i;
const EDIT_OBJECT =
  /\b(tahta|tahtasi|tahtası|renk|rengi|buton|butonu|yazi|yazı|baslik|başlık|ekran|sayfa|component|bilesen|bileşen|menü|menu)\b/i;

const SOURCE_FILE =
  /\.(ts|tsx|js|jsx|mjs|cjs|html|css|scss|sass|less|vue|svelte|php|py|go|rs|java|kt|kts|swift|dart|rb|cs|cpp|c|h|sh)$/i;
const CONFIG_FILE =
  /(^|\/)(?:vite|webpack|rollup|next|nuxt|svelte|tailwind|postcss|eslint|prettier|tsconfig|jsconfig|package|package-lock|pnpm-lock|yarn)\./i;

const THEME_HINTS: { pattern: RegExp; label: string }[] = [
  { pattern: /\b(kedi|kedili|cat|kitten|kittens)\b/i, label: "cat theme" },
  { pattern: /\b(kopek|köpek|dog|puppy|puppies)\b/i, label: "dog theme" },
  { pattern: /\b(uzay|space|galaxy|yildiz|yıldız)\b/i, label: "space theme" },
  { pattern: /\b(retro|neon|pixel|8-bit|arcade)\b/i, label: "retro theme" },
  { pattern: /\b(minimal|sade|clean)\b/i, label: "minimal style" },
  { pattern: /\b(ahsap|ahşap|wooden)\b/i, label: "wooden style" },
  { pattern: /\b(karanlik|karanlık|dark)\b/i, label: "dark theme" },
  { pattern: /\b(aydinlik|aydınlık|light)\b/i, label: "light theme" },
  { pattern: /\b(mavi|blue)\b/i, label: "blue accent" },
  { pattern: /\b(kirmizi|kırmızı|red)\b/i, label: "red accent" },
  { pattern: /\b(yesil|yeşil|green)\b/i, label: "green accent" },
  { pattern: /\b(pembe|pink)\b/i, label: "pink accent" },
  { pattern: /\b(cizgi film|çizgi film|cartoon|karikatur|karikatür)\b/i, label: "cartoon style" },
  { pattern: /\b(klasik|classic)\b/i, label: "classic style" },
];

const CONSTRAINT_HINT =
  /\b(sadece|yalnizca|yalnızca|only|without|olmadan|kullanma|kullanmayin|kullanmayın|degistirme|değiştirme|degistirmeyin|değiştirmeyin|dokunma|dokunmayın|do not|don't|never|asla)\b/i;

const DOMAIN_SURFACE: Record<string, IntentBehaviorSurface> = {
  chess: "game",
  puzzle: "game",
  platformer: "game",
  "todo-dashboard": "ui",
  booking: "ui",
};

export function isEffectivelyEmptyProject(analysis: AnalysisResult): boolean {
  if (analysis.files.length === 0) return true;
  return !analysis.files.some(
    (file) => SOURCE_FILE.test(file.path) && !CONFIG_FILE.test(file.path),
  );
}

function detectLanguage(instruction: string, provided?: string): string {
  const normalized = provided?.trim().toLowerCase();
  if (normalized && /^[a-z]{2}(?:-[a-z]{2})?$/.test(normalized)) {
    return normalized.slice(0, 2);
  }
  if (
    /[çğıöşü]/i.test(instruction) ||
    /\b(bir|ve|için|icin|yap|oyun|uygulama|değil|degil|ama|ile)\b/i.test(instruction)
  ) {
    return "tr";
  }
  return "en";
}

function extractExtras(instruction: string): string[] {
  const extras: string[] = [];
  for (const hint of THEME_HINTS) {
    if (hint.pattern.test(instruction) && !extras.includes(hint.label)) {
      extras.push(hint.label);
    }
  }
  return extras;
}

function extractConstraints(instruction: string): string[] {
  if (!CONSTRAINT_HINT.test(instruction)) return [];
  return instruction
    .split(/[.!?;\n]+/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 0 && part.length <= 200 && CONSTRAINT_HINT.test(part))
    .slice(0, 4);
}

function pickDeliverable(
  domain: DomainMatch | undefined,
  instruction: string,
): { deliverable: string; surface: IntentBehaviorSurface; mentionsUi: boolean } {
  const domainSurface = domain ? DOMAIN_SURFACE[domain.card.id] : undefined;
  if (domainSurface) {
    return {
      deliverable: domain?.card.name ?? "application",
      surface: domainSurface,
      mentionsUi: true,
    };
  }
  if (/\b(api|backend|servis|service|endpoint)\b/i.test(instruction)) {
    return { deliverable: "API", surface: "api", mentionsUi: false };
  }
  if (/\b(veritabani|veritabanı|database|schema|data model)\b/i.test(instruction)) {
    return { deliverable: "data model", surface: "data", mentionsUi: false };
  }
  if (/\b(dokuman|doküman|rapor|report|readme|doc)\b/i.test(instruction)) {
    return { deliverable: "document", surface: "docs", mentionsUi: false };
  }
  if (/\b(oyun|game|puzzle|bulmaca)\b/i.test(instruction)) {
    return { deliverable: "game", surface: "game", mentionsUi: true };
  }
  return { deliverable: "application", surface: "ui", mentionsUi: true };
}

/**
 * Deterministic reading of the request before the intent model runs. This is the
 * safety net for JSON failures and the source of truth for build vs edit,
 * domain, user extras and language.
 */
export function analyzeRequestFrame(
  instruction: string,
  analysis: AnalysisResult,
  language?: string,
): RequestFrame {
  const text = instruction.trim();
  const domain = matchDomainCards(text, { limit: 1 })[0];
  const emptyProject = isEffectivelyEmptyProject(analysis);
  const extras = extractExtras(text);
  const { deliverable, surface, mentionsUi } = pickDeliverable(domain, text);

  const hasBuildVerb = BUILD_VERB.test(text);
  const hasEditVerb = EDIT_VERB.test(text);
  const hasCreationNoun = CREATION_NOUN.test(text);
  const hasEditObject = EDIT_OBJECT.test(text);
  const isQuestion = QUESTION_START.test(text) || (text.endsWith("?") && !hasBuildVerb);

  let action: RequestFrameAction = "analyze";
  if (isQuestion) {
    action = "question";
  } else if (RUN_VERB.test(text) && !hasBuildVerb) {
    action = "run";
  } else if (hasBuildVerb && (hasCreationNoun || (domain && !hasEditObject))) {
    action = "build";
  } else if (hasEditVerb || extras.length > 0 || hasEditObject) {
    action = "edit";
  } else if (hasBuildVerb) {
    action = "build";
  }

  const newBuild =
    action === "build" &&
    (emptyProject ||
      hasCreationNoun ||
      Boolean(domain && (domain.card.id === "puzzle" || domain.card.id === "chess")));

  return {
    action,
    deliverable,
    surface,
    domain,
    extras,
    constraints: extractConstraints(text),
    language: detectLanguage(text, language),
    newBuild,
    emptyProject,
    mentionsUi: mentionsUi && action !== "run",
  };
}

export function requestMentionsExtra(extra: string, text: string): boolean {
  const hint = THEME_HINTS.find((item) => item.label === extra);
  return hint ? hint.pattern.test(text) : text.toLowerCase().includes(extra.toLowerCase());
}

/** Prompt-ready facts for the intent model. */
export function requestFrameFacts(frame: RequestFrame): string {
  return [
    `action=${frame.action}`,
    `deliverable=${frame.deliverable}`,
    `surface=${frame.surface}`,
    `newBuild=${frame.newBuild}`,
    `emptyProject=${frame.emptyProject}`,
    frame.domain ? `domain=${frame.domain.card.name} (${frame.domain.card.id})` : "",
    frame.extras.length > 0 ? `userExtras=${frame.extras.join(", ")}` : "",
    frame.constraints.length > 0 ? `constraints=${frame.constraints.join(" | ")}` : "",
    `language=${frame.language}`,
  ]
    .filter(Boolean)
    .join("\n");
}
