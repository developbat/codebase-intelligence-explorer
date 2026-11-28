import type { IntentBehaviorSurface } from "../../../shared/intent";
import type { ProjectTask } from "../../../shared/tasks";
import type { TaskBrief } from "./taskBrief";
import { normalizeDomainText } from "./domainKnowledge";

export type CoverageKind = "invariant" | "norm" | "ux" | "extra" | "component" | "acceptance";

export interface CoverageItem {
  id: string;
  kind: CoverageKind;
  text: string;
  coveredBy: string[];
}

export interface PlanCoverage {
  items: CoverageItem[];
  missing: string[];
  addedTasks: number;
}

export interface CoverageResult {
  tasks: ProjectTask[];
  plan: PlanCoverage;
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "into",
  "that",
  "this",
  "these",
  "those",
  "must",
  "should",
  "will",
  "can",
  "may",
  "not",
  "are",
  "was",
  "were",
  "have",
  "has",
  "had",
  "each",
  "when",
  "then",
  "than",
  "only",
  "same",
  "other",
  "all",
  "any",
  "use",
  "using",
  "used",
  "task",
  "tasks",
  "user",
  "users",
  "one",
  "two",
  "both",
  "also",
  "make",
  "sure",
  "like",
  "such",
  "more",
  "most",
  "less",
  "least",
  "there",
  "their",
  "they",
  "them",
  "you",
  "your",
  "bir",
  "ve",
  "ile",
  "için",
  "icin",
  "olan",
  "olarak",
  "daha",
  "gibi",
  "her",
  "bu",
  "şu",
  "su",
  "veya",
  "ama",
  "ancak",
  "değil",
  "degil",
  "olmalı",
  "olmali",
  "gerekir",
  "kadar",
  "sonra",
  "önce",
  "once",
]);

const TERM_ALIASES: { pattern: RegExp; words: string[] }[] = [
  { pattern: /castl|rok/i, words: ["castling", "castle", "rok"] },
  { pattern: /en[\s-]?passant|gecerken|geçerken/i, words: ["passant", "enpassant", "gecerken"] },
  { pattern: /promotion|terfi/i, words: ["promotion", "terfi"] },
  { pattern: /checkmate|sah\s?mat|\bmat\b/i, words: ["checkmate", "sahmat", "mat"] },
  { pattern: /stalemate|\bpat\b/i, words: ["stalemate", "pat"] },
  { pattern: /draw|beraberlik/i, words: ["draw", "draws", "beraberlik"] },
  { pattern: /board|tahta/i, words: ["board", "tahta"] },
  { pattern: /piece|\btas\b|taş/i, words: ["piece", "pieces", "tas"] },
  { pattern: /pawn|piyon/i, words: ["pawn", "piyon"] },
  { pattern: /king|\bsah\b|şah/i, words: ["king", "sah"] },
  { pattern: /queen|vezir/i, words: ["queen", "vezir"] },
  { pattern: /rook|kale/i, words: ["rook", "kale"] },
  { pattern: /bishop|\bfil\b/i, words: ["bishop", "fil"] },
  { pattern: /knight|\bat\b|at[iı]?\b/i, words: ["knight"] },
  { pattern: /move|hamle/i, words: ["move", "moves", "hamle"] },
  { pattern: /legal|yasal/i, words: ["legal", "yasal"] },
  { pattern: /theme|tema|cat|kedi/i, words: ["theme", "tema", "cat", "kedi"] },
  { pattern: /undo|geri\s?al/i, words: ["undo", "geri"] },
  { pattern: /restart|yeniden/i, words: ["restart", "yeniden"] },
  { pattern: /notation|notasyon/i, words: ["notation", "notasyon"] },
  { pattern: /captured|alinan|alınan/i, words: ["captured", "alinan"] },
  { pattern: /accessibility|erisilebilirlik|erişilebilirlik/i, words: ["accessibility", "erisilebilirlik"] },
  { pattern: /hint|ipucu/i, words: ["hint", "ipucu"] },
  { pattern: /score|skor/i, words: ["score", "skor"] },
  { pattern: /timer|sure|süre/i, words: ["timer", "sure"] },
  { pattern: /grid|izgara/i, words: ["grid", "izgara"] },
  { pattern: /level|seviye/i, words: ["level", "seviye"] },
  { pattern: /mobile|mobil/i, words: ["mobile", "mobil"] },
  { pattern: /keyboard|klavye/i, words: ["keyboard", "klavye"] },
  { pattern: /touch|dokunmatik/i, words: ["touch", "dokunmatik"] },
  { pattern: /sound|ses/i, words: ["sound", "ses"] },
  { pattern: /animation|animasyon/i, words: ["animation", "animasyon"] },
  { pattern: /validation|dogrulama|doğrulama/i, words: ["validation", "dogrulama"] },
  { pattern: /empty|bos|boş/i, words: ["empty", "bos"] },
  { pattern: /booking|randevu/i, words: ["booking", "randevu"] },
  { pattern: /calendar|takvim/i, words: ["calendar", "takvim"] },
  { pattern: /slot|musaitlik|müsaitlik/i, words: ["slot", "musaitlik"] },
  { pattern: /auth|giris|giriş/i, words: ["auth", "giris"] },
  { pattern: /persistence|kalicilik|kalıcılık|localstorage|depolama/i, words: ["persistence", "localstorage", "depolama"] },
];

