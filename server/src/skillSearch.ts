import type { SkillCatalogItem, SkillCatalogResponse } from "../../shared/skills";

const SEARCH_URL = "https://skills.sh/api/search";
const MAX_RESULTS = 20;
const CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 60;

interface CacheEntry {
  at: number;
  value: SkillCatalogResponse;
}

const cache = new Map<string, CacheEntry>();

function text(value: unknown, max = 200): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function positiveInt(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

/**
 * Read-only search over the public skills.sh catalog.
 *
 * This deliberately does not install anything and does not shell out to
 * `npx skills`; installation stays in the existing preview/approval flow.
 */
export async function searchSkillCatalog(
  query: string,
  options: {
    owner?: string;
    limit?: number;
    fetchImpl?: typeof fetch;
    now?: number;
  } = {},
): Promise<SkillCatalogResponse> {
  const q = text(query, 120);
  if (q.length < 2) throw new Error("Enter at least 2 characters to search skills.");
  const owner = text(options.owner, 80);
  const limit = Math.max(1, Math.min(MAX_RESULTS, options.limit ?? 12));
  const now = options.now ?? Date.now();
  const cacheKey = `${q.toLowerCase()}|${owner.toLowerCase()}|${limit}`;
  const cached = cache.get(cacheKey);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.value;

  const url = new URL(SEARCH_URL);
  url.searchParams.set("q", q);
  if (owner) url.searchParams.set("owner", owner);

  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  let response: Response;
  try {
    response = await doFetch(url.toString(), {
      headers: {
        accept: "application/json",
        "user-agent": "BAD-IDE/skill-search",
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`Skill search failed with status ${response.status}.`);
  }
  const data = (await response.json()) as { skills?: unknown[] };
  const skills: SkillCatalogItem[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(data.skills) ? data.skills : []) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const id = text(record.id, 240);
    const source = text(record.source, 160);
    const skillId = text(record.skillId, 160) || id.split("/").pop() || "";
    const name = text(record.name, 160) || skillId;
    if (!id || !source || !skillId || !name) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    skills.push({
      id,
      source,
      skillId,
      name,
      installs: positiveInt(record.installs),
      url: `https://skills.sh/${id}`,
    });
    if (skills.length >= limit) break;
  }
  const value: SkillCatalogResponse = { query: q, skills };
  cache.set(cacheKey, { at: now, value });
  if (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = [...cache.entries()].sort((left, right) => left[1].at - right[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  return value;
}

/** Test seam: clear the in-memory search cache. */
export function clearSkillSearchCache(): void {
  cache.clear();
}
