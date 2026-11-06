import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeProject } from "./analyzer";
import {
  askProject,
  analyzeSymbol,
  discoverBusinessFlows,
  investigateUnresolved,
  reviewChanges,
  summarizeProject,
  summarizeScope,
} from "./ai/service";
import { listProviderModels, testProvider } from "./ai/providers";
import { getPublicSettings, updateAiSettings } from "./ai/settings";
import { buildChangeReport } from "./changes";
import { getFileDiff, getGitStatus } from "./git";
import { listFolders } from "./fsbrowse";
import { searchCode } from "./search";
import { subscribeProjectEvents } from "./watcher";
import { isWithin } from "./scanner";
import { AI_PROVIDERS, type AiProviderId } from "../../shared/ai";

function isProviderId(value: string): value is AiProviderId {
  return AI_PROVIDERS.some((provider) => provider.id === value);
}
import {
  isValidProjectId,
  listRecent,
  loadAnalysis,
  removeAnalysis,
  saveAnalysis,
  touchProject,
} from "./store";
import type { SourceResponse } from "../../shared/types";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const PORT = Number(process.env.PORT || 4317);
const SERVE_WEB = process.argv.includes("--serve-web") || process.env.CIE_SERVE_WEB === "1";

const app = express();
app.use(express.json({ limit: "1mb" }));

// Local desktop companion: never expose the analysis server to the network.
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  next();
});

function handleError(res: express.Response, error: unknown, status = 500) {
  const message = error instanceof Error ? error.message : "Bilinmeyen hata";
  const code = message.includes("not found") || message.includes("ENOENT") ? 404 : status;
  res.status(code).json({ error: message });
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, name: "codebase-intelligence-explorer", version: "0.2.0" });
});

