import type {
  AnalysisResult,
  BackgroundJob,
  BackgroundJobRead,
  DevCommandSuggestion,
  ChangeReport,
  CodeSearchResponse,
  FolderListing,
  GitCommitDetail,
  GitCommitHistory,
  GitDiffResult,
  GitStatus,
  GraphNodeKind,
  PathChangeResult,
  ProjectIndexHit,
  ProjectIndexStatus,
  ProjectTemplate,
  RecentProject,
  RunCommandResult,
  RunStreamEvent,
  ScaffoldProjectRequest,
  ScaffoldProjectResult,
  SourceFileContent,
  SourceResponse,
  TerminalSessionInfo,
  TerminalStreamEvent,
  TestDiscovery,
  TestRunResult,
  TestStreamEvent,
} from "../../shared/types";
import type {
  AiAgentEvent,
  AiAgentResult,
  AiBusinessFlowsResult,
  AiChatResult,
  AiProjectSummary,
  AiScopeSummary,
  AiPromptDefinition,
  AiPromptVersionContent,
  AiAgentAutoResult,
  AiPlanSummary,
  AiProviderId,
  AiReviewResult,
  AiSettingsInput,
  AiSettingsPublic,
  AiSymbolAnalysis,
  AiTestGenerationResult,
  AiUsageReport,
  AiTestResult,
  AiUnresolvedAnalysis,
} from "../../shared/ai";
import type { ProjectTaskQueue } from "../../shared/tasks";
import type {
  CatalogImportResult,
  ModelCatalog,
} from "../../shared/catalog";
import type {
  BrowserCheckOptions,
  BrowserCheckResult,
} from "../../shared/browserCheck";
import type { GameCheckOptions, GameCheckResult } from "../../shared/gameCheck";
import type {
  GraphicCheckResult,
  GraphicRequest,
  GraphicResult,
} from "../../shared/graphics";
import type { ModelHealth } from "../../shared/modelHealth";
import type {
  MobileBootResult,
  MobileCheckOptions,
  MobileCheckResult,
  MobileDeviceReport,
  MobileInstallResult,
  MobileLaunchResult,
  MobileLogsResult,
  MobileOpenUrlResult,
  MobileScreenshotResult,
} from "../../shared/mobileDevices";
import type {
  PlaceholderAssetRequest,
  PlaceholderAssetResult,
} from "../../shared/assetPlaceholder";
import type { ProjectTool, ProjectToolList } from "../../shared/projectTools";
import type { PricingReport } from "../../shared/pricing";
import type {
  ToolchainInstallResult,
  ToolchainReport,
} from "../../shared/toolchains";
import type {
  SkillDetail,
  SkillFileResponse,
  SkillInstallRequest,
  SkillInstallResult,
  SkillListResponse,
  SkillRecord,
  SkillSourcePreview,
} from "../../shared/skills";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // keep generic message
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export const api = {
  analyze: (projectPath: string) =>
    request<AnalysisResult>("/api/analyze", {
      method: "POST",
      body: JSON.stringify({ path: projectPath }),
    }),

  projectTemplates: () => request<{ templates: ProjectTemplate[] }>("/api/project-templates"),

  scaffoldProject: (input: ScaffoldProjectRequest) =>
    request<ScaffoldProjectResult>("/api/projects/scaffold", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  recent: () => request<{ projects: RecentProject[] }>("/api/recent"),

  project: (id: string) => request<AnalysisResult>(`/api/projects/${id}`),

  projectIconUrl: (id: string, version?: string) => {
    const query = version ? `?v=${encodeURIComponent(version)}` : "";
    return `/api/projects/${id}/icon${query}`;
  },

  rescan: (id: string) => request<AnalysisResult>(`/api/projects/${id}/rescan`, { method: "POST" }),

  source: (id: string, file: string, start?: number, end?: number) => {
    const params = new URLSearchParams({ file });
    if (start) params.set("start", String(start));
    if (end) params.set("end", String(end));
    return request<SourceResponse>(`/api/projects/${id}/source?${params.toString()}`);
  },

  fileContent: (id: string, filePath: string) => {
    const params = new URLSearchParams({ path: filePath });
    return request<SourceFileContent>(`/api/projects/${id}/file?${params.toString()}`);
  },

  writeFile: (id: string, filePath: string, content: string) =>
    request<{ filePath: string; bytes: number; backupPath?: string }>(`/api/projects/${id}/file`, {
      method: "PUT",
      body: JSON.stringify({ filePath, content }),
    }),

  createFile: (id: string, filePath: string) =>
    request<SourceFileContent>(`/api/projects/${id}/files`, {
      method: "POST",
      body: JSON.stringify({ filePath }),
    }),

  uploadAsset: (id: string, filePath: string, dataBase64: string) =>
    request<{ filePath: string; bytes: number }>(`/api/projects/${id}/assets`, {
      method: "POST",
      body: JSON.stringify({ filePath, dataBase64 }),
    }),

  checkSyntax: (id: string, filePath: string) =>
    request<{
      filePath: string;
      supported: boolean;
      command?: string;
      ok: boolean;
      exitCode: number | null;
      output: string;
    }>(`/api/projects/${id}/checks/syntax`, {
      method: "POST",
      body: JSON.stringify({ filePath }),
    }),

  scanDuplications: (id: string, windowLines = 6) =>
    request<{
      filesScanned: number;
      windowLines: number;
      blocks: {
        hash: string;
        lines: number;
        sample: string;
        occurrences: { path: string; startLine: number; endLine: number }[];
      }[];
      duplicatedLines: number;
      generatedAt: string;
    }>(`/api/projects/${id}/checks/duplication?windowLines=${windowLines}`),

  formatFile: (id: string, filePath: string) =>
    request<{
      filePath: string;
      command?: string;
      exitCode: number | null;
      stdout: string;
      stderr: string;
      content: string;
      formatted: boolean;
    }>(`/api/projects/${id}/format`, {
      method: "POST",
      body: JSON.stringify({ filePath }),
    }),

  renamePath: (id: string, from: string, to: string) =>
    request<PathChangeResult>(`/api/projects/${id}/fs/rename`, {
      method: "POST",
      body: JSON.stringify({ path: from, newPath: to }),
    }),

  deletePath: (id: string, pathToDelete: string) =>
    request<{ path: string; kind: "file" | "directory" }>(`/api/projects/${id}/fs/delete`, {
      method: "POST",
      body: JSON.stringify({ path: pathToDelete }),
    }),

  runCommand: (id: string, command: string, cwd?: string) =>
    request<RunCommandResult>(`/api/projects/${id}/run`, {
      method: "POST",
      body: JSON.stringify({ command, cwd }),
    }),

  runCommandStream: async (
    id: string,
    command: string,
    options: { cwd?: string; timeoutMs?: number },
    onEvent: (event: RunStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> => {
    const response = await fetch(`/api/projects/${id}/run/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, ...options }),
      signal,
    });
    if (!response.ok || !response.body) {
      const message = await response
        .json()
        .then((value: { error?: string }) => value.error)
        .catch(() => null);
      throw new Error(message ?? `Command request failed with status ${response.status}.`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.trim()) onEvent(JSON.parse(line) as RunStreamEvent);
          newline = buffer.indexOf("\n");
        }
      }
      if (buffer.trim()) onEvent(JSON.parse(buffer) as RunStreamEvent);
    } finally {
      reader.releaseLock();
    }
  },

  tests: (id: string) => request<TestDiscovery>(`/api/projects/${id}/tests`),

  usage: (id: string) => request<AiUsageReport>(`/api/projects/${id}/usage`),

  indexStatus: (id: string) =>
    request<ProjectIndexStatus>(`/api/projects/${id}/index/status`),

  buildIndex: (id: string) =>
    request<ProjectIndexStatus>(`/api/projects/${id}/index/build`, { method: "POST" }),

  importConversations: (
    id: string,
    pairs: { question: string; answer: string; chatId?: string }[],
  ) =>
    request<{ imported: number }>(`/api/projects/${id}/conversations/import`, {
      method: "POST",
      body: JSON.stringify({ pairs }),
    }),

  searchIndex: (id: string, query: string, limit = 20) =>
    request<{ query: string; results: ProjectIndexHit[] }>(
      `/api/projects/${id}/index/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    ),

  processes: {
    devCommands: (id: string) =>
      request<{ commands: DevCommandSuggestion[] }>(`/api/projects/${id}/dev-commands`),
    list: (id: string) =>
      request<{ jobs: BackgroundJob[] }>(`/api/projects/${id}/processes`),
    start: (id: string, command: string, cwd?: string) =>
      request<BackgroundJob>(`/api/projects/${id}/processes`, {
        method: "POST",
        body: JSON.stringify({ command, cwd }),
      }),
    read: (id: string, jobId: string, offset = 0) =>
      request<BackgroundJobRead>(
        `/api/projects/${id}/processes/${encodeURIComponent(jobId)}?offset=${offset}`,
      ),
    stop: (id: string, jobId: string) =>
      request<BackgroundJob>(
        `/api/projects/${id}/processes/${encodeURIComponent(jobId)}`,
        { method: "DELETE" },
      ),
    remove: (id: string, jobId: string) =>
      request<{ ok: boolean }>(
        `/api/projects/${id}/processes/${encodeURIComponent(jobId)}/remove`,
        { method: "DELETE" },
      ),
  },

  skills: {
    list: (id: string) => request<SkillListResponse>(`/api/projects/${id}/skills`),

    previewSource: (id: string, source: string, ref?: string) =>
      request<SkillSourcePreview>(`/api/projects/${id}/skills/preview`, {
        method: "POST",
        body: JSON.stringify({ source, ref }),
      }),

    install: (id: string, input: SkillInstallRequest) =>
      request<SkillInstallResult>(`/api/projects/${id}/skills/install`, {
        method: "POST",
        body: JSON.stringify(input),
      }),

    update: (id: string, key: string) =>
      request<{ key: string; name: string; directory: string; scope: string; source: string; ref: string; hash: string; enabled: boolean }>(
        `/api/projects/${id}/skills/update`,
        {
          method: "POST",
          body: JSON.stringify({ key }),
        },
      ),

    remove: (id: string, key: string) =>
      request<{ ok: boolean }>(`/api/projects/${id}/skills/remove`, {
        method: "POST",
        body: JSON.stringify({ key }),
      }),

    get: (id: string, key: string) =>
      request<SkillDetail>(`/api/projects/${id}/skills/${encodeURIComponent(key)}`),

    setEnabled: (id: string, key: string, enabled: boolean) =>
      request<SkillRecord>(`/api/projects/${id}/skills/${encodeURIComponent(key)}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      }),

    readFile: (id: string, key: string, filePath: string) =>
      request<SkillFileResponse>(
        `/api/projects/${id}/skills/${encodeURIComponent(key)}/file?path=${encodeURIComponent(filePath)}`,
      ),
  },

  runTests: (id: string, command?: string) =>
    request<TestRunResult>(`/api/projects/${id}/tests/run`, {
      method: "POST",
      body: JSON.stringify({ command }),
    }),

  terminals: {
    list: (id: string) =>
      request<{ sessions: TerminalSessionInfo[] }>(`/api/projects/${id}/terminals`),

    create: (id: string, size?: { cols?: number; rows?: number }) =>
      request<TerminalSessionInfo>(`/api/projects/${id}/terminals`, {
        method: "POST",
        body: JSON.stringify(size ?? {}),
      }),

    resize: (id: string, sessionId: string, cols: number, rows: number) =>
      request<{ ok: boolean }>(`/api/projects/${id}/terminals/${sessionId}/resize`, {
        method: "POST",
        body: JSON.stringify({ cols, rows }),
      }),

    input: (id: string, sessionId: string, data: string) =>
      request<{ ok: boolean }>(`/api/projects/${id}/terminals/${sessionId}/input`, {
        method: "POST",
        body: JSON.stringify({ data }),
      }),

    interrupt: (id: string, sessionId: string) =>
      request<{ ok: boolean }>(`/api/projects/${id}/terminals/${sessionId}/interrupt`, {
        method: "POST",
        body: JSON.stringify({}),
      }),

    close: (id: string, sessionId: string) =>
      request<TerminalSessionInfo>(`/api/projects/${id}/terminals/${sessionId}`, {
        method: "DELETE",
      }),

    stream: async (
      id: string,
      sessionId: string,
      onEvent: (event: TerminalStreamEvent) => void,
      signal?: AbortSignal,
    ): Promise<void> => {
      const response = await fetch(`/api/projects/${id}/terminals/${sessionId}/stream`, {
        method: "GET",
        signal,
      });
      if (!response.ok || !response.body) {
        const message = await response
          .json()
          .then((value: { error?: string }) => value.error)
          .catch(() => null);
        throw new Error(message ?? `Terminal stream failed with status ${response.status}.`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (line.trim()) onEvent(JSON.parse(line) as TerminalStreamEvent);
            newline = buffer.indexOf("\n");
          }
        }
        if (buffer.trim()) onEvent(JSON.parse(buffer) as TerminalStreamEvent);
      } finally {
        reader.releaseLock();
      }
    },
  },

  runTestsStream: async (
    id: string,
    command: string,
    options: { timeoutSeconds?: number },
    onEvent: (event: TestStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> => {
    const response = await fetch(`/api/projects/${id}/tests/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, ...options }),
      signal,
    });
    if (!response.ok || !response.body) {
      const message = await response
        .json()
        .then((value: { error?: string }) => value.error)
        .catch(() => null);
      throw new Error(message ?? `Test request failed with status ${response.status}.`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.trim()) onEvent(JSON.parse(line) as TestStreamEvent);
          newline = buffer.indexOf("\n");
        }
      }
      if (buffer.trim()) onEvent(JSON.parse(buffer) as TestStreamEvent);
    } finally {
      reader.releaseLock();
    }
  },

  remove: (id: string) => request<{ ok: boolean }>(`/api/projects/${id}`, { method: "DELETE" }),

  gitStatus: (id: string) => request<GitStatus>(`/api/projects/${id}/git`),

  gitDiff: (id: string, file: string, base?: string) => {
    const params = new URLSearchParams({ file });
    if (base) params.set("base", base);
    return request<GitDiffResult>(`/api/projects/${id}/git/diff?${params.toString()}`);
  },

  gitCommits: (id: string, limit = 20, skip = 0) => {
    const params = new URLSearchParams({ limit: String(limit), skip: String(skip) });
    return request<GitCommitHistory>(`/api/projects/${id}/git/commits?${params.toString()}`);
  },

  gitCommit: (id: string, hash: string) =>
    request<GitCommitDetail>(`/api/projects/${id}/git/commits/${encodeURIComponent(hash)}`),

  gitCommitDiff: (id: string, hash: string, file: string) => {
    const params = new URLSearchParams({ file });
    return request<GitDiffResult>(
      `/api/projects/${id}/git/commits/${encodeURIComponent(hash)}/diff?${params.toString()}`,
    );
  },

  changes: (id: string) =>
    request<{ report: ChangeReport; analysis: AnalysisResult }>(`/api/projects/${id}/changes`, {
      method: "POST",
    }),

  search: (projectId: string, query: string, limit = 20) =>
    request<CodeSearchResponse>(`/api/projects/${projectId}/search`, {
      method: "POST",
      body: JSON.stringify({ query, limit }),
    }),

  fs: {
    list: (folderPath?: string) => {
      const params = new URLSearchParams();
      if (folderPath) params.set("path", folderPath);
      return request<FolderListing>(`/api/fs/list?${params.toString()}`);
    },
  },

  mobileDevices: () => request<MobileDeviceReport>("/api/mobile/devices"),

  toolchains: (refresh = false) =>
    request<ToolchainReport>(`/api/toolchains${refresh ? "?refresh=1" : ""}`),

  installToolchain: (id: string) =>
    request<ToolchainInstallResult>("/api/toolchains/install", {
      method: "POST",
      body: JSON.stringify({ id }),
    }),

  mobileBoot: (projectId: string, platform: "ios" | "android", id: string) =>
    request<MobileBootResult>(`/api/projects/${projectId}/mobile/devices/boot`, {
      method: "POST",
      body: JSON.stringify({ platform, id }),
    }),

  mobileScreenshot: (projectId: string, platform: "ios" | "android", id: string) =>
    request<MobileScreenshotResult>(`/api/projects/${projectId}/mobile/devices/screenshot`, {
      method: "POST",
      body: JSON.stringify({ platform, id }),
    }),

  mobileOpenUrl: (projectId: string, platform: "ios" | "android", id: string, url: string) =>
    request<MobileOpenUrlResult>(`/api/projects/${projectId}/mobile/devices/open-url`, {
      method: "POST",
      body: JSON.stringify({ platform, id, url }),
    }),

  mobileLogs: (projectId: string, platform: "ios" | "android", id: string, limit = 200) =>
    request<MobileLogsResult>(`/api/projects/${projectId}/mobile/devices/logs`, {
      method: "POST",
      body: JSON.stringify({ platform, id, limit }),
    }),

  mobileCheck: (projectId: string, options: MobileCheckOptions) =>
    request<MobileCheckResult>(`/api/projects/${projectId}/mobile/check`, {
      method: "POST",
      body: JSON.stringify(options),
    }),

  mobileInstall: (projectId: string, platform: "ios" | "android", id: string, pathValue: string) =>
    request<MobileInstallResult>(`/api/projects/${projectId}/mobile/devices/install`, {
      method: "POST",
      body: JSON.stringify({ platform, id, path: pathValue }),
    }),

  mobileLaunch: (projectId: string, platform: "ios" | "android", id: string, target: string) =>
    request<MobileLaunchResult>(`/api/projects/${projectId}/mobile/devices/launch`, {
      method: "POST",
      body: JSON.stringify({ platform, id, target }),
    }),

  placeholderAsset: (projectId: string, input: PlaceholderAssetRequest) =>
    request<PlaceholderAssetResult>(`/api/projects/${projectId}/assets/placeholder`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  projectTools: (projectId: string) =>
    request<ProjectToolList>(`/api/projects/${projectId}/tools`),

  runProjectTool: (projectId: string, name: string) =>
    request<{ tool: ProjectTool; result: RunCommandResult }>(
      `/api/projects/${projectId}/tools/run`,
      {
        method: "POST",
        body: JSON.stringify({ name }),
      },
    ),

  checkGraphic: (projectId: string, pathValue: string, expectText?: string) =>
    request<GraphicCheckResult>(`/api/projects/${projectId}/graphics/check`, {
      method: "POST",
      body: JSON.stringify({ path: pathValue, expectText }),
    }),

  createGraphic: (projectId: string, input: GraphicRequest) =>
    request<GraphicResult>(`/api/projects/${projectId}/graphics`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  gameCheck: (projectId: string, options: GameCheckOptions = {}) =>
    request<GameCheckResult>(`/api/projects/${projectId}/game-check`, {
      method: "POST",
      body: JSON.stringify(options),
    }),

  browserCheck: (projectId: string, options: BrowserCheckOptions = {}) =>
    request<BrowserCheckResult>(`/api/projects/${projectId}/browser-check`, {
      method: "POST",
      body: JSON.stringify(options),
    }),

  browserCheckStatus: () =>
    request<{ available: boolean }>("/api/browser-check/status"),

  tasks: {
    get: (projectId: string) =>
      request<{ queue: ProjectTaskQueue | null }>(`/api/projects/${projectId}/tasks`),
    plan: (projectId: string, instruction: string, language?: string, replan = false) =>
      request<ProjectTaskQueue>(`/api/projects/${projectId}/tasks/plan`, {
        method: "POST",
        body: JSON.stringify({ instruction, language, replan }),
      }),
    loopStream: async (
      projectId: string,
      instruction: string,
      options: {
        activeFile?: string;
        provider?: AiProviderId;
        model?: string;
        allowWrite?: boolean;
        allowCommands?: boolean;
        language?: string;
        maxTasks?: number;
        maxMinutes?: number;
        replan?: boolean;
        retryFailed?: boolean;
        clarified?: boolean;
        workspaceMode?: "ask" | "plan" | "build" | "research";
        history?: { role: "user" | "assistant"; content: string }[];
      },
      onEvent: (event: AiAgentEvent) => void,
      signal?: AbortSignal,
    ): Promise<void> => {
      const response = await fetch(`/api/projects/${projectId}/ai/loop/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction, ...options }),
        signal,
      });
      if (!response.ok || !response.body) {
        const message = await response
          .json()
          .then((value: { error?: string }) => value.error)
          .catch(() => null);
        throw new Error(message ?? `Task loop failed with status ${response.status}.`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (line.trim()) onEvent(JSON.parse(line) as AiAgentEvent);
            newline = buffer.indexOf("\n");
          }
        }
        if (buffer.trim()) onEvent(JSON.parse(buffer) as AiAgentEvent);
      } finally {
        reader.releaseLock();
      }
    },
  },

  plans: {
    list: (projectId: string) =>
      request<{ plans: AiPlanSummary[] }>(`/api/projects/${projectId}/plans`),
    get: (projectId: string, name: string) =>
      request<{ path: string; content: string }>(
        `/api/projects/${projectId}/plans/${encodeURIComponent(name)}`,
      ),
  },

  ai: {
    stop: (projectId: string) =>
      request<{ stopped: number }>(`/api/projects/${projectId}/ai/stop`, {
        method: "POST",
      }),

    autoConfigureAgents: () =>
      request<AiAgentAutoResult>("/api/ai/agents/auto", {
        method: "POST",
        body: JSON.stringify({}),
      }),

    catalog: () => request<{ catalog: ModelCatalog | null }>("/api/ai/catalog"),

    modelHealth: () => request<{ models: ModelHealth[] }>("/api/ai/model-health"),

    pricing: () => request<PricingReport>("/api/ai/pricing"),

    refreshPricing: () =>
      request<PricingReport>("/api/ai/pricing/refresh", {
        method: "POST",
      }),

    importCatalog: (input: { json?: string; url?: string; replace?: boolean }) =>
      request<CatalogImportResult>("/api/ai/catalog/import", {
        method: "POST",
        body: JSON.stringify(input),
      }),

    clearCatalog: () => request<{ ok: boolean }>("/api/ai/catalog", { method: "DELETE" }),

    settings: () => request<AiSettingsPublic>("/api/ai/settings"),

    updateSettings: (input: AiSettingsInput) =>
      request<AiSettingsPublic>("/api/ai/settings", {
        method: "PUT",
        body: JSON.stringify(input),
      }),

    test: (provider?: AiProviderId, model?: string) =>
      request<AiTestResult>("/api/ai/test", {
        method: "POST",
        body: JSON.stringify({ provider, model }),
      }),

    prompts: (projectId?: string) =>
      request<{ prompts: AiPromptDefinition[] }>(
        `/api/prompts${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
      ),

    promptVersionContent: (
      id: string,
      version: number,
      scope: "global" | "project",
      projectId?: string,
    ) => {
      const params = new URLSearchParams({ scope });
      if (projectId) params.set("projectId", projectId);
      return request<AiPromptVersionContent>(
        `/api/prompts/${encodeURIComponent(id)}/versions/${version}?${params.toString()}`,
      );
    },

    savePrompt: (id: string, system: string, projectId?: string) =>
      request<AiPromptDefinition>(`/api/prompts/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify({ system, projectId }),
      }),

    resetPrompt: (id: string, projectId?: string) =>
      request<AiPromptDefinition>(
        `/api/prompts/${encodeURIComponent(id)}${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
        { method: "DELETE" },
      ),

    previewPrompt: (
      id: string,
      projectId?: string,
      variables?: Record<string, string>,
    ) =>
      request<AiPromptDefinition & { preview: string }>(
        `/api/prompts/${encodeURIComponent(id)}/preview`,
        {
          method: "POST",
          body: JSON.stringify({ projectId, variables }),
        },
      ),

    models: (provider: AiProviderId, refresh = false) =>
      request<{ models: string[] }>(
        `/api/ai/models?provider=${encodeURIComponent(provider)}${refresh ? "&refresh=1" : ""}`,
      ),

    symbol: (
      projectId: string,
      symbolId: string,
      provider?: AiProviderId,
      model?: string,
      force?: boolean,
      language?: string,
    ) =>
      request<AiSymbolAnalysis>(`/api/projects/${projectId}/ai/symbol`, {
        method: "POST",
        body: JSON.stringify({ symbolId, provider, model, force, language }),
      }),

    scope: (
      projectId: string,
      nodeId: string,
      provider?: AiProviderId,
      model?: string,
      force?: boolean,
      language?: string,
    ) =>
      request<AiScopeSummary>(`/api/projects/${projectId}/ai/scope`, {
        method: "POST",
        body: JSON.stringify({ nodeId, provider, model, force, language }),
      }),

    flows: (projectId: string, provider?: AiProviderId, model?: string, force?: boolean, language?: string) =>
      request<AiBusinessFlowsResult>(`/api/projects/${projectId}/ai/flows`, {
        method: "POST",
        body: JSON.stringify({ provider, model, force, language }),
      }),

    summary: (projectId: string, provider?: AiProviderId, model?: string, force?: boolean, language?: string) =>
      request<AiProjectSummary>(`/api/projects/${projectId}/ai/summary`, {
        method: "POST",
        body: JSON.stringify({ provider, model, force, language }),
      }),

    unresolved: (
      projectId: string,
      nodeId: string,
      provider?: AiProviderId,
      model?: string,
      force?: boolean,
      language?: string,
    ) =>
      request<AiUnresolvedAnalysis>(`/api/projects/${projectId}/ai/unresolved`, {
        method: "POST",
        body: JSON.stringify({ nodeId, provider, model, force, language }),
      }),

    review: (
      projectId: string,
      provider?: AiProviderId,
      model?: string,
      force?: boolean,
      files?: string[],
      base?: string,
      language?: string,
    ) =>
      request<AiReviewResult>(`/api/projects/${projectId}/ai/review`, {
        method: "POST",
        body: JSON.stringify({ provider, model, force, files, base, language }),
      }),

    chat: (
      projectId: string,
      question: string,
      history: { role: "user" | "assistant"; content: string }[],
      provider?: AiProviderId,
      model?: string,
      language?: string,
    ) =>
      request<AiChatResult>(`/api/projects/${projectId}/ai/chat`, {
        method: "POST",
        body: JSON.stringify({ question, history, provider, model, language }),
      }),

    generateTests: (
      projectId: string,
      sourceFile: string,
      framework?: string,
      instruction?: string,
      provider?: AiProviderId,
      model?: string,
    ) =>
      request<AiTestGenerationResult>(`/api/projects/${projectId}/ai/tests`, {
        method: "POST",
        body: JSON.stringify({ sourceFile, framework, instruction, provider, model }),
      }),

    resolvePermission: (
      projectId: string,
      requestId: string,
      decision: "once" | "always" | "deny",
    ) =>
      request<{ ok: boolean; decision: string }>(
        `/api/projects/${projectId}/agent/permissions/${encodeURIComponent(requestId)}`,
        {
          method: "POST",
          body: JSON.stringify({ decision }),
        },
      ),

    agent: (
      projectId: string,
      instruction: string,
      options: {
        activeFile?: string;
        provider?: AiProviderId;
        model?: string;
        allowWrite?: boolean;
        allowCommands?: boolean;
        language?: string;
        maxSteps?: number;
        mode?: "ask" | "coding" | "auto";
        history?: { role: "user" | "assistant"; content: string }[];
      } = {},
    ) =>
      request<AiAgentResult>(`/api/projects/${projectId}/ai/agent`, {
        method: "POST",
        body: JSON.stringify({ instruction, ...options }),
      }),

    agentStream: async (
      projectId: string,
      instruction: string,
      options: {
        activeFile?: string;
        provider?: AiProviderId;
        model?: string;
        allowWrite?: boolean;
        allowCommands?: boolean;
        language?: string;
        maxSteps?: number;
        mode?: "ask" | "coding" | "auto";
        workspaceMode?: "ask" | "plan" | "build" | "research";
        history?: { role: "user" | "assistant"; content: string }[];
        clarified?: boolean;
      },
      onEvent: (event: AiAgentEvent) => void,
      signal?: AbortSignal,
    ): Promise<void> => {
      const response = await fetch(`/api/projects/${projectId}/ai/agent/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction, ...options }),
        signal,
      });
      if (!response.ok || !response.body) {
        const message = await response
          .json()
          .then((value: { error?: string }) => value.error)
          .catch(() => null);
        throw new Error(message ?? `Agent request failed with status ${response.status}.`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (line.trim()) onEvent(JSON.parse(line) as AiAgentEvent);
            newline = buffer.indexOf("\n");
          }
        }
        if (buffer.trim()) onEvent(JSON.parse(buffer) as AiAgentEvent);
      } finally {
        reader.releaseLock();
      }
    },
  },
};

export type {
  AiAgentResult,
  AiBusinessFlowsResult,
  AiChatResult,
  AiProjectSummary,
  AiProviderId,
  AiReviewResult,
  AiScopeSummary,
  AiSettingsPublic,
  AiSymbolAnalysis,
  AiTestGenerationResult,
  AiTestResult,
  AiUsageReport,
  AiUnresolvedAnalysis,
  AnalysisResult,
  BackgroundJob,
  BackgroundJobRead,
  ChangeReport,
  CodeSearchResponse,
  FolderListing,
  GitCommitDetail,
  GitCommitHistory,
  GitDiffResult,
  GitStatus,
  GraphNodeKind,
  RecentProject,
  SourceResponse,
  TestDiscovery,
  TestRunResult,
};
