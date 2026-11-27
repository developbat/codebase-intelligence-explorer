import type {
  AiAgentAutoPick,
  AiAgentAutoResult,
  AiAgentRole,
  AiAgentRoleConfig,
  AiProviderState,
} from "../../../shared/ai";
import type { CatalogModel, ModelCatalog } from "../../../shared/catalog";
import { localModelStatus } from "../localModels";
import { getPublicSettings, updateAiSettings } from "./settings";
import { getModelCatalog } from "./catalog";
import { findPrice, getPricingReport } from "./pricing";
import {
  healthKey,
  isModelUnhealthy,
  modelHealthByProviderModel,
  modelHealthPenalty,
} from "./modelStats";

const FAST_HINTS = /(mini|nano|tiny|flash|haiku|small|lite|free|7b|8b|9b|1\.5b|3b|4b|qwen.*coder)/i;
const HEAVY_HINTS = /(opus|pro|large|70b|72b|120b|405b|reasoning|reasoner|thinking|o1|o3|max)/i;

function fastScore(
  model: string,
  catalogModel?: CatalogModel,
  healthPenalty = 0,
): number {
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
  return score + healthPenalty;
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
  const health = await modelHealthByProviderModel();
  const pricing = await getPricingReport().catch(() => null);
  const localStatus = await localModelStatus().catch(() => null);
  const localRunning = Boolean(localStatus?.running);
  const providers = settings.providers.filter(
    (provider) =>
      (provider.hasKey || provider.custom || provider.id === "local") &&
      provider.enabled !== false,
  );
  if (providers.length === 0) {
    throw new Error("Add an API key to at least one provider before auto-selecting agents.");
  }

  const warnings: string[] = [];
  if (providers.some((provider) => provider.id === "local") && !localRunning) {
    warnings.push(
      "The local model server is not running, so automatic assignment skips local models. Start it in Model providers → Local models.",
    );
  }
  const catalogs = new Map<string, string[]>(
    providers.map((provider) => [
      provider.id,
      provider.models.length > 0 ? provider.models : provider.model ? [provider.model] : [],
    ]),
  );
  const hasFreshCatalog = providers.some((provider) => Boolean(provider.modelsUpdatedAt));
  if (!hasFreshCatalog) {
    warnings.push(
      "Using the saved/default model lists. Use Update model list in Model providers when you want fresh catalogs.",
    );
  }
  if (catalog) {
    warnings.push(
      `Model catalog: ${catalog.models.length} models, ${catalog.agents.length} agent presets (${catalog.source}).`,
    );
  } else {
    warnings.push("No imported model catalog. Fast/main routing uses name heuristics only.");
  }
  const configuredChain = (settings.fallback?.chain ?? []).filter((item) => {
    const provider = providers.find((candidate) => candidate.id === item.provider);
    return Boolean(
      provider && provider.enabled !== false && (item.provider !== "local" || localRunning),
    );
  });
  const chainMain = configuredChain[0];
  const main = chainMain
    ? {
        provider:
          providers.find((provider) => provider.id === chainMain.provider) ?? providers[0],
        model: chainMain.model,
      }
    : pickMain(providers, settings.defaultProvider, settings.defaultModel);
  if (!main.model) throw new Error("The main provider has no model. Add a model in Models.");
  const mainHealth = health.get(healthKey(main.provider.id, main.model));
  if (mainHealth && isModelUnhealthy(mainHealth, settings.modelHealth)) {
    warnings.push(
      `Main model is over the configured health limit (${mainHealth.protocolFailures} protocol, ${mainHealth.emptyFailures} empty). Consider a different main model.`,
    );
  }


  let fastProvider = main.provider;
  let fastModel = main.model;
  let fastBest = Number.NEGATIVE_INFINITY;
  for (const provider of providers) {
    if (provider.id === "local" && !localRunning) continue;
    const models = catalogs.get(provider.id) ?? [];
    for (const model of models) {
      if (!model) continue;
      let score = fastScore(
        model,
        catalogLookup(catalog, provider.id, model),
        modelHealthPenalty(
          health.get(healthKey(provider.id, model)),
          settings.modelHealth,
        ),
      );
      if (provider.id === main.provider.id) score += 5;
      if (provider.id === settings.defaultProvider) score += 70;
      if (provider.id === "local") score += 100;
      if (
        configuredChain.some(
          (item) => item.provider === provider.id && item.model === model,
        )
      ) {
        score += 30;
      }
      const price = pricing ? findPrice(pricing.prices, provider.id, model) : undefined;
      if (
        price &&
        price.inputPerMillion === 0 &&
        price.outputPerMillion === 0
      ) {
        score += 60;
      }
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
  const chainReviewer = configuredChain[1];
  const reviewerPick =
    chainReviewer && providerIds.has(chainReviewer.provider)
      ? {
          provider: chainReviewer.provider,
          model: chainReviewer.model,
          reason: "Second model in the selected fallback chain",
        }
      : reviewerAgent && providerIds.has(reviewerAgent.provider)
        ? { provider: reviewerAgent.provider, model: reviewerAgent.model, reason: "Catalog reviewer preset" }
        : { provider: main.provider.id, model: main.model, reason: "Review uses the main model" };

  const picks: AiAgentAutoPick[] = [
    {
      role: "main",
      provider: main.provider.id,
      model: main.model,
      reason: configuredChain[0]
        ? "First model in the selected fallback chain"
        : "Current default provider/model",
    },
    {
      role: "planner",
      ...plannerPick,
    },
    {
      role: "diagnosis",
      provider: plannerPick.provider,
      model: plannerPick.model,
      reason: "Diagnosis uses the planner/reasoning model",
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
  const health = await modelHealthByProviderModel();
  const pricing = await getPricingReport().catch(() => null);
  const localStatus = await localModelStatus().catch(() => null);
  const localRunning = Boolean(localStatus?.running);
  const localUsable = (provider: string) => provider !== "local" || localRunning;
  const priceAllowed = (candidate: { provider: string; model: string }) => {
    if (!pricing) return true;
    const price = findPrice(pricing.prices, candidate.provider, candidate.model);
    if (!price) return true;
    const maxInput = settings.fallback?.maxInputPricePerMillion;
    const maxOutput = settings.fallback?.maxOutputPricePerMillion;
    if (maxInput !== undefined && price.inputPerMillion !== undefined && price.inputPerMillion > maxInput) {
      return false;
    }
    if (
      maxOutput !== undefined &&
      price.outputPerMillion !== undefined &&
      price.outputPerMillion > maxOutput
    ) {
      return false;
    }
    return true;
  };
  const hasKnownSuccess = [...health.values()].some((item) => item.successCount > 0);
  const healthyAndAffordable = (candidate: { provider: string; model: string }) => {
    const item = health.get(healthKey(candidate.provider, candidate.model));
    if (hasKnownSuccess && (!item || item.successCount === 0)) return false;
    return !isModelUnhealthy(item, settings.modelHealth) && priceAllowed(candidate);
  };

  const chain = settings.fallback?.chain ?? [];
  if (chain.length > 0) {
    const chained = chain
      .filter((item) => !(item.provider === exclude?.provider && item.model === exclude?.model))
      .filter((item) =>
        settings.providers.some(
          (provider) =>
            provider.id === item.provider &&
            (provider.hasKey || provider.custom || provider.id === "local") &&
            provider.enabled !== false &&
            localUsable(provider.id),
        ),
      )
      .map((item) => ({
        provider: item.provider,
        model: item.model,
        reason: "configured fallback chain",
      }))
      .filter(healthyAndAffordable);
    return chained[0] ?? null;
  }

  const configured = settings.providers.filter(
    (provider) =>
      (provider.hasKey || provider.custom || provider.id === "local") &&
      provider.enabled !== false &&
      localUsable(provider.id) &&
      provider.id !== exclude?.provider,
  );
  // Coding fallbacks should stay cheap and fast first. Reviewer/planner models
  // are often the most expensive ones and should be a last resort.
  const roleOrder: AiAgentRole[] = ["fast", "main", "planner", "diagnosis", "reviewer"];
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
  const healthy = candidates.filter(healthyAndAffordable);
  const pool = healthy.length > 0 ? healthy : candidates;
  // Prefer an explicitly cheap/fast-looking model before role-based picks.
  // This prevents a run that lost its original model from moving every later
  // task onto an expensive reviewer/planner model.
  const cheap = pool.find((candidate) =>
    /flash|mini|nano|free|deepseek|ling|small|lite|qwen/i.test(candidate.model),
  );
  if (cheap) return cheap;
  const catalogFast = pool.find((candidate) => {
    const item = catalogLookup(catalog, candidate.provider, candidate.model);
    return item?.roles.includes("fast");
  });
  if (catalogFast) return catalogFast;
  const catalogBest = pool.find((candidate) => {
    const item = catalogLookup(catalog, candidate.provider, candidate.model);
    return item?.roles.includes("main");
  });
  if (catalogBest) return catalogBest;
  const coderFirst = pool.find((candidate) => /coder|code|deepseek|claude|gpt/i.test(candidate.model));
  return coderFirst ?? pool[0];
}
