import assert from "node:assert/strict";
import test from "node:test";
import {
  isNewsQuery,
  parseDuckDuckGoHtml,
  parseGoogleNewsRss,
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
