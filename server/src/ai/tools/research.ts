import {
  httpRequest,
  listResearchNotes,
  readResearchNote,
  saveResearchNote,
  searchResearchNotes,
  webFetch,
} from "../../webResearch";
import type { AgentToolHandler, AgentToolResult } from "./types";

const webFetchHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const url = String(context.args.url ?? "").trim();
  if (!url) throw new Error("A URL is required.");
  const fetched = await webFetch(url, Number(context.args.maxChars) || undefined);
  context.log("success", "Web page fetched", `${fetched.status} · ${fetched.bytes} bytes`);
  return {
    observation: [
      `URL: ${fetched.finalUrl}`,
      `Status: ${fetched.status} · ${fetched.contentType} · ${fetched.bytes} bytes`,
      fetched.title ? `Title: ${fetched.title}` : "",
      fetched.truncated ? "(page text truncated)" : "",
      "",
      fetched.text || "(no readable text)",
    ]
      .filter(Boolean)
      .join("\n"),
    ok: true,
  };
};

const httpRequestHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const url = String(context.args.url ?? "").trim();
  const method = String(context.args.method ?? "GET").toUpperCase();
  if (!url) throw new Error("A request URL is required.");
  const bodyValue =
    typeof context.args.body === "string"
      ? context.args.body
      : context.args.body && typeof context.args.body === "object"
        ? JSON.stringify(context.args.body)
        : undefined;
  const allowed = await context.requirePermission(
    "command",
    "http_request",
    url,
    `Send an HTTP ${method} request.`,
    { preview: bodyValue ? bodyValue.slice(0, 800) : `${method} ${url}` },
  );
  if (!allowed) throw new Error("The user denied permission to send this HTTP request.");
  const response = await httpRequest({
    method,
    url,
    headers:
      context.args.headers &&
      typeof context.args.headers === "object" &&
      !Array.isArray(context.args.headers)
        ? Object.fromEntries(
            Object.entries(context.args.headers as Record<string, unknown>)
              .filter((entry): entry is [string, string] => typeof entry[1] === "string")
              .slice(0, 40),
          )
        : undefined,
    body: bodyValue,
    timeoutMs: Number(context.args.timeoutMs) || undefined,
    maxChars: Number(context.args.maxChars) || undefined,
    allowLocalhost: context.args.allowLocalhost === true,
  });
  context.log("success", "HTTP request completed", `${response.status} ${response.method}`);
  return {
    observation: [
      `${response.method} ${response.finalUrl}`,
      `Status: ${response.status} · ${response.contentType} · ${response.bytes} bytes`,
      Object.entries(response.headers).length > 0
        ? `Headers: ${Object.entries(response.headers)
            .map(([key, value]) => `${key}: ${value}`)
            .join(" | ")}`
        : "",
      "",
      response.body || "(empty body)",
      response.truncated ? "\n(response body truncated)" : "",
    ]
      .filter(Boolean)
      .join("\n"),
    ok: response.status >= 200 && response.status < 400,
  };
};

const saveNoteHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const title = String(context.args.title ?? "").trim();
  const content = String(context.args.content ?? "").trim();
  if (!title || !content) throw new Error("Note title and content are required.");
  const allowed = await context.requirePermission(
    "write",
    "save_note",
    title,
    "Save a research note under .cie/agent/notes.",
    { preview: content.slice(0, 500) },
  );
  if (!allowed) throw new Error("The user denied permission to save this note.");
  const saved = await saveResearchNote(context.analysis.rootPath, {
    title,
    content,
    tags: Array.isArray(context.args.tags) ? context.args.tags.map(String) : undefined,
    sources: Array.isArray(context.args.sources) ? context.args.sources.map(String) : undefined,
    name: typeof context.args.name === "string" ? context.args.name : undefined,
    append: context.args.append === true,
  });
  context.log("success", "Research note saved", saved.path);
  return { observation: `Saved note: ${saved.path} (${saved.bytes} bytes).`, ok: true };
};

const listNotesHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const notes = await listResearchNotes(context.analysis.rootPath);
  context.log("info", "Research notes listed", `${notes.length} notes`);
  return {
    observation:
      notes.length === 0
        ? "No research notes yet."
        : [
            `${notes.length} research notes:`,
            ...notes.map(
              (note) =>
                `- ${note.title} · ${note.path}${
                  note.tags.length ? ` · ${note.tags.join(", ")}` : ""
                }`,
            ),
          ].join("\n"),
    ok: true,
  };
};

const readNoteHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const notePath = String(context.args.path ?? "").trim();
  if (!notePath) throw new Error("A note path is required.");
  const note = await readResearchNote(context.analysis.rootPath, notePath);
  context.log("success", "Research note read", note.path);
  return {
    observation: [
      `Note: ${note.title}`,
      note.sources.length ? `Sources: ${note.sources.join(", ")}` : "",
      "",
      note.content,
    ]
      .filter(Boolean)
      .join("\n"),
    ok: true,
  };
};

const searchNotesHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const query = String(context.args.query ?? "").trim();
  if (!query) throw new Error("A note search query is required.");
  const results = await searchResearchNotes(
    context.analysis.rootPath,
    query,
    Number(context.args.limit) || 10,
  );
  context.log("info", "Research notes searched", `${results.length} matches`);
  return {
    observation:
      results.length === 0
        ? "No matching research notes."
        : [
            `${results.length} matching notes:`,
            ...results.map(
              (result) => `- ${result.title} · ${result.path}\n  ${result.snippet}`,
            ),
          ].join("\n"),
    ok: true,
  };
};

export const RESEARCH_TOOL_HANDLERS: Record<string, AgentToolHandler> = {
  web_fetch: webFetchHandler,
  http_request: httpRequestHandler,
  save_note: saveNoteHandler,
  list_notes: listNotesHandler,
  read_note: readNoteHandler,
  search_notes: searchNotesHandler,
};
