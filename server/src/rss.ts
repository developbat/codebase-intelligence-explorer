export interface RssItem {
  title: string;
  link: string;
  published?: string;
  summary?: string;
}

export interface RssFeed {
  title: string;
  items: RssItem[];
  source: string;
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, names: string[]): string {
  for (const name of names) {
    const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
    if (match) return decodeXml(match[1]);
  }
  return "";
}

function atomLink(block: string): string {
  const match = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i);
  return match ? decodeXml(match[1]) : "";
}

function linkOf(block: string): string {
  const direct = tag(block, ["link"]);
  if (direct) return direct;
  return atomLink(block);
}

function feedTitle(xml: string): string {
  const channel = xml.match(/<channel\b[^>]*>([\s\S]*?)<\/channel>/i);
  if (channel) return tag(channel[1], ["title"]);
  const feed = xml.match(/<feed\b[^>]*>([\s\S]*?)<\/feed>/i);
  if (feed) return tag(feed[1], ["title"]);
  return "";
}

export async function readRssFeed(
  url: string,
  options: { limit?: number; timeoutMs?: number } = {},
): Promise<RssFeed> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("RSS URL is invalid.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("RSS URL must start with http:// or https://.");
  }
  const limit = Math.max(1, Math.min(30, Number(options.limit) || 10));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  let xml: string;
  try {
    const response = await fetch(parsed.toString(), {
      signal: controller.signal,
      headers: {
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
        "User-Agent": "B.A.D-IDE/1.0 (+https://localhost)",
      },
    });
    if (!response.ok) throw new Error(`RSS feed returned HTTP ${response.status}.`);
    xml = await response.text();
  } catch (error) {
    throw new Error(
      error instanceof Error ? `RSS fetch failed: ${error.message}` : "RSS fetch failed.",
    );
  } finally {
    clearTimeout(timer);
  }
  if (xml.length > 4_000_000) throw new Error("RSS feed is too large.");
  return parseRssFeed(xml, parsed.toString(), limit);
}

export function parseRssFeed(xml: string, source: string, limit = 10): RssFeed {
  const blocks = [
    ...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi),
    ...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi),
  ]
    .map((match) => match[1])
    .slice(0, Math.max(1, Math.min(30, limit)));

  const items = blocks
    .map((block) => ({
      title: tag(block, ["title"]),
      link: linkOf(block),
      published: tag(block, ["pubDate", "published", "updated", "dc:date"]),
      summary: tag(block, ["description", "summary", "content:encoded", "content"]).slice(0, 800),
    }))
    .filter((item) => item.title || item.link);

  if (items.length === 0) throw new Error("No RSS/Atom items were found in this feed.");
  return { title: feedTitle(xml), items, source };
}
