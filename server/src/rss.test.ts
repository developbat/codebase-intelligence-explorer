import assert from "node:assert/strict";
import test from "node:test";
import { parseRssFeed } from "./rss";

test("parses RSS items and decodes entities", () => {
  const xml = `<?xml version="1.0"?><rss><channel><title>News</title>
    <item><title>Hello &amp; world</title><link>https://example.com/a</link>
    <pubDate>Mon, 30 Nov 2026 09:00:00 GMT</pubDate>
    <description><![CDATA[<p>Summary <b>here</b></p>]]></description></item>
  </channel></rss>`;
  const feed = parseRssFeed(xml, "https://example.com/feed.xml");
  assert.equal(feed.title, "News");
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].title, "Hello & world");
  assert.equal(feed.items[0].link, "https://example.com/a");
  assert.equal(feed.items[0].summary, "Summary here");
});

test("parses Atom entries", () => {
  const xml = `<feed><title>Blog</title><entry><title>Post</title>
    <link href="https://example.com/post"/><updated>2026-11-30T09:00:00Z</updated>
    <summary>Short text</summary></entry></feed>`;
  const feed = parseRssFeed(xml, "https://example.com/atom.xml");
  assert.equal(feed.title, "Blog");
  assert.equal(feed.items[0].link, "https://example.com/post");
  assert.equal(feed.items[0].published, "2026-11-30T09:00:00Z");
});