app.get("/api/fs/list", async (req, res) => {
  try {
    const requested = typeof req.query.path === "string" ? req.query.path : undefined;
    const listing = await listFolders(requested);
    res.json(listing);
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.get("/api/ai/settings", async (_req, res) => {
  try {
    res.json(await getPublicSettings());
  } catch (error) {
    handleError(res, error);
  }
});

app.put("/api/ai/settings", async (req, res) => {
  try {
    const body = req.body ?? {};
    const provider = typeof body.provider === "string" ? (body.provider as AiProviderId) : undefined;
    const defaultProvider =
      typeof body.defaultProvider === "string" ? (body.defaultProvider as AiProviderId) : undefined;
    if (provider && !isProviderId(provider)) {
      res.status(400).json({ error: "Unknown AI provider." });
      return;
    }
    if (defaultProvider && !isProviderId(defaultProvider)) {
      res.status(400).json({ error: "Unknown AI provider." });
      return;
    }
    const settings = await updateAiSettings({
      provider,
      defaultProvider,
      defaultModel: typeof body.defaultModel === "string" ? body.defaultModel : undefined,
      apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
      clearKey: Boolean(body.clearKey),
      baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : undefined,
      model: typeof body.model === "string" ? body.model : undefined,
    });
    res.json(settings);
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/ai/test", async (req, res) => {
  try {
    const provider = typeof req.body?.provider === "string" ? (req.body.provider as AiProviderId) : undefined;
    if (provider && !isProviderId(provider)) {
      res.status(400).json({ error: "Unknown AI provider." });
      return;
    }
    res.json(await testProvider(provider, typeof req.body?.model === "string" ? req.body.model : undefined));
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.get("/api/ai/models", async (req, res) => {
  try {
    const provider = typeof req.query.provider === "string" ? (req.query.provider as AiProviderId) : "openai";
    if (!isProviderId(provider)) {
      res.status(400).json({ error: "Unknown AI provider." });
      return;
    }
    res.json({ models: await listProviderModels(provider) });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/projects/:id/ai/symbol", async (req, res) => {
  try {
    const symbolId = typeof req.body?.symbolId === "string" ? req.body.symbolId : "";
    if (!symbolId) {
      res.status(400).json({ error: "symbolId is required." });
      return;
    }
    const provider = typeof req.body?.provider === "string" ? (req.body.provider as AiProviderId) : undefined;
    const result = await analyzeSymbol(req.params.id, symbolId, {
      provider,
      model: typeof req.body?.model === "string" ? req.body.model : undefined,
      force: Boolean(req.body?.force),
      language: typeof req.body?.language === "string" ? req.body.language : undefined,
    });
    res.json(result);
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/ai/review", async (req, res) => {
  try {
    const provider = typeof req.body?.provider === "string" ? (req.body.provider as AiProviderId) : undefined;
    const result = await reviewChanges(req.params.id, {
      provider,
      model: typeof req.body?.model === "string" ? req.body.model : undefined,
      force: Boolean(req.body?.force),
      language: typeof req.body?.language === "string" ? req.body.language : undefined,
      files: Array.isArray(req.body?.files) ? req.body.files.filter((file: unknown) => typeof file === "string") : undefined,
      base: typeof req.body?.base === "string" ? req.body.base : undefined,
    });
    res.json(result);
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/ai/scope", async (req, res) => {
  try {
    const nodeId = typeof req.body?.nodeId === "string" ? req.body.nodeId : "";
    if (!nodeId) {
      res.status(400).json({ error: "nodeId is required." });
      return;
    }
    const provider = typeof req.body?.provider === "string" ? (req.body.provider as AiProviderId) : undefined;
    const result = await summarizeScope(req.params.id, nodeId, {
      provider,
      model: typeof req.body?.model === "string" ? req.body.model : undefined,
      force: Boolean(req.body?.force),
      language: typeof req.body?.language === "string" ? req.body.language : undefined,
    });
    res.json(result);
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/ai/flows", async (req, res) => {
  try {
    const provider = typeof req.body?.provider === "string" ? (req.body.provider as AiProviderId) : undefined;
    const result = await discoverBusinessFlows(req.params.id, {
      provider,
      model: typeof req.body?.model === "string" ? req.body.model : undefined,
      force: Boolean(req.body?.force),
      language: typeof req.body?.language === "string" ? req.body.language : undefined,
    });
    res.json(result);
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/ai/summary", async (req, res) => {
  try {
    const provider = typeof req.body?.provider === "string" ? (req.body.provider as AiProviderId) : undefined;
    const result = await summarizeProject(req.params.id, {
      provider,
      model: typeof req.body?.model === "string" ? req.body.model : undefined,
      force: Boolean(req.body?.force),
      language: typeof req.body?.language === "string" ? req.body.language : undefined,
    });
    res.json(result);
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/ai/unresolved", async (req, res) => {
  try {
    const nodeId = typeof req.body?.nodeId === "string" ? req.body.nodeId : "";
    if (!nodeId) {
      res.status(400).json({ error: "nodeId is required." });
      return;
    }
    const provider = typeof req.body?.provider === "string" ? (req.body.provider as AiProviderId) : undefined;
    const result = await investigateUnresolved(req.params.id, nodeId, {
      provider,
      model: typeof req.body?.model === "string" ? req.body.model : undefined,
      force: Boolean(req.body?.force),
      language: typeof req.body?.language === "string" ? req.body.language : undefined,
    });
    res.json(result);
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/ai/chat", async (req, res) => {
  try {
    const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
    if (!question) {
      res.status(400).json({ error: "A question is required." });
      return;
    }
    const provider = typeof req.body?.provider === "string" ? (req.body.provider as AiProviderId) : undefined;
    const history = Array.isArray(req.body?.history)
      ? req.body.history
          .filter(
            (message: unknown): message is { role: "user" | "assistant"; content: string } =>
              Boolean(message) &&
              typeof (message as { content?: unknown }).content === "string" &&
              ["user", "assistant"].includes((message as { role?: string }).role ?? ""),
          )
          .slice(-6)
      : [];
    const result = await askProject(req.params.id, question, {
      provider,
      model: typeof req.body?.model === "string" ? req.body.model : undefined,
      history,
      language: typeof req.body?.language === "string" ? req.body.language : undefined,
    });
    res.json(result);
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.get("/api/recent", async (_req, res) => {
  try {
    res.json({ projects: await listRecent() });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/analyze", async (req, res) => {
  try {
    const inputPath = req.body?.path;
    if (typeof inputPath !== "string" || inputPath.trim().length === 0) {
      res.status(400).json({ error: "A folder path is required." });
      return;
    }
    const expanded = inputPath.startsWith("~") ? path.join(process.env.HOME || "", inputPath.slice(1)) : inputPath;
    const result = await analyzeProject(expanded);
    await saveAnalysis(result);
    res.json(result);
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/rescan", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidProjectId(id)) {
      res.status(400).json({ error: "Invalid project id." });
      return;
    }
    const previous = await loadAnalysis(id);
    const result = await analyzeProject(previous.rootPath);
    await saveAnalysis(result);
    res.json(result);
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/projects/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await loadAnalysis(id);
    await touchProject(id);
    res.json(result);
  } catch (error) {
    handleError(res, error, 404);
  }
});

app.delete("/api/projects/:id", async (req, res) => {
  try {
    await removeAnalysis(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.get("/api/projects/:id/events", async (req, res) => {
  try {
    if (!isValidProjectId(req.params.id)) {
      res.status(400).json({ error: "Invalid project id." });
      return;
    }
    await subscribeProjectEvents(req.params.id, res);
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/projects/:id/search", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    const query = typeof req.body?.query === "string" ? req.body.query : "";
    if (!query.trim()) {
      res.status(400).json({ error: "A search query is required." });
      return;
    }
    const limit = Number(req.body?.limit) || 20;
    res.json(await searchCode(analysis, query, limit));
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/projects/:id/git", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    const status = await getGitStatus(analysis.rootPath, analysis);
    res.json(status);
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/projects/:id/git/diff", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    const file = typeof req.query.file === "string" ? req.query.file : "";
    if (!file) {
      res.status(400).json({ error: "A file path is required." });
      return;
    }
    const base = typeof req.query.base === "string" && req.query.base ? req.query.base : analysis.git?.head ?? "HEAD";
    const diff = await getFileDiff(analysis.rootPath, file, base);
    res.json(diff);
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/projects/:id/changes", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidProjectId(id)) {
      res.status(400).json({ error: "Invalid project id." });
      return;
    }
    const { report, analysis } = await buildChangeReport(id);
    await saveAnalysis(analysis);
    res.json({ report, analysis });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/projects/:id/source", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await loadAnalysis(id);
    const requested = typeof req.query.file === "string" ? req.query.file.replace(/^\/+/, "") : "";
    const record = result.files.find((file) => file.path === requested);
    if (!record) {
      res.status(404).json({ error: "File was not found in this analysis." });
      return;
    }

    const absolute = path.resolve(result.rootPath, record.path);
    if (!isWithin(result.rootPath, absolute)) {
      res.status(403).json({ error: "Access outside the project root was denied." });
      return;
    }

    // Resolve symlinks after the fact: a file replaced by a symlink must not
    // become a read primitive outside the analyzed project.
    const [realRoot, realFile] = await Promise.all([fs.realpath(result.rootPath), fs.realpath(absolute)]);
    if (!isWithin(realRoot, realFile)) {
      res.status(403).json({ error: "Access outside the project root was denied." });
      return;
    }

    const content = await fs.readFile(realFile, "utf8");
    const allLines = content.split("\n");
    const totalLines = allLines.length;
    const requestedStart = Number(req.query.start ?? 1);
    const requestedEnd = Number(req.query.end ?? 0);
    const startLine = Math.max(1, Number.isFinite(requestedStart) ? Math.floor(requestedStart) : 1);
    const endLine = Math.min(
      totalLines,
      Math.max(startLine, Number.isFinite(requestedEnd) && requestedEnd > 0 ? Math.floor(requestedEnd) : Math.min(totalLines, startLine + 160)),
      startLine + 600,
    );

    const response: SourceResponse = {
      filePath: record.path,
      language: record.language,
      startLine,
      endLine,
      totalLines,
      lines: allLines.slice(startLine - 1, endLine).map((text, index) => ({
        number: startLine + index,
        text,
      })),
    };
    res.json(response);
  } catch (error) {
    handleError(res, error);
  }
});

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API endpoint not found." });
});

const distDir = path.join(REPO_ROOT, "dist");
if (SERVE_WEB) {
  app.use(express.static(distDir));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });
}

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  handleError(res, error);
});

app.listen(PORT, "127.0.0.1", () => {
  const mode = SERVE_WEB ? "production UI" : "API";
  console.log(`Codebase Intelligence Explorer (${mode}) → http://127.0.0.1:${PORT}`);
});
