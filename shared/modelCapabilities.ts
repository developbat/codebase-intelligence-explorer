import type { AiProviderId, AiSettingsPublic } from "./ai";

export type StudioId = "chat" | "code" | "image" | "video" | "audio";

export type ModelCapability =
  | "chat"
  | "code"
  | "reasoning"
  | "vision"
  | "image"
  | "video"
  | "audio"
  | "embedding";

const IMAGE_HINTS =
  /(dall-?e|gpt-image|flux|stable-diffusion|sdxl|sd3|imagen|ideogram|midjourney|firefly|recraft|seedream|kolors|image|banana)/i;
const VIDEO_HINTS =
  /(sora|veo|runway|gen-3|kling|pika|luma|dream.?machine|hailuo|seedance|wan-?2|wan-?3|video|omni)/i;
const AUDIO_HINTS =
  /(whisper|tts|speech|audio|musicgen|elevenlabs|suno|lyria|voice|transcri)/i;
const EMBED_HINTS = /(embed|bge-|e5-|text-embedding)/i;
const CODE_HINTS =
  /(coder|coding|codex|devstral|starcoder|codestral|codegemma|qwen.*code|deepseek.*code)/i;
const REASONING_HINTS = /(reason|thinking|o1|o3|o4|deepseek-r1)/i;
const VISION_HINTS = /(vision|vl|4o|gemini|claude|gpt-4|gpt-5|omni)/i;

export function capabilitiesForModel(
  _provider: AiProviderId,
  model: string,
): ModelCapability[] {
  if (EMBED_HINTS.test(model)) return ["embedding"];
  if (VIDEO_HINTS.test(model)) return ["video"];
  if (IMAGE_HINTS.test(model)) return ["image"];
  if (AUDIO_HINTS.test(model)) return ["audio"];
  const capabilities: ModelCapability[] = ["chat"];
  if (CODE_HINTS.test(model)) capabilities.push("code");
  if (REASONING_HINTS.test(model)) capabilities.push("reasoning");
  if (VISION_HINTS.test(model)) capabilities.push("vision");
  return capabilities;
}

export function modelSupportsStudio(
  studio: StudioId,
  provider: AiProviderId,
  model: string,
): boolean {
  const capabilities = capabilitiesForModel(provider, model);
  if (studio === "image") return capabilities.includes("image");
  if (studio === "video") return capabilities.includes("video");
  if (studio === "audio") return capabilities.includes("audio");
  if (studio === "code") {
    return capabilities.includes("chat") && !capabilities.includes("embedding");
  }
  return capabilities.includes("chat");
}

export interface StudioModelRow {
  provider: AiProviderId;
  providerName: string;
  model: string;
  capabilities: ModelCapability[];
  requiresKey?: boolean;
}

const MEDIA_STUDIOS: StudioId[] = ["image", "video", "audio"];

export function modelsForStudio(
  settings: AiSettingsPublic | null,
  studio: StudioId,
): StudioModelRow[] {
  if (!settings) return [];
  const mediaStudio = MEDIA_STUDIOS.includes(studio);
  const rows: StudioModelRow[] = [];
  for (const provider of settings.providers) {
    if (provider.enabled === false) continue;
    const mediaProvider = provider.id === "pollinations" || provider.custom === true;
    if (mediaStudio && !mediaProvider) continue;
    if (
      !mediaStudio &&
      !provider.hasKey &&
      !provider.custom &&
      provider.id !== "local" &&
      provider.id !== "free"
    ) {
      continue;
    }
    const models = provider.models.length > 0 ? provider.models : provider.model ? [provider.model] : [];
    for (const model of models) {
      if (!model || !modelSupportsStudio(studio, provider.id, model)) continue;
      rows.push({
        provider: provider.id,
        providerName: provider.name,
        model,
        capabilities: capabilitiesForModel(provider.id, model),
        requiresKey: mediaStudio && !provider.hasKey,
      });
    }
  }
  return rows;
}

export function preferredStudioModel(
  settings: AiSettingsPublic | null,
  studio: StudioId,
  preferred?: { provider?: string; model?: string } | null,
): { provider: AiProviderId; model: string } | null {
  if (!settings) return null;
  if (preferred?.provider && preferred.model) {
    if (modelSupportsStudio(studio, preferred.provider, preferred.model)) {
      return { provider: preferred.provider, model: preferred.model };
    }
  }
  const chain = settings.fallback?.chain ?? [];
  for (const item of chain) {
    if (modelSupportsStudio(studio, item.provider, item.model)) {
      return { provider: item.provider, model: item.model };
    }
  }
  if (modelSupportsStudio(studio, settings.defaultProvider, settings.defaultModel)) {
    return { provider: settings.defaultProvider, model: settings.defaultModel };
  }
  return modelsForStudio(settings, studio)[0] ?? null;
}

/** Built-in free image models. These work without an API key. */
export const FREE_IMAGE_MODELS = [
  { id: "flux", name: "Flux (free)" },
  { id: "turbo", name: "Turbo (free)" },
] as const;
