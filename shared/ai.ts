import type { ClarificationRequest, IntentAnalysis } from "./intent";
import type { ProjectTaskQueue } from "./tasks";

export type BuiltInAiProviderId =
  | "openai"
  | "anthropic"
  | "deepseek"
  | "openrouter"
  | "gemini"
  | "nvidia"
  | "xai"
  | "custom";

/** Built-in ids plus user-defined `custom:<slug>` ids. */
export type AiProviderId = string;

export const CUSTOM_PROVIDER_PREFIX = "custom:";

export type AiProviderKind = "openai" | "anthropic" | "gemini";

export interface AiProviderInfo {
  id: AiProviderId;
  name: string;
  kind: AiProviderKind;
  baseUrl: string;
  models: string[];
  docsUrl: string;
  keyPlaceholder: string;
  custom?: boolean;
  modelListUrl?: string;
}

export const AI_PROVIDERS: AiProviderInfo[] = [
  {
    id: "openai",
    name: "OpenAI",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-5.1", "gpt-5-mini", "gpt-4.1", "gpt-4o"],
    docsUrl: "https://platform.openai.com/api-keys",
    keyPlaceholder: "sk-…",
  },
  {
    id: "anthropic",
    name: "Anthropic Claude",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
    models: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5", "claude-3-7-sonnet-latest"],
    docsUrl: "https://console.anthropic.com/settings/keys",
    keyPlaceholder: "sk-ant-…",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    kind: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
    docsUrl: "https://platform.deepseek.com/api_keys",
    keyPlaceholder: "sk-…",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [
      "openai/gpt-5.1",
      "anthropic/claude-sonnet-4.5",
      "google/gemini-2.5-pro",
      "deepseek/deepseek-chat",
      "qwen/qwen3-coder",
    ],
    docsUrl: "https://openrouter.ai/keys",
    keyPlaceholder: "sk-or-…",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    kind: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
    docsUrl: "https://aistudio.google.com/app/apikey",
    keyPlaceholder: "AIza…",
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    kind: "openai",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    models: [
      "meta/llama-3.3-70b-instruct",
      "qwen/qwen2.5-coder-32b-instruct",
      "nvidia/llama-3.1-nemotron-ultra-253b-v1",
    ],
    docsUrl: "https://build.nvidia.com/",
    keyPlaceholder: "nvapi-…",
  },
  {
    id: "xai",
    name: "xAI Grok",
    kind: "openai",
    baseUrl: "https://api.x.ai/v1",
    models: ["grok-4", "grok-4-fast", "grok-3", "grok-3-mini", "grok-2-vision-1212"],
    docsUrl: "https://console.x.ai/",
    keyPlaceholder: "xai-…",
  },
  {
    id: "custom",
    name: "Custom OpenAI-compatible",
    kind: "openai",
    baseUrl: "http://localhost:11434/v1",
    models: [],
    docsUrl: "",
    keyPlaceholder: "API key (optional)",
  },
];

export function providerInfo(id: AiProviderId): AiProviderInfo {
  return (
    AI_PROVIDERS.find((provider) => provider.id === id) ?? {
      id,
      name: id.startsWith(CUSTOM_PROVIDER_PREFIX) ? id.slice(CUSTOM_PROVIDER_PREFIX.length) : id,
      kind: "openai",
      baseUrl: "",
      models: [],
      docsUrl: "",
      keyPlaceholder: "API key (optional)",
      custom: true,
    }
  );
}

/** Languages the UI can request for AI answers. Keep in sync with the UI locales. */
export const AI_LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  tr: "Turkish",
  de: "German",
  fr: "French",
  es: "Spanish",
  pt: "Portuguese",
  ru: "Russian",
  zh: "Simplified Chinese",
  ja: "Japanese",
};

export function aiLanguageName(code?: string): string {
  return (code && AI_LANGUAGE_NAMES[code]) || "English";
}

export function aiLanguageInstruction(code?: string): string {
  return `Write every human-readable string value in ${aiLanguageName(code)}. Keep code identifiers, file paths, API names, JSON property names, and enum values unchanged.`;
}

export interface AiProviderState {
  id: AiProviderId;
  name: string;
  kind: AiProviderKind;
  baseUrl: string;
  model: string;
  models: string[];
  custom?: boolean;
  modelListUrl?: string;
  modelsUpdatedAt?: string;
  hasKey: boolean;
  keyHint?: string;
}

