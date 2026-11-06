import type {
  AnalysisResult,
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
} from "../../shared/types";
import type {
  AiBusinessFlowsResult,
  AiChatResult,
  AiProjectSummary,
  AiScopeSummary,
  AiProviderId,
  AiReviewResult,
  AiSettingsInput,
  AiSettingsPublic,
  AiSymbolAnalysis,
  AiTestResult,
  AiUnresolvedAnalysis,
} from "../../shared/ai";

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

  ai: {
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

    models: (provider: AiProviderId) =>
      request<{ models: string[] }>(`/api/ai/models?provider=${encodeURIComponent(provider)}`),

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
  },
};

export type {
  AiBusinessFlowsResult,
  AiChatResult,
  AiProjectSummary,
  AiProviderId,
  AiReviewResult,
  AiScopeSummary,
  AiSettingsPublic,
  AiSymbolAnalysis,
  AiTestResult,
  AiUnresolvedAnalysis,
  AnalysisResult,
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
};
