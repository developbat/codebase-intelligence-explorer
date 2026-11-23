import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeProject } from "./analyzer";
import {
  askProject,
  analyzeSymbol,
  discoverBusinessFlows,
  editSourceFile,
  generateTests,
  investigateUnresolved,
  runAgentTask,
  runCodingTask,
  answerGeneralChat,
  reviewChanges,
  summarizeProject,
  summarizeScope,
} from "./ai/service";
import { listProviderModels, testProvider } from "./ai/providers";
import { discoverLocalModelDirs, localModelStatus, pullLocalModel, startLocalServer } from "./localModels";
import { autoConfigureAgents } from "./ai/agents";
import { clearModelCatalog, getModelCatalog, importModelCatalog } from "./ai/catalog";
import { getModelHealthReport } from "./ai/modelStats";
import { getPricingReport, refreshPricing } from "./ai/pricing";
import { isBrowserCheckAvailable, runBrowserCheck } from "./browserCheck";
import { findProjectTool, listProjectTools, recordProjectToolRun } from "./projectTools";
import {
  bootMobileDevice,
  captureMobileScreenshot,
  installMobileApp,
  launchMobileApp,
  listMobileDevices,
  openMobileUrl,
  readMobileLogs,
  runMobileCheck,
} from "./mobileDevices";
import { createPlaceholderAsset } from "./placeholderAssets";
import { checkToolchains, installRecommended, installToolchain } from "./toolchains";
import { runGameCheck } from "./gameCheck";
import { createGraphic } from "./graphics";
import { checkGraphic } from "./graphicCheck";
import { getProjectTaskQueue, planProjectTasks, runProjectLoop } from "./ai/loop";
import { loadQueue, removeTask, reorderTasks, saveQueue, updateTask } from "./tasks";
import type { ProjectTask } from "../../shared/tasks";
import { getPublicSettings, updateAiSettings } from "./ai/settings";
import { getPrompt, getPromptVersion, listPrompts, renderPrompt, resetPrompt, savePrompt } from "./ai/prompts";
import { resolvePermission } from "./ai/permissions";
import { analyzeIntent } from "./ai/intent";
import { listPlans, readPlan } from "./plans";
import type { IntentAnalysis } from "../../shared/intent";
import type { AiWorkspaceMode } from "../../shared/ai";
import { getProjectUsage } from "./ai/usage";
import { buildChangeReport } from "./changes";
import { formatProjectFile } from "./formatter";
import { checkFileSyntax } from "./syntax";
import {
  isLspAvailable,
  lspServersStatus,
  lspCompletion,
  lspDiagnostics,
  lspHover,
  shutdownLspSessions,
} from "./lsp";
import { scanDuplications } from "./duplication";
import {
  getProjectIndexStatus,
  removeIndexedPath,
  renameIndexedPath,
  importConversations,
  searchConversations,
  searchProjectIndex,
  startProjectIndexBuild,
} from "./indexer";
import {
  createSourceFile,
  deleteProjectPath,
  readSourceFile,
  renameProjectPath,
  runProjectCommand,
  writeProjectAsset,
  writeSourceFile,
} from "./editor";
import {
  listBackgroundProcesses,
  readBackgroundProcess,
  removeBackgroundProcess,
  detectDevCommands,
  startBackgroundProcess,
  stopBackgroundProcess,
} from "./processes";
import {
  closeProjectTerminals,
  closeTerminalSession,
  createTerminalSession,
  interruptTerminal,
  listTerminalSessions,
  resizeTerminal,
  subscribeTerminal,
  writeTerminalInput,
} from "./terminals";
import { readPreviewFile } from "./preview";
import { getCommitDetail, getCommitFileDiff, getCommitLog, getFileDiff, getGitStatus } from "./git";
import { findProjectIcon } from "./icons";
import { discoverTests, runTests } from "./tests";
import { listFolders } from "./fsbrowse";
import { listProjectTemplates, scaffoldProject } from "./scaffold";
import { getSkill, listSkills, readSkillFile, setSkillEnabled } from "./skills";
import {
  installSkills,
  previewSkillSource,
  removeInstalledSkill,
  updateInstalledSkill,
} from "./skillInstall";
import { searchCode } from "./search";
import { subscribeProjectEvents } from "./watcher";
import { isWithin } from "./scanner";
import {
  AI_PROVIDERS,
  CUSTOM_PROVIDER_PREFIX,
  type AiProviderId,
  type AiSettingsInput,
} from "../../shared/ai";

function isProviderId(value: string): value is AiProviderId {
  return (
    AI_PROVIDERS.some((provider) => provider.id === value) ||
    value.startsWith(CUSTOM_PROVIDER_PREFIX)
  );
}
import {
  getRecentProject,
  isValidProjectId,
  listRecent,
  loadAnalysis,
  removeAnalysis,
  saveAnalysis,
  touchProject,
} from "./store";
import type { ProjectTemplateId, SourceResponse } from "../../shared/types";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const PORT = Number(process.env.PORT || 4317);
const TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const SERVE_WEB = process.argv.includes("--serve-web") || process.env.CIE_SERVE_WEB === "1";

const app = express();

// Agent runs are server-owned. Disconnecting the browser (screen lock, reload,
// sleeping laptop) must not abort work that is already in progress.
const activeAgentRuns = new Map<string, Set<AbortController>>();

function registerAgentRun(projectId: string, controller: AbortController): void {
  const runs = activeAgentRuns.get(projectId) ?? new Set<AbortController>();
  runs.add(controller);
  activeAgentRuns.set(projectId, runs);
}

function unregisterAgentRun(projectId: string, controller: AbortController): void {
  const runs = activeAgentRuns.get(projectId);
  if (!runs) return;
  runs.delete(controller);
  if (runs.size === 0) activeAgentRuns.delete(projectId);
}

function stopAgentRuns(projectId: string): number {
  const runs = activeAgentRuns.get(projectId);
  if (!runs) return 0;
  for (const controller of runs) controller.abort();
  return runs.size;
}

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

app.get("/favicon.ico", (_req, res) => {
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(TRANSPARENT_PNG);
});

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

