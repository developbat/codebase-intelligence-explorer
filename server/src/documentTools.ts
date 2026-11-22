import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import XLSX from "xlsx";
import { isWithin } from "./scanner";

const execFileAsync = promisify(execFile);
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_TEXT_CHARS = 80_000;
const EXEC_TIMEOUT = 120_000;

export interface DocumentStats {
  lines: number;
  chars: number;
  words: number;
  checkedBoxes: number;
  uncheckedBoxes: number;
  headings: number;
  links: number;
}

export interface DocumentResult {
  path: string;
  kind: string;
  bytes: number;
  text: string;
  truncated: boolean;
  pages?: number;
  sheets?: string[];
  width?: number;
  height?: number;
  imageFormat?: string;
  ocr?: boolean;
  stats?: DocumentStats;
  metadata?: Record<string, string | number>;
}

async function resolveFile(rootPath: string, inputPath: string): Promise<{ absolute: string; relative: string }> {
  const relative = inputPath.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (!relative || relative.split("/").some((part) => part === "..")) {
    throw new Error("Document path is outside the project.");
  }
  const absolute = path.resolve(rootPath, relative);
  if (!isWithin(rootPath, absolute)) throw new Error("Document path is outside the project.");
  const realRoot = await fs.realpath(rootPath);
  const realFile = await fs.realpath(absolute).catch(() => {
    throw new Error("Document does not exist.");
  });
  if (!isWithin(realRoot, realFile)) throw new Error("Document path is outside the project.");
  const stat = await fs.stat(realFile);
  if (!stat.isFile()) throw new Error("Document path is not a file.");
  if (stat.size > MAX_FILE_BYTES) throw new Error("Document is larger than the 100 MB limit.");
  return { absolute: realFile, relative };
}

export function documentStats(text: string): DocumentStats {
  const lines = text.split("\n");
  let checkedBoxes = 0;
  let uncheckedBoxes = 0;
  let headings = 0;
  let links = 0;
  for (const line of lines) {
    if (/^\s*#{1,6}\s/.test(line)) headings += 1;
    const box = /^\s*(?:[-*+]|\d+\.)\s+\[([ xX])\]/.exec(line);
    if (box) {
      if (box[1].toLowerCase() === "x") checkedBoxes += 1;
      else uncheckedBoxes += 1;
    }
    links += (line.match(/\[[^\]]+\]\([^)]+\)/g) ?? []).length;
  }
  return {
    lines: lines.length,
    chars: text.length,
    words: (text.match(/\S+/g) ?? []).length,
    checkedBoxes,
    uncheckedBoxes,
    headings,
    links,
  };
}

function limitText(text: string, maxChars: number): { text: string; truncated: boolean } {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (clean.length <= maxChars) return { text: clean, truncated: false };
  return { text: `${clean.slice(0, maxChars)}\n… content truncated …`, truncated: true };
}

