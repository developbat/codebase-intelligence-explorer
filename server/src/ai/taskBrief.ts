import fs from "node:fs/promises";
import path from "node:path";
import type { AnalysisResult } from "../../../shared/types";
import type { IntentAnalysis } from "../../../shared/intent";
import { chat, type ChatMessage } from "./providers";
import { resolveAgentRole } from "./settings";
import { recordUsage } from "./usage";
import { analyzeRequestFrame, type RequestFrame } from "./requestFrame";
import { webSearch, type WebSearchResult } from "../webSearch";
import { webFetch } from "../webResearch";
import { matchDomainCards, type DomainCard } from "./domainKnowledge";

/**
 * Research-first task brief.
 *
 * Invariants come from a curated domain card (or are absent); task norms are
 * researched from the web with sources. The brief is written in the request
 * language and reused for 30 days per domain/extras/language.
 */

const BRIEF_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SOURCES = 4;
const MAX_FETCHED_SOURCES = 3;
const MAX_SOURCE_CHARS = 3_500;

export interface TaskBriefSource {
  title: string;
  url: string;
}

export interface TaskBrief {
  key: string;
  language: string;
  instruction: string;
  domain?: { id: string; name: string; summary: string };
  summary: string;
  invariants: string[];
  norms: string[];
  components: string[];
  dataModel: string[];
  ux: string[];
  pitfalls: string[];
  acceptance: string[];
  openDecisions: string[];
  extras: string[];
  sources: TaskBriefSource[];
  verifiedAt: string;
  cached: boolean;
  fallback?: string;
}

interface BriefPayload {
  summary?: string;
  invariants?: string[];
  norms?: string[];
  components?: string[];
  dataModel?: string[];
  ux?: string[];
  pitfalls?: string[];
  acceptance?: string[];
  openDecisions?: string[];
}

const LANGUAGE_NAMES: Record<string, string> = {
  tr: "Turkish",
  en: "English",
  de: "German",
  fr: "French",
  es: "Spanish",
  it: "Italian",
  pt: "Portuguese",
  ru: "Russian",
  ar: "Arabic",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
  nl: "Dutch",
  pl: "Polish",
  uk: "Ukrainian",
};

function languageName(language: string): string {
  return LANGUAGE_NAMES[language.toLowerCase().slice(0, 2)] ?? language;
}

function slug(value: string): string {
  const normalized = value
    .toLocaleLowerCase("tr")
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return normalized || "task";
}

export function taskBriefKey(frame: RequestFrame, language: string): string {
  const subject = frame.domain?.card.id ?? slug(frame.deliverable);
  const extras = frame.extras.map(slug).join("-") || "default";
  return `${slug(subject)}-${extras}-${slug(language)}`;
}

function briefPaths(rootPath: string, key: string): { json: string; md: string; relMd: string } {
  const relMd = `.cie/agent/briefs/${key}.md`;
  return {
    json: path.resolve(rootPath, `.cie/agent/briefs/${key}.json`),
    md: path.resolve(rootPath, relMd),
    relMd,
  };
}

async function writeAtomic(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temp, file);
}

function asStringArray(value: unknown, limit = 20): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim().slice(0, 400))
    .slice(0, limit);
}

function extractJson(text: string): unknown {
  const trimmed = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

function dedupe(items: string[], limit: number): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of items) {
    const key = item.replace(/\s+/g, " ").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(item.trim());
    if (output.length >= limit) break;
  }
  return output;
}

function cardFacts(card: DomainCard | undefined): {
  invariants: string[];
  components: string[];
  ux: string[];
  pitfalls: string[];
  acceptance: string[];
  openDecisions: string[];
} {
  if (!card) {
    return {
      invariants: [],
      components: [],
      ux: [],
      pitfalls: [],
      acceptance: [],
      openDecisions: [],
    };
  }
  return {
    invariants: card.mechanics.slice(0, 12),
    components: card.entities.slice(0, 10),
    ux: card.ux.slice(0, 8),
    pitfalls: card.pitfalls.slice(0, 8),
    acceptance: card.verification.slice(0, 12),
    openDecisions: card.questions
      .filter((question) => question.highImpact === true)
      .map((question) => question.ask.en),
  };
}

