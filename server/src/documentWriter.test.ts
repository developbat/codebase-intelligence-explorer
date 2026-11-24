import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createArchive, createDocument } from "./documentWriter";
import { readDocument } from "./documentTools";

test("creates Excel, Word, CSV, PDF and ZIP outputs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cie-docs-"));
  try {
    const xlsx = await createDocument(root, "out/report.xlsx", {
      format: "xlsx",
      rows: [
        ["name", "value"],
        ["alpha", "1"],
      ],
    });
    assert.equal(xlsx.format, "xlsx");
    const workbook = await readDocument(root, "out/report.xlsx");
    assert.match(workbook.text, /alpha/);

    await createDocument(root, "out/data.csv", {
      format: "csv",
      rows: [
        ["name", "value"],
        ["beta", "2"],
      ],
    });
    assert.match(await fs.readFile(path.join(root, "out/data.csv"), "utf8"), /beta/);

    await createDocument(root, "out/notes.docx", {
      format: "docx",
      content: "Hello Word\nSecond line",
    });
    const word = await readDocument(root, "out/notes.docx");
    assert.match(word.text, /Hello Word/);

    await createDocument(root, "out/notes.pdf", {
      format: "pdf",
      content: "Hello PDF\nSecond page line",
      title: "Notes",
    });
    const pdf = await fs.readFile(path.join(root, "out/notes.pdf"));
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");

    await createArchive(root, "out/bundle.zip", ["out/data.csv", "out/notes.docx"]);
    const zip = await fs.readFile(path.join(root, "out/bundle.zip"));
    assert.equal(zip.subarray(0, 2).toString(), "PK");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
