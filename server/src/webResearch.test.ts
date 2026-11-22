import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  extractReadableText,
  listResearchNotes,
  readResearchNote,
  saveResearchNote,
  searchResearchNotes,
} from "./webResearch";

test("HTML is reduced to readable text with a title", () => {
  const result = extractReadableText(
    `<html><head><title>Docs &amp; API</title><style>.x{}</style></head>
     <body><script>alert(1)</script><h1>Hello</h1><p>First&nbsp;line</p><p>Second &lt;tag&gt;</p></body></html>`,
  );
  assert.equal(result.title, "Docs & API");
  assert.match(result.text, /Hello/);
  assert.match(result.text, /First line/);
  assert.match(result.text, /Second <tag>/);
  assert.doesNotMatch(result.text, /alert/);
});

test("research notes are saved, listed, read and searched as one note", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-notes-"));
  try {
    const first = await saveResearchNote(root, {
      title: "Video compression notes",
      content: "ffmpeg crf 28 is a good default for screen recordings.",
      tags: ["video", "ffmpeg"],
      sources: ["https://example.com/ffmpeg"],
    });
    assert.equal(first.path, ".cie/agent/notes/video-compression-notes.md");
    await saveResearchNote(root, {
      title: "Video compression notes",
      content: "Use a max width of 1280 for web delivery.",
      append: true,
    });
    const notes = await listResearchNotes(root);
    assert.equal(notes.length, 1);
    assert.deepEqual(notes[0].tags, ["video", "ffmpeg"]);
    const read = await readResearchNote(root, first.path);
    assert.match(read.content, /crf 28/);
    assert.match(read.content, /max width of 1280/);
    const results = await searchResearchNotes(root, "ffmpeg");
    assert.equal(results.length, 1);
    assert.match(results[0].snippet, /crf 28/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