async function gatherSources(
  subject: string,
  frame: RequestFrame,
  language: string,
): Promise<{ sources: TaskBriefSource[]; excerpts: { title: string; url: string; text: string; snippet?: string }[] }> {
  const queries = [
    `${subject} UI UX best practices components`,
    `${subject} rules mechanics checklist`,
    frame.extras.length > 0 ? `${frame.extras.join(" ")} game UI design inspiration` : "",
  ].filter(Boolean);
  const searches = await Promise.allSettled(
    queries.map((query) => webSearch(query, { limit: 4, language: "en" })),
  );
  const results: WebSearchResult[] = [];
  for (const search of searches) {
    if (search.status !== "fulfilled") continue;
    for (const result of search.value.results) {
      if (!result.url) continue;
      results.push(result);
    }
  }
  const seen = new Set<string>();
  const unique: WebSearchResult[] = [];
  for (const result of results) {
    const url = result.url.replace(/#.*$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    unique.push({ ...result, url });
    if (unique.length >= MAX_SOURCES) break;
  }
  const sources = unique.map((result) => ({
    title: result.title || result.url,
    url: result.url,
  }));

  const fetched = await Promise.allSettled(
    unique.slice(0, MAX_FETCHED_SOURCES).map(async (result) => {
      const page = await webFetch(result.url, MAX_SOURCE_CHARS);
      return {
        title: page.title || result.title || result.url,
        url: result.url,
        text: page.text.slice(0, MAX_SOURCE_CHARS),
        snippet: result.snippet,
      };
    }),
  );
  const excerpts: {
    title: string;
    url: string;
    text: string;
    snippet?: string;
  }[] = [];
  for (const item of fetched) {
    if (item.status === "fulfilled") excerpts.push(item.value);
  }
  return { sources, excerpts };
}

function fallbackPayload(
  card: DomainCard | undefined,
  excerpts: { title: string; url: string; text: string; snippet?: string }[],
): BriefPayload {
  const facts = cardFacts(card);
  const snippets = excerpts
    .map((excerpt) => excerpt.snippet)
    .filter((item): item is string => Boolean(item && item.trim()))
    .slice(0, 6);
  return {
    summary: card?.summary ?? "",
    invariants: facts.invariants,
    norms: snippets,
    components: facts.components,
    dataModel: [],
    ux: facts.ux,
    pitfalls: facts.pitfalls,
    acceptance: facts.acceptance,
    openDecisions: facts.openDecisions,
  };
}

function renderSourceExcerpts(
  excerpts: { title: string; url: string; text: string; snippet?: string }[],
): string {
  return excerpts
    .map(
      (source, index) =>
        `[${index + 1}] ${source.title} — ${source.url}\n${source.snippet ? `Snippet: ${source.snippet}\n` : ""}${source.text}`,
    )
    .join("\n\n")
    .slice(0, 14_000);
}

function buildSynthesisMessages(
  instruction: string,
  frame: RequestFrame,
  language: string,
  card: DomainCard | undefined,
  excerpts: { title: string; url: string; text: string; snippet?: string }[],
): ChatMessage[] {
  const facts = cardFacts(card);
  const sourceText = renderSourceExcerpts(excerpts);
  const languageLabel = languageName(language);
  return [
    {
      role: "system",
      content: `You are a task brief researcher for a coding agent. Use only the supplied sources; never invent facts. Separate fixed domain invariants from researched product norms. Write the JSON only, no prose, no Markdown fences.
Schema:
{"summary":"one paragraph","invariants":["fixed rule"],"norms":["how good products in this domain normally work"],"components":["UI/logic component"],"dataModel":["state/data entity"],"ux":["UX convention"],"pitfalls":["common failure"],"acceptance":["observable check"],"openDecisions":["decision the user must make"]}
Rules:
- Write summary, norms, components, dataModel, ux, pitfalls, acceptance and openDecisions in ${languageLabel}. Keep source titles, URLs and quoted authoritative rule text unchanged.
- Domain invariants supplied below are authoritative; merge them without contradiction. If a source conflicts with an invariant, keep the invariant.
- Include 3-6 researched norms, 4-8 components, 2-5 data/state items, 3-6 UX items, 3-6 pitfalls, 4-8 acceptance checks and 2-4 open decisions.
- Cite a norm by putting its source URL in parentheses at the end of the norm.
- User extras (theme, style, mascot) are required presentation requirements; they must never change domain rules or mechanics.
- If a norm is not supported by a source, omit it.`,
    },
    {
      role: "user",
      content: [
        `Task: ${instruction}`,
        `Deliverable: ${frame.deliverable} (${frame.surface})`,
        frame.extras.length > 0 ? `User extras: ${frame.extras.join(", ")}` : "",
        card ? `Domain: ${card.name} (${card.id})` : "",
        facts.invariants.length > 0
          ? `Authoritative domain invariants:\n${facts.invariants.map((item) => `- ${item}`).join("\n")}`
          : "",
        `Sources:\n${sourceText || "(no fetched sources)"}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];
}

async function synthesizePayload(
  instruction: string,
  frame: RequestFrame,
  language: string,
  card: DomainCard | undefined,
  excerpts: { title: string; url: string; text: string; snippet?: string }[],
  options: { projectId?: string; signal?: AbortSignal },
): Promise<{ payload: BriefPayload; fallback?: string }> {
  if (excerpts.length === 0 && !card) {
    return {
      payload: fallbackPayload(card, excerpts),
      fallback: "No web sources were available; used the request frame only.",
    };
  }
  try {
    const config = await resolveAgentRole("planner");
    let usage:
      | { inputTokens: number; outputTokens: number; totalTokens: number }
      | undefined;
    const addUsage = (
      current: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined,
      next: { inputTokens: number; outputTokens: number; totalTokens: number },
    ) =>
      current
        ? {
            inputTokens: current.inputTokens + next.inputTokens,
            outputTokens: current.outputTokens + next.outputTokens,
            totalTokens: current.totalTokens + next.totalTokens,
          }
        : next;
    let raw = await chat(
      config,
      buildSynthesisMessages(instruction, frame, language, card, excerpts),
      {
        maxTokens: 3_000,
        temperature: 0.1,
        timeoutMs: 90_000,
        signal: options.signal,
        onUsage: (value) => {
          usage = addUsage(usage, value);
        },
      },
    );
    let parsed = extractJson(raw) as BriefPayload | null;
    if (!parsed || typeof parsed !== "object") {
      // Small models often wrap or truncate a large schema. Retry with the
      // smallest useful shape before falling back to raw snippets.
      raw = await chat(
        config,
        [
          {
            role: "system",
            content: `Return only JSON with this shape: {"summary":"","norms":[""],"components":[""],"ux":[""],"pitfalls":[""],"acceptance":[""],"openDecisions":[""]}. Write the text in ${languageName(language)}. Use only the supplied sources. No prose, no Markdown fences.`,
          },
          {
            role: "user",
            content: `Task: ${instruction}\nUser extras: ${frame.extras.join(", ") || "none"}\nSources:\n${renderSourceExcerpts(excerpts).slice(0, 9_000)}`,
          },
        ],
        {
          maxTokens: 1_400,
          temperature: 0.1,
          timeoutMs: 60_000,
          signal: options.signal,
          onUsage: (value) => {
            usage = addUsage(usage, value);
          },
        },
      );
      parsed = extractJson(raw) as BriefPayload | null;
    }
    if (usage && options.projectId) {
      await recordUsage({
        projectId: options.projectId,
        provider: config.id,
        model: config.model,
        kind: "research",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
      }).catch(() => undefined);
    }
    if (!parsed || typeof parsed !== "object") {
      return {
        payload: fallbackPayload(card, excerpts),
        fallback:
          language.toLowerCase().startsWith("tr")
            ? "Araştırma özeti JSON üretemedi; kaynak alıntıları ve domain kartı kullanıldı."
            : "Research synthesis returned invalid JSON; used search snippets and the domain card.",
      };
    }
    return {
      payload: {
        summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
        invariants: asStringArray(parsed.invariants),
        norms: asStringArray(parsed.norms),
        components: asStringArray(parsed.components),
        dataModel: asStringArray(parsed.dataModel),
        ux: asStringArray(parsed.ux),
        pitfalls: asStringArray(parsed.pitfalls),
        acceptance: asStringArray(parsed.acceptance),
        openDecisions: asStringArray(parsed.openDecisions),
      },
    };
  } catch (error) {
    return {
      payload: fallbackPayload(card, excerpts),
      fallback: `Research synthesis failed (${error instanceof Error ? error.message.slice(0, 160) : "unknown"}); used search snippets and the domain card.`,
    };
  }
}

function mergeBrief(
  frame: RequestFrame,
  language: string,
  instruction: string,
  key: string,
  card: DomainCard | undefined,
  payload: BriefPayload,
  sources: TaskBriefSource[],
  fallback: string | undefined,
): TaskBrief {
  const facts = cardFacts(card);
  return {
    key,
    language,
    instruction,
    domain: card ? { id: card.id, name: card.name, summary: card.summary } : undefined,
    summary: payload.summary?.trim() || card?.summary || instruction,
    invariants: dedupe([...facts.invariants, ...(payload.invariants ?? [])], 14),
    norms: dedupe(payload.norms ?? [], 8),
    components: dedupe([...(payload.components ?? []), ...facts.components], 10),
    dataModel: dedupe(payload.dataModel ?? [], 8),
    ux: dedupe([...(payload.ux ?? []), ...facts.ux], 10),
    pitfalls: dedupe([...(payload.pitfalls ?? []), ...facts.pitfalls], 10),
    acceptance: dedupe([...facts.acceptance, ...(payload.acceptance ?? [])], 14),
    openDecisions: dedupe([...facts.openDecisions, ...(payload.openDecisions ?? [])], 8),
    extras: frame.extras,
    sources,
    verifiedAt: new Date().toISOString(),
    cached: false,
    fallback,
  };
}

function localizedLabels(language: string) {
  if (language.toLowerCase().startsWith("tr")) {
    return {
      title: "Görev brief'i",
      goal: "Amaç",
      invariants: "Değişmez kurallar",
      norms: "Araştırılan normlar",
      components: "Bileşenler",
      dataModel: "Veri ve durum",
      ux: "UX",
      pitfalls: "Tuzaklar",
      acceptance: "Kabul kriterleri",
      decisions: "Açık kararlar",
      extras: "Kullanıcı ekstraları",
      sources: "Kaynaklar",
      note: "Not",
    };
  }
  return {
    title: "Task brief",
    goal: "Goal",
    invariants: "Domain invariants",
    norms: "Researched norms",
    components: "Components",
    dataModel: "Data and state",
    ux: "UX",
    pitfalls: "Pitfalls",
    acceptance: "Acceptance",
    decisions: "Open decisions",
    extras: "User extras",
    sources: "Sources",
    note: "Note",
  };
}

export function renderTaskBriefMarkdown(brief: TaskBrief): string {
  const labels = localizedLabels(brief.language);
  const list = (items: string[]) => (items.length > 0 ? items.map((item) => `- ${item}`) : ["- —"]);
  return [
    `# ${labels.title}: ${brief.domain?.name ?? brief.instruction.slice(0, 80)}`,
    "",
    `Generated: ${brief.verifiedAt} · Language: ${brief.language}${brief.cached ? " · cached" : ""}`,
    brief.fallback ? `${labels.note}: ${brief.fallback}` : "",
    "",
    `## ${labels.goal}`,
    brief.instruction,
    "",
    brief.summary ? `${brief.summary}` : "",
    "",
    `## ${labels.invariants}`,
    ...list(brief.invariants),
    "",
    `## ${labels.norms}`,
    ...list(brief.norms),
    "",
    `## ${labels.components}`,
    ...list(brief.components),
    "",
    `## ${labels.dataModel}`,
    ...list(brief.dataModel),
    "",
    `## ${labels.ux}`,
    ...list(brief.ux),
    "",
    `## ${labels.pitfalls}`,
    ...list(brief.pitfalls),
    "",
    `## ${labels.acceptance}`,
    ...list(brief.acceptance),
    "",
    `## ${labels.decisions}`,
    ...list(brief.openDecisions),
    "",
    `## ${labels.extras}`,
    ...list(brief.extras),
    "",
    `## ${labels.sources}`,
    ...(brief.sources.length > 0
      ? brief.sources.map((source) => `- [${source.title}](${source.url})`)
      : ["- —"]),
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function briefPromptFacts(brief: TaskBrief): string {
  const list = (items: string[], limit: number) =>
    items.slice(0, limit).map((item) => `- ${item}`).join("\n");
  return [
    `Task brief (${brief.language}; researched norms with sources; authoritative invariants):`,
    `Summary: ${brief.summary}`,
    brief.invariants.length > 0
      ? `Domain invariants:\n${list(brief.invariants, 12)}`
      : "",
    brief.norms.length > 0 ? `Researched norms:\n${list(brief.norms, 8)}` : "",
    brief.components.length > 0 ? `Components:\n${list(brief.components, 10)}` : "",
    brief.dataModel.length > 0 ? `Data/state:\n${list(brief.dataModel, 8)}` : "",
    brief.ux.length > 0 ? `UX conventions:\n${list(brief.ux, 8)}` : "",
    brief.pitfalls.length > 0 ? `Pitfalls:\n${list(brief.pitfalls, 8)}` : "",
    brief.acceptance.length > 0 ? `Acceptance checks:\n${list(brief.acceptance, 12)}` : "",
    brief.openDecisions.length > 0 ? `Open decisions: ${brief.openDecisions.join("; ")}` : "",
    brief.extras.length > 0
      ? `User extras (required; never change domain rules): ${brief.extras.join(", ")}`
      : "",
    brief.sources.length > 0
      ? `Sources:\n${brief.sources.map((source) => `- ${source.title} — ${source.url}`).join("\n")}`
      : "Sources: none (domain card only)",
    brief.fallback ? `Research note: ${brief.fallback}` : "",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 8_000);
}

export async function prepareTaskBrief(
  rootPath: string,
  instruction: string,
  analysis: AnalysisResult,
  options: {
    language?: string;
    intent?: IntentAnalysis;
    write?: boolean;
    projectId?: string;
    signal?: AbortSignal;
    research?: boolean;
    force?: boolean;
  } = {},
): Promise<TaskBrief> {
  const normalizedInstruction = instruction.trim();
  const frame = analyzeRequestFrame(normalizedInstruction, analysis, options.language);
  const language = options.language?.trim().toLowerCase().slice(0, 2) || frame.language;
  const card = frame.domain?.card ?? matchDomainCards(normalizedInstruction, { limit: 1 })[0]?.card;
  const key = taskBriefKey(frame, language);
  const paths = briefPaths(rootPath, key);

  if (!options.force) {
    try {
      const cached = JSON.parse(await fs.readFile(paths.json, "utf8")) as TaskBrief;
      if (
        cached.key === key &&
        cached.language === language &&
        Date.now() - Date.parse(cached.verifiedAt) < BRIEF_TTL_MS
      ) {
        return { ...cached, cached: true };
      }
    } catch {
      // No fresh cache.
    }
  }

  const wantsResearch =
    options.research ??
    (frame.action === "build" ||
      (frame.action === "edit" && (options.intent?.scope === "large" || options.intent?.mode === "loop")));

  let sources: TaskBriefSource[] = [];
  let payload: BriefPayload;
  let fallback: string | undefined;
  if (wantsResearch) {
    const subject = card?.name ?? frame.deliverable;
    const gathered = await gatherSources(subject, frame, language);
    sources = gathered.sources;
    const synthesized = await synthesizePayload(
      normalizedInstruction,
      frame,
      language,
      card,
      gathered.excerpts,
      { projectId: options.projectId, signal: options.signal },
    );
    payload = synthesized.payload;
    fallback = synthesized.fallback;
  } else {
    payload = fallbackPayload(card, []);
    fallback = "Research skipped for a small task; used the domain card and request frame.";
  }

  const brief = mergeBrief(
    frame,
    language,
    normalizedInstruction,
    key,
    card,
    payload,
    sources,
    fallback,
  );
  if (options.write !== false) {
    await writeAtomic(paths.json, JSON.stringify(brief, null, 2));
    await writeAtomic(paths.md, renderTaskBriefMarkdown(brief));
  }
  return brief;
}
