import fs from "node:fs/promises";
import path from "node:path";
import { analyzeProject } from "../../analyzer";
import { saveAnalysis } from "../../store";
import {
  deleteProjectPath,
  readSourceFile,
  renameProjectPath,
  restoreLatestEditorBackup,
  runProjectCommand,
  writeSourceFile,
} from "../../editor";
import { formatProjectFile } from "../../formatter";
import { pythonEnvironmentHint } from "../pythonHints";
import { withCommandLock } from "../commandLock";
import { searchCode } from "../../search";
import {
  applyMappingsToContent,
  extractEntities,
} from "../../extractors";
import { auditContentInventory } from "../../contentInventory";
import { queryCsvFile, querySqliteFile } from "../../dataQuery";
import { getGitBlame } from "../../git";
import { runBrowserCheck } from "../../browserCheck";
import { runGameCheck } from "../../gameCheck";
import { searchConversations } from "../../indexer";
import { lspCompletion, lspDiagnostics, lspHover } from "../../lsp";
import { agentSearch, listDiskFiles, queryProjectSymbols } from "../service";
import type { AgentToolHandler, AgentToolResult } from "./types";

function lines(content: string, startLine = 1, endLine = 200): string {
  const all = content.split("\n");
  const start = Math.max(1, startLine);
  const end = Math.min(all.length, Math.max(start, endLine));
  return all
    .slice(start - 1, end)
    .map((line, index) => `${String(start + index).padStart(5, " ")} │ ${line}`)
    .join("\n");
}

function targetPath(context: Parameters<AgentToolHandler>[0]): string {
  const value = context.pathFromArgs(context.args);
  return context.normalizePath(value);
}

const listFilesHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const prefix = targetPath(context).replace(/\/$/, "");
  const limit = Math.max(1, Math.min(200, Number(context.args.limit) || 80));
  const files = await listDiskFiles(context.analysis.rootPath, prefix, limit);
  const analysisByPath = new Map(context.analysis.files.map((file) => [file.path, file]));
  return {
    observation: files.length
      ? files
          .map((file) => {
            const known = analysisByPath.get(file.path);
            return `${file.path} (${file.bytes} B)${known?.loc ? ` · ${known.loc} lines` : ""}`;
          })
          .join("\n")
      : `No files found under ${prefix || "the project root"}.`,
    ok: true,
  };
};

const searchCodeHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const query = String(context.args.query ?? "").trim();
  if (!query) throw new Error("A search query is required.");
  const limit = Math.max(1, Math.min(30, Number(context.args.limit) || 15));
  const found = await searchCode(context.analysis, query, limit);
  return {
    observation: found.results.length
      ? found.results
          .map(
            (hit) =>
              `${hit.label} · ${hit.filePath ?? ""}${hit.startLine ? `:${hit.startLine}` : ""}${
                hit.snippet ? ` — ${hit.snippet}` : ""
              }`,
          )
          .join("\n")
      : `No matches for "${query}".`,
    ok: true,
  };
};

const readFileHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const filePath = targetPath(context);
  if (!filePath) throw new Error("A file path is required.");
  const file = await readSourceFile(context.analysis.rootPath, filePath);
  const start = Number(context.args.startLine) || 1;
  const end = Number(context.args.endLine) || Math.min(200, start + 199);
  const body = lines(file.content, start, end);
  return {
    observation: `File: ${file.filePath} (${file.content.split("\n").length} lines, showing ${start}-${end})\n${body}`,
    ok: true,
  };
};

const readSymbolHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const name = String(context.args.name ?? "").trim();
  const filePath = targetPath(context);
  const line = Number(context.args.line) || undefined;
  const symbol = name
    ? context.analysis.symbols.find(
        (item) =>
          item.name.toLowerCase() === name.toLowerCase() ||
          item.qualifiedName.toLowerCase() === name.toLowerCase(),
      )
    : filePath
      ? context.analysis.symbols.find(
          (item) =>
            item.filePath === filePath &&
            (line === undefined ||
              (item.startLine <= line && (item.endLine ?? item.startLine) >= line)),
        )
      : undefined;
  if (!symbol) throw new Error("Symbol was not found.");
  const file = await readSourceFile(context.analysis.rootPath, symbol.filePath);
  return {
    observation: `Symbol: ${symbol.kind} ${symbol.qualifiedName} — ${symbol.filePath}:${symbol.startLine}-${symbol.endLine ?? symbol.startLine}\n${lines(
      file.content,
      symbol.startLine,
      symbol.endLine ?? symbol.startLine,
    )}`,
    ok: true,
  };
};

const findInFileHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const filePath = targetPath(context);
  const query = String(context.args.query ?? "").trim();
  if (!filePath || !query) throw new Error("A file path and query are required.");
  const file = await readSourceFile(context.analysis.rootPath, filePath);
  const limit = Math.max(1, Math.min(50, Number(context.args.limit) || 10));
  const contextLines = Math.max(0, Math.min(5, Number(context.args.contextLines) || 0));
  const all = file.content.split("\n");
  const hits: string[] = [];
  for (let index = 0; index < all.length && hits.length < limit; index += 1) {
    if (!all[index].toLowerCase().includes(query.toLowerCase())) continue;
    const from = Math.max(0, index - contextLines);
    const to = Math.min(all.length - 1, index + contextLines);
    hits.push(
      all
        .slice(from, to + 1)
        .map((line, offset) => `${from + offset + 1} │ ${line}`)
        .join("\n"),
    );
  }
  return {
    observation: hits.length ? hits.join("\n---\n") : `No matches for "${query}" in ${filePath}.`,
    ok: true,
  };
};

const diagnosticsHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const filePath = targetPath(context);
  if (!filePath) throw new Error("A file path is required.");
  const result = await lspDiagnostics(context.analysis.rootPath, filePath);
  return {
    observation: result.supported
      ? result.diagnostics.length
        ? result.diagnostics
            .map(
              (item) =>
                `${item.severity ?? "info"} · line ${item.line ?? "?"} · ${item.message}`,
            )
            .join("\n")
        : `No diagnostics for ${filePath}.`
      : result.reason ?? "LSP is not available for this file.",
    ok: true,
  };
};

const lspHoverHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const filePath = targetPath(context);
  const line = Number(context.args.line) || 1;
  const character = Number(context.args.character) || 1;
  if (!filePath) throw new Error("A file path is required.");
  const hover = await lspHover(context.analysis.rootPath, filePath, line, character);
  return {
    observation: hover?.contents ?? "No hover information.",
    ok: true,
  };
};

const lspCompletionHandler: AgentToolHandler = async (
  context,
): Promise<AgentToolResult> => {
  const filePath = targetPath(context);
  const line = Number(context.args.line) || 1;
  const character = Number(context.args.character) || 1;
  if (!filePath) throw new Error("A file path is required.");
  const items = await lspCompletion(context.analysis.rootPath, filePath, line, character);
  return {
    observation: items.length
      ? items.map((item) => `${item.label}${item.detail ? ` · ${item.detail}` : ""}`).join("\n")
      : "No completions.",
    ok: true,
  };
};

const listItemsHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const filePath = targetPath(context);
  if (!filePath) throw new Error("A file path is required.");
  const file = await readSourceFile(context.analysis.rootPath, filePath);
  const limit = Math.max(1, Math.min(200, Number(context.args.limit) || 100));
  const items = [...file.content.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
    .slice(0, limit)
    .map((match) => match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  return {
    observation: items.length
      ? items.map((item, index) => `${index + 1}. ${item}`).join("\n")
      : "No <li> items found.",
    ok: true,
  };
};

const countMatchesHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const query = String(context.args.query ?? "");
  if (!query) throw new Error("A query is required.");
  const target = targetPath(context);
  const files = target
    ? [target]
    : (await listDiskFiles(context.analysis.rootPath, "", 300)).map((file) => file.path);
  let count = 0;
  let scanned = 0;
  for (const filePath of files) {
    if (/^(?:\.cie|node_modules|dist|build|\.git)\//.test(filePath)) continue;
    try {
      const file = await readSourceFile(context.analysis.rootPath, filePath);
      count += file.content.split(query).length - 1;
      scanned += 1;
    } catch {
      // binary/unreadable files are skipped
    }
  }
  return { observation: `${count} matches for "${query}" across ${scanned} file(s).`, ok: true };
};

const listColorsHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const scope = targetPath(context) || undefined;
  const result = await extractEntities(context.analysis, {
    kind: "color",
    scope,
    limit: 500,
  });
  return {
    observation:
      result.items.length > 0
        ? result.items
            .slice(0, 100)
            .map(
              (item) =>
                `${Object.entries(item.values)
                  .slice(0, 2)
                  .map(([key, value]) => `${key}=${value}`)
                  .join(" · ")} · ${item.file}:${item.line}`,
            )
            .join("\n")
        : "No colors found.",
    ok: true,
  };
};

