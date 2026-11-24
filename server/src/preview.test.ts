import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readPreviewFile } from "./preview";

test("serves PDF, Markdown and JSON previews with the right MIME type", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-preview-"));
  try {
    await fs.writeFile(path.join(root, "notes.pdf"), "%PDF-1.4\n");
    await fs.writeFile(path.join(root, "README.md"), "# Hello\n");
    await fs.writeFile(path.join(root, "data.json"), '{"ok":true}\n');
    const pdf = await readPreviewFile(root, "previewtest0000", "notes.pdf");
    assert.equal(pdf.mime, "application/pdf");
    assert.equal(pdf.data.toString(), "%PDF-1.4\n");
    const md = await readPreviewFile(root, "previewtest0000", "README.md");
    assert.match(md.mime, /text\/markdown/);
    const json = await readPreviewFile(root, "previewtest0000", "data.json");
    assert.match(json.mime, /application\/json/);
    assert.ok(json.data.toString().includes('"ok"'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
