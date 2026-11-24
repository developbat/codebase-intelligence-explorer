import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import XLSX from "xlsx";
import { chromium } from "playwright-core";
import { browserExecutable } from "./browserCheck";
import { isWithin } from "./scanner";
import { readDocument } from "./documentTools";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;

export type DocumentFormat =
  | "xlsx"
  | "csv"
  | "tsv"
  | "docx"
  | "pdf"
  | "md"
  | "markdown"
  | "txt"
  | "json"
  | "html";

export interface SheetInput {
  name?: string;
  rows: string[][];
}

export interface CreateDocumentOptions {
  format?: DocumentFormat;
  content?: string;
  rows?: string[][];
  sheets?: SheetInput[];
  source?: string;
  title?: string;
}

export interface CreateDocumentResult {
  path: string;
  bytes: number;
  format: string;
}

export interface CreateArchiveResult {
  path: string;
  bytes: number;
  entries: string[];
}

function safeRelative(input: string): string {
  const relative = input.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (!relative || relative.split("/").some((part) => part === "..")) {
    throw new Error("Output path is outside the project.");
  }
  return relative;
}

async function outputPath(rootPath: string, input: string): Promise<{ relative: string; absolute: string }> {
  const relative = safeRelative(input);
  const absolute = path.resolve(rootPath, relative);
  if (!isWithin(rootPath, absolute)) throw new Error("Output path is outside the project.");
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  return { relative, absolute };
}

function inferFormat(outputPath: string, requested?: DocumentFormat): DocumentFormat {
  if (requested) return requested;
  const extension = path.extname(outputPath).slice(1).toLowerCase();
  if (extension === "markdown") return "md";
  if (extension === "htm") return "html";
  if (
    ["xlsx", "csv", "tsv", "docx", "pdf", "md", "txt", "json", "html"].includes(extension)
  ) {
    return extension as DocumentFormat;
  }
  return "txt";
}

async function fileContent(
  rootPath: string,
  options: CreateDocumentOptions,
): Promise<string> {
  if (typeof options.content === "string") return options.content;
  if (options.source) {
    const document = await readDocument(rootPath, options.source, {
      pageStart: 1,
      pageEnd: 500,
      maxChars: 200_000,
    });
    return document.text;
  }
  if (options.rows) {
    return options.rows.map((row) => row.join("\t")).join("\n");
  }
  if (options.sheets?.[0]) {
    return options.sheets[0].rows.map((row) => row.join("\t")).join("\n");
  }
  throw new Error("content, rows, sheets or source is required.");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function htmlDocument(title: string, content: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeXml(
    title,
  )}</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:2.5rem;color:#1f2933;line-height:1.55}h1,h2,h3{color:#111827}pre{white-space:pre-wrap}</style></head><body><pre>${escapeXml(
    content,
  )}</pre></body></html>`;
}

async function writeDocx(content: string, absolute: string): Promise<void> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "cie-docx-"));
  try {
    await fs.mkdir(path.join(temporary, "_rels"), { recursive: true });
    await fs.mkdir(path.join(temporary, "word"), { recursive: true });
    await fs.writeFile(
      path.join(temporary, "[Content_Types].xml"),
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
      "utf8",
    );
    await fs.writeFile(
      path.join(temporary, "_rels", ".rels"),
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
      "utf8",
    );
    const paragraphs = content.split(/\r?\n/).map(
      (line) =>
        `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`,
    );
    await fs.writeFile(
      path.join(temporary, "word", "document.xml"),
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${paragraphs.join("")}<w:sectPr/></w:body></w:document>`,
      "utf8",
    );
    await execFileAsync("zip", ["-q", "-r", absolute, ".", "-x", "*.DS_Store"], {
      cwd: temporary,
      maxBuffer: 10 * 1024 * 1024,
    });
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function writePdf(content: string, absolute: string, title: string): Promise<void> {
  const executablePath = await browserExecutable();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(htmlDocument(title, content), { waitUntil: "load" });
    await page.pdf({ path: absolute, format: "A4", printBackground: true });
  } finally {
    await browser.close();
  }
}

export async function createDocument(
  rootPath: string,
  output: string,
  options: CreateDocumentOptions = {},
): Promise<CreateDocumentResult> {
  const target = await outputPath(rootPath, output);
  const format = inferFormat(target.relative, options.format);
  const content = await fileContent(rootPath, options);
  const title = options.title || path.basename(target.relative, path.extname(target.relative));

  if (format === "xlsx") {
    const workbook = XLSX.utils.book_new();
    const sheets = options.sheets?.length
      ? options.sheets
      : [{ name: "Sheet1", rows: options.rows ?? content.split("\n").map((line) => [line]) }];
    for (const [index, sheet] of sheets.entries()) {
      const worksheet = XLSX.utils.aoa_to_sheet(sheet.rows);
      XLSX.utils.book_append_sheet(
        workbook,
        worksheet,
        (sheet.name || `Sheet${index + 1}`).slice(0, 31),
      );
    }
    XLSX.writeFile(workbook, target.absolute);
  } else if (format === "csv" || format === "tsv") {
    const delimiter = format === "csv" ? "," : "\t";
    const rows = options.rows ?? content.split("\n").map((line) => [line]);
    const escape = (value: string) =>
      format === "csv" ? `"${value.replace(/"/g, '""')}"` : value.replace(/\t/g, " ");
    await fs.writeFile(
      target.absolute,
      `${rows.map((row) => row.map(escape).join(delimiter)).join("\n")}\n`,
      "utf8",
    );
  } else if (format === "docx") {
    await writeDocx(content, target.absolute);
  } else if (format === "pdf") {
    await writePdf(content, target.absolute, title);
  } else if (format === "json") {
    let json = content;
    try {
      json = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      json = JSON.stringify({ title, content }, null, 2);
    }
    await fs.writeFile(target.absolute, json, "utf8");
  } else if (format === "html") {
    await fs.writeFile(target.absolute, htmlDocument(title, content), "utf8");
  } else {
    await fs.writeFile(target.absolute, content, "utf8");
  }

  const stat = await fs.stat(target.absolute);
  if (stat.size > MAX_OUTPUT_BYTES) {
    await fs.rm(target.absolute, { force: true });
    throw new Error("Created document is larger than the 100 MB limit.");
  }
  return { path: target.relative, bytes: stat.size, format };
}

export async function createArchive(
  rootPath: string,
  output: string,
  entries: string[],
): Promise<CreateArchiveResult> {
  const target = await outputPath(rootPath, output);
  const files = entries
    .map((entry) => safeRelative(entry))
    .filter((entry, index, all) => all.indexOf(entry) === index);
  if (files.length === 0) throw new Error("At least one file or folder is required.");
  for (const file of files) {
    const absolute = path.resolve(rootPath, file);
    if (!isWithin(rootPath, absolute)) throw new Error(`Archive entry is outside the project: ${file}`);
    // eslint-disable-next-line no-await-in-loop
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat) throw new Error(`Archive entry does not exist: ${file}`);
  }
  await fs.rm(target.absolute, { force: true });
  await execFileAsync("zip", ["-q", "-r", target.absolute, ...files, "-x", "*.DS_Store"], {
    cwd: rootPath,
    maxBuffer: 10 * 1024 * 1024,
  });
  const stat = await fs.stat(target.absolute);
  if (stat.size > MAX_OUTPUT_BYTES) {
    await fs.rm(target.absolute, { force: true });
    throw new Error("Created archive is larger than the 100 MB limit.");
  }
  return { path: target.relative, bytes: stat.size, entries: files };
}