app.get("/api/ai/model-health", async (_req, res) => {
  try {
    res.json(await getModelHealthReport());
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/ai/local/status", async (_req, res) => {
  try {
    res.json(await localModelStatus());
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.get("/api/ai/local/discover", async (_req, res) => {
  try {
    res.json({ dirs: await discoverLocalModelDirs() });
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/ai/local/start", async (_req, res) => {
  try {
    res.json(await startLocalServer());
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/ai/local/pull", async (req, res) => {
  try {
    const model = typeof req.body?.model === "string" ? req.body.model : "";
    res.json(await pullLocalModel(model));
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.get("/api/ai/catalog", async (_req, res) => {
  try {
    res.json({ catalog: await getModelCatalog() });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/ai/catalog/import", async (req, res) => {
  try {
    const json = typeof req.body?.json === "string" ? req.body.json : undefined;
    const url = typeof req.body?.url === "string" ? req.body.url : undefined;
    const result = await importModelCatalog({
      json,
      url,
      replace: req.body?.replace !== false,
    });
    res.json(result);
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.delete("/api/ai/catalog", async (_req, res) => {
  try {
    await clearModelCatalog();
    res.json({ ok: true });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/ai/agents/auto", async (_req, res) => {
  try {
    res.json(await autoConfigureAgents());
  } catch (error) {
    handleError(res, error, 400);
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
    const rawCustom = body.customProvider;
    const customProvider =
      rawCustom && typeof rawCustom === "object"
        ? {
            id: typeof rawCustom.id === "string" ? rawCustom.id : undefined,
            name: typeof rawCustom.name === "string" ? rawCustom.name : undefined,
            baseUrl: typeof rawCustom.baseUrl === "string" ? rawCustom.baseUrl : undefined,
            apiKey: typeof rawCustom.apiKey === "string" ? rawCustom.apiKey : undefined,
            clearKey: Boolean(rawCustom.clearKey),
            models: Array.isArray(rawCustom.models)
              ? rawCustom.models.filter((model: unknown): model is string => typeof model === "string")
              : undefined,
            modelListUrl:
              typeof rawCustom.modelListUrl === "string" ? rawCustom.modelListUrl : undefined,
          }
        : undefined;
    const rawFallback = body.fallback;
    const fallback: AiSettingsInput["fallback"] =
      rawFallback && typeof rawFallback === "object"
        ? {
            chain: Array.isArray(rawFallback.chain)
              ? rawFallback.chain
                  .filter(
                    (item: unknown): item is { provider: string; model: string } =>
                      Boolean(
                        item &&
                          typeof item === "object" &&
                          typeof (item as { provider?: unknown }).provider === "string" &&
                          typeof (item as { model?: unknown }).model === "string",
                      ),
                  )
                  .map((item: { provider: string; model: string }) => ({
                    provider: item.provider,
                    model: item.model,
                  }))
              : undefined,
            maxInputPricePerMillion:
              typeof rawFallback.maxInputPricePerMillion === "number"
                ? rawFallback.maxInputPricePerMillion
                : undefined,
            maxOutputPricePerMillion:
              typeof rawFallback.maxOutputPricePerMillion === "number"
                ? rawFallback.maxOutputPricePerMillion
                : undefined,
          }
        : undefined;
    const rawProviderEnabled = body.providerEnabled;
    const providerEnabled: AiSettingsInput["providerEnabled"] =
      rawProviderEnabled &&
      typeof rawProviderEnabled === "object" &&
      typeof rawProviderEnabled.provider === "string"
        ? {
            provider: rawProviderEnabled.provider as AiProviderId,
            enabled: rawProviderEnabled.enabled !== false,
          }
        : undefined;
    const settings = await updateAiSettings({
      provider,
      defaultProvider,
      defaultModel: typeof body.defaultModel === "string" ? body.defaultModel : undefined,
      apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
      clearKey: Boolean(body.clearKey),
      baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : undefined,
      model: typeof body.model === "string" ? body.model : undefined,
      models: Array.isArray(body.models)
        ? body.models.filter((model: unknown): model is string => typeof model === "string")
        : undefined,
      customProvider,
      removeProviderId:
        typeof body.removeProviderId === "string" ? body.removeProviderId : undefined,
      autoSwitchModels:
        typeof body.autoSwitchModels === "boolean" ? body.autoSwitchModels : undefined,
      fallback,
      agentRoles:
        body.agentRoles && typeof body.agentRoles === "object"
          ? (body.agentRoles as AiSettingsInput["agentRoles"])
          : undefined,
      modelHealth:
        body.modelHealth && typeof body.modelHealth === "object"
          ? (body.modelHealth as AiSettingsInput["modelHealth"])
          : undefined,
      providerEnabled,
      localModelsDir:
        typeof body.localModelsDir === "string" ? body.localModelsDir : undefined,
    });
    res.json(settings);
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.get("/api/prompts", async (req, res) => {
  try {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    res.json({ prompts: await listPrompts(projectId) });
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.get("/api/prompts/:id/versions/:version", async (req, res) => {
  try {
    const scope = req.query.scope === "project" ? "project" : "global";
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    const version = Number(req.params.version);
    if (!Number.isInteger(version) || version < 1) {
      res.status(400).json({ error: "A positive version number is required." });
      return;
    }
    res.json(await getPromptVersion(req.params.id, version, scope, projectId));
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.put("/api/prompts/:id", async (req, res) => {
  try {
    const system = typeof req.body?.system === "string" ? req.body.system : "";
    const projectId = typeof req.body?.projectId === "string" ? req.body.projectId : undefined;
    res.json(await savePrompt(req.params.id, system, projectId));
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.delete("/api/prompts/:id", async (req, res) => {
  try {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    res.json(await resetPrompt(req.params.id, projectId));
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/prompts/:id/preview", async (req, res) => {
  try {
    const projectId = typeof req.body?.projectId === "string" ? req.body.projectId : undefined;
    const prompt = await getPrompt(req.params.id, projectId);
    const variables =
      req.body?.variables && typeof req.body.variables === "object"
        ? (req.body.variables as Record<string, string>)
        : {};
    res.json({ ...prompt, preview: renderPrompt(prompt.system, variables) });
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
    const refresh = req.query.refresh === "1" || req.query.refresh === "true";
    const models = await listProviderModels(provider, { refresh });
    let pricingUpdatedAt: string | undefined;
    if (refresh) {
      pricingUpdatedAt = await refreshPricing()
        .then((report) => report.updatedAt)
        .catch(() => undefined);
    }
    res.json({ models, pricingUpdatedAt });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/ai/pricing", async (_req, res) => {
  try {
    res.json(await getPricingReport());
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/ai/pricing/refresh", async (_req, res) => {
  try {
    res.json(await refreshPricing());
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/mobile/devices/boot", async (req, res) => {
  try {
    const platform = req.body?.platform === "android" ? "android" : "ios";
    const id = typeof req.body?.id === "string" ? req.body.id : "";
    if (!id) {
      res.status(400).json({ error: "A device id is required." });
      return;
    }
    res.json(await bootMobileDevice(platform, id));
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/mobile/check", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    res.json(
      await runMobileCheck(analysis.rootPath, {
        platform: req.body?.platform === "android" ? "android" : req.body?.platform === "ios" ? "ios" : undefined,
        id: typeof req.body?.id === "string" ? req.body.id : undefined,
        boot: req.body?.boot === true,
        screenshot: req.body?.screenshot !== false,
        logs: req.body?.logs === true,
        openUrl: typeof req.body?.openUrl === "string" ? req.body.openUrl : undefined,
        logLimit: Number(req.body?.logLimit) || undefined,
      }),
    );
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/mobile/devices/install", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    const platform = req.body?.platform === "android" ? "android" : "ios";
    const id = typeof req.body?.id === "string" ? req.body.id : "";
    const pathValue = typeof req.body?.path === "string" ? req.body.path : "";
    if (!id || !pathValue) {
      res.status(400).json({ error: "Device id and app path are required." });
      return;
    }
    res.json(await installMobileApp(analysis.rootPath, platform, id, pathValue));
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/mobile/devices/launch", async (req, res) => {
  try {
    const platform = req.body?.platform === "android" ? "android" : "ios";
    const id = typeof req.body?.id === "string" ? req.body.id : "";
    const target = typeof req.body?.target === "string" ? req.body.target : "";
    if (!id || !target) {
      res.status(400).json({ error: "Device id and package/bundle id are required." });
      return;
    }
    res.json(await launchMobileApp(platform, id, target));
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/mobile/devices/open-url", async (req, res) => {
  try {
    const platform = req.body?.platform === "android" ? "android" : "ios";
    const id = typeof req.body?.id === "string" ? req.body.id : "";
    const url = typeof req.body?.url === "string" ? req.body.url : "";
    if (!id || !url) {
      res.status(400).json({ error: "Device id and URL are required." });
      return;
    }
    res.json(await openMobileUrl(platform, id, url));
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/mobile/devices/logs", async (req, res) => {
  try {
    const platform = req.body?.platform === "android" ? "android" : "ios";
    const id = typeof req.body?.id === "string" ? req.body.id : "";
    if (!id) {
      res.status(400).json({ error: "Device id is required." });
      return;
    }
    res.json(await readMobileLogs(platform, id, Number(req.body?.limit) || 200));
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/mobile/devices/screenshot", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    const platform = req.body?.platform === "android" ? "android" : "ios";
    const id = typeof req.body?.id === "string" ? req.body.id : "";
    if (!id) {
      res.status(400).json({ error: "A device id is required." });
      return;
    }
    res.json(await captureMobileScreenshot(analysis.rootPath, platform, id));
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/assets/placeholder", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    res.status(201).json(
      await createPlaceholderAsset(analysis.rootPath, {
        path: typeof req.body?.path === "string" ? req.body.path : "",
        kind: req.body?.kind,
        width: Number(req.body?.width) || undefined,
        height: Number(req.body?.height) || undefined,
        label: typeof req.body?.label === "string" ? req.body.label : undefined,
        color: typeof req.body?.color === "string" ? req.body.color : undefined,
        background: typeof req.body?.background === "string" ? req.body.background : undefined,
        format: req.body?.format === "png" ? "png" : undefined,
        durationMs: Number(req.body?.durationMs) || undefined,
        frequency: Number(req.body?.frequency) || undefined,
        loop: req.body?.loop === true,
        fps: Number(req.body?.fps) || undefined,
      }),
    );
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.get("/api/toolchains", async (req, res) => {
  try {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : "";
    if (projectId) {
      const analysis = await loadAnalysis(projectId);
      res.json(
        await checkToolchains(req.query.refresh === "1", {
          rootPath: analysis.rootPath,
          languages: Object.keys(analysis.languages),
          files: analysis.files.map((file) => file.path),
        }),
      );
      return;
    }
    res.json(await checkToolchains(req.query.refresh === "1"));
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/toolchains/install", async (req, res) => {
  try {
    const id = typeof req.body?.id === "string" ? req.body.id : "";
    if (!id) {
      res.status(400).json({ error: "A toolchain id is required." });
      return;
    }
    const projectId = typeof req.body?.projectId === "string" ? req.body.projectId : "";
    const analysis = projectId ? await loadAnalysis(projectId) : null;
    res.json(await installToolchain(id, analysis?.rootPath));
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/toolchains/install-recommended", async (req, res) => {
  try {
    const projectId = typeof req.body?.projectId === "string" ? req.body.projectId : "";
    const analysis = projectId ? await loadAnalysis(projectId) : null;
    res.json(
      await installRecommended({
        rootPath: analysis?.rootPath,
        languages: analysis ? Object.keys(analysis.languages) : [],
        files: analysis?.files.map((file) => file.path) ?? [],
      }),
    );
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.get("/api/mobile/devices", async (_req, res) => {
  try {
    res.json(await listMobileDevices());
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/projects/:id/tools", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    res.json(await listProjectTools(analysis.rootPath));
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/tools/run", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name) {
      res.status(400).json({ error: "A tool name is required." });
      return;
    }
    const tool = await findProjectTool(analysis.rootPath, name);
    if (!tool) {
      res.status(404).json({ error: "Project tool not found." });
      return;
    }
    const result = await runProjectCommand(analysis.rootPath, tool.command, undefined, {
      timeoutMs: 180_000,
    });
    await recordProjectToolRun(analysis.rootPath, name, result.exitCode === 0).catch(() => undefined);
    res.json({ tool, result });
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.get("/api/browser-check/status", async (_req, res) => {
  res.json({ available: await isBrowserCheckAvailable() });
});

app.post("/api/projects/:id/graphics/check", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    res.json(
      await checkGraphic(
        analysis.rootPath,
        typeof req.body?.path === "string" ? req.body.path : "",
        typeof req.body?.expectText === "string" ? req.body.expectText : undefined,
      ),
    );
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/graphics", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    res.status(201).json(
      await createGraphic(analysis.rootPath, {
        path: typeof req.body?.path === "string" ? req.body.path : "",
        kind: req.body?.kind,
        title: typeof req.body?.title === "string" ? req.body.title : undefined,
        subtitle: typeof req.body?.subtitle === "string" ? req.body.subtitle : undefined,
        data: Array.isArray(req.body?.data) ? req.body.data : undefined,
        steps: Array.isArray(req.body?.steps) ? req.body.steps : undefined,
        width: Number(req.body?.width) || undefined,
        height: Number(req.body?.height) || undefined,
        colors: Array.isArray(req.body?.colors) ? req.body.colors : undefined,
        format: req.body?.format === "png" ? "png" : undefined,
      }),
    );
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/game-check", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    res.json(
      await runGameCheck(req.params.id, analysis.rootPath, {
        path: typeof req.body?.path === "string" ? req.body.path : "index.html",
        url: typeof req.body?.url === "string" ? req.body.url : undefined,
        steps: Array.isArray(req.body?.steps) ? req.body.steps : undefined,
        screenshot: req.body?.screenshot !== false,
        timeoutMs: Number(req.body?.timeoutMs) || undefined,
      }),
    );
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.get("/api/lsp/status", (_req, res) => {
  const servers = lspServersStatus();
  res.json({
    available: isLspAvailable(),
    servers,
    languages: [...new Set(servers.flatMap((server) => server.extensions))],
  });
});

app.post("/api/projects/:id/lsp/diagnostics", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    const filePath = typeof req.body?.path === "string" ? req.body.path : "";
    if (!filePath) {
      res.status(400).json({ error: "A file path is required." });
      return;
    }
    res.json(await lspDiagnostics(analysis.rootPath, filePath));
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/lsp/hover", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    const filePath = typeof req.body?.path === "string" ? req.body.path : "";
    if (!filePath) {
      res.status(400).json({ error: "A file path is required." });
      return;
    }
    res.json({
      hover: await lspHover(
        analysis.rootPath,
        filePath,
        Number(req.body?.line) || 1,
        Number(req.body?.character) || 1,
      ),
    });
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/lsp/completion", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    const filePath = typeof req.body?.path === "string" ? req.body.path : "";
    if (!filePath) {
      res.status(400).json({ error: "A file path is required." });
      return;
    }
    res.json({
      items: await lspCompletion(
        analysis.rootPath,
        filePath,
        Number(req.body?.line) || 1,
        Number(req.body?.character) || 1,
      ),
    });
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/browser-check", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    const result = await runBrowserCheck(req.params.id, analysis.rootPath, {
      path: typeof req.body?.path === "string" ? req.body.path : "index.html",
      url: typeof req.body?.url === "string" ? req.body.url : undefined,
      steps: Array.isArray(req.body?.steps) ? req.body.steps : [],
      mobile: req.body?.mobile === true,
      screenshot: req.body?.screenshot === true,
      timeoutMs: Number(req.body?.timeoutMs) || undefined,
    });
    res.json(result);
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.get("/api/projects/:id/skills", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    res.json(await listSkills(analysis.rootPath, req.params.id));
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/skills/preview", async (req, res) => {
  try {
    const source = typeof req.body?.source === "string" ? req.body.source : "";
    if (!source.trim()) {
      res.status(400).json({ error: "A skill source is required." });
      return;
    }
    res.json(await previewSkillSource(source, typeof req.body?.ref === "string" ? req.body.ref : undefined));
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/skills/install", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    const source = typeof req.body?.source === "string" ? req.body.source : "";
    const skills = Array.isArray(req.body?.skills) ? req.body.skills.filter((item: unknown): item is string => typeof item === "string") : [];
    if (!source.trim() || skills.length === 0) {
      res.status(400).json({ error: "Source and at least one skill are required." });
      return;
    }
    res.json(
      await installSkills(analysis.rootPath, req.params.id, {
        source,
        ref: typeof req.body?.ref === "string" ? req.body.ref : undefined,
        skills,
        scope: req.body?.scope === "global" ? "global" : "project",
        enable: req.body?.enable === true,
      }),
    );
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/skills/update", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    const key = typeof req.body?.key === "string" ? req.body.key : "";
    if (!key) {
      res.status(400).json({ error: "A skill key is required." });
      return;
    }
    res.json(await updateInstalledSkill(analysis.rootPath, req.params.id, key));
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/skills/remove", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    const key = typeof req.body?.key === "string" ? req.body.key : "";
    if (!key) {
      res.status(400).json({ error: "A skill key is required." });
      return;
    }
    await removeInstalledSkill(analysis.rootPath, req.params.id, key);
    res.json({ ok: true });
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.get("/api/projects/:id/skills/:key/file", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    const filePath = typeof req.query.path === "string" ? req.query.path : "";
    res.json(await readSkillFile(analysis.rootPath, req.params.id, req.params.key, filePath));
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.get("/api/projects/:id/skills/:key", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    res.json(await getSkill(analysis.rootPath, req.params.id, req.params.key));
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.patch("/api/projects/:id/skills/:key", async (req, res) => {
  try {
    if (typeof req.body?.enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be a boolean." });
      return;
    }
    const analysis = await loadAnalysis(req.params.id);
    res.json(
      await setSkillEnabled(
        analysis.rootPath,
        req.params.id,
        req.params.key,
        req.body.enabled,
      ),
    );
  } catch (error) {
    handleError(res, error, 400);
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

app.post("/api/projects/:id/ai/edit", async (req, res) => {
  try {
    const filePath = typeof req.body?.filePath === "string" ? req.body.filePath : "";
    const instruction = typeof req.body?.instruction === "string" ? req.body.instruction : "";
    if (!filePath || !instruction.trim()) {
      res.status(400).json({ error: "A file path and edit instruction are required." });
      return;
    }
    const provider = typeof req.body?.provider === "string" ? (req.body.provider as AiProviderId) : undefined;
    const result = await editSourceFile(req.params.id, filePath, instruction, {
      provider,
      model: typeof req.body?.model === "string" ? req.body.model : undefined,
      language: typeof req.body?.language === "string" ? req.body.language : undefined,
    });
    res.json(result);
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/ai/tests", async (req, res) => {
  try {
    const sourceFile = typeof req.body?.sourceFile === "string" ? req.body.sourceFile : "";
    if (!sourceFile) {
      res.status(400).json({ error: "A source file is required." });
      return;
    }
    const provider = typeof req.body?.provider === "string" ? (req.body.provider as AiProviderId) : undefined;
    const result = await generateTests(
      req.params.id,
      sourceFile,
      typeof req.body?.framework === "string" ? req.body.framework : undefined,
      typeof req.body?.instruction === "string" ? req.body.instruction : "",
      {
        provider,
        model: typeof req.body?.model === "string" ? req.body.model : undefined,
      },
    );
    res.json(result);
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/ai/task", async (req, res) => {
  try {
    const instruction = typeof req.body?.instruction === "string" ? req.body.instruction : "";
    if (!instruction.trim()) {
      res.status(400).json({ error: "A coding instruction is required." });
      return;
    }
    const provider = typeof req.body?.provider === "string" ? (req.body.provider as AiProviderId) : undefined;
    const result = await runCodingTask(req.params.id, instruction, {
      activeFile: typeof req.body?.activeFile === "string" ? req.body.activeFile : undefined,
      provider,
      model: typeof req.body?.model === "string" ? req.body.model : undefined,
    });
    res.json(result);
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/ai/agent", async (req, res) => {
  try {
    const instruction = typeof req.body?.instruction === "string" ? req.body.instruction : "";
    if (!instruction.trim()) {
      res.status(400).json({ error: "An agent instruction is required." });
      return;
    }
    const provider = typeof req.body?.provider === "string" ? (req.body.provider as AiProviderId) : undefined;
    let intent: IntentAnalysis | undefined;
    if (req.body?.mode !== "ask") {
      const analyzed = await analyzeIntent(req.params.id, instruction, {
        provider,
        model: typeof req.body?.model === "string" ? req.body.model : undefined,
        language: typeof req.body?.language === "string" ? req.body.language : undefined,
        activeFile: typeof req.body?.activeFile === "string" ? req.body.activeFile : undefined,
        clarified: req.body?.clarified === true,
      });
      if (analyzed.intent.needsClarification) {
        res.status(409).json({
          error: analyzed.intent.question,
          clarification: {
            question: analyzed.intent.question,
            options: analyzed.intent.options ?? [],
            original: instruction,
          },
        });
        return;
      }
      intent = analyzed.intent;
    }
    if (intent?.kind === "question" && intent.context === "none") {
      const result = await answerGeneralChat(req.params.id, instruction, {
        provider,
        model: typeof req.body?.model === "string" ? req.body.model : undefined,
        language: typeof req.body?.language === "string" ? req.body.language : undefined,
        history: Array.isArray(req.body?.history)
          ? req.body.history
              .filter(
                (message: unknown): message is { role: "user" | "assistant"; content: string } =>
                  typeof message === "object" &&
                  message !== null &&
                  ((message as { role?: unknown }).role === "user" ||
                    (message as { role?: unknown }).role === "assistant") &&
                  typeof (message as { content?: unknown }).content === "string",
              )
              .slice(-6)
          : undefined,
      });
      res.json(result);
      return;
    }
    const result = await runAgentTask(req.params.id, instruction, {
      activeFile: typeof req.body?.activeFile === "string" ? req.body.activeFile : undefined,
      provider,
      model: typeof req.body?.model === "string" ? req.body.model : undefined,
      allowWrite: req.body?.allowWrite === true,
      allowCommands: req.body?.allowCommands === true,
      language: typeof req.body?.language === "string" ? req.body.language : undefined,
      maxSteps: Number(req.body?.maxSteps) || undefined,
      intent,
      mode:
        req.body?.mode === "ask" ? "ask" : req.body?.mode === "auto" ? "auto" : "coding",
      workspaceMode: ["ask", "plan", "build", "research"].includes(req.body?.workspaceMode)
        ? (req.body.workspaceMode as AiWorkspaceMode)
        : undefined,
      tokenBudget: Number(req.body?.tokenBudget) || undefined,
      costBudgetUsd: Number(req.body?.costBudgetUsd) || undefined,
      interactive: false,
      history: Array.isArray(req.body?.history)
        ? req.body.history
            .filter(
              (message: unknown): message is { role: "user" | "assistant"; content: string } =>
                typeof message === "object" &&
                message !== null &&
                ((message as { role?: unknown }).role === "user" ||
                  (message as { role?: unknown }).role === "assistant") &&
                typeof (message as { content?: unknown }).content === "string",
            )
            .slice(-6)
        : undefined,
    });
    res.json(result);
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/ai/agent/stream", async (req, res) => {
  const instruction = typeof req.body?.instruction === "string" ? req.body.instruction : "";
  if (!instruction.trim()) {
    res.status(400).json({ error: "An agent instruction is required." });
    return;
  }
  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const controller = new AbortController();
  registerAgentRun(req.params.id, controller);
  res.on("error", () => undefined);
  const write = (event: unknown) => {
    if (res.writable && !res.destroyed && !res.writableEnded) {
      res.write(`${JSON.stringify(event)}\n`);
    }
  };

  let intent: IntentAnalysis | undefined;
  let intentProvider: string | undefined;
  let intentModel: string | undefined;
  const history = Array.isArray(req.body?.history)
    ? (req.body.history as unknown[])
        .filter(
          (message): message is { role: "user" | "assistant"; content: string } =>
            typeof message === "object" &&
            message !== null &&
            ((message as { role?: unknown }).role === "user" ||
              (message as { role?: unknown }).role === "assistant") &&
            typeof (message as { content?: unknown }).content === "string",
        )
        .slice(-8)
    : undefined;
  if (req.body?.mode !== "ask") {
    try {
      const analyzed = await analyzeIntent(req.params.id, instruction, {
        provider: typeof req.body?.provider === "string" ? req.body.provider : undefined,
        model: typeof req.body?.model === "string" ? req.body.model : undefined,
        language: typeof req.body?.language === "string" ? req.body.language : undefined,
        activeFile: typeof req.body?.activeFile === "string" ? req.body.activeFile : undefined,
        clarified: req.body?.clarified === true,
        history,
        signal: controller.signal,
      });
      intent = analyzed.intent;
      intentProvider = analyzed.provider;
      intentModel = analyzed.model;
      write({
        type: "intent",
        intent: analyzed.intent,
        provider: analyzed.provider,
        model: analyzed.model,
        totalTokens: analyzed.totalTokens,
      });
      if (analyzed.intent.needsClarification) {
        write({
          type: "clarify",
          request: {
            question: analyzed.intent.question,
            options: analyzed.intent.options ?? [],
            original: instruction,
          },
        });
        unregisterAgentRun(req.params.id, controller);
        res.end();
        return;
      }
    } catch (error) {
      write({
        type: "error",
        message: error instanceof Error ? error.message : "Intent analysis failed.",
      });
      unregisterAgentRun(req.params.id, controller);
      res.end();
      return;
    }
  }

  if (intent?.kind === "question" && intent.context === "none") {
    try {
      write({
        type: "start",
        provider:
          typeof req.body?.provider === "string" ? req.body.provider : intentProvider ?? "intent",
        model:
          typeof req.body?.model === "string" ? req.body.model : intentModel ?? "intent",
      });
      const result = await answerGeneralChat(req.params.id, instruction, {
        provider:
          typeof req.body?.provider === "string" ? (req.body.provider as AiProviderId) : undefined,
        model: typeof req.body?.model === "string" ? req.body.model : undefined,
        language: typeof req.body?.language === "string" ? req.body.language : undefined,
        history,
        onToken: (chunk) => write({ type: "token", text: chunk }),
      });
      write({ type: "done", result });
    } catch (error) {
      write({
        type: "error",
        message: error instanceof Error ? error.message : "Direct chat failed.",
      });
    } finally {
      unregisterAgentRun(req.params.id, controller);
      res.end();
    }
    return;
  }

  try {
    const provider = typeof req.body?.provider === "string" ? (req.body.provider as AiProviderId) : undefined;
    const result = await runAgentTask(
      req.params.id,
      instruction,
      {
        activeFile: typeof req.body?.activeFile === "string" ? req.body.activeFile : undefined,
        provider,
        model: typeof req.body?.model === "string" ? req.body.model : undefined,
        allowWrite: req.body?.allowWrite === true,
        allowCommands: req.body?.allowCommands === true,
        language: typeof req.body?.language === "string" ? req.body.language : undefined,
        maxSteps: Number(req.body?.maxSteps) || undefined,
        intent,
        mode:
          req.body?.mode === "ask" ? "ask" : req.body?.mode === "auto" ? "auto" : "coding",
        workspaceMode: ["ask", "plan", "build", "research"].includes(req.body?.workspaceMode)
          ? (req.body.workspaceMode as AiWorkspaceMode)
          : undefined,
        tokenBudget: Number(req.body?.tokenBudget) || undefined,
        costBudgetUsd: Number(req.body?.costBudgetUsd) || undefined,
        history,
      },
      write,
      controller.signal,
    );
    write({ type: "done", result });
  } catch (error) {
    write({ type: "error", message: error instanceof Error ? error.message : "Agent run failed." });
  } finally {
    unregisterAgentRun(req.params.id, controller);
    res.end();
  }
});

app.get("/api/projects/:id/plans", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    res.json({ plans: await listPlans(analysis.rootPath) });
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.get("/api/projects/:id/plans/:name", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    res.json(await readPlan(analysis.rootPath, req.params.name));
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.get("/api/projects/:id/tasks", async (req, res) => {
  try {
    res.json({ queue: await getProjectTaskQueue(req.params.id) });
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.patch("/api/projects/:id/tasks/:taskId", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    const queue = await loadQueue(analysis.rootPath, req.params.id);
    if (!queue) {
      res.status(404).json({ error: "No task queue for this project." });
      return;
    }
    if (queue.status === "running") {
      res.status(409).json({ error: "Stop the running task loop before editing the queue." });
      return;
    }
    const patch: Partial<ProjectTask> = {};
    if (typeof req.body?.title === "string" && req.body.title.trim()) {
      patch.title = req.body.title.trim().slice(0, 240);
    }
    if (typeof req.body?.detail === "string") patch.detail = req.body.detail.slice(0, 4_000);
    if (typeof req.body?.acceptance === "string") {
      patch.acceptance = req.body.acceptance.slice(0, 1_000);
    }
    if (["simple", "standard", "hard"].includes(req.body?.effort)) patch.effort = req.body.effort;
    if (["main", "fast", "planner", "reviewer"].includes(req.body?.role)) patch.role = req.body.role;
    if (["pending", "failed", "blocked"].includes(req.body?.status)) {
      patch.status = req.body.status;
      if (req.body.status === "pending") {
        patch.completedAt = undefined;
        patch.attempts = 0;
        patch.notes = req.body?.notes ?? undefined;
      }
    }
    if (Number(req.body?.tokenBudget) > 0) patch.tokenBudget = Number(req.body.tokenBudget);
    if (Number(req.body?.costBudgetUsd) > 0) patch.costBudgetUsd = Number(req.body.costBudgetUsd);
    if (Array.isArray(req.body?.dependsOn)) {
      patch.dependsOn = req.body.dependsOn
        .filter((id: unknown): id is string => typeof id === "string")
        .filter((id: string) => queue.tasks.some((task) => task.id === id));
    }
    const updated = updateTask(queue, req.params.taskId, patch);
    res.json({ queue: await saveQueue(analysis.rootPath, updated) });
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.delete("/api/projects/:id/tasks/:taskId", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    const queue = await loadQueue(analysis.rootPath, req.params.id);
    if (!queue) {
      res.status(404).json({ error: "No task queue for this project." });
      return;
    }
    if (queue.status === "running") {
      res.status(409).json({ error: "Stop the running task loop before editing the queue." });
      return;
    }
    res.json({ queue: await saveQueue(analysis.rootPath, removeTask(queue, req.params.taskId)) });
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/tasks/reorder", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    const queue = await loadQueue(analysis.rootPath, req.params.id);
    if (!queue) {
      res.status(404).json({ error: "No task queue for this project." });
      return;
    }
    if (queue.status === "running") {
      res.status(409).json({ error: "Stop the running task loop before editing the queue." });
      return;
    }
    const order = Array.isArray(req.body?.order)
      ? req.body.order.filter((id: unknown): id is string => typeof id === "string")
      : [];
    res.json({ queue: await saveQueue(analysis.rootPath, reorderTasks(queue, order)) });
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/tasks/plan", async (req, res) => {
  try {
    const goal = typeof req.body?.instruction === "string" ? req.body.instruction : "";
    if (!goal.trim()) {
      res.status(400).json({ error: "A task goal is required." });
      return;
    }
    res.json(
      await planProjectTasks(req.params.id, goal, {
        language: typeof req.body?.language === "string" ? req.body.language : undefined,
        replan: req.body?.replan === true,
      }),
    );
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/ai/loop/stream", async (req, res) => {
  const goal = typeof req.body?.instruction === "string" ? req.body.instruction : "";
  if (!goal.trim()) {
    res.status(400).json({ error: "A task goal is required." });
    return;
  }
  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const controller = new AbortController();
  registerAgentRun(req.params.id, controller);
  res.on("error", () => undefined);
  const write = (event: unknown) => {
    if (res.writable && !res.destroyed && !res.writableEnded) {
      res.write(`${JSON.stringify(event)}\n`);
    }
  };

  let intent = undefined as Awaited<ReturnType<typeof analyzeIntent>>["intent"] | undefined;
  let intentProvider: string | undefined;
  let intentModel: string | undefined;
  let intentTotalTokens: number | undefined;
  let intentTokenUsage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;
  let intentCostUsd: number | undefined;
  const history = Array.isArray(req.body?.history)
    ? (req.body.history as unknown[])
        .filter(
          (message): message is { role: "user" | "assistant"; content: string } =>
            typeof message === "object" &&
            message !== null &&
            ((message as { role?: unknown }).role === "user" ||
              (message as { role?: unknown }).role === "assistant") &&
            typeof (message as { content?: unknown }).content === "string",
        )
        .slice(-8)
    : undefined;
  const existing = await getProjectTaskQueue(req.params.id).catch(() => null);
  const resuming =
    Boolean(existing) &&
    existing!.goal.trim() === goal.trim() &&
    existing!.status !== "completed" &&
    req.body?.replan !== true;
  if (!resuming) {
    try {
      const analyzed = await analyzeIntent(req.params.id, goal, {
        provider: typeof req.body?.provider === "string" ? req.body.provider : undefined,
        model: typeof req.body?.model === "string" ? req.body.model : undefined,
        language: typeof req.body?.language === "string" ? req.body.language : undefined,
        activeFile: typeof req.body?.activeFile === "string" ? req.body.activeFile : undefined,
        clarified: req.body?.clarified === true,
        history,
      });
      intent = analyzed.intent;
      intentProvider = analyzed.provider;
      intentModel = analyzed.model;
      intentTotalTokens = analyzed.totalTokens;
      intentTokenUsage = analyzed.tokenUsage;
      intentCostUsd = analyzed.costUsd;
      write({
        type: "intent",
        intent: analyzed.intent,
        provider: analyzed.provider,
        model: analyzed.model,
        totalTokens: analyzed.totalTokens,
      });
      if (analyzed.intent.needsClarification) {
        write({
          type: "clarify",
          request: {
            question: analyzed.intent.question,
            options: analyzed.intent.options ?? [],
            original: goal,
          },
        });
        res.end();
        return;
      }
    } catch (error) {
      write({
        type: "error",
        message: error instanceof Error ? error.message : "Intent analysis failed.",
      });
      res.end();
      return;
    }
  }

  if (intent?.kind === "question" && intent.context === "none") {
    try {
      write({
        type: "start",
        provider:
          typeof req.body?.provider === "string" ? req.body.provider : intentProvider ?? "intent",
        model:
          typeof req.body?.model === "string" ? req.body.model : intentModel ?? "intent",
      });
      const result = await answerGeneralChat(req.params.id, goal, {
        provider:
          typeof req.body?.provider === "string" ? (req.body.provider as AiProviderId) : undefined,
        model: typeof req.body?.model === "string" ? req.body.model : undefined,
        language: typeof req.body?.language === "string" ? req.body.language : undefined,
        history,
        onToken: (chunk) => write({ type: "token", text: chunk }),
      });
      write({ type: "done", result });
    } catch (error) {
      write({
        type: "error",
        message: error instanceof Error ? error.message : "Direct chat failed.",
      });
    } finally {
      unregisterAgentRun(req.params.id, controller);
      res.end();
    }
    return;
  }

  try {
    await runProjectLoop(
      req.params.id,
      goal,
      {
        activeFile: typeof req.body?.activeFile === "string" ? req.body.activeFile : undefined,
        provider: typeof req.body?.provider === "string" ? (req.body.provider as AiProviderId) : undefined,
        model: typeof req.body?.model === "string" ? req.body.model : undefined,
        allowWrite: req.body?.allowWrite === true,
        allowCommands: req.body?.allowCommands === true,
        language: typeof req.body?.language === "string" ? req.body.language : undefined,
        maxTasks: Number(req.body?.maxTasks) || undefined,
        maxMinutes: Number(req.body?.maxMinutes) || undefined,
        replan: req.body?.replan === true,
        retryFailed: req.body?.retryFailed === true,
        workspaceMode: ["ask", "plan", "build", "research"].includes(req.body?.workspaceMode)
          ? (req.body.workspaceMode as AiWorkspaceMode)
          : undefined,
        tokenBudget: Number(req.body?.tokenBudget) || undefined,
        costBudgetUsd: Number(req.body?.costBudgetUsd) || undefined,
        intent,
        history,
      },
      write,
      controller.signal,
    );
  } catch (error) {
    write({ type: "error", message: error instanceof Error ? error.message : "Task loop failed." });
  } finally {
    unregisterAgentRun(req.params.id, controller);
    res.end();
  }
});

app.post("/api/projects/:id/ai/stop", (req, res) => {
  res.json({ stopped: stopAgentRuns(req.params.id) });
});

app.post("/api/projects/:id/agent/permissions/:requestId", (req, res) => {
  const decision = req.body?.decision;
  if (decision !== "once" && decision !== "always" && decision !== "deny") {
    res.status(400).json({ error: "Decision must be once, always or deny." });
    return;
  }
  const resolved = resolvePermission(req.params.id, req.params.requestId, decision);
  if (!resolved) {
    res.status(404).json({ error: "This permission request is unknown or already decided." });
    return;
  }
  res.json({ ok: true, decision });
});

app.get("/api/recent", async (_req, res) => {
  try {
    res.json({ projects: await listRecent() });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/project-templates", (_req, res) => {
  res.json({ templates: listProjectTemplates() });
});

app.post("/api/projects/scaffold", async (req, res) => {
  try {
    const parentPath = typeof req.body?.parentPath === "string" ? req.body.parentPath : "";
    const name = typeof req.body?.name === "string" ? req.body.name : "";
    const template = typeof req.body?.template === "string" ? req.body.template : "";
    if (!parentPath.trim() || !name.trim() || !template) {
      res.status(400).json({ error: "Parent folder, project name and template are required." });
      return;
    }
    const result = await scaffoldProject({
      parentPath,
      name,
      template: template as ProjectTemplateId,
    });
    res.status(201).json(result);
  } catch (error) {
    handleError(res, error, 400);
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
    startProjectIndexBuild(result.id, result);
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
    startProjectIndexBuild(result.id, result);
    res.json(result);
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/projects/:id/icon", async (req, res) => {
  try {
    const project = await getRecentProject(req.params.id);
    if (!project) {
      res.status(404).end();
      return;
    }
    const icon = await findProjectIcon(project.rootPath);
    if (!icon) {
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "private, max-age=60");
      res.setHeader("X-Project-Icon", "none");
      res.send(TRANSPARENT_PNG);
      return;
    }
    res.setHeader("Content-Type", icon.mime);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader("X-Project-Icon", icon.relativePath);
    res.send(icon.data);
  } catch {
    res.status(404).end();
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
    closeProjectTerminals(req.params.id);
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

app.get("/api/projects/:id/git/commits", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    const limit = Number(req.query.limit) || 20;
    const skip = Number(req.query.skip) || 0;
    res.json(await getCommitLog(analysis.rootPath, { limit, skip }));
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/projects/:id/git/commits/:hash", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    res.json(await getCommitDetail(analysis.rootPath, req.params.hash, analysis));
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/projects/:id/git/commits/:hash/diff", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    const file = typeof req.query.file === "string" ? req.query.file : "";
    if (!file) {
      res.status(400).json({ error: "A file path is required." });
      return;
    }
    res.json(await getCommitFileDiff(analysis.rootPath, req.params.hash, file));
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

app.get("/api/projects/:id/file", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    const file = typeof req.query.path === "string" ? req.query.path : "";
    if (!file) {
      res.status(400).json({ error: "A file path is required." });
      return;
    }
    res.json(await readSourceFile(analysis.rootPath, file));
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.put("/api/projects/:id/file", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    const file = typeof req.body?.filePath === "string" ? req.body.filePath : "";
    const content = typeof req.body?.content === "string" ? req.body.content : "";
    if (!file) {
      res.status(400).json({ error: "A file path is required." });
      return;
    }
    res.json(await writeSourceFile(req.params.id, analysis.rootPath, file, content));
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/files", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    const file = typeof req.body?.filePath === "string" ? req.body.filePath : "";
    if (!file) {
      res.status(400).json({ error: "A file path is required." });
      return;
    }
    res.status(201).json(await createSourceFile(req.params.id, analysis.rootPath, file));
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/assets", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    const filePath = typeof req.body?.filePath === "string" ? req.body.filePath : "";
    const dataBase64 = typeof req.body?.dataBase64 === "string" ? req.body.dataBase64 : "";
    if (!filePath) {
      res.status(400).json({ error: "A file path is required." });
      return;
    }
    if (!dataBase64) {
      res.status(400).json({ error: "Asset data is required." });
      return;
    }
    res.status(201).json(await writeProjectAsset(analysis.rootPath, filePath, dataBase64));
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/checks/syntax", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    const filePath = typeof req.body?.filePath === "string" ? req.body.filePath : "";
    if (!filePath) {
      res.status(400).json({ error: "A file path is required." });
      return;
    }
    res.json(await checkFileSyntax(analysis, filePath));
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.get("/api/projects/:id/checks/duplication", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    const windowLines = Number(req.query.windowLines) || 6;
    res.json(await scanDuplications(analysis, { windowLines }));
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/format", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    const filePath = typeof req.body?.filePath === "string" ? req.body.filePath : "";
    if (!filePath) {
      res.status(400).json({ error: "A file path is required." });
      return;
    }
    res.json(await formatProjectFile(req.params.id, analysis, filePath));
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/fs/rename", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    const from = typeof req.body?.path === "string" ? req.body.path : "";
    const to = typeof req.body?.newPath === "string" ? req.body.newPath : "";
    if (!from || !to) {
      res.status(400).json({ error: "Source and target paths are required." });
      return;
    }
    const result = await renameProjectPath(analysis.rootPath, from, to);
    await renameIndexedPath(req.params.id, analysis.rootPath, result.from, result.to).catch(() => {
      // index updates must not fail the rename
    });
    res.json(result);
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/fs/delete", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    const target = typeof req.body?.path === "string" ? req.body.path : "";
    if (!target) {
      res.status(400).json({ error: "A path is required." });
      return;
    }
    const result = await deleteProjectPath(analysis.rootPath, target);
    await removeIndexedPath(req.params.id, result.path).catch(() => {
      // index updates must not fail the delete
    });
    res.json(result);
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/run", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    const command = typeof req.body?.command === "string" ? req.body.command : "";
    const cwd = typeof req.body?.cwd === "string" ? req.body.cwd : undefined;
    if (!command.trim()) {
      res.status(400).json({ error: "A command is required." });
      return;
    }
    res.json(await runProjectCommand(analysis.rootPath, command, cwd));
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/run/stream", async (req, res) => {
  const command = typeof req.body?.command === "string" ? req.body.command : "";
  if (!command.trim()) {
    res.status(400).json({ error: "A command is required." });
    return;
  }
  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on("close", onClose);
  req.on("aborted", onClose);
  res.on("error", () => undefined);
  const write = (event: unknown) => {
    if (res.writable && !res.destroyed && !res.writableEnded) {
      res.write(`${JSON.stringify(event)}\n`);
    }
  };

  try {
    const analysis = await loadAnalysis(req.params.id);
    const cwd = typeof req.body?.cwd === "string" ? req.body.cwd : undefined;
    const timeoutMs = Number(req.body?.timeoutMs) || undefined;
    write({ type: "start", command: command.trim(), cwd: cwd ?? "." });
    const result = await runProjectCommand(analysis.rootPath, command, cwd, {
      signal: controller.signal,
      timeoutMs,
      onStdout: (chunk) => write({ type: "stdout", chunk }),
      onStderr: (chunk) => write({ type: "stderr", chunk }),
    });
    write({ type: "exit", result });
  } catch (error) {
    write({ type: "error", message: error instanceof Error ? error.message : "Command failed." });
  } finally {
    res.off("close", onClose);
    res.end();
  }
});

app.get("/api/projects/:id/index/status", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    res.json(await getProjectIndexStatus(req.params.id, analysis));
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/index/build", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    res.json(startProjectIndexBuild(req.params.id, analysis));
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/conversations/import", async (req, res) => {
  try {
    const raw = Array.isArray(req.body?.pairs) ? req.body.pairs : [];
    const pairs = raw
      .filter(
        (pair: unknown): pair is { question: string; answer: string; chatId?: string } =>
          typeof pair === "object" &&
          pair !== null &&
          typeof (pair as { question?: unknown }).question === "string" &&
          typeof (pair as { answer?: unknown }).answer === "string" &&
          ((pair as { chatId?: unknown }).chatId === undefined ||
            typeof (pair as { chatId?: unknown }).chatId === "string"),
      )
      .slice(0, 80);
    res.json({ imported: await importConversations(req.params.id, pairs) });
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.get("/api/projects/:id/index/search", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    const query = typeof req.query.q === "string" ? req.query.q : "";
    const limit = Number(req.query.limit) || 20;
    const conversationHits = await searchConversations(req.params.id, query, Math.min(5, limit));
    const indexHits = await searchProjectIndex(
      req.params.id,
      query,
      limit,
      analysis.rootPath,
    );
    const seen = new Set<string>();
    const results = [...conversationHits, ...indexHits].filter((hit) => {
      if (seen.has(hit.id)) return false;
      seen.add(hit.id);
      return true;
    });
    res.json({ query, results: results.slice(0, limit) });
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.get("/api/projects/:id/usage", async (req, res) => {
  try {
    res.json(await getProjectUsage(req.params.id));
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.get("/api/projects/:id/dev-commands", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    res.json({ commands: await detectDevCommands(analysis.rootPath) });
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.get("/api/projects/:id/processes", async (req, res) => {
  try {
    res.json({ jobs: listBackgroundProcesses(req.params.id) });
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/processes", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    const command = typeof req.body?.command === "string" ? req.body.command : "";
    if (!command.trim()) {
      res.status(400).json({ error: "A command is required." });
      return;
    }
    const job = await startBackgroundProcess(
      analysis.rootPath,
      req.params.id,
      command,
      typeof req.body?.cwd === "string" ? req.body.cwd : undefined,
    );
    res.json(job);
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.get("/api/projects/:id/processes/:jobId", async (req, res) => {
  try {
    const offset = Number(req.query.offset) || 0;
    res.json(readBackgroundProcess(req.params.id, req.params.jobId, offset));
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.delete("/api/projects/:id/processes/:jobId", async (req, res) => {
  try {
    res.json(stopBackgroundProcess(req.params.id, req.params.jobId));
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.delete("/api/projects/:id/processes/:jobId/remove", async (req, res) => {
  try {
    removeBackgroundProcess(req.params.id, req.params.jobId);
    res.json({ ok: true });
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.get("/api/projects/:id/terminals", async (req, res) => {
  try {
    res.json({ sessions: listTerminalSessions(req.params.id) });
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/terminals", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    const cols = Number(req.body?.cols) || undefined;
    const rows = Number(req.body?.rows) || undefined;
    res.status(201).json(await createTerminalSession(analysis.rootPath, req.params.id, { cols, rows }));
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.get("/api/projects/:id/terminals/:sessionId/stream", (req, res) => {
  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  res.on("error", () => undefined);
  const write = (event: unknown) => {
    if (res.writable && !res.destroyed && !res.writableEnded) {
      res.write(`${JSON.stringify(event)}\n`);
    }
  };
  let unsubscribe: (() => void) | null = null;
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    unsubscribe?.();
    unsubscribe = null;
    if (!res.writableEnded) res.end();
  };
  const onClose = () => {
    if (!res.writableEnded) finish();
  };
  res.on("close", onClose);
  try {
    unsubscribe = subscribeTerminal(req.params.id, req.params.sessionId, (event) => {
      write(event);
      if (event.type === "exit") {
        res.off("close", onClose);
        finish();
      }
    });
  } catch (error) {
    write({ type: "error", message: error instanceof Error ? error.message : "Terminal stream failed." });
    finish();
  }
});

app.post("/api/projects/:id/terminals/:sessionId/input", (req, res) => {
  try {
    const data = typeof req.body?.data === "string" ? req.body.data : "";
    writeTerminalInput(req.params.id, req.params.sessionId, data);
    res.json({ ok: true });
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/terminals/:sessionId/resize", (req, res) => {
  try {
    const cols = Number(req.body?.cols);
    const rows = Number(req.body?.rows);
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
      res.status(400).json({ error: "Terminal size is required." });
      return;
    }
    resizeTerminal(req.params.id, req.params.sessionId, cols, rows);
    res.json({ ok: true });
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/terminals/:sessionId/interrupt", (req, res) => {
  try {
    interruptTerminal(req.params.id, req.params.sessionId);
    res.json({ ok: true });
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.delete("/api/projects/:id/terminals/:sessionId", (req, res) => {
  try {
    res.json(closeTerminalSession(req.params.id, req.params.sessionId));
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.get("/api/projects/:id/tests", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    res.json(await discoverTests(analysis));
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.post("/api/projects/:id/tests/stream", async (req, res) => {
  const analysis = await loadAnalysis(req.params.id).catch((error: unknown) => {
    handleError(res, error, 404);
    return null;
  });
  if (!analysis) return;
  const discovery = await discoverTests(analysis);
  const requested = typeof req.body?.command === "string" ? req.body.command.trim() : "";
  const command = requested || discovery.commands[0];
  if (!command) {
    res.status(400).json({ error: "No test command was detected." });
    return;
  }
  if (!discovery.commands.includes(command)) {
    res.status(400).json({ error: "Only a detected test command can be streamed." });
    return;
  }
  const timeoutSeconds = Number(req.body?.timeoutSeconds);
  const timeoutMs = Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
    ? Math.max(30_000, Math.min(30 * 60_000, timeoutSeconds * 1_000))
    : undefined;

  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on("close", onClose);
  res.on("error", () => undefined);
  const write = (event: unknown) => {
    if (res.writable && !res.destroyed && !res.writableEnded) {
      res.write(`${JSON.stringify(event)}\n`);
    }
  };

  try {
    const result = await runTests(analysis, command, {
      signal: controller.signal,
      timeoutMs,
      onOutput: (chunk, stream) => write({ type: "output", stream, chunk }),
    });
    write({ type: "done", result });
  } catch (error) {
    write({ type: "error", message: error instanceof Error ? error.message : "Test run failed." });
  } finally {
    res.off("close", onClose);
    res.end();
  }
});

app.post("/api/projects/:id/tests/run", async (req, res) => {
  try {
    const analysis = await loadAnalysis(req.params.id);
    const command = typeof req.body?.command === "string" ? req.body.command : undefined;
    res.json(await runTests(analysis, command));
  } catch (error) {
    handleError(res, error, 400);
  }
});

app.get("/api/projects/:id/preview/*", async (req, res) => {
  const wildcard = (req.params as Record<string, string | string[]>)[0];
  const requested = typeof wildcard === "string" ? decodeURIComponent(wildcard) : "index.html";
  try {
    const analysis = await loadAnalysis(req.params.id);
    const preview = await readPreviewFile(analysis.rootPath, analysis.id, requested);
    res.setHeader("Content-Type", preview.mime);
    res.setHeader("Cache-Control", "no-cache");
    res.send(preview.data);
  } catch {
    if (/favicon\.ico$/i.test(requested)) {
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.send(TRANSPARENT_PNG);
      return;
    }
    res.status(404).end();
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

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdownLspSessions().finally(() => process.exit(0));
  });
}
