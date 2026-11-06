import type { AiProviderId, AiTestResult } from "../../../shared/ai";
import { providerInfo } from "../../../shared/ai";
import { resolveProvider, type ResolvedProvider } from "./settings";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

async function request(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  providerName: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let message = text.slice(0, 600) || response.statusText;
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
        if (typeof parsed.error === "string") message = parsed.error;
        else if (parsed.error?.message) message = parsed.error.message;
        else if (parsed.message) message = parsed.message;
      } catch {
        // keep plain text
      }
      throw new Error(`${providerName} error ${response.status}: ${message}`);
    }
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${providerName} request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function openAiHeaders(config: ResolvedProvider): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  if (config.id === "openrouter") {
    headers["HTTP-Referer"] = "http://localhost:4317";
    headers["X-Title"] = "Codebase Intelligence Explorer";
  }
  return headers;
}

function extractOpenAiText(payload: unknown): string {
  const data = payload as {
    choices?: { message?: { content?: string | { type?: string; text?: string }[] } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : part.text ?? "")).join("");
  }
  throw new Error("The provider returned an empty response.");
}

async function chatOpenAi(config: ResolvedProvider, messages: ChatMessage[], options: ChatOptions): Promise<string> {
  const maxTokens = options.maxTokens ?? 2400;
  const reasoningModel = /^(gpt-5|o\d|o-)/i.test(config.model);
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: false,
  };
  if (reasoningModel) body.max_completion_tokens = maxTokens;
  else {
    body.max_tokens = maxTokens;
    body.temperature = options.temperature ?? 0.2;
  }

  const response = await request(
    `${config.baseUrl}/chat/completions`,
    { method: "POST", headers: openAiHeaders(config), body: JSON.stringify(body) },
    options.timeoutMs ?? 90_000,
    providerInfo(config.id).name,
  );
  return extractOpenAiText(await response.json());
}

async function chatAnthropic(config: ResolvedProvider, messages: ChatMessage[], options: ChatOptions): Promise<string> {
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  const conversation = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({ role: message.role, content: message.content }));

  const response = await request(
    `${config.baseUrl}/v1/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: options.maxTokens ?? 2400,
        temperature: options.temperature ?? 0.2,
        ...(system ? { system } : {}),
        messages: conversation,
      }),
    },
    options.timeoutMs ?? 90_000,
    "Anthropic",
  );
  const payload = (await response.json()) as { content?: { type?: string; text?: string }[] };
  const text = (payload.content ?? []).map((part) => part.text ?? "").join("");
  if (!text) throw new Error("Anthropic returned an empty response.");
  return text;
}

async function chatGemini(config: ResolvedProvider, messages: ChatMessage[], options: ChatOptions): Promise<string> {
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  const contents = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    }));

  const response = await request(
    `${config.baseUrl}/v1beta/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents,
        generationConfig: {
          temperature: options.temperature ?? 0.2,
          maxOutputTokens: options.maxTokens ?? 2400,
        },
      }),
    },
    options.timeoutMs ?? 90_000,
    "Google Gemini",
  );
  const payload = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = (payload.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? "").join("");
  if (!text) throw new Error("Gemini returned an empty response.");
  return text;
}

export async function chat(
  config: ResolvedProvider,
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<string> {
  if (config.kind === "anthropic") return chatAnthropic(config, messages, options);
  if (config.kind === "gemini") return chatGemini(config, messages, options);
  return chatOpenAi(config, messages, options);
}

export async function testProvider(provider?: AiProviderId, model?: string): Promise<AiTestResult> {
  const config = await resolveProvider(provider, model);
  const started = Date.now();
  try {
    const answer = await chat(
      config,
      [
        { role: "system", content: "You are a connection health check. Answer with exactly: OK" },
        { role: "user", content: "Reply with exactly: OK" },
      ],
      { maxTokens: 16, temperature: 0, timeoutMs: 30_000 },
    );
    return {
      ok: true,
      provider: config.id,
      model: config.model,
      latencyMs: Date.now() - started,
      message: answer.trim().slice(0, 120) || "OK",
    };
  } catch (error) {
    return {
      ok: false,
      provider: config.id,
      model: config.model,
      latencyMs: Date.now() - started,
      message: error instanceof Error ? error.message : "Connection failed.",
    };
  }
}

export async function listProviderModels(provider: AiProviderId): Promise<string[]> {
  const info = providerInfo(provider);
  if (info.kind === "anthropic") return info.models;

  const config = await resolveProvider(provider);
  const timeout = 20_000;

  try {
    if (info.kind === "gemini") {
      const response = await request(
        `${config.baseUrl}/v1beta/models?key=${encodeURIComponent(config.apiKey)}`,
        { method: "GET" },
        timeout,
        "Google Gemini",
      );
      const payload = (await response.json()) as { models?: { name?: string; supportedGenerationMethods?: string[] }[] };
      return (payload.models ?? [])
        .filter((model) => !model.supportedGenerationMethods || model.supportedGenerationMethods.includes("generateContent"))
        .map((model) => model.name?.replace(/^models\//, "") ?? "")
        .filter(Boolean)
        .sort();
    }

    const headers: Record<string, string> = {};
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    const response = await request(`${config.baseUrl}/models`, { method: "GET", headers }, timeout, info.name);
    const payload = (await response.json()) as { data?: { id?: string }[] };
    const models = (payload.data ?? []).map((model) => model.id ?? "").filter(Boolean);
    return models.length > 0 ? models.sort() : info.models;
  } catch {
    return info.models;
  }
}
