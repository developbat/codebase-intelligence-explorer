export function isCapabilityQuestion(text: string): boolean {
  return /(?:neler yapabil|neler yapıyorsun|ne yapabil|yeteneklerin|yetenekleriniz|özelliklerin|ozelliklerin|hangi araçlar|hangi araclar|araçların|araclarin|what can you do|what are your capabilities|your capabilities|features|what tools)/i.test(
    text.trim(),
  );
}

/**
 * Local, authoritative product info. This is injected only when the user asks
 * what the assistant/product can do; it is never part of every prompt and never
 * triggers a web search.
 */
export function chatCapabilityBrief(): string {
  return [
    "B.A.D IDE capability info (local, authoritative):",
    "- Research: live web search through Google News RSS, optional Google Custom Search, and DuckDuckGo fallback; fetch page text; compare sources and flag single/weak evidence.",
    "- Current information: today/latest questions can use fresh search results and the current date; the Sources panel keeps URLs out of the answer body.",
    "- Documents and analysis: summarize long text, extract structured data, build comparison tables, check claim/number consistency, and turn drafts into decision frameworks.",
    "- Writing: emails, proposals, reports, FAQs, product copy, technical docs, tone adjustment, shortening, and TR↔EN translation.",
    "- Planning: trade-off analysis, assumptions/risks, option comparison, and step-by-step plans.",
    "- Technical topics: read and explain code, debug logic, discuss architecture and technology choices, and plan changes; file edits, commands, tests and browser verification are handled by Code Studio.",
    "Answer with 4-6 short bullets. Do not add a limitations section, raw URLs, or a self-introduction.",
  ].join("\n");
}