const SIGNIFICANT = new Set([
  "board",
  "tahta",
  "piece",
  "move",
  "legal",
  "theme",
  "tema",
  "draw",
  "check",
  "castle",
  "castling",
  "promotion",
  "passant",
  "undo",
  "restart",
  "notation",
  "captured",
  "hint",
  "score",
  "timer",
  "grid",
  "level",
  "mobile",
  "keyboard",
  "touch",
  "sound",
  "animation",
  "validation",
  "empty",
  "booking",
  "calendar",
  "slot",
  "auth",
  "persistence",
  "accessibility",
  "turn",
  "rank",
  "file",
  "pin",
  "mate",
  "stalemate",
  "pawn",
  "king",
  "queen",
  "rook",
  "bishop",
  "knight",
]);

function normalizeDimensions(text: string): string {
  return text.replace(/(\d)\s*[x×]\s*(\d)/gi, "$1x$2");
}

function keywords(text: string): string[] {
  const cleaned = normalizeDimensions(text).replace(/https?:\/\/\S+/gi, " ");
  const tokens = normalizeDomainText(cleaned)
    .split(" ")
    .filter(
      (token) =>
        token.length >= 3 &&
        token.length <= 40 &&
        !STOPWORDS.has(token) &&
        !/^\d+$/.test(token),
    );
  return [...new Set(tokens)];
}

function extraWords(text: string): string[] {
  const words = new Set(keywords(text));
  for (const alias of TERM_ALIASES) {
    if (!alias.pattern.test(text) && !alias.pattern.test(normalizeDomainText(text))) {
      continue;
    }
    for (const value of alias.words) {
      for (const token of normalizeDomainText(value).split(" ")) {
        if (token.length >= 3 && !STOPWORDS.has(token)) words.add(token);
      }
    }
  }
  return [...words];
}

function implementationTasks(tasks: ProjectTask[]): ProjectTask[] {
  return tasks.filter(
    (task) => task.verificationOnly !== true && task.action !== "verify",
  );
}

function taskWordSet(tasks: ProjectTask[]): Set<string> {
  const words = new Set<string>();
  for (const task of implementationTasks(tasks)) {
    for (const word of extraWords(
      `${task.title} ${task.detail} ${task.acceptance ?? ""}`,
    )) {
      words.add(word);
    }
  }
  return words;
}

function tokenMatches(left: string, right: string): boolean {
  if (left === right) return true;
  if (left.length >= 5 && right.startsWith(left)) return true;
  if (right.length >= 5 && left.startsWith(right)) return true;
  return false;
}