export type AiAgentRole = "main" | "planner" | "fast" | "reviewer";

export interface AiAgentRoleConfig {
  provider: AiProviderId;
  model: string;
}

export interface AiAgentRoleState extends AiAgentRoleConfig {
  role: AiAgentRole;
  providerName: string;
  models: string[];
}

export interface AiAgentAutoPick {
  role: AiAgentRole;
  provider: AiProviderId;
  model: string;
  reason: string;
}

export interface AiAgentAutoResult {
  settings: AiSettingsPublic;
  picks: AiAgentAutoPick[];
  warnings: string[];
}

export interface AiModelHealthSettings {
  protocolFailureLimit: number;
  emptyFailureLimit: number;
  penaltyPerFailure: number;
}

export interface AiModelRef {
  provider: string;
  model: string;
}

export interface AiFallbackSettings {
  /** Ordered fallback chain. Empty means use the automatic heuristic. */
  chain: AiModelRef[];
  /** Skip fallback models whose output price is above this USD / 1M tokens. */
  maxOutputPricePerMillion?: number;
  /** Skip fallback models whose input price is above this USD / 1M tokens. */
  maxInputPricePerMillion?: number;
}

export interface AiSettingsPublic {
  defaultProvider: AiProviderId;
  defaultModel: string;
  providers: AiProviderState[];
  agentRoles: AiAgentRoleState[];
  modelHealth: AiModelHealthSettings;
  autoSwitchModels: boolean;
  fallback: AiFallbackSettings;
}

export interface AiCustomProviderInput {
  id?: string;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  clearKey?: boolean;
  models?: string[];
  modelListUrl?: string;
}

export interface AiSettingsInput {
  defaultProvider?: AiProviderId;
  defaultModel?: string;
  provider?: AiProviderId;
  apiKey?: string;
  clearKey?: boolean;
  baseUrl?: string;
  model?: string;
  models?: string[];
  customProvider?: AiCustomProviderInput;
  removeProviderId?: string;
  agentRoles?: Partial<Record<AiAgentRole, AiAgentRoleConfig>>;
  modelHealth?: Partial<AiModelHealthSettings>;
  autoSwitchModels?: boolean;
  fallback?: Partial<AiFallbackSettings>;
}

export interface AiUsage {
  inputChars: number;
  estimatedTokens: number;
  contextFiles: AiContextFile[];
}

export interface AiPromptVariable {
  name: string;
  description: string;
  required: boolean;
  sample?: string;
}

export interface AiPromptVersionInfo {
  version: number;
  updatedAt: string;
  scope: "global" | "project";
}

export interface AiPromptVersionContent extends AiPromptVersionInfo {
  system: string;
}

export interface AiPromptDefinition {
  id: string;
  title: string;
  description: string;
  variables: AiPromptVariable[];
  system: string;
  defaultSystem: string;
  version: number;
  source: "default" | "global" | "project";
  updatedAt?: string;
  history: AiPromptVersionInfo[];
}

export interface AiTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AiUsageEntry {
  id: string;
  projectId: string;
  provider: string;
  model: string;
  kind: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd?: number;
  createdAt: string;
}

export interface AiUsageBucket {
  provider: string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd?: number;
}

export interface AiUsageDay {
  day: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd?: number;
}

export interface AiUsageReport {
  projectId: string;
  total: AiTokenUsage;
  today: AiTokenUsage;
  last7Days: AiTokenUsage;
  byModel: AiUsageBucket[];
  byDay: AiUsageDay[];
  recent: AiUsageEntry[];
  totalCostUsd?: number;
  todayCostUsd?: number;
  last7DaysCostUsd?: number;
  unpricedRequests?: number;
  pricingUpdatedAt?: string;
}

export interface AiContextFile {
  path: string;
  startLine?: number;
  endLine?: number;
  label?: string;
}

export interface AiSymbolAnalysis {
  symbol: string;
  purpose: string;
  businessSteps: string[];
  inputs: string[];
  outputs: string[];
  sideEffects: string[];
  risks: string[];
  uncertainties: string[];
  evidence: AiContextFile[];
  provider: string;
  model: string;
  cached: boolean;
  createdAt: string;
  usage?: AiUsage;
  tokenUsage?: AiTokenUsage;
}

