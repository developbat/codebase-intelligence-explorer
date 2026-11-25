import assert from "node:assert/strict";
import test from "node:test";
import {
  isNewsQuery,
  parseDuckDuckGoHtml,
  parseGoogleNewsRss,
  refineSearchQuery,
  shouldSearchWeb,
} from "./webSearch";

test("parses Google News RSS items and entities", () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item>
      <title>Yapay zeka &amp; haber</title>
      <link>https://news.example.com/a</link>
      <pubDate>Mon, 24 Nov 2026 10:00:00 GMT</pubDate>
      <description>&lt;p&gt;Bugünün özeti&lt;/p&gt;</description>
      <source>Example News</source>
    </item>
    <item>
      <title>Second</title>
      <link>https://news.example.com/b</link>
    </item>
  </channel></rss>`;
  const results = parseGoogleNewsRss(xml);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, "Yapay zeka & haber");
  assert.equal(results[0].url, "https://news.example.com/a");
  assert.match(results[0].snippet ?? "", /Bugünün özeti/);
  assert.equal(results[0].source, "Example News");
});

test("parses DuckDuckGo result blocks and decodes redirects", () => {
  const html = `<div class="result results_links">
    <a rel="nofollow" class="result__a" href="https://example.com/page">Example title</a>
    <a class="result__snippet" href="https://example.com/page">A short snippet &amp; detail</a>
  </div>
  <div class="result results_links">
    <a rel="nofollow" class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fb">Second</a>
  </div>`;
  const results = parseDuckDuckGoHtml(html);
  assert.equal(results.length, 2);
  assert.equal(results[0].url, "https://example.com/page");
  assert.match(results[0].snippet ?? "", /snip.*detail/);
  assert.equal(results[1].url, "https://example.org/b");
});

test("detects news intent in Turkish and English", () => {
  assert.equal(isNewsQuery("bugün en güncel haberler"), true);
  assert.equal(isNewsQuery("latest AI news"), true);
  assert.equal(isNewsQuery("rename the button"), false);
});


test("routes explicit and recent AI-model searches to web search", () => {
  assert.equal(shouldSearchWeb("son çıkan yapay zeka modeli araması yaparmısın"), true);
  assert.equal(shouldSearchWeb("son çıkan yapay zeka modeli"), true);
  assert.equal(shouldSearchWeb("bu hafta çıkan yapay zeka modelleri"), true);
  assert.equal(shouldSearchWeb("bugün hava nasıl?"), true);
  assert.equal(shouldSearchWeb("merhaba"), false);
  assert.equal(
    shouldSearchWeb("neler yapabilirsin", { capabilityQuestion: true }),
    false,
  );
  assert.equal(shouldSearchWeb("src/app.ts dosyasını oku"), false);
  assert.equal(shouldSearchWeb("son çıkan yapay zeka modeli", { useWeb: false }), false);
  assert.equal(shouldSearchWeb("https://example.com/foo", { hasUrls: true }), false);
});


test("refines vague latest-model requests into a dated search query", () => {
  const tr = refineSearchQuery(
    "son çıkan yapay zeka modeli araması yaparmısın",
    "tr",
    new Date("2026-11-25T00:00:00Z"),
  );
  assert.match(tr, /2026/);
  assert.match(tr, /yapay zeka/i);
  assert.match(tr, /duyuru|sürüm/i);
  const en = refineSearchQuery(
    "latest AI model release",
    "en",
    new Date("2026-11-25T00:00:00Z"),
  );
  assert.match(en, /2026/);
  assert.match(en, /AI models/i);
  assert.equal(refineSearchQuery("rename the button", "en"), "rename the button");
});
