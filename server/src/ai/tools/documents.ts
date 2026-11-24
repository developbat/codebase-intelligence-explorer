import { compressVideo } from "../../mediaTools";
import {
  convertDocument,
  documentStats,
  readDocument,
  searchDocument,
  transformImage,
} from "../../documentTools";
import type { AgentToolHandler, AgentToolResult } from "./types";

const readDocumentHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const documentPath = String(context.args.path ?? "").trim();
  if (!documentPath) throw new Error("A document path is required.");
  const document = await readDocument(context.analysis.rootPath, documentPath, {
    pageStart: Number(context.args.pageStart) || undefined,
    pageEnd: Number(context.args.pageEnd) || undefined,
    sheet: typeof context.args.sheet === "string" ? context.args.sheet : undefined,
    ocr: context.args.ocr !== false,
    lang: typeof context.args.lang === "string" ? context.args.lang : undefined,
    maxChars: Number(context.args.maxChars) || undefined,
    startChar: Number(context.args.startChar) || undefined,
  });
  const stats = document.stats ?? documentStats(document.text);
  context.log("success", "Document read", `${document.path} · ${document.kind}`);
  return {
    observation: [
      `Document: ${document.path} · ${document.kind} · ${document.bytes} bytes`,
      `Structure: ${stats.lines} lines · ${stats.words} words · ${stats.headings} headings · ${stats.links} links · ${stats.checkedBoxes} checked / ${stats.uncheckedBoxes} unchecked checkboxes`,
      document.pages ? `Pages: ${document.pages}` : "",
      document.sheets ? `Sheets: ${document.sheets.join(", ")}` : "",
      document.width && document.height
        ? `Image: ${document.width}×${document.height}${document.ocr ? " · OCR" : ""}`
        : "",
      document.truncated
        ? `(text truncated${document.nextChar ? `; continue with read_document startChar=${document.nextChar}` : ""})`
        : "",
      "",
      document.text || "(no readable text)",
    ]
      .filter(Boolean)
      .join("\n"),
    ok: true,
  };
};

const searchDocumentHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const documentPath = String(context.args.path ?? "").trim();
  const query = String(context.args.query ?? "").trim();
  if (!documentPath || !query) throw new Error("A document path and query are required.");
  const result = await searchDocument(context.analysis.rootPath, documentPath, query, {
    maxResults: Number(context.args.maxResults) || undefined,
    maxChars: Number(context.args.maxChars) || undefined,
  });
  context.log("info", "Document searched", `${result.hits.length} matches`);
  return {
    observation:
      result.hits.length === 0
        ? `No matches for "${query}" in ${result.path}.`
        : [
            `${result.hits.length} matches for "${query}" in ${result.path}:`,
            ...result.hits.map((hit) => `- line ${hit.line}: ${hit.snippet}`),
          ].join("\n"),
    ok: true,
  };
};

const convertDocumentHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const documentPath = String(context.args.path ?? "").trim();
  const outputPath = String(context.args.outputPath ?? "").trim();
  if (!documentPath || !outputPath) throw new Error("Document path and output path are required.");
  const format =
    context.args.format === "md" ||
    context.args.format === "json" ||
    context.args.format === "csv" ||
    context.args.format === "txt"
      ? context.args.format
      : undefined;
  const allowed = await context.requirePermission(
    "write",
    "convert_document",
    outputPath,
    "Extract a document and write the converted copy into the project.",
    { preview: `${documentPath} → ${outputPath}` },
  );
  if (!allowed) throw new Error("The user denied permission to convert this document.");
  const result = await convertDocument(context.analysis.rootPath, documentPath, outputPath, {
    sheet: typeof context.args.sheet === "string" ? context.args.sheet : undefined,
    format,
  });
  context.changedFiles.push(result.path);
  context.evidence.push({ path: result.path, label: "Converted document" });
  context.log("success", "Document converted", result.path);
  return {
    observation: `Converted to ${result.path} (${result.bytes} bytes, ${result.format}).`,
    ok: true,
  };
};

const transformImageHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const imagePath = String(context.args.path ?? "").trim();
  if (!imagePath) throw new Error("An image path is required.");
  const allowed = await context.requirePermission(
    "write",
    "transform_image",
    imagePath,
    "Resize or convert an image. This writes a new image file.",
    {
      preview: `${context.args.width ?? "?"}×${context.args.height ?? "?"} · ${
        context.args.format ?? "same format"
      }`,
    },
  );
  if (!allowed) throw new Error("The user denied permission to transform this image.");
  const result = await transformImage(context.analysis.rootPath, imagePath, {
    outputPath: typeof context.args.outputPath === "string" ? context.args.outputPath : undefined,
    width: Number(context.args.width) || undefined,
    height: Number(context.args.height) || undefined,
    maxDimension: Number(context.args.maxDimension) || undefined,
    format:
      context.args.format === "png" ||
      context.args.format === "jpeg" ||
      context.args.format === "tiff" ||
      context.args.format === "gif"
        ? context.args.format
        : undefined,
    quality: Number(context.args.quality) || undefined,
  });
  context.changedFiles.push(result.path);
  context.evidence.push({ path: result.path, label: "Transformed image" });
  context.log("success", "Image transformed", result.path);
  return {
    observation: `Image written: ${result.path}\n${result.width ?? "?"}×${
      result.height ?? "?"
    } · ${result.bytes} bytes · ${result.format ?? "image"}`,
    ok: true,
  };
};

const compressVideoHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const videoPath = String(context.args.path ?? "").trim();
  if (!videoPath) throw new Error("A video path is required.");
  const allowed = await context.requirePermission(
    "command",
    "compress_video",
    videoPath,
    "Compress a video with ffmpeg. This writes a new file.",
    {
      preview: `maxWidth=${Number(context.args.maxWidth) || 1280} crf=${
        Number(context.args.crf) || 28
      }`,
    },
  );
  if (!allowed) throw new Error("The user denied permission to compress this video.");
  const result = await compressVideo(context.analysis.rootPath, {
    path: videoPath,
    outputPath: typeof context.args.outputPath === "string" ? context.args.outputPath : undefined,
    maxWidth: Number(context.args.maxWidth) || undefined,
    crf: Number(context.args.crf) || undefined,
    preset:
      context.args.preset === "ultrafast" ||
      context.args.preset === "veryfast" ||
      context.args.preset === "fast" ||
      context.args.preset === "slow"
        ? context.args.preset
        : "medium",
  });
  context.evidence.push({ path: result.output.path, label: "Compressed video" });
  context.log("success", "Video compressed", `${result.savedPercent}% saved`);
  return {
    observation: [
      `Compressed ${result.input.path} → ${result.output.path}`,
      `${result.input.bytes} → ${result.output.bytes} bytes · saved ${result.savedBytes} (${result.savedPercent}%)`,
      `Dimensions: ${result.input.width ?? "?"}×${result.input.height ?? "?"} → ${
        result.output.width ?? "?"
      }×${result.output.height ?? "?"}`,
      result.input.durationSeconds ? `Duration: ${result.input.durationSeconds.toFixed(1)}s` : "",
      `Command: ${result.command}`,
    ]
      .filter(Boolean)
      .join("\n"),
    ok: true,
  };
};

export const DOCUMENT_TOOL_HANDLERS: Record<string, AgentToolHandler> = {
  read_document: readDocumentHandler,
  search_document: searchDocumentHandler,
  convert_document: convertDocumentHandler,
  transform_image: transformImageHandler,
  compress_video: compressVideoHandler,
};
