import path from "node:path";
import { checkGraphic } from "../../graphicCheck";
import { createGraphic } from "../../graphics";
import { createArchive, createDocument, type DocumentFormat } from "../../documentWriter";
import { listProjectTools } from "../../projectTools";
import { checkToolchains } from "../../toolchains";
import type { AgentToolContext, AgentToolHandler, AgentToolResult } from "./types";

const checkToolchainsHandler: AgentToolHandler = async (): Promise<AgentToolResult> => {
  const report = await checkToolchains();
  const observation = report.tools
    .map(
      (tool) =>
        `${tool.installed ? "installed" : "MISSING"} · ${tool.name}${
          tool.version ? ` · ${tool.version}` : ""
        }${
          !tool.installed && tool.installCommands.length > 0
            ? ` · install: ${
                tool.installCommands.find((item) => item.platform === report.platform)?.command ??
                "manual"
              }`
            : ""
        }`,
    )
    .join("\n");
  return { observation, ok: true };
};

const listProjectToolsHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const projectTools = await listProjectTools(context.analysis.rootPath);
  const observation =
    projectTools.tools.length > 0
      ? `Saved project tools (${projectTools.tools.length}):\n${projectTools.tools
          .map(
            (tool) =>
              `- ${tool.name}: ${tool.command}${
                tool.description ? ` — ${tool.description}` : ""
              }`,
          )
          .join("\n")}`
      : "No saved project tools. Create a reusable script under .cie/agent/tools/ and it will be auto-registered.";
  context.log("info", "Project tools listed", `${projectTools.tools.length} tools`);
  return { observation, ok: true };
};

const createDocumentHandler: AgentToolHandler = async (
  context,
): Promise<AgentToolResult> => {
  const { args } = context;
  const outputPath = context.normalizePath(context.pathFromArgs(args));
  if (!outputPath) throw new Error("An output path is required.");
  const format = typeof args.format === "string" ? (args.format as DocumentFormat) : undefined;
  const content = typeof args.content === "string" ? args.content : undefined;
  const rows = Array.isArray(args.rows)
    ? (args.rows as unknown[])
        .filter((row): row is unknown[] => Array.isArray(row))
        .map((row) => row.map((cell) => String(cell ?? "")))
    : undefined;
  const sheets = Array.isArray(args.sheets)
    ? (args.sheets as unknown[])
        .filter((sheet): sheet is Record<string, unknown> =>
          Boolean(sheet && typeof sheet === "object"),
        )
        .map((sheet, index) => ({
          name: typeof sheet.name === "string" ? sheet.name : `Sheet${index + 1}`,
          rows: Array.isArray(sheet.rows)
            ? (sheet.rows as unknown[])
                .filter((row): row is unknown[] => Array.isArray(row))
                .map((row) => row.map((cell) => String(cell ?? "")))
            : [],
        }))
    : undefined;
  const source = typeof args.source === "string" ? args.source : undefined;
  const allowed = await context.requirePermission(
    "write",
    "create_document",
    outputPath,
    `Create ${format ?? (path.extname(outputPath).slice(1) || "document")} output.`,
    { preview: (content ?? "").slice(0, 1_000) },
  );
  if (!allowed) throw new Error("The user denied permission to create the document.");
  const created = await createDocument(context.analysis.rootPath, outputPath, {
    format,
    content,
    rows,
    sheets,
    source,
    title: typeof args.title === "string" ? args.title : undefined,
  });
  if (!context.changedFiles.includes(created.path)) context.changedFiles.push(created.path);
  context.evidence.push({ path: created.path, label: "Created document" });
  context.invalidate();
  context.log("success", "Document created", `${created.path} · ${created.bytes} bytes`);
  return {
    observation: `Created ${created.format} document ${created.path} (${created.bytes} bytes).`,
    ok: true,
  };
};

const createZipHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const { args } = context;
  const outputPath = context.normalizePath(context.pathFromArgs(args));
  if (!outputPath) throw new Error("An output path is required.");
  const rawEntries = Array.isArray(args.entries)
    ? args.entries
    : Array.isArray(args.files)
      ? args.files
      : Array.isArray(args.paths)
        ? args.paths
        : [];
  const entries = rawEntries.filter((entry): entry is string => typeof entry === "string");
  if (entries.length === 0) throw new Error("At least one file or folder entry is required.");
  const allowed = await context.requirePermission(
    "write",
    "create_zip",
    outputPath,
    `Create archive with ${entries.length} entry/entries.`,
    { preview: entries.join("\n").slice(0, 1_000) },
  );
  if (!allowed) throw new Error("The user denied permission to create the archive.");
  const created = await createArchive(context.analysis.rootPath, outputPath, entries);
  if (!context.changedFiles.includes(created.path)) context.changedFiles.push(created.path);
  context.evidence.push({ path: created.path, label: "Created archive" });
  context.invalidate();
  context.log("success", "Archive created", `${created.path} · ${created.bytes} bytes`);
  return {
    observation: `Created archive ${created.path} (${created.bytes} bytes) with ${created.entries.length} entries:\n${created.entries.join("\n")}`,
    ok: true,
  };
};

const graphicCheckHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const graphicPath = context.normalizePath(context.pathFromArgs(context.args));
  if (!graphicPath) throw new Error("A graphic path is required.");
  const result = await checkGraphic(
    context.analysis.rootPath,
    graphicPath,
    typeof context.args.expectText === "string" ? context.args.expectText : undefined,
  );
  context.log(
    result.ok ? "success" : "warn",
    "Graphic check",
    `${result.format} · ${result.width ?? "?"}×${result.height ?? "?"}`,
  );
  return { observation: result.summary, ok: result.ok };
};

const createGraphicHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const { args } = context;
  const graphicPath = context.normalizePath(context.pathFromArgs(args));
  if (!graphicPath) throw new Error("A graphic path is required.");
  if (context.isSecretPath(graphicPath)) {
    throw new Error("Writing environment, key or Git internals graphics is denied.");
  }
  const allowed = await context.requirePermission(
    "write",
    "create_graphic",
    graphicPath,
    "Create a deterministic SVG/PNG chart, flow or illustration.",
    { preview: String(args.kind ?? "bar") },
  );
  if (!allowed) throw new Error("The user denied permission to create this graphic.");
  const created = await createGraphic(context.analysis.rootPath, {
    path: graphicPath,
    kind: args.kind as Parameters<typeof createGraphic>[1]["kind"],
    title: typeof args.title === "string" ? args.title : undefined,
    subtitle: typeof args.subtitle === "string" ? args.subtitle : undefined,
    data: Array.isArray(args.data)
      ? (args.data as Parameters<typeof createGraphic>[1]["data"])
      : undefined,
    steps: Array.isArray(args.steps) ? args.steps.map(String) : undefined,
    width: Number(args.width) || undefined,
    height: Number(args.height) || undefined,
    colors: Array.isArray(args.colors) ? args.colors.map(String) : undefined,
    format: args.format === "png" ? "png" : undefined,
  });
  if (!context.changedFiles.includes(created.path)) context.changedFiles.push(created.path);
  context.evidence.push({ path: created.path, label: "Generated graphic" });
  context.log("success", "Graphic created", created.path);
  return {
    observation: `Created ${created.kind} graphic: ${created.path} (${created.bytes} bytes, ${created.mime}).`,
    ok: true,
  };
};

export const BUILTIN_TOOL_HANDLERS: Record<string, AgentToolHandler> = {
  check_toolchains: checkToolchainsHandler,
  list_project_tools: listProjectToolsHandler,
  create_document: createDocumentHandler,
  create_zip: createZipHandler,
  graphic_check: graphicCheckHandler,
  create_graphic: createGraphicHandler,
};
