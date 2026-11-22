import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import XLSX from "xlsx";
import { convertDocument, readDocument, searchDocument, transformImage } from "./documentTools";

test("text, JSON and spreadsheet documents are readable and searchable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-docs-"));
  try {
    await fs.mkdir(path.join(root, "docs"), { recursive: true });
    await fs.writeFile(path.join(root, "docs", "notes.md"), "# Notes\n\nThe deadline is Friday.\nOwner: Ada\n");
    const text = await readDocument(root, "docs/notes.md");
    assert.equal(text.kind, "text");
    assert.match(text.text, /deadline is Friday/);
    const search = await searchDocument(root, "docs/notes.md", "deadline");
    assert.equal(search.hits.length, 1);
    assert.match(search.hits[0].snippet, /Friday/);

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["name", "score"],
        ["Ada", 9],
        ["Linus", 8],
      ]),
      "Scores",
    );
    XLSX.writeFile(workbook, path.join(root, "scores.xlsx"));
    const sheet = await readDocument(root, "scores.xlsx", { sheet: "Scores" });
    assert.equal(sheet.kind, "spreadsheet");
    assert.match(sheet.text, /Ada/);
    await convertDocument(root, "scores.xlsx", "scores.json", { format: "json" });
    const json = JSON.parse(await fs.readFile(path.join(root, "scores.json"), "utf8")) as Record<string, unknown>;
    assert.ok(Array.isArray((json as { Scores?: unknown[] }).Scores));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("images can be resized without an AI call", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-img-"));
  try {
    // 1x1 transparent PNG
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    await fs.mkdir(path.join(root, "assets"), { recursive: true });
    await fs.writeFile(path.join(root, "assets", "dot.png"), png);
    const result = await transformImage(root, "assets/dot.png", {
      outputPath: "assets/dot-small.png",
      width: 12,
      height: 12,
      format: "png",
    });
    assert.equal(result.path, "assets/dot-small.png");
    assert.ok(result.bytes > 0);
    assert.equal(result.width, 12);
    assert.equal(result.height, 12);
  } catch (error) {
    if (/sips/.test(error instanceof Error ? error.message : "")) {
      t.skip("sips is not available");
      return;
    }
    throw error;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