function stripHtml(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function ocrImage(absolute: string, lang = "eng"): Promise<string> {
  try {
    const result = await execFileAsync("tesseract", [absolute, "stdout", "-l", lang, "--psm", "6"], {
      timeout: EXEC_TIMEOUT,
      maxBuffer: 20 * 1024 * 1024,
    });
    return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  } catch {
    throw new Error("OCR failed. Is tesseract installed?");
  }
}

async function imageInfo(absolute: string): Promise<{ width?: number; height?: number; format?: string }> {
  try {
    const result = await execFileAsync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", "-g", "format", absolute], {
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const text = `${result.stdout ?? ""}`;
    return {
      width: Number(/pixelWidth:\s*(\d+)/.exec(text)?.[1]) || undefined,
      height: Number(/pixelHeight:\s*(\d+)/.exec(text)?.[1]) || undefined,
      format: /format:\s*([a-zA-Z0-9]+)/.exec(text)?.[1],
    };
  } catch {
    return {};
  }
}

async function extractPdf(
  absolute: string,
  options: { pageStart?: number; pageEnd?: number; ocr?: boolean; lang?: string; maxChars: number },
): Promise<DocumentResult> {
  const start = Math.max(1, Math.round(options.pageStart ?? 1));
  const end = Math.max(start, Math.round(options.pageEnd ?? start + 49));
  const args = ["-layout", "-f", String(start), "-l", String(end), absolute, "-"];
  const result = await execFileAsync("pdftotext", args, {
    timeout: EXEC_TIMEOUT,
    maxBuffer: 40 * 1024 * 1024,
  }).catch(() => {
    throw new Error("pdftotext is not available or the PDF is unreadable.");
  });
  let text = `${result.stdout ?? ""}`.replace(/\f/g, "\n\n--- page ---\n\n");
  let ocr = false;
  if (text.trim().length < 20 && options.ocr !== false) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cie-pdf-"));
    const prefix = path.join(tmp, "page");
    try {
      await execFileAsync("pdftoppm", ["-png", "-r", "150", "-f", String(start), "-l", String(Math.min(end, start + 4)), absolute, prefix], {
        timeout: EXEC_TIMEOUT,
        maxBuffer: 4 * 1024 * 1024,
      });
      const files = (await fs.readdir(tmp)).filter((name) => name.endsWith(".png")).sort();
      const pieces: string[] = [];
      for (const file of files.slice(0, 5)) {
        pieces.push(await ocrImage(path.join(tmp, file), options.lang ?? "eng"));
      }
      if (pieces.join("\n").trim()) {
        text = pieces.join("\n\n--- page ---\n\n");
        ocr = true;
      }
    } catch {
      // keep the embedded text or empty result
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  const stats = documentStats(text);
  const limited = limitText(text, options.maxChars);
  return {
    path: absolute,
    kind: "pdf",
    bytes: (await fs.stat(absolute)).size,
    text: limited.text,
    truncated: limited.truncated,
    pages: text.split(/\f|\[\[PAGE\]\]|--- page ---/).length > 1 ? undefined : start,
    ocr,
    stats,
  };
}

async function extractSpreadsheet(
  absolute: string,
  options: { sheet?: string; maxChars: number },
): Promise<DocumentResult> {
  const workbook = XLSX.readFile(absolute, { cellDates: true, sheetRows: 2000 });
  const names = workbook.SheetNames;
  const selected = options.sheet
    ? names.filter((name) => name.toLowerCase() === options.sheet!.toLowerCase())
    : names;
  if (selected.length === 0) throw new Error(`Sheet not found. Available: ${names.join(", ")}`);
  const blocks = selected.map((name) => {
    const sheet = workbook.Sheets[name];
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    return `## ${name}\n${csv}`;
  });
  const fullText = blocks.join("\n\n");
  const stats = documentStats(fullText);
  const limited = limitText(fullText, options.maxChars);
  return {
    path: absolute,
    kind: "spreadsheet",
    bytes: (await fs.stat(absolute)).size,
    text: limited.text,
    truncated: limited.truncated,
    sheets: names,
    stats,
  };
}

async function extractLegacyDocument(absolute: string): Promise<string> {
  if (process.platform === "darwin") {
    try {
      const result = await execFileAsync("textutil", ["-convert", "txt", "-stdout", absolute], {
        timeout: EXEC_TIMEOUT,
        maxBuffer: 40 * 1024 * 1024,
      });
      return `${result.stdout ?? ""}`.trim();
    } catch {
      // fall through to docx XML extraction
    }
  }
  if (absolute.toLowerCase().endsWith(".docx")) {
    const result = await execFileAsync("unzip", ["-p", absolute, "word/document.xml"], {
      timeout: EXEC_TIMEOUT,
      maxBuffer: 40 * 1024 * 1024,
    }).catch(() => {
      throw new Error("Could not read this Word document.");
    });
    const xml = `${result.stdout ?? ""}`;
    return xml
      .replace(/<w:p\b[^>]*>/gi, "\n")
      .replace(/<w:tab\b[^>]*\/>/gi, "\t")
      .replace(/<w:br\b[^>]*\/>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  throw new Error("Word/RTF extraction needs textutil (macOS) or a .docx file.");
}

export async function readDocument(
  rootPath: string,
  inputPath: string,
  options: {
    pageStart?: number;
    pageEnd?: number;
    sheet?: string;
    ocr?: boolean;
    lang?: string;
    maxChars?: number;
  } = {},
): Promise<DocumentResult> {
  const file = await resolveFile(rootPath, inputPath);
  const extension = path.extname(file.relative).toLowerCase();
  const maxChars = Math.max(1_000, Math.min(MAX_TEXT_CHARS, options.maxChars ?? 30_000));
  const stat = await fs.stat(file.absolute);
  if (extension === ".pdf") return extractPdf(file.absolute, { ...options, maxChars });
  if (extension === ".xlsx" || extension === ".xls") {
    return { ...(await extractSpreadsheet(file.absolute, { ...options, maxChars })), path: file.relative };
  }
  if (extension === ".doc" || extension === ".docx" || extension === ".rtf") {
    const fullText = await extractLegacyDocument(file.absolute);
    const stats = documentStats(fullText);
    const limited = limitText(fullText, maxChars);
    return {
      path: file.relative,
      kind: "word",
      bytes: stat.size,
      text: limited.text,
      truncated: limited.truncated,
      stats,
    };
  }
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic"].includes(extension)) {
    const info = await imageInfo(file.absolute);
    let text = "";
    let ocr = false;
    if (options.ocr !== false) {
      try {
        text = await ocrImage(file.absolute, options.lang ?? "eng");
        ocr = Boolean(text);
      } catch {
        text = "";
      }
    }
    const stats = documentStats(text);
    const limited = limitText(text, maxChars);
    return {
      path: file.relative,
      kind: "image",
      bytes: stat.size,
      text: limited.text || "(image has no OCR text)",
      truncated: limited.truncated,
      width: info.width,
      height: info.height,
      imageFormat: info.format,
      ocr,
      stats,
    };
  }
  const raw = await fs.readFile(file.absolute, "utf8").catch(() => {
    throw new Error("This file is not readable as text.");
  });
  const text = extension === ".html" || extension === ".htm" ? stripHtml(raw) : raw;
  let display = text;
  if (extension === ".json") {
    try {
      display = JSON.stringify(JSON.parse(raw) as unknown, null, 2);
    } catch {
      display = text;
    }
  }
  const stats = documentStats(display);
  const limited = limitText(display, maxChars);
  return {
    path: file.relative,
    kind: extension === ".json" ? "json" : extension === ".csv" ? "csv" : "text",
    bytes: stat.size,
    text: limited.text,
    truncated: limited.truncated,
    stats,
  };
}

export async function searchDocument(
  rootPath: string,
  inputPath: string,
  query: string,
  options: { maxResults?: number; maxChars?: number } = {},
): Promise<{ path: string; query: string; hits: { line: number; snippet: string }[] }> {
  const needle = query.trim();
  if (!needle) throw new Error("A search query is required.");
  const document = await readDocument(rootPath, inputPath, { maxChars: options.maxChars ?? 80_000 });
  const tokens = needle.toLowerCase().split(/\s+/).filter((token) => token.length > 1);
  const hits: { line: number; snippet: string }[] = [];
  const lines = document.text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const lower = lines[index].toLowerCase();
    if (!lower.includes(needle.toLowerCase()) && !tokens.every((token) => lower.includes(token))) {
      continue;
    }
    hits.push({
      line: index + 1,
      snippet: lines[index].trim().slice(0, 500),
    });
    if (hits.length >= Math.max(1, Math.min(100, options.maxResults ?? 20))) break;
  }
  return { path: document.path, query: needle, hits };
}

export async function convertDocument(
  rootPath: string,
  inputPath: string,
  outputPath: string,
  options: { sheet?: string; format?: "txt" | "md" | "csv" | "json" } = {},
): Promise<{ path: string; bytes: number; format: string; text?: string }> {
  const file = await resolveFile(rootPath, inputPath);
  const extension = path.extname(file.relative).toLowerCase();
  const requestedFormat =
    options.format ??
    (outputPath.toLowerCase().endsWith(".csv")
      ? "csv"
      : outputPath.toLowerCase().endsWith(".json")
        ? "json"
        : outputPath.toLowerCase().endsWith(".md")
          ? "md"
          : "txt");
  const outputRelative = outputPath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!outputRelative || outputRelative.split("/").some((part) => part === "..")) {
    throw new Error("Output path is outside the project.");
  }
  const outputAbsolute = path.resolve(rootPath, outputRelative);
  if (!isWithin(rootPath, outputAbsolute)) throw new Error("Output path is outside the project.");
  await fs.mkdir(path.dirname(outputAbsolute), { recursive: true });

  if (extension === ".xlsx" || extension === ".xls") {
    const workbook = XLSX.readFile(file.absolute, { cellDates: true });
    const selected = options.sheet
      ? workbook.SheetNames.filter((name) => name.toLowerCase() === options.sheet!.toLowerCase())
      : workbook.SheetNames;
    if (selected.length === 0) throw new Error("Sheet not found.");
    if (requestedFormat === "json") {
      const data = Object.fromEntries(
        selected.map((name) => [
          name,
          XLSX.utils.sheet_to_json(workbook.Sheets[name], { defval: null }),
        ]),
      );
      await fs.writeFile(outputAbsolute, JSON.stringify(data, null, 2), "utf8");
    } else {
      const csv = selected
        .map((name) => `# ${name}\n${XLSX.utils.sheet_to_csv(workbook.Sheets[name])}`)
        .join("\n\n");
      await fs.writeFile(outputAbsolute, csv, "utf8");
    }
    return {
      path: outputRelative,
      bytes: (await fs.stat(outputAbsolute)).size,
      format: requestedFormat,
    };
  }

  const document = await readDocument(rootPath, inputPath, {
    pageStart: 1,
    pageEnd: 200,
    maxChars: 80_000,
  });
  const body =
    requestedFormat === "json"
      ? JSON.stringify({ path: document.path, kind: document.kind, text: document.text }, null, 2)
      : document.text;
  await fs.writeFile(outputAbsolute, body, "utf8");
  return {
    path: outputRelative,
    bytes: (await fs.stat(outputAbsolute)).size,
    format: requestedFormat,
    text: body.slice(0, 500),
  };
}

export async function transformImage(
  rootPath: string,
  inputPath: string,
  options: {
    outputPath?: string;
    width?: number;
    height?: number;
    maxDimension?: number;
    format?: "png" | "jpeg" | "tiff" | "gif";
    quality?: number;
  } = {},
): Promise<{ path: string; bytes: number; width?: number; height?: number; format?: string }> {
  const file = await resolveFile(rootPath, inputPath);
  const extension = path.extname(file.relative).toLowerCase();
  if (![".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic"].includes(extension)) {
    throw new Error("transform_image supports image files only.");
  }
  const format = options.format ?? (extension === ".png" ? "png" : "jpeg");
  const outputRelative = (
    options.outputPath?.trim() ||
    `${file.relative.replace(/\.[^.]+$/, "")}-resized.${format === "jpeg" ? "jpg" : format}`
  )
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  if (!outputRelative || outputRelative.split("/").some((part) => part === "..")) {
    throw new Error("Output path is outside the project.");
  }
  const outputAbsolute = path.resolve(rootPath, outputRelative);
  if (!isWithin(rootPath, outputAbsolute)) throw new Error("Output path is outside the project.");
  await fs.mkdir(path.dirname(outputAbsolute), { recursive: true });
  const args: string[] = [];
  if (options.width && options.height) {
    args.push("-z", String(Math.max(1, Math.round(options.height))), String(Math.max(1, Math.round(options.width))));
  } else if (options.maxDimension) {
    args.push("-Z", String(Math.max(1, Math.round(options.maxDimension))));
  } else if (options.width) {
    args.push("--resampleWidth", String(Math.max(1, Math.round(options.width))));
  } else if (options.height) {
    args.push("--resampleHeight", String(Math.max(1, Math.round(options.height))));
  }
  args.push("-s", "format", format);
  if (options.quality && format === "jpeg") {
    args.push("-s", "formatOptions", String(Math.max(1, Math.min(100, Math.round(options.quality)))));
  }
  args.push(file.absolute, "--out", outputAbsolute);
  await execFileAsync("sips", args, { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 }).catch(() => {
    throw new Error("Image processing failed. Is sips available?");
  });
  const info = await imageInfo(outputAbsolute);
  return {
    path: outputRelative,
    bytes: (await fs.stat(outputAbsolute)).size,
    width: info.width,
    height: info.height,
    format: info.format ?? format,
  };
}
