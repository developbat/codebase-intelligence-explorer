import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LspCompletionItem, LspDiagnostic, LspHover } from "../../shared/lsp";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface DiagnosticsWaiter {
  resolve: (items: LspDiagnostic[]) => void;
  timer: NodeJS.Timeout;
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

interface LspServerDefinition {
  id: string;
  name: string;
  command: string;
  args: string[];
  extensions: string[];
  languageId: (filePath: string) => string;
}

export interface LspServerStatus {
  id: string;
  name: string;
  available: boolean;
  extensions: string[];
}

const SERVERS: LspServerDefinition[] = [
  {
    id: "typescript",
    name: "TypeScript Language Server",
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    languageId: (filePath) => {
      const extension = path.extname(filePath).toLowerCase();
      if (extension === ".tsx") return "typescriptreact";
      if (extension === ".jsx") return "javascriptreact";
      if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return "javascript";
      return "typescript";
    },
  },
  {
    id: "pyright",
    name: "Pyright",
    command: "pyright-langserver",
    args: ["--stdio"],
    extensions: [".py", ".pyi"],
    languageId: () => "python",
  },
  {
    id: "rust-analyzer",
    name: "rust-analyzer",
    command: "rust-analyzer",
    args: [],
    extensions: [".rs"],
    languageId: () => "rust",
  },
  {
    id: "gopls",
    name: "gopls",
    command: "gopls",
    args: ["serve"],
    extensions: [".go"],
    languageId: () => "go",
  },
  {
    id: "intelephense",
    name: "Intelephense",
    command: "intelephense",
    args: ["--stdio"],
    extensions: [".php"],
    languageId: () => "php",
  },
];

const REQUEST_TIMEOUT_MS = 8_000;
const DIAGNOSTICS_TIMEOUT_MS = 4_000;

export function lspServerFor(filePath: string): LspServerDefinition | null {
  const extension = path.extname(filePath).toLowerCase();
  return SERVERS.find((server) => server.extensions.includes(extension)) ?? null;
}

function commandExists(command: string): boolean {
  if (command.includes(path.sep)) return fs.existsSync(command);
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .some((directory) =>
      [command, `${command}.cmd`, `${command}.exe`].some((name) =>
        fs.existsSync(path.join(directory, name)),
      ),
    );
}

function appLocalBinary(command: string): string | undefined {
  const candidate = path.resolve(process.cwd(), "node_modules", ".bin", command);
  return fs.existsSync(candidate) ? candidate : undefined;
}

function projectLocalBinary(rootPath: string, command: string): string | undefined {
  const candidate = path.resolve(rootPath, "node_modules", ".bin", command);
  return fs.existsSync(candidate) ? candidate : undefined;
}

function resolveServerCommand(
  definition: LspServerDefinition,
  rootPath: string,
): { command: string; args: string[] } {
  if (definition.id === "typescript") {
    const fromSource = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../node_modules/typescript-language-server/lib/cli.mjs",
    );
    if (fs.existsSync(fromSource)) {
      return { command: process.execPath, args: [fromSource, ...definition.args] };
    }
    const local = appLocalBinary(definition.command) ?? projectLocalBinary(rootPath, definition.command);
    if (local) return { command: local, args: definition.args };
  } else {
    const local =
      projectLocalBinary(rootPath, definition.command) ??
      appLocalBinary(definition.command);
    if (local) return { command: local, args: definition.args };
  }
  return { command: definition.command, args: definition.args };
}

export function isLspAvailable(): boolean {
  return lspServersStatus().some((server) => server.available);
}

export function lspServersStatus(): LspServerStatus[] {
  return SERVERS.map((server) => {
    const resolved = resolveServerCommand(server, process.cwd());
    return {
      id: server.id,
      name: server.name,
      available:
        resolved.command === process.execPath
          ? fs.existsSync(resolved.args[0] ?? "")
          : commandExists(resolved.command),
      extensions: server.extensions,
    };
  });
}

function uriFor(rootPath: string, filePath: string): string {
  return pathToFileURL(path.resolve(rootPath, filePath)).toString();
}

class LspClient {
  private process: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private diagnostics = new Map<string, LspDiagnostic[]>();
  private diagnosticsWaiters = new Map<string, DiagnosticsWaiter[]>();
  private versions = new Map<string, number>();
  private closed = false;