const extractEntitiesHandler: AgentToolHandler = async (
  context,
): Promise<AgentToolResult> => {
  const kind = String(context.args.kind ?? "").trim();
  if (!kind) throw new Error("An entity kind is required.");
  const result = await extractEntities(context.analysis, {
    kind: kind as Parameters<typeof extractEntities>[1]["kind"],
    scope: Array.isArray(context.args.scope)
      ? context.args.scope.map(String)
      : typeof context.args.scope === "string"
        ? context.args.scope
        : undefined,
    query: typeof context.args.query === "string" ? context.args.query : undefined,
    limit: Number(context.args.limit) || 500,
  });
  return {
    observation: [
      `${result.kind}: ${result.total} item(s)${result.truncated ? " (truncated)" : ""}`,
      ...result.items
        .slice(0, 60)
        .map(
          (item) =>
            `- ${Object.entries(item.values)
              .slice(0, 3)
              .map(([key, value]) => `${key}=${value}`)
              .join(" · ")} · ${item.file}:${item.line}`,
        ),
    ].join("\n"),
    ok: true,
  };
};

const auditContentHandler: AgentToolHandler = async (
  context,
): Promise<AgentToolResult> => {
  const inventory = await auditContentInventory(context.analysis);
  return {
    observation: JSON.stringify(
      {
        assets: inventory.summary.assets,
        broken: inventory.summary.broken,
        unreferenced: inventory.summary.unreferenced,
        markdownFiles: inventory.summary.markdownFiles,
        headingWarnings: inventory.summary.headingWarnings,
        notes: inventory.notes,
      },
      null,
      2,
    ),
    ok: true,
  };
};

const applyMappedChangesHandler: AgentToolHandler = async (
  context,
): Promise<AgentToolResult> => {
  const mappingRaw =
    context.args.mapping && typeof context.args.mapping === "object"
      ? (context.args.mapping as Record<string, unknown>)
      : {};
  const mapping = Object.entries(mappingRaw)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([from, to]) => [from, to] as const);
  if (mapping.length === 0) throw new Error("A non-empty mapping is required.");
  const kind = context.args.kind === "text" ? "text" : "color";
  const scope = Array.isArray(context.args.scope)
    ? context.args.scope.map(String)
    : typeof context.args.scope === "string"
      ? [context.args.scope]
      : [];
  if (scope.length === 0) {
    throw new Error("Try mode requires an explicit scope for apply_mapped_changes.");
  }
  const dryRun = context.args.dryRun === true;
  let total = 0;
  const reports: string[] = [];
  for (const filePath of scope) {
    const allowed = await context.requirePermission(
      "write",
      "apply_mapped_changes",
      filePath,
      dryRun ? "Preview a mapped change." : "Apply a mapped change.",
      { preview: JSON.stringify(mappingRaw).slice(0, 800) },
    );
    if (!allowed) throw new Error(`Permission denied for ${filePath}.`);
    const file = await readSourceFile(context.analysis.rootPath, filePath);
    const result = applyMappingsToContent(file.content, kind, mapping);
    if (result.count === 0) continue;
    if (!dryRun) {
      await writeSourceFile(
        context.projectId,
        context.analysis.rootPath,
        filePath,
        result.content,
      );
      context.changedFiles.push(filePath);
    }
    total += result.count;
    reports.push(`${filePath}: ${result.count} replacement(s)`);
  }
  context.invalidate([...scope]);
  return {
    observation: `${dryRun ? "Preview" : "Applied"} ${total} mapped replacement(s):\n${reports.join("\n") || "none"}`,
    ok: true,
  };
};

const undoChangeHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const filePath = targetPath(context);
  if (!filePath) throw new Error("A file path is required.");
  const allowed = await context.requirePermission(
    "write",
    "undo_change",
    filePath,
    "Restore the latest editor backup for this file.",
    { destructive: true },
  );
  if (!allowed) throw new Error("The user denied permission to restore this file.");
  const restored = await restoreLatestEditorBackup(
    context.projectId,
    context.analysis.rootPath,
    filePath,
  );
  context.changedFiles.push(filePath);
  context.invalidate([filePath]);
  return {
    observation: `Restored ${restored.filePath} from ${restored.backupPath}.`,
    ok: true,
  };
};

const jsonQueryHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const filePath = targetPath(context);
  if (!filePath) throw new Error("A file path is required.");
  const file = await readSourceFile(context.analysis.rootPath, filePath);
  let data: unknown;
  try {
    data = JSON.parse(file.content.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`${filePath} is not valid JSON.`);
  }
  const pointer = String(context.args.pointer ?? "").trim();
  let current: unknown = data;
  for (const part of pointer.split(".").filter(Boolean)) {
    if (current && typeof current === "object" && part in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[part];
    } else if (Array.isArray(current) && /^\d+$/.test(part)) {
      current = current[Number(part)];
    } else {
      throw new Error(`JSON pointer "${pointer}" was not found.`);
    }
  }
  return {
    observation:
      Array.isArray(current)
        ? `array (length ${current.length})\nsample: ${JSON.stringify(current.slice(0, 3)).slice(0, 2_000)}`
        : JSON.stringify(current, null, 2).slice(0, 6_000),
    ok: true,
  };
};

const findSymbolsHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const query = String(context.args.query ?? "").trim();
  const kind = typeof context.args.kind === "string" ? context.args.kind : undefined;
  const limit = Math.max(1, Math.min(50, Number(context.args.limit) || 20));
  const symbols = queryProjectSymbols(context.analysis, query, kind, limit);
  return {
    observation: symbols.length
      ? symbols
          .map(
            (symbol) =>
              `${symbol.kind} ${symbol.qualifiedName} — ${symbol.filePath}:${symbol.startLine}`,
          )
          .join("\n")
      : "No symbols found.",
    ok: true,
  };
};

const sqliteQueryHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const filePath = targetPath(context);
  const query = String(context.args.query ?? "").trim();
  if (!filePath || !query) throw new Error("A SQLite path and query are required.");
  return { observation: await querySqliteFile(context.analysis.rootPath, filePath, query), ok: true };
};

const csvQueryHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const filePath = targetPath(context);
  if (!filePath) throw new Error("A CSV path is required.");
  const result = await queryCsvFile(context.analysis.rootPath, filePath, {
    columns: context.args.columns,
    where: context.args.where,
    limit: context.args.limit,
    count: context.args.count,
    columnsOnly: context.args.columnsOnly,
  });
  return { observation: result, ok: true };
};

const gitBlameHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const filePath = targetPath(context);
  if (!filePath) throw new Error("A file path is required.");
  return {
    observation: await getGitBlame(
      context.analysis.rootPath,
      filePath,
      Number(context.args.startLine) || 1,
      Number(context.args.endLine) || 40,
    ),
    ok: true,
  };
};

const browserCheckHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const result = await runBrowserCheck(context.projectId, context.analysis.rootPath, {
    path: typeof context.args.path === "string" ? context.args.path : "index.html",
    url: typeof context.args.url === "string" ? context.args.url : undefined,
    steps: Array.isArray(context.args.steps)
      ? (context.args.steps as NonNullable<Parameters<typeof runBrowserCheck>[2]>["steps"])
      : [],
    mobile: context.args.mobile === true,
    screenshot: context.args.screenshot === true,
    live: context.liveBrowser,
    signal: context.signal,
  });
  return { observation: result.summary, ok: result.ok };
};

