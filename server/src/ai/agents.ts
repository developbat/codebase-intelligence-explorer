import type {
  AiAgentAutoPick,
  AiAgentAutoResult,
  AiAgentRole,
  AiAgentRoleConfig,
  AiProviderState,
} from "../../../shared/ai";
import type { CatalogModel, ModelCatalog } from "../../../shared/catalog";
import { getPublicSettings, updateAiSettings } from "./settings";
import { getModelCatalog } from "./catalog";

const FAST_HINTS = /(mini|nano|tiny|flash|haiku|small|lite|free|7b|8b|9b|1\.5b|3b|4b|qwen.*coder)/i;
const HEAVY_HINTS = /(opus|pro|large|70b|72b|120b|405b|reasoning|reasoner|thinking|o1|o3|max)/i;

function fastScore(model: string, catalogModel?: CatalogModel): number {
  let score = 0;
  if (FAST_HINTS.test(model)) score += 20;
  if (HEAVY_HINTS.test(model)) score -= 20;
  if (/coder|code/i.test(model)) score += 3;
  if (/deepseek|qwen|claude|gpt-|gemini|llama|mistral/i.test(model)) score += 3;
  if (/free/i.test(model)) score += 4;
  if (catalogModel) {
    if (catalogModel.roles.includes("fast")) score += 18;
    if (catalogModel.roles.includes("main")) score += 2;
    const speed = catalogModel.speed?.toLowerCase() ?? "";
    if (/fast|high|low.latency|realtime/.test(speed)) score += 10;
    if (/slow|heavy|reason/.test(speed)) score -= 10;
    const price = catalogModel.outputPrice ?? catalogModel.inputPrice;
    if (price !== undefined) {
      if (price <= 0.5) score += 8;
      else if (price <= 2) score += 4;
      else if (price > 10) score -= 8;
    }
    if (catalogModel.quality !== undefined) score += Math.max(-5, Math.min(6, catalogModel.quality / 20));
  }
  return score;
}

function catalogLookup(catalog: ModelCatalog | null, provider: string, model: string): CatalogModel | undefined {
  if (!catalog) return undefined;
  const key = `${provider}/${model}`.toLowerCase();
  return (
    catalog.models.find((item) => `${item.provider}/${item.id}`.toLowerCase() === key) ??
    catalog.models.find((item) => item.id.toLowerCase() === model.toLowerCase()) ??
    catalog.models.find(
      (item) =>
        model.toLowerCase().endsWith(`/${item.id.toLowerCase()}`) ||
        item.id.toLowerCase().endsWith(`/${model.toLowerCase()}`),
    )
  );
}

function catalogAgent(catalog: ModelCatalog | null, role: string) {
  return catalog?.agents.find((agent) => agent.role === role) ?? undefined;
}

function pickMain(providers: AiProviderState[], defaultProvider: string, defaultModel: string) {
  const provider =
    providers.find((item) => item.id === defaultProvider && (item.hasKey || item.custom)) ??
    providers.find((item) => item.hasKey || item.custom) ??
    providers[0];
  if (!provider) throw new Error("No AI provider is configured.");
  const model =
    provider.id === defaultProvider && defaultModel
      ? defaultModel
      : provider.model || provider.models[0] || "";
  return { provider, model };
}