export interface AiReviewFinding {
  severity: "critical" | "high" | "medium" | "low";
  file: string;
  line?: number;
  category: string;
  title: string;
  description: string;
  suggestion?: string;
}

export interface AiReviewResult {
  summary: string;
  riskLevel: "critical" | "high" | "medium" | "low";
  findings: AiReviewFinding[];
  filesReviewed: string[];
  provider: string;
  model: string;
  cached: boolean;
  createdAt: string;
  usage?: AiUsage;
  tokenUsage?: AiTokenUsage;
}

export interface AiScopeSummary {
  scope: string;
  kind: string;
  summary: string;
  responsibilities: string[];
  dependencies: string[];
  risks: string[];
  evidence: AiContextFile[];
  provider: string;
  model: string;
  cached: boolean;
  createdAt: string;
  usage?: AiUsage;
  tokenUsage?: AiTokenUsage;
}

export interface AiBusinessFlowStep {
  label: string;
  description?: string;
  file?: string;
  startLine?: number;
  endLine?: number;
  kind?: string;
}

export interface AiBusinessFlow {
  name: string;
  description: string;
  confidence: "high" | "medium" | "low";
  steps: AiBusinessFlowStep[];
  entities: string[];
  risks: string[];
}

export interface AiBusinessFlowsResult {
  flows: AiBusinessFlow[];
  provider: string;
  model: string;
  cached: boolean;
  createdAt: string;
  usage?: AiUsage;
  tokenUsage?: AiTokenUsage;
}

export interface AiProjectSummary {
  summary: string;
  architecture: string;
  keyFlows: string[];
  entryPoints: string[];
  risks: string[];
  evidence: AiContextFile[];
  provider: string;
  model: string;
  cached: boolean;
  createdAt: string;
  usage?: AiUsage;
  tokenUsage?: AiTokenUsage;
}

export type UnresolvedClassification =
  | "builtin"
  | "external-package"
  | "dynamic-dispatch"
  | "callback"
  | "string-based"
  | "missed-local"
  | "unknown";

export interface AiUnresolvedAnalysis {
  target: string;
  classification: UnresolvedClassification;
  confidence: "high" | "medium" | "low";
  explanation: string;
  recommendation: string;
  callSites: AiContextFile[];
  provider: string;
  model: string;
  cached: boolean;
  createdAt: string;
  usage?: AiUsage;
  tokenUsage?: AiTokenUsage;
}

export interface AiChatResult {
  answer: string;
  evidence: AiContextFile[];
  provider: string;
  model: string;
  createdAt: string;
  usage?: AiUsage;
  tokenUsage?: AiTokenUsage;
}

export interface AiTaskFileChange {
  path: string;
  action: "create" | "modify";
  content: string;
  originalContent?: string;
  explanation?: string;
}

export interface AiTaskResult {
  instruction: string;
  summary: string;
  changes: AiTaskFileChange[];
  provider: string;
  model: string;
  createdAt: string;
  usage?: AiUsage;
  tokenUsage?: AiTokenUsage;
}

export interface AiTestGenerationResult {
  sourceFile: string;
  testFilePath: string;
  framework?: string;
  content: string;
  explanation: string;
  provider: string;
  model: string;
  createdAt: string;
  usage?: AiUsage;
  tokenUsage?: AiTokenUsage;
}

export interface AiCodeEditResult {
  filePath: string;
  instruction: string;
  originalContent: string;
  newContent: string;
  explanation: string;
  provider: string;
  model: string;
  createdAt: string;
  usage?: AiUsage;
  tokenUsage?: AiTokenUsage;
}

export interface AiTestResult {
  ok: boolean;
  provider: AiProviderId;
  model: string;
  latencyMs: number;
  message: string;
}