const runTestScenarioHandler: AgentToolHandler = async (
  context,
): Promise<AgentToolResult> => {
  const rawName = String(context.args.name ?? context.args.path ?? "").trim();
  if (!rawName) throw new Error("A test scenario name is required.");
  const relative = rawName.endsWith(".json")
    ? rawName
    : `.cie/agent/scenarios/${rawName.replace(/^.*[\\/]/, "")}.json`;
  const scenarioFile = await readSourceFile(context.analysis.rootPath, relative);
  const scenario = JSON.parse(scenarioFile.content) as {
    path?: string;
    mobile?: boolean;
    timeoutMs?: number;
    steps?: NonNullable<Parameters<typeof runBrowserCheck>[2]>["steps"];
  };
  const result = await runBrowserCheck(context.projectId, context.analysis.rootPath, {
    path: scenario.path,
    mobile: scenario.mobile,
    timeoutMs: scenario.timeoutMs,
    steps: scenario.steps ?? [],
    live: context.liveBrowser,
    signal: context.signal,
  });
  return {
    observation: `${relative}: ${result.ok ? "PASSED" : "FAILED"}\n${result.summary}`,
    ok: result.ok,
  };
};

const gameCheckHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const result = await runGameCheck(context.projectId, context.analysis.rootPath, {
    path: typeof context.args.path === "string" ? context.args.path : "index.html",
    url: typeof context.args.url === "string" ? context.args.url : undefined,
    steps: Array.isArray(context.args.steps)
      ? (context.args.steps as NonNullable<Parameters<typeof runGameCheck>[2]>["steps"])
      : undefined,
    screenshot: context.args.screenshot !== false,
    live: context.liveBrowser,
    signal: context.signal,
  });
  return { observation: result.summary, ok: result.check.ok };
};

const projectSearchHandler: AgentToolHandler = async (
  context,
): Promise<AgentToolResult> => {
  const query = String(context.args.query ?? "").trim();
  if (!query) throw new Error("A search query is required.");
  const limit = Math.max(1, Math.min(30, Number(context.args.limit) || 15));
  const found = await agentSearch(context.analysis, query, limit);
  const symbols = queryProjectSymbols(context.analysis, query, undefined, Math.min(12, limit));
  return {
    observation: [
      `Project search: ${query}`,
      ...found.results.map((result) => `- ${result.path}:${result.line} — ${result.text}`),
      ...symbols.map(
        (symbol) =>
          `- ${symbol.kind} ${symbol.qualifiedName} — ${symbol.filePath}:${symbol.startLine}`,
      ),
    ].join("\n"),
    ok: true,
  };
};

const searchConversationsHandler: AgentToolHandler = async (
  context,
): Promise<AgentToolResult> => {
  const query = String(context.args.query ?? "").trim();
  if (!query) throw new Error("A conversation query is required.");
  const hits = await searchConversations(
    context.projectId,
    query,
    Number(context.args.limit) || 5,
  );
  return {
    observation: hits.length
      ? hits
          .map((hit) => `- ${hit.title}${hit.snippet ? ` — ${hit.snippet}` : ""}`)
          .join("\n")
      : `No earlier conversation matched "${query}".`,
    ok: true,
  };
};

const rescanProjectHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const fresh = await analyzeProject(context.analysis.rootPath);
  await saveAnalysis(fresh);
  return {
    observation: `Rescanned project: ${fresh.files.length} files, ${fresh.symbols.length} symbols.`,
    ok: true,
  };
};

const writeFileHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const filePath = targetPath(context);
  const content = String(context.args.content ?? context.args.text ?? context.args.code ?? "");
  if (!filePath) throw new Error("A file path is required.");
  const allowed = await context.requirePermission(
    "write",
    "write_file",
    filePath,
    "Write a complete file.",
    { preview: content.slice(0, 800) },
  );
  if (!allowed) throw new Error("The user denied permission to write the file.");
  const written = await writeSourceFile(
    context.projectId,
    context.analysis.rootPath,
    filePath,
    content,
  );
  context.changedFiles.push(filePath);
  context.invalidate([filePath]);
  return { observation: `Wrote ${written.bytes} bytes to ${written.filePath}.`, ok: true };
};