export async function autoConfigureAgents(): Promise<AiAgentAutoResult> {
  const settings = await getPublicSettings();
  const catalog = await getModelCatalog().catch(() => null);
  const providers = settings.providers.filter((provider) => provider.hasKey || provider.custom);
  if (providers.length === 0) {
    throw new Error("Add an API key to at least one provider before auto-selecting agents.");
  }

  const warnings: string[] = [];
  const catalogs = new Map<string, string[]>(
    providers.map((provider) => [
      provider.id,
      provider.models.length > 0 ? provider.models : provider.model ? [provider.model] : [],
    ]),
  );
  const hasFreshCatalog = providers.some((provider) => Boolean(provider.modelsUpdatedAt));
  if (!hasFreshCatalog) {
    warnings.push(
      "Using the saved/default model lists. Use Update model list in Models when you want fresh catalogs.",
    );
  }
  if (catalog) {
    warnings.push(
      `Model catalog: ${catalog.models.length} models, ${catalog.agents.length} agent presets (${catalog.source}).`,
    );
  } else {
    warnings.push("No imported model catalog. Fast/main routing uses name heuristics only.");
  }

  const main = pickMain(providers, settings.defaultProvider, settings.defaultModel);
  if (!main.model) throw new Error("The main provider has no model. Add a model in Models.");

  let fastProvider = main.provider;
  let fastModel = main.model;
  let fastBest = Number.NEGATIVE_INFINITY;
  for (const provider of providers) {
    const models = catalogs.get(provider.id) ?? [];
    for (const model of models) {
      if (!model) continue;
      let score = fastScore(model, catalogLookup(catalog, provider.id, model));
      if (provider.id === main.provider.id) score += 5;
      if (score > fastBest) {
        fastBest = score;
        fastProvider = provider;
        fastModel = model;
      }
    }
  }
  if (fastProvider.id === main.provider.id && fastModel === main.model) {
    warnings.push("No smaller model was found; the fast role currently uses the main model.");
  }

  const providerIds = new Set(providers.map((provider) => provider.id));
  const plannerAgent = catalogAgent(catalog, "planner");
  const reviewerAgent = catalogAgent(catalog, "reviewer");
  const plannerPick =
    plannerAgent && providerIds.has(plannerAgent.provider)
      ? { provider: plannerAgent.provider, model: plannerAgent.model, reason: "Catalog planner preset" }
      : { provider: main.provider.id, model: main.model, reason: "Planning uses the main model" };
  const reviewerPick =
    reviewerAgent && providerIds.has(reviewerAgent.provider)
      ? { provider: reviewerAgent.provider, model: reviewerAgent.model, reason: "Catalog reviewer preset" }
      : { provider: main.provider.id, model: main.model, reason: "Review uses the main model" };

  const picks: AiAgentAutoPick[] = [
    {
      role: "main",
      provider: main.provider.id,
      model: main.model,
      reason: "Current default provider/model",
    },
    {
      role: "planner",
      ...plannerPick,
    },
    {
      role: "fast",
      provider: fastProvider.id,
      model: fastModel,
      reason:
        fastProvider.id === main.provider.id && fastModel === main.model
          ? "No cheaper model found"
          : catalogLookup(catalog, fastProvider.id, fastModel)
            ? "Catalog-ranked fast/economy model"
            : "Smallest/cheapest-looking available model",
    },
    {
      role: "reviewer",
      ...reviewerPick,
    },
  ];

  const agentRoles: Partial<Record<AiAgentRole, AiAgentRoleConfig>> = {};
  for (const pick of picks) {
    agentRoles[pick.role] = { provider: pick.provider, model: pick.model };
  }

  const next = await updateAiSettings({ agentRoles });
  return { settings: next, picks, warnings };
}

export async function pickAlternateAgentModel(exclude?: {
  provider?: string;
  model?: string;
}): Promise<{ provider: string; model: string; reason: string } | null> {
  const settings = await getPublicSettings();
  const catalog = await getModelCatalog().catch(() => null);
  const configured = settings.providers.filter(
    (provider) => (provider.hasKey || provider.custom) && provider.id !== exclude?.provider,
  );
  const roleOrder: AiAgentRole[] = ["reviewer", "planner", "main", "fast"];
  const candidates: { provider: string; model: string; reason: string }[] = [];
  for (const role of roleOrder) {
    const configuredRole = settings.agentRoles.find((item) => item.role === role);
    if (!configuredRole) continue;
    if (
      configuredRole.provider === exclude?.provider &&
      configuredRole.model === exclude?.model
    ) {
      continue;
    }
    candidates.push({
      provider: configuredRole.provider,
      model: configuredRole.model,
      reason: `${role} role`,
    });
  }
  for (const provider of configured) {
    const models =
      provider.models.length > 0 ? provider.models : provider.model ? [provider.model] : [];
    for (const model of models) {
      if (provider.id === exclude?.provider && model === exclude?.model) continue;
      if (/embed|whisper|tts|image|vision|rerank|moderation|dall|stable-diffusion/i.test(model)) {
        continue;
      }
      const catalogModel = catalogLookup(catalog, provider.id, model);
      candidates.push({
        provider: provider.id,
        model,
        reason: catalogModel
          ? `alternate · catalog roles: ${catalogModel.roles.join(", ") || "model"}`
          : "alternate provider/model",
      });
    }
  }
  if (candidates.length === 0) return null;
  const catalogBest = candidates.find((candidate) => {
    const item = catalogLookup(catalog, candidate.provider, candidate.model);
    return item?.roles.includes("main") || item?.roles.includes("reviewer");
  });
  if (catalogBest) return catalogBest;
  const coderFirst = candidates.find((candidate) => /coder|code|deepseek|claude|gpt/i.test(candidate.model));
  return coderFirst ?? candidates[0];
}