function isCovered(item: CoverageItem, tasks: ProjectTask[]): string[] {
  const candidates = implementationTasks(tasks);
  const words = extraWords(item.text);
  if (words.length === 0) return [];
  const taskWords = taskWordSet(candidates);
  const hits = words.filter((word) =>
    [...taskWords].some((taskWord) => tokenMatches(word, taskWord)),
  );
  if (hits.length === 0) return [];
  const strong = hits.some((word) => SIGNIFICANT.has(word) || word.length >= 7);
  if (!strong && hits.length < 2) return [];
  return candidates
    .filter((task) => {
      const wordsForTask = extraWords(
        `${task.title} ${task.detail} ${task.acceptance ?? ""}`,
      );
      return wordsForTask.some((taskWord) =>
        hits.some((hit) => tokenMatches(hit, taskWord)),
      );
    })
    .map((task) => task.id);
}

function coverageItems(brief: TaskBrief): CoverageItem[] {
  const items: CoverageItem[] = [];
  const push = (kind: CoverageKind, values: string[]) => {
    for (const text of values) {
      if (!text.trim()) continue;
      items.push({
        id: `${kind}-${items.length + 1}`,
        kind,
        text: text.trim(),
        coveredBy: [],
      });
    }
  };
  const splitInvariants = (text: string): string[] => {
    const colon = text.indexOf(":");
    if (colon > 0) {
      const prefix = text.slice(0, colon).trim();
      const parts = text
        .slice(colon + 1)
        .split(/,|;/)
        .map((part) => part.replace(/^\s*and\s+/i, "").trim())
        .filter((part) => part.length >= 8);
      if (parts.length >= 3) {
        return parts.map((part) => `${prefix}: ${part}`);
      }
    }
    return [text];
  };
  push("invariant", brief.invariants.flatMap(splitInvariants));
  push("norm", brief.norms);
  push("ux", brief.ux);
  push("extra", brief.extras);
  push("acceptance", brief.acceptance);
  push("component", [...brief.components, ...brief.dataModel]);
  return items;
}

function localized(language: string | undefined) {
  const tr = language?.toLowerCase().startsWith("tr");
  return {
    tr,
    titles: {
      invariant: tr ? "Eksik alan kurallarını tamamla" : "Complete missing domain rules",
      norm: tr ? "Eksik ürün normlarını uygula" : "Apply missing product norms",
      ux: tr ? "Eksik arayüz davranışlarını tamamla" : "Finish missing UI behaviors",
      extra: tr ? "Eksik kullanıcı ekstralarını uygula" : "Apply missing user extras",
      component: tr ? "Eksik bileşen ve durumu tamamla" : "Complete missing components and state",
      acceptance: tr ? "Brief kabul kontrollerini doğrula" : "Verify the brief acceptance checks",
    } as Record<CoverageKind, string>,
    acceptance: (kind: CoverageKind) =>
      tr
        ? kind === "invariant"
          ? "Listedeki her kural gerçek oyunda/uygulamada doğrulanır."
          : "Listedeki her davranış çalışır durumda ve gerçek sayfada doğrulanır."
        : kind === "invariant"
          ? "Every listed rule holds in the real game/app."
          : "Every listed behavior works and is verified on the real page.",
    intro: tr
      ? "Görev brief'inde kapsanmayan maddeler:"
      : "Brief items not covered by the current plan:",
  };
}