  constructor(
    private readonly rootPath: string,
    private readonly definition: LspServerDefinition,
  ) {
    const resolved = resolveServerCommand(definition, rootPath);
    this.process = spawn(resolved.command, resolved.args, {
      cwd: rootPath,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TSS_LOG: "-level off" },
    });
    this.process.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.process.stderr.on("data", () => {
      // The language server may log warnings; diagnostics are delivered by JSON-RPC.
    });
    this.process.on("error", (error) => this.failAll(error));
    this.process.on("exit", () => {
      if (!this.closed) this.failAll(new Error("The language server exited."));
    });
  }

  private failAll(error: Error): void {
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    for (const waiters of this.diagnosticsWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve([]);
      }
    }
    this.diagnosticsWaiters.clear();
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      try {
        this.handleMessage(JSON.parse(body) as JsonRpcMessage);
      } catch {
        // Ignore malformed server messages; the next frame may still be valid.
      }
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (message.id !== undefined && (message.result !== undefined || message.error)) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) return;
      this.pending.delete(Number(message.id));
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "textDocument/publishDiagnostics") {
      const params = message.params as {
        uri?: string;
        diagnostics?: {
          range: { start: { line: number; character: number }; end: { line: number; character: number } };
          severity?: number;
          message?: string;
          source?: string;
          code?: string | number;
        }[];
      };
      if (!params?.uri) return;
      const items = (params.diagnostics ?? []).map((diagnostic) => ({
        filePath: fileURLToPath(params.uri!),
        line: diagnostic.range.start.line + 1,
        character: diagnostic.range.start.character + 1,
        endLine: diagnostic.range.end.line + 1,
        endCharacter: diagnostic.range.end.character + 1,
        severity:
          diagnostic.severity === 1
            ? ("error" as const)
            : diagnostic.severity === 2
              ? ("warning" as const)
              : diagnostic.severity === 3
                ? ("info" as const)
                : ("hint" as const),
        message: diagnostic.message ?? "",
        source: diagnostic.source,
        code: diagnostic.code,
      }));
      this.diagnostics.set(params.uri, items);
      const waiters = this.diagnosticsWaiters.get(params.uri) ?? [];
      this.diagnosticsWaiters.delete(params.uri);
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(items);
      }
    }
  }

  private send(message: JsonRpcMessage): void {
    const body = JSON.stringify(message);
    this.process.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    if (this.closed) throw new Error("The language server is not running.");
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.send({ jsonrpc: "2.0", method, params });
  }

  async initialize(): Promise<void> {
    const rootUri = pathToFileURL(this.rootPath).toString();
    await this.request("initialize", {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: path.basename(this.rootPath) }],
      capabilities: {
        textDocument: {
          synchronize: { dynamicRegistration: false },
          publishDiagnostics: {},
          hover: { contentFormat: ["markdown", "plaintext"] },
          completion: { completionItem: { snippetSupport: true, documentationFormat: ["markdown", "plaintext"] } },
        },
        workspace: { workspaceFolders: true },
      },
    });
    this.notify("initialized", {});
  }

  async openOrUpdate(rootPath: string, filePath: string): Promise<string> {
    const uri = uriFor(rootPath, filePath);
    const absolute = path.resolve(rootPath, filePath);
    const fs = await import("node:fs/promises");
    const text = await fs.readFile(absolute, "utf8");
    const version = (this.versions.get(uri) ?? 0) + 1;
    this.versions.set(uri, version);
    if (version === 1) {
      this.notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: this.definition.languageId(filePath),
          version,
          text,
        },
      });
    } else {
      this.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    }
    return uri;
  }

  async diagnosticsFor(rootPath: string, filePath: string): Promise<LspDiagnostic[]> {
    const uri = await this.openOrUpdate(rootPath, filePath);
    const cached = this.diagnostics.get(uri);
    if (cached) {
      // A publishDiagnostics notification may already be waiting from a previous edit.
      return cached;
    }
    return new Promise<LspDiagnostic[]>((resolve) => {
      const timer = setTimeout(() => {
        const waiters = this.diagnosticsWaiters.get(uri) ?? [];
        this.diagnosticsWaiters.set(
          uri,
          waiters.filter((waiter) => waiter.timer !== timer),
        );
        resolve([]);
      }, DIAGNOSTICS_TIMEOUT_MS);
      const waiters = this.diagnosticsWaiters.get(uri) ?? [];
      waiters.push({ resolve, timer });
      this.diagnosticsWaiters.set(uri, waiters);
    });
  }

  async hover(rootPath: string, filePath: string, line: number, character: number): Promise<LspHover | null> {
    const uri = await this.openOrUpdate(rootPath, filePath);
    const result = await this.request<{
      contents?: string | { kind?: string; value?: string } | (string | { language?: string; value?: string })[];
      range?: LspHover["range"];
    } | null>("textDocument/hover", {
      textDocument: { uri },
      position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) },
    });
    if (!result?.contents) return null;
    const contents = Array.isArray(result.contents)
      ? result.contents
          .map((item) => (typeof item === "string" ? item : item.value ?? ""))
          .join("\n\n")
      : typeof result.contents === "string"
        ? result.contents
        : result.contents.value ?? "";
    return { contents, range: result.range };
  }

  async completion(
    rootPath: string,
    filePath: string,
    line: number,
    character: number,
  ): Promise<LspCompletionItem[]> {
    const uri = await this.openOrUpdate(rootPath, filePath);
    const result = await this.request<{
      items?: {
        label?: string;
        kind?: number;
        detail?: string;
        documentation?: string | { value?: string };
        insertText?: string;
      }[];
    } | {
      label?: string;
      kind?: number;
      detail?: string;
      documentation?: string | { value?: string };
      insertText?: string;
    }[] | null>("textDocument/completion", {
      textDocument: { uri },
      position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) },
      context: { triggerKind: 1 },
    });
    const items = Array.isArray(result) ? result : result?.items ?? [];
    return items.slice(0, 100).map((item) => ({
      label: item.label ?? "",
      kind: item.kind,
      detail: item.detail,
      documentation:
        typeof item.documentation === "string"
          ? item.documentation
          : item.documentation?.value,
      insertText: item.insertText,
    }));
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.request("shutdown", null);
      this.notify("exit", null);
    } catch {
      // The process is killed below.
    }
    this.process.kill();
  }
}