const replaceInFileHandler: AgentToolHandler = async (
  context,
): Promise<AgentToolResult> => {
  const filePath = targetPath(context);
  const find = String(context.args.find ?? "");
  const replace = String(context.args.replace ?? "");
  if (!filePath || !find) throw new Error("A file path and find text are required.");
  const file = await readSourceFile(context.analysis.rootPath, filePath);
  if (!file.content.includes(find)) throw new Error(`The exact find text was not found in ${filePath}.`);
  const allowed = await context.requirePermission(
    "write",
    "replace_in_file",
    filePath,
    "Replace one exact snippet.",
    { preview: find.slice(0, 800) },
  );
  if (!allowed) throw new Error("The user denied permission to edit the file.");
  const next = file.content.replace(find, replace);
  const written = await writeSourceFile(
    context.projectId,
    context.analysis.rootPath,
    filePath,
    next,
  );
  context.changedFiles.push(filePath);
  context.invalidate([filePath]);
  return { observation: `Replaced 1 snippet in ${filePath} (${written.bytes} bytes).`, ok: true };
};

const replaceManyHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const filePath = targetPath(context);
  if (!filePath) throw new Error("A file path is required.");
  const edits = Array.isArray(context.args.edits) ? context.args.edits : [];
  if (edits.length === 0) throw new Error("At least one edit is required.");
  const file = await readSourceFile(context.analysis.rootPath, filePath);
  let next = file.content;
  let count = 0;
  for (const edit of edits) {
    if (!edit || typeof edit !== "object") continue;
    const record = edit as Record<string, unknown>;
    const find = String(record.find ?? "");
    const replace = String(record.replace ?? "");
    if (!find || !next.includes(find)) continue;
    next = next.replace(find, replace);
    count += 1;
  }
  if (count === 0) throw new Error("No exact snippets were found.");
  const allowed = await context.requirePermission(
    "write",
    "replace_many",
    filePath,
    `Apply ${count} exact replacement(s).`,
    { preview: String(JSON.stringify(edits)).slice(0, 800) },
  );
  if (!allowed) throw new Error("The user denied permission to edit the file.");
  const written = await writeSourceFile(
    context.projectId,
    context.analysis.rootPath,
    filePath,
    next,
  );
  context.changedFiles.push(filePath);
  context.invalidate([filePath]);
  return { observation: `Applied ${count} replacement(s) to ${filePath} (${written.bytes} bytes).`, ok: true };
};

const appendTextHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const filePath = targetPath(context);
  const content = String(context.args.content ?? "");
  if (!filePath || !content) throw new Error("A file path and content are required.");
  const allowed = await context.requirePermission(
    "write",
    "append_text",
    filePath,
    "Append a block to a file.",
    { preview: content.slice(0, 800) },
  );
  if (!allowed) throw new Error("The user denied permission to append to the file.");
  const file = await readSourceFile(context.analysis.rootPath, filePath).catch(() => null);
  const next = `${file?.content ?? ""}${file?.content && !file.content.endsWith("\n") ? "\n" : ""}${content}`;
  const written = await writeSourceFile(
    context.projectId,
    context.analysis.rootPath,
    filePath,
    next,
  );
  context.changedFiles.push(filePath);
  context.invalidate([filePath]);
  return { observation: `Appended ${content.length} characters to ${filePath} (${written.bytes} bytes).`, ok: true };
};

const renamePathHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const from = targetPath(context);
  const to = context.normalizePath(context.args.newPath ?? context.args.to);
  if (!from || !to) throw new Error("Source and target paths are required.");
  const allowed = await context.requirePermission(
    "write",
    "rename_path",
    from,
    `Rename ${from} to ${to}.`,
    { destructive: true },
  );
  if (!allowed) throw new Error("The user denied permission to rename the path.");
  const result = await renameProjectPath(context.analysis.rootPath, from, to);
  context.changedFiles.push(from, to);
  context.invalidate([from, to]);
  return { observation: `Renamed ${result.from} to ${result.to}.`, ok: true };
};

const deleteFileHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const filePath = targetPath(context);
  if (!filePath) throw new Error("A file path is required.");
  const allowed = await context.requirePermission(
    "write",
    "delete_file",
    filePath,
    "Delete this path.",
    { destructive: true },
  );
  if (!allowed) throw new Error("The user denied permission to delete the path.");
  const result = await deleteProjectPath(context.analysis.rootPath, filePath);
  context.changedFiles.push(filePath);
  context.invalidate([filePath]);
  return { observation: `Deleted ${result.path}.`, ok: true };
};

const formatFileHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const filePath = targetPath(context);
  if (!filePath) throw new Error("A file path is required.");
  const allowed = await context.requirePermission(
    "write",
    "format_file",
    filePath,
    "Format this file.",
  );
  if (!allowed) throw new Error("The user denied permission to format the file.");
  const result = await formatProjectFile(
    context.projectId,
    context.analysis,
    filePath,
  );
  context.changedFiles.push(filePath);
  context.invalidate([filePath]);
  return {
    observation: result.formatted
      ? `Formatted ${result.filePath}${result.command ? ` with ${result.command}` : ""}.`
      : `${result.filePath} is already formatted or no formatter is available.`,
    ok: result.exitCode === 0 || result.exitCode === null,
  };
};

const runCommandHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const command = String(context.args.command ?? "").trim();
  if (!command) throw new Error("A command is required.");
  const allowed = await context.requirePermission(
    "command",
    "run_command",
    command,
    "Run a project command.",
    { preview: command },
  );
  if (!allowed) throw new Error("The user denied permission to run the command.");
  const result = await withCommandLock(context.projectId, () =>
    runProjectCommand(
      context.analysis.rootPath,
      command,
      typeof context.args.cwd === "string" ? context.args.cwd : undefined,
      { timeoutMs: 120_000, signal: context.signal },
    ),
  );
  context.ranCommands.push(command);
  const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
  return {
    observation: `Command: ${command}\nExit: ${result.exitCode ?? "—"}\n${output || "(no output)"}${pythonEnvironmentHint(command, result.exitCode, output)}`,
    ok: result.exitCode === 0,
  };
};

const delegateResearchHandler: AgentToolHandler = async (
  context,
): Promise<AgentToolResult> => {
  const goal = String(context.args.goal ?? "").trim();
  if (!goal) throw new Error("A research goal is required.");
  const { runAgentTask } = await import("../service");
  const result = await runAgentTask(
    context.projectId,
    `Read-only research subagent. Investigate and report a compact answer with file:line evidence. Do not modify files or run commands.\n\n${goal}`,
    {
      mode: "ask",
      allowWrite: false,
      allowCommands: false,
      interactive: false,
      language: "en",
    },
    () => undefined,
    context.signal,
  );
  return { observation: result.summary, ok: result.stoppedReason === "finished" };
};

export const TRY_TOOL_HANDLERS: Record<string, AgentToolHandler> = {
  list_files: listFilesHandler,
  search_code: searchCodeHandler,
  read_file: readFileHandler,
  read_symbol: readSymbolHandler,
  find_in_file: findInFileHandler,
  diagnostics: diagnosticsHandler,
  lsp_hover: lspHoverHandler,
  lsp_completion: lspCompletionHandler,
  list_items: listItemsHandler,
  count_matches: countMatchesHandler,
  list_colors: listColorsHandler,
  extract_entities: extractEntitiesHandler,
  audit_content: auditContentHandler,
  apply_mapped_changes: applyMappedChangesHandler,
  undo_change: undoChangeHandler,
  json_query: jsonQueryHandler,
  find_symbols: findSymbolsHandler,
  sqlite_query: sqliteQueryHandler,
  csv_query: csvQueryHandler,
  git_blame: gitBlameHandler,
  browser_check: browserCheckHandler,
  run_test_scenario: runTestScenarioHandler,
  game_check: gameCheckHandler,
  project_search: projectSearchHandler,
  search_conversations: searchConversationsHandler,
  rescan_project: rescanProjectHandler,
  write_file: writeFileHandler,
  replace_in_file: replaceInFileHandler,
  replace_many: replaceManyHandler,
  append_text: appendTextHandler,
  rename_path: renamePathHandler,
  delete_file: deleteFileHandler,
  format_file: formatFileHandler,
  run_command: runCommandHandler,
  delegate_research: delegateResearchHandler,
};
