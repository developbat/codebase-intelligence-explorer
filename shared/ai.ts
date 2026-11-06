export type AiProviderId =
  | "openai"
  | "anthropic"
  | "deepseek"
  | "openrouter"
  | "gemini"
  | "nvidia"
  | "custom";

export type AiProviderKind = "openai" | "anthropic" | "gemini";

export interface AiProviderInfo {
  id: AiProviderId;
  name: string;
  kind: AiProviderKind;
  baseUrl: string;
  models: string[];
  docsUrl: string;
  keyPlaceholder: string;
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
  return AI_PROVIDERS.find((provider) => provider.id === id) ?? AI_PROVIDERS[0];
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
  baseUrl: string;
  model: string;
  hasKey: boolean;
  keyHint?: string;
}

export interface AiSettingsPublic {
  defaultProvider: AiProviderId;
  defaultModel: string;
  providers: AiProviderState[];
}

export interface AiSettingsInput {
  defaultProvider?: AiProviderId;
  defaultModel?: string;
  provider?: AiProviderId;
  apiKey?: string;
  clearKey?: boolean;
  baseUrl?: string;
  model?: string;
}

export interface AiUsage {
  inputChars: number;
  estimatedTokens: number;
  contextFiles: AiContextFile[];
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
}

export interface AiChatResult {
  answer: string;
  evidence: AiContextFile[];
  provider: string;
  model: string;
  createdAt: string;
  usage?: AiUsage;
}

export interface AiTestResult {
  ok: boolean;
  provider: AiProviderId;
  model: string;
  latencyMs: number;
  message: string;
}
