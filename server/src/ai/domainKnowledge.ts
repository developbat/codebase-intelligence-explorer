import fs from "node:fs/promises";
import path from "node:path";
import chess from "../../../knowledge/domains/chess.json";
import puzzle from "../../../knowledge/domains/puzzle.json";
import platformer from "../../../knowledge/domains/platformer.json";
import todoDashboard from "../../../knowledge/domains/todo-dashboard.json";
import booking from "../../../knowledge/domains/booking.json";
import type { IntentAnalysis, IntentOption } from "../../../shared/intent";

export interface LocalizedText {
  en: string;
  tr?: string;
}

export interface DomainOption {
  label: LocalizedText;
  suffix: LocalizedText;
}

export interface DomainQuestion {
  id: string;
  highImpact?: boolean;
  ask: LocalizedText;
  /** Signals that show the request already settled this decision. */
  answeredBy?: string[];
  options: DomainOption[];
}

export interface DomainCard {
  id: string;
  name: string;
  aliases: string[];
  signals: string[];
  summary: string;
  entities: string[];
  mechanics: string[];
  ux: string[];
  pitfalls: string[];
  defaults: string[];
  questions: DomainQuestion[];
  verification: string[];
  sources?: string[];
}

export interface DomainMatch {
  card: DomainCard;
  score: number;
  matched: string[];
}

export const DOMAIN_CARDS: DomainCard[] = [
  chess,
  puzzle,
  platformer,
  todoDashboard,
  booking,
] as DomainCard[];

const MIN_MATCH_SCORE = 2;