export type AiAgentAction =
  | "list_files"
  | "search_code"
  | "read_file"
  | "read_symbol"
  | "find_in_file"
  | "diagnostics"
  | "lsp_hover"
  | "lsp_completion"
  | "list_items"
  | "count_matches"
  | "json_query"
  | "find_symbols"
  | "sqlite_query"
  | "csv_query"
  | "git_blame"
  | "browser_check"
  | "list_project_tools"
  | "run_project_tool"
  | "list_mobile_devices"
  | "boot_mobile_device"
  | "mobile_screenshot"
  | "open_mobile_url"
  | "mobile_logs"
  | "install_mobile_app"
  | "launch_mobile_app"
  | "mobile_check"
  | "check_toolchains"
  | "install_toolchain"
  | "game_check"
  | "list_skills"
  | "preview_skill_source"
  | "install_skill"
  | "set_skill_enabled"
  | "remove_skill"
  | "create_graphic"
  | "graphic_check"
  | "web_fetch"
  | "http_request"
  | "read_document"
  | "search_document"
  | "search_conversations"
  | "project_search"
  | "convert_document"
  | "transform_image"
  | "save_note"
  | "list_notes"
  | "read_note"
  | "search_notes"
  | "create_project_tool"
  | "create_skill"
  | "git_info"
  | "git_commit"
  | "git_create_branch"
  | "git_remote"
  | "git_push"
  | "compress_video"
  | "delegate_research"
  | "placeholder_asset"
  | "write_file"
  | "rename_path"
  | "delete_file"
  | "format_file"
  | "replace_in_file"
  | "replace_many"
  | "append_text"
  | "run_command"
  | "finish";

export interface AiAgentLogEntry {
  id: string;
  at: string;
  level: "info" | "tool" | "model" | "success" | "warn" | "error";
  label: string;
  detail?: string;
  step?: number;
}

export interface AiAgentStep {
  index: number;
  action: AiAgentAction | "invalid";
  args: Record<string, unknown>;
  observation: string;
  ok: boolean;
  durationMs: number;
  tokenUsage?: AiTokenUsage;
  trace?: AiAgentLogEntry[];
}

export interface AiAgentResult {
  instruction: string;
  summary: string;
  steps: AiAgentStep[];
  changedFiles: string[];
  ranCommands: string[];
  stoppedReason: "finished" | "max_steps" | "error" | "aborted" | "budget";
  error?: string;
  provider: string;
  model: string;
  createdAt: string;
  usage?: AiUsage;
  tokenUsage?: AiTokenUsage;
  costUsd?: number;
  plan?: AiAgentPlan;
  /** Markdown plan artifact saved under .cie/agent/plans. */
  planPath?: string;
  logs?: AiAgentLogEntry[];
  taskQueue?: ProjectTaskQueue;
}

export type AiPermissionKind = "write" | "command";

export type AiPermissionDecision = "once" | "always" | "deny";

export type AiAgentIntent = "question" | "explain" | "edit" | "multi_file" | "run" | "scaffold";

/** User-selected workspace mode inside Code Studio. */
export type AiWorkspaceMode = "ask" | "plan" | "build" | "research";

export interface AiPlanSummary {
  name: string;
  path: string;
  title: string;
  createdAt: string;
  bytes: number;
}

export interface AiAgentPlanStep {
  label: string;
  detail?: string;
}

export interface AiAgentPlan {
  intent: AiAgentIntent;
  summary: string;
  needsWrite: boolean;
  needsCommand: boolean;
  risk: "low" | "medium" | "high";
  scope: string[];
  verification?: string;
  steps: AiAgentPlanStep[];
}

export interface AiAgentPermissionRequest {
  requestId: string;
  runId: string;
  kind: AiPermissionKind;
  tool: string;
  target?: string;
  detail?: string;
  preview?: string;
  destructive: boolean;
  canAlways: boolean;
  createdAt: string;
}

export interface AiAgentPermissionResult {
  ok: boolean;
  decision: AiPermissionDecision;
}

export type AiAgentEvent =
  | { type: "start"; provider: string; model: string }
  | { type: "log"; entry: AiAgentLogEntry }
  | { type: "step"; step: AiAgentStep }
  | { type: "plan"; plan: AiAgentPlan }
  | { type: "task"; queue: ProjectTaskQueue; task?: ProjectTaskQueue["tasks"][number] }
  | { type: "permission"; request: AiAgentPermissionRequest }
  | { type: "intent"; intent: IntentAnalysis; provider: string; model: string; totalTokens: number }
  | { type: "clarify"; request: ClarificationRequest }
  | {
      type: "model";
      from: { provider: string; model: string };
      to: { provider: string; model: string };
      reason: string;
    }
  | { type: "token"; text: string }
  | { type: "done"; result: AiAgentResult }
  | { type: "error"; message: string };
