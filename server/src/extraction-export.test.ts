import assert from "node:assert/strict";
import test from "node:test";
import {
  extractionToCsv,
  extractionToMarkdown,
  type ExtractionTable,
} from "../../shared/extraction";

const table: ExtractionTable = {
  kind: "button",
  headers: [
    { key: "file", label: "Dosya" },
    { key: "name", label: "Ad" },
    { key: "text", label: "Metin" },
  ],
  items: [
    {
      key: "a",
      file: "index.html",
      line: 10,
      values: { file: "index.html", name: "save", text: 'Save, "now"' },
    },
    {
      key: "b",
      file: "app.js",
      line: 20,
      values: { file: "app.js", name: "pipe", text: "a|b\nc" },
    },
  ],
  total: 2,
  unique: 2,
  truncated: false,
};

test("exports extraction tables as escaped CSV", () => {
  const csv = extractionToCsv(table, { file: "File", name: "Name", text: "Text" });
  assert.match(csv, /^"File","Name","Text"/);
  assert.ok(csv.includes('"index.html","save","Save, ""now"""'));
  assert.ok(csv.endsWith("\n"));
});

test("exports extraction tables as escaped Markdown", () => {
  const markdown = extractionToMarkdown(table, { file: "File", name: "Name", text: "Text" });
  assert.match(markdown, /^\| File \| Name \| Text \|/);
  assert.ok(markdown.includes("| index.html | save | Save, \"now\" |"));
  assert.ok(markdown.includes("| app.js | pipe | a\\|b c |"));
});
