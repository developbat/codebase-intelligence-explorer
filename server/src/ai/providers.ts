import type { AiProviderId, AiTestResult, AiTokenUsage } from "../../../shared/ai";
import { resolveProvider, saveProviderModels, type ResolvedProvider } from "./settings";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onUsage?: (usage: AiTokenUsage) => void;
  onToken?: (chunk: string) => void;
  onFinishReason?: (reason: string | undefined) => void;
}

async function request(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  providerName: string,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
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
    if (signal?.aborted) throw new Error("The request was cancelled.");
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${providerName} request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
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

export function toolCallsToJson(
  calls: { name?: string; arguments?: string }[],
): string | null {
  if (calls.length === 0) return null;
  const actions = calls.map((call) => {
    let args: Record<string, unknown> = {};
    if (typeof call.arguments === "string" && call.arguments.trim()) {
      try {
        const parsed = JSON.parse(call.arguments) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        args = {};
      }
    }
    return { action: call.name ?? "invalid", args };
  });
  return JSON.stringify(
    actions.length === 1
      ? actions[0]
      : {
          action: actions[0].action,
          args: actions[0].args,
          __actionCount: actions.length,
          __actions: actions,
        },
  );
}

function extractOpenAiText(payload: unknown): string {
  const data = payload as {
    choices?: {
      text?: string;
      finish_reason?: string;
      message?: {
        content?: string | { type?: string; text?: string }[];
        reasoning?: string;
        reasoning_content?: string;
        tool_calls?: { function?: { name?: string; arguments?: string } }[];
      };
    }[];
  };
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === "string" && content.trim()) return content;
  if (Array.isArray(content)) {
    const text = content.map((part) => (typeof part === "string" ? part : part.text ?? "")).join("");
    if (text.trim()) return text;
  }
  const toolCalls = choice?.message?.tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    const converted = toolCallsToJson(
      toolCalls.map((call) => ({
        name: call.function?.name,
        arguments: call.function?.arguments,
      })),
    );
    if (converted) return converted;
  }
  // Some reasoning models put the answer in a separate field and leave content empty.
  const reasoning = choice?.message?.reasoning_content ?? choice?.message?.reasoning;
  if (typeof reasoning === "string" && reasoning.trim()) return reasoning;
  if (typeof choice?.text === "string" && choice.text.trim()) return choice.text;
  throw new Error(
    `The provider returned an empty response${choice?.finish_reason ? ` (finish_reason: ${choice.finish_reason})` : ""}.`,
  );
}

async function readOpenAiStream(
  response: Response,
  options: ChatOptions,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The provider returned no streaming body.");
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let reasoning = "";
  let finishReason: string | undefined;
  let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
  const toolCalls = new Map<number, { name: string; arguments: string }>();

  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const rawLine = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!rawLine.startsWith("data:")) continue;
        const data = rawLine.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let payload: {
          choices?: {
            delta?: {
              content?: string | { type?: string; text?: string }[];
              reasoning?: string;
              reasoning_content?: string;
              tool_calls?: {
                index?: number;
                function?: { name?: string; arguments?: string };
              }[];
            };
            finish_reason?: string;
          }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        };
        try {
          payload = JSON.parse(data) as typeof payload;
        } catch {
          continue;
        }
        if (payload.usage) usage = payload.usage;
        const choice = payload.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta;
        if (!delta) continue;
        const content = delta.content;
        if (typeof content === "string" && content) {
          text += content;
          options.onToken?.(content);
        } else if (Array.isArray(content)) {
          const piece = content.map((part) => (typeof part === "string" ? part : part.text ?? "")).join("");
          if (piece) {
            text += piece;
            options.onToken?.(piece);
          }
        }
        const thinking = delta.reasoning_content ?? delta.reasoning;
        if (typeof thinking === "string" && thinking) reasoning += thinking;
        for (const call of delta.tool_calls ?? []) {
          const index = call.index ?? 0;
          const current = toolCalls.get(index) ?? { name: "", arguments: "" };
          if (call.function?.name) current.name = call.function.name;
          if (call.function?.arguments) current.arguments += call.function.arguments;
          toolCalls.set(index, current);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  options.onFinishReason?.(finishReason);
  if (usage) {
    const inputTokens = usage.prompt_tokens ?? 0;
    const outputTokens = usage.completion_tokens ?? 0;
    options.onUsage?.({
      inputTokens,
      outputTokens,
      totalTokens: usage.total_tokens ?? inputTokens + outputTokens,
    });
  }
  if (text.trim()) return text;
  if (toolCalls.size > 0) {
    const converted = toolCallsToJson([...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call));
    if (converted) return converted;
  }
  if (reasoning.trim()) return reasoning;
  throw new Error(
    `The provider returned an empty response${finishReason ? ` (finish_reason: ${finishReason})` : ""}.`,
  );
}