/** Lowercase, strip Turkish diacritics and punctuation so TR/EN stems match. */
export function normalizeDomainText(value: string): string {
  return value
    .toLocaleLowerCase("tr")
    .replace(/ı/g, "i")
    .replace(/İ/g, "i")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasSignal(normalized: string, signal: string): boolean {
  const needle = normalizeDomainText(signal);
  if (!needle) return false;
  return new RegExp(`(?:^|\\s)${escapeRegExp(needle)}`).test(normalized);
}

export function scoreDomainCard(card: DomainCard, instruction: string): DomainMatch {
  const normalized = normalizeDomainText(instruction);
  const matched: string[] = [];
  let score = 0;
  for (const signal of [...card.aliases, ...card.signals]) {
    if (!hasSignal(normalized, signal)) continue;
    const key = normalizeDomainText(signal);
    if (matched.includes(key)) continue;
    matched.push(key);
    // One long signal is enough; short ones need a second hit.
    score += key.replace(/\s+/g, "").length >= 5 ? 2 : 1;
  }
  return { card, score, matched };
}

export function matchDomainCards(
  instruction: string,
  options: { limit?: number; minScore?: number } = {},
): DomainMatch[] {
  const minScore = options.minScore ?? MIN_MATCH_SCORE;
  return DOMAIN_CARDS.map((card) => scoreDomainCard(card, instruction))
    .filter((match) => match.score >= minScore)
    .sort((left, right) => right.score - left.score)
    .slice(0, options.limit ?? 2);
}

export function localizedText(value: LocalizedText, language?: string): string {
  return language?.toLowerCase().startsWith("tr") && value.tr ? value.tr : value.en;
}

export function pickDomainQuestion(
  card: DomainCard,
  instruction: string,
): DomainQuestion | null {
  const normalized = normalizeDomainText(instruction);
  for (const question of card.questions) {
    if (question.highImpact !== true) continue;
    if (question.options.length < 2) continue;
    const answered = (question.answeredBy ?? []).some((signal) => hasSignal(normalized, signal));
    if (!answered) return question;
  }
  return null;
}

export function domainQuestionOptions(
  card: DomainCard,
  question: DomainQuestion,
  language?: string,
): IntentOption[] {
  return question.options.map((option, index) => ({
    id: `${card.id}-${question.id}-${index + 1}`,
    label: localizedText(option.label, language),
    instructionSuffix: localizedText(option.suffix, language),
  }));
}

/**
 * Force the card's highest-impact unanswered decision into the clarification
 * slot for a new build. The intent model normally asks it itself because the
 * card is in its prompt; this is the deterministic fallback.
 */
export function applyDomainClarification(
  intent: IntentAnalysis,
  instruction: string,
  match: DomainMatch | undefined,
  language?: string,
  clarified?: boolean,
): IntentAnalysis {
  if (!match || clarified === true) return intent;
  if (intent.needsClarification) return intent;
  if (intent.kind !== "scaffold" && intent.kind !== "edit") return intent;
  // A new build asks for the core decision; a small edit (color, label, fix)
  // must not be interrupted by a domain question.
  if (intent.kind === "edit" && intent.scope !== "large") return intent;
  const question = pickDomainQuestion(match.card, instruction);
  if (!question) return intent;
  const options = domainQuestionOptions(match.card, question, language);
  if (options.length < 2) return intent;
  return {
    ...intent,
    needsClarification: true,
    question: localizedText(question.ask, language),
    options,
    assumptions: [
      ...intent.assumptions.filter((item) => !/^Domain:/.test(item)),
      `Domain: ${match.card.name} (${match.card.id})`,
    ].slice(0, 8),
  };
}

function compactList(items: string[], limit: number): string[] {
  return items.slice(0, limit);
}

export function domainPromptFacts(match: DomainMatch): string {
  const card = match.card;
  const openQuestions = card.questions
    .filter((question) => question.highImpact === true)
    .map((question) => `${question.id}: ${question.ask.en}`);
  return [
    `Domain reference: ${card.name} (${card.id})`,
    `Summary: ${card.summary}`,
    `Core rules / mechanics:\n${compactList(card.mechanics, 12)
      .map((item) => `- ${item}`)
      .join("\n")}`,
    `Defaults when the user leaves a choice open:\n${compactList(card.defaults, 6)
      .map((item) => `- ${item}`)
      .join("\n")}`,
    openQuestions.length > 0
      ? `High-impact decisions (ask only if the request does not already answer them): ${openQuestions.join("; ")}`
      : "",
    `Verification checklist:\n${compactList(card.verification, 10)
      .map((item) => `- ${item}`)
      .join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderDomainBrief(card: DomainCard, goal: string): string {
  const request = goal.replace(/\s+/g, " ").trim().slice(0, 400);
  return [
    `# ${card.name} domain brief`,
    "",
    `Generated from \`knowledge/domains/${card.id}.json\`. Reused for this project;`,
    "edit the domain card to change the rules.",
    "",
    `Latest request: ${request}`,
    "",
    "## Summary",
    card.summary,
    "",
    "## Entities",
    ...card.entities.map((item) => `- ${item}`),
    "",
    "## Rules / mechanics",
    ...card.mechanics.map((item) => `- ${item}`),
    "",
    "## UX conventions",
    ...card.ux.map((item) => `- ${item}`),
    "",
    "## Pitfalls",
    ...card.pitfalls.map((item) => `- ${item}`),
    "",
    "## Defaults",
    ...card.defaults.map((item) => `- ${item}`),
    "",
    "## Open questions",
    ...card.questions.map((question) => {
      const options = question.options.map((option) => option.label.en).join(" / ");
      return `- ${question.ask.en} (${options})`;
    }),
    "",
    "## Verification checklist",
    ...card.verification.map((item) => `- [ ] ${item}`),
    "",
    "## Sources",
    ...(card.sources && card.sources.length > 0
      ? card.sources.map((item) => `- ${item}`)
      : ["- Curated domain card in this repository."]),
    "",
  ].join("\n");
}

export interface DomainBrief {
  match: DomainMatch;
  /** Prompt-ready compact facts (authoritative). */
  facts: string;
  /** Project-relative markdown path. */
  relPath: string;
  markdown: string;
  wrote: boolean;
}

/**
 * Match the goal, write (once) a reusable brief under `.cie/agent/knowledge`,
 * and return the facts for the planner/executor prompts.
 */
export async function prepareDomainBrief(
  rootPath: string,
  goal: string,
  options: { write?: boolean } = {},
): Promise<DomainBrief | null> {
  const match = matchDomainCards(goal, { limit: 1 })[0];
  if (!match) return null;
  const relPath = `.cie/agent/knowledge/${match.card.id}.md`;
  const absolute = path.resolve(rootPath, relPath);
  const root = path.resolve(rootPath);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) return null;
  const markdown = renderDomainBrief(match.card, goal);
  let wrote = false;
  if (options.write !== false) {
    let existing = "";
    try {
      existing = await fs.readFile(absolute, "utf8");
    } catch {
      // No brief yet.
    }
    if (!existing.trim()) {
      await fs.mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
      const temp = `${absolute}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(temp, markdown, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temp, absolute);
      wrote = true;
    }
  }
  return {
    match,
    facts: domainPromptFacts(match),
    relPath,
    markdown,
    wrote,
  };
}