const sessions = new Map<string, Promise<LspClient>>();
const idleTimers = new Map<string, NodeJS.Timeout>();
const IDLE_MS = 5 * 60_000;

function resetIdle(key: string): void {
  const existing = idleTimers.get(key);
  if (existing) clearTimeout(existing);
  idleTimers.set(
    key,
    setTimeout(() => {
      const session = sessions.get(key);
      sessions.delete(key);
      idleTimers.delete(key);
      void session?.then((client) => client.shutdown()).catch(() => undefined);
    }, IDLE_MS),
  );
}

export async function getLspClient(
  rootPath: string,
  definition: LspServerDefinition,
): Promise<LspClient> {
  const key = `${rootPath}::${definition.id}`;
  const existing = sessions.get(key);
  if (existing) {
    resetIdle(key);
    return existing;
  }
  const created = (async () => {
    const client = new LspClient(rootPath, definition);
    await client.initialize();
    return client;
  })();
  sessions.set(key, created);
  resetIdle(key);
  try {
    return await created;
  } catch (error) {
    sessions.delete(key);
    throw error;
  }
}

export function supportsLsp(filePath: string): boolean {
  return lspServerFor(filePath) !== null;
}

export async function lspDiagnostics(
  rootPath: string,
  filePath: string,
): Promise<{ supported: boolean; diagnostics: LspDiagnostic[]; reason?: string }> {
  const definition = lspServerFor(filePath);
  if (!definition) {
    return {
      supported: false,
      diagnostics: [],
      reason: "No LSP server is configured for this file type.",
    };
  }
  try {
    const client = await getLspClient(rootPath, definition);
    const diagnostics = await client.diagnosticsFor(rootPath, filePath);
    return { supported: true, diagnostics };
  } catch (error) {
    return {
      supported: false,
      diagnostics: [],
      reason: `${definition.name} is not available: ${
        error instanceof Error ? error.message : "could not start the language server"
      }. Install it from Settings → Development environment.`,
    };
  }
}

export async function lspHover(
  rootPath: string,
  filePath: string,
  line: number,
  character: number,
): Promise<LspHover | null> {
  const definition = lspServerFor(filePath);
  if (!definition) return null;
  try {
    const client = await getLspClient(rootPath, definition);
    return await client.hover(rootPath, filePath, line, character);
  } catch {
    return null;
  }
}

export async function lspCompletion(
  rootPath: string,
  filePath: string,
  line: number,
  character: number,
): Promise<LspCompletionItem[]> {
  const definition = lspServerFor(filePath);
  if (!definition) return [];
  try {
    const client = await getLspClient(rootPath, definition);
    return await client.completion(rootPath, filePath, line, character);
  } catch {
    return [];
  }
}

export async function shutdownLspSessions(): Promise<void> {
  for (const timer of idleTimers.values()) clearTimeout(timer);
  idleTimers.clear();
  const clients = [...sessions.values()];
  sessions.clear();
  await Promise.all(clients.map((client) => client.then((value) => value.shutdown()).catch(() => undefined)));
}