async function chatOpenAi(config: ResolvedProvider, messages: ChatMessage[], options: ChatOptions): Promise<string> {
  const maxTokens = options.maxTokens ?? 2400;
  const reasoningModel = /^(gpt-5|o\d|o-)/i.test(config.model);
  const streaming = typeof options.onToken === "function";
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: streaming,
  };
  if (streaming) body.stream_options = { include_usage: true };
  if (reasoningModel) body.max_completion_tokens = maxTokens;
  else {
    body.max_tokens = maxTokens;
    body.temperature = options.temperature ?? 0.2;
  }

  let response: Response;
  try {
    response = await request(
      `${config.baseUrl}/chat/completions`,
      { method: "POST", headers: openAiHeaders(config), body: JSON.stringify(body) },
      options.timeoutMs ?? 90_000,
      config.name,
      options.signal,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!streaming || !/error 4\d\d/.test(message)) throw error;
    // Some OpenAI-compatible servers reject stream_options or streaming itself.
    body.stream = false;
    delete body.stream_options;
    response = await request(
      `${config.baseUrl}/chat/completions`,
      { method: "POST", headers: openAiHeaders(config), body: JSON.stringify(body) },
      options.timeoutMs ?? 90_000,
      config.name,
      options.signal,
    );
  }
  if (streaming && body.stream === true) return readOpenAiStream(response, options);
  const payload = (await response.json()) as {
    choices?: { finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  options.onFinishReason?.(payload.choices?.[0]?.finish_reason);
  if (payload.usage) {
    const inputTokens = payload.usage.prompt_tokens ?? 0;
    const outputTokens = payload.usage.completion_tokens ?? 0;
    options.onUsage?.({
      inputTokens,
      outputTokens,
      totalTokens: payload.usage.total_tokens ?? inputTokens + outputTokens,
    });
  }
  return extractOpenAiText(payload);
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
    options.signal,
  );
  const payload = (await response.json()) as {
    content?: { type?: string; text?: string }[];
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  options.onFinishReason?.(payload.stop_reason);
  if (payload.usage) {
    const inputTokens = payload.usage.input_tokens ?? 0;
    const outputTokens = payload.usage.output_tokens ?? 0;
    options.onUsage?.({ inputTokens, outputTokens, totalTokens: inputTokens + outputTokens });
  }
  const text = (payload.content ?? []).map((part) => part.text ?? "").join("");
  if (!text) {
    throw new Error(
      `Anthropic returned an empty response${payload.stop_reason ? ` (stop_reason: ${payload.stop_reason})` : ""}.`,
    );
  }
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
    options.signal,
  );
  const payload = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
  };
  options.onFinishReason?.(payload.candidates?.[0]?.finishReason);
  if (payload.usageMetadata) {
    const inputTokens = payload.usageMetadata.promptTokenCount ?? 0;
    const outputTokens = payload.usageMetadata.candidatesTokenCount ?? 0;
    options.onUsage?.({
      inputTokens,
      outputTokens,
      totalTokens: payload.usageMetadata.totalTokenCount ?? inputTokens + outputTokens,
    });
  }
  const text = (payload.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? "").join("");
  if (!text) {
    const finish = payload.candidates?.[0]?.finishReason;
    throw new Error(`Gemini returned an empty response${finish ? ` (finishReason: ${finish})` : ""}.`);
  }
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

export async function listProviderModels(
  provider: AiProviderId,
  options: { refresh?: boolean } = {},
): Promise<string[]> {
  const config = await resolveProvider(provider);
  if (!options.refresh && config.models.length > 0) return config.models;
  if (config.kind === "anthropic") return config.models;

  const timeout = 20_000;

  try {
    if (config.kind === "gemini") {
      const response = await request(
        `${config.baseUrl}/v1beta/models?key=${encodeURIComponent(config.apiKey)}`,
        { method: "GET" },
        timeout,
        "Google Gemini",
      );
      const payload = (await response.json()) as { models?: { name?: string; supportedGenerationMethods?: string[] }[] };
      const models = (payload.models ?? [])
        .filter((model) => !model.supportedGenerationMethods || model.supportedGenerationMethods.includes("generateContent"))
        .map((model) => model.name?.replace(/^models\//, "") ?? "")
        .filter(Boolean)
        .sort();
      if (models.length === 0) return config.models;
      await saveProviderModels(provider, models);
      return models;
    }

    const headers: Record<string, string> = {};
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    const modelUrl = config.modelListUrl?.trim() || `${config.baseUrl}/models`;
    const response = await request(modelUrl, { method: "GET", headers }, timeout, config.name);
    const payload = (await response.json()) as {
      data?: { id?: string }[];
      models?: { id?: string; name?: string }[];
      result?: string[];
    };
    const models = [
      ...(payload.data ?? []).map((model) => model.id ?? ""),
      ...(payload.models ?? []).map((model) => model.id ?? model.name ?? ""),
      ...(payload.result ?? []),
    ].filter(Boolean);
    if (models.length === 0) return config.models;
    const unique = [...new Set(models)].sort();
    await saveProviderModels(provider, unique);
    return unique;
  } catch {
    return config.models;
  }
}