function addTaskForKind(
  kind: CoverageKind,
  items: CoverageItem[],
  tasks: ProjectTask[],
  language: string | undefined,
  verification: string | undefined,
  gameDomain: boolean,
): ProjectTask | null {
  if (items.length === 0) return null;
  const labels = localized(language);
  const at = new Date().toISOString();
  const surface: IntentBehaviorSurface =
    kind === "extra" || kind === "ux" || kind === "acceptance"
      ? gameDomain
        ? "game"
        : "ui"
      : kind === "invariant" || kind === "norm"
        ? gameDomain
          ? "game"
          : "ui"
        : "other";
  const detail = [
    labels.intro,
    ...items.slice(0, 8).map((item) => `- ${item.text.slice(0, 260)}`),
  ].join("\n");
  const verifyOnly = kind === "acceptance";
  return {
    id: `task-cov-${tasks.length + 1}`,
    title: labels.titles[kind],
    detail,
    acceptance: labels.acceptance(kind),
    status: "pending",
    effort: items.length >= 4 ? "hard" : "standard",
    role: verifyOnly ? "reviewer" : "main",
    action: verifyOnly ? "verify" : "update",
    readOnly: verifyOnly ? true : undefined,
    verificationOnly: verifyOnly ? true : undefined,
    surface,
    dependsOn: tasks.length > 0 ? [tasks[tasks.length - 1].id] : [],
    attempts: 0,
    changedFiles: [],
    commands: [],
    verification: verification ? { command: verification } : undefined,
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * Deterministically map brief items to tasks, then add one focused task per
 * missing group. This is the coverage matrix the planner itself cannot skip.
 */
export function applyBriefCoverage(
  tasks: ProjectTask[],
  brief: TaskBrief,
  language: string | undefined,
  verification?: string,
): CoverageResult {
  const items = coverageItems(brief);
  const added: ProjectTask[] = [];
  const kinds: CoverageKind[] = ["invariant", "ux", "extra", "norm", "component"];
  const gameDomain =
    brief.domain !== undefined &&
    ["chess", "puzzle", "platformer"].includes(brief.domain.id);
  let current = [...tasks];
  // Keep the final verification task last; coverage edits must run before it.
  const verificationTail: ProjectTask[] = [];
  while (current.length > 0) {
    const last = current[current.length - 1];
    if (last.verificationOnly === true || last.action === "verify") {
      verificationTail.unshift(current.pop() as ProjectTask);
    } else {
      break;
    }
  }

  for (const kind of kinds) {
    const kindItems = items.filter((item) => item.kind === kind);
    if (kindItems.length === 0) continue;
    for (const item of kindItems) {
      item.coveredBy = isCovered(item, current);
    }
    const missing = kindItems.filter((item) => item.coveredBy.length === 0);
    if (missing.length === 0) continue;
    const task = addTaskForKind(kind, missing, current, language, verification, gameDomain);
    if (!task) continue;
    current = [...current, task];
    added.push(task);
    if (added.length >= 4) break;
  }

  const acceptanceItems = items.filter((item) => item.kind === "acceptance");
  if (acceptanceItems.length > 0) {
    for (const item of acceptanceItems) {
      item.coveredBy = isCovered(item, current);
    }
    const missingAcceptance = acceptanceItems.filter((item) => item.coveredBy.length === 0);
    const acceptanceTask = addTaskForKind(
      "acceptance",
      missingAcceptance,
      current,
      language,
      verification,
      gameDomain,
    );
    if (acceptanceTask) {
      current = [...current, acceptanceTask];
      added.push(acceptanceTask);
    }
  }

  if (verificationTail.length > 0) {
    if (added.length > 0 && current.length > 0) {
      verificationTail[0] = {
        ...verificationTail[0],
        dependsOn: [current[current.length - 1].id],
      };
    }
    current = [...current, ...verificationTail];
  }

  for (const item of items) {
    item.coveredBy = isCovered(item, current);
  }
  const missing = items.filter((item) => item.coveredBy.length === 0).map((item) => item.text);
  return {
    tasks: current,
    plan: {
      items,
      missing,
      addedTasks: added.length,
    },
  };
}

export function remapCoverage(items: CoverageItem[], tasks: ProjectTask[]): PlanCoverage {
  const remapped = items.map((item) => ({
    ...item,
    coveredBy: isCovered(item, tasks),
  }));
  return {
    items: remapped,
    missing: remapped
      .filter((item) => item.coveredBy.length === 0)
      .map((item) => item.text),
    addedTasks: 0,
  };
}

export function coveragePrompt(plan: PlanCoverage): string {
  const covered = plan.items.filter((item) => item.coveredBy.length > 0).length;
  return [
    `Coverage: ${covered}/${plan.items.length}`,
    plan.addedTasks > 0 ? `Added tasks for missing groups: ${plan.addedTasks}` : "",
    plan.missing.length > 0 ? `Missing:\n${plan.missing.map((item) => `- ${item}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
