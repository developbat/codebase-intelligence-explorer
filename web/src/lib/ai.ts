import type { AiProviderId, AiSettingsPublic } from "../../../shared/ai";

export interface ActiveProvider {
  provider: AiProviderId;
  model: string;
  name: string;
}

/**
 * The default provider can be unconfigured while another provider has a key.
 * Pick the default when it is usable, otherwise the first configured provider.
 */
export function activeProvider(settings: AiSettingsPublic | null): ActiveProvider | null {
  if (!settings) return null;
  const defaultState = settings.providers.find((provider) => provider.id === settings.defaultProvider);
  if (defaultState?.hasKey || settings.defaultProvider === "custom") {
    return {
      provider: settings.defaultProvider,
      model: settings.defaultModel || defaultState?.model || "",
      name: defaultState?.id ?? settings.defaultProvider,
    };
  }
  const configured = settings.providers.find((provider) => provider.hasKey);
  if (!configured) return null;
  return { provider: configured.id, model: configured.model, name: configured.id };
}
