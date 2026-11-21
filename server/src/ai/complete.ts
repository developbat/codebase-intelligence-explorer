import type { AiTokenUsage } from "../../../shared/ai";
import { chat, type ChatMessage, type ChatOptions } from "./providers";

const TRUNCATED = /length|max_tokens|max_output|MAX_TOKENS|max_output_tokens/i;
const MAX_CONTINUATIONS = 2;
const MAX_CONTEXT_CHARS = 28_000;

function emptyUsage(): AiTokenUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function addUsage(total: AiTokenUsage, next?: AiTokenUsage): AiTokenUsage {
  if (!next) return total;
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    totalTokens: total.totalTokens + next.totalTokens,
  };
}

export function mergeContinuation(current: string, next: string): string {
  const text = next.trim();
  if (!text) return current;
  const max = Math.min(2_000, current.length, text.length);
  for (let length = max; length >= 16; length -= 1) {
    if (current.slice(-length) === text.slice(0, length)) {
      return current + text.slice(length);
    }
  }
  return `${current}${current.endsWith("\n") || text.startsWith("\n") ? "" : "\n"}${text}`;
}

/**
 * Runs a prose/markdown completion and transparently continues when the
 * provider stops because of its output-token limit. Provider limits differ;
 * this avoids returning a half sentence without needing a per-model table.
 */
export async function chatComplete(
  config: Parameters<typeof chat>[0],
  messages: ChatMessage[],
  options: ChatOptions = {},
  settings: { maxContinuations?: number; continuationPrompt?: string } = {},
): Promise<{ text: string; tokenUsage: AiTokenUsage; truncated: boolean }> {
  const maxContinuations = Math.max(0, Math.min(4, settings.maxContinuations ?? MAX_CONTINUATIONS));
  const continuationPrompt =
    settings.continuationPrompt ??
    "Your previous answer was cut off by the model's output limit. Continue exactly where it stopped. Do not repeat headings, sentences or code that already appeared. Output only the continuation.";
  let combined = "";
  let usage = emptyUsage();
  let truncated = false;
  let conversation = messages;

  for (let attempt = 0; attempt <= maxContinuations; attempt += 1) {
    let finishReason: string | undefined;
    let stepUsage: AiTokenUsage | undefined;
    const piece = await chat(config, conversation, {
      ...options,
      onUsage: (next) => {
        stepUsage = next;
      },
      onFinishReason: (reason) => {
        finishReason = reason;
      },
    });
    usage = addUsage(usage, stepUsage);
    combined = attempt === 0 ? piece : mergeContinuation(combined, piece);
    const hitTokenBudget =
      (stepUsage?.outputTokens ?? 0) >= Math.max(1, (options.maxTokens ?? 2400) - 2);
    truncated =
      Boolean(finishReason && TRUNCATED.test(finishReason)) || hitTokenBudget;
    if (!truncated || attempt === maxContinuations) break;

    const tail = combined.slice(-MAX_CONTEXT_CHARS);
    conversation = [
      ...messages,
      { role: "assistant" as const, content: tail },
      { role: "user" as const, content: continuationPrompt },
    ];
  }

  if (truncated) {
    combined = `${combined.trimEnd()}\n\n… _(answer truncated by the provider output limit)_`;
  }
  return { text: combined.trim(), tokenUsage: usage, truncated };
}
