import fs from "node:fs/promises";
import path from "node:path";
import type { AiModelHealthSettings } from "../../../shared/ai";
import type { ModelHealth } from "../../../shared/modelHealth";
import { getDataDir } from "../store";

interface ModelStatsFile {
  version: 1;
  updatedAt: string;
  models: Record<string, ModelHealth>;
}

function statsPath(): string {
  return path.join(getDataDir(), "model-health.json");
}

function key(provider: string, model: string): string {
  return `${provider}::${model}`;
}

async function readStats(): Promise<ModelStatsFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(statsPath(), "utf8")) as ModelStatsFile;
    return {
      version: 1,
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      models: parsed.models && typeof parsed.models === "object" ? parsed.models : {},
    };
  } catch {
    return { version: 1, updatedAt: new Date().toISOString(), models: {} };
  }
}

async function writeStats(file: ModelStatsFile): Promise<void> {
  const target = statsPath();
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(file, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.rename(temp, target);
}

export async function recordModelOutcome(
  provider: string,
  model: string,
  outcome: { success: boolean; protocolFailure?: boolean; emptyFailure?: boolean },
): Promise<void> {
  const file = await readStats();
  const id = key(provider, model);
  const current: ModelHealth = file.models[id] ?? {
    provider,
    model,
    successCount: 0,
    protocolFailures: 0,
    emptyFailures: 0,
  };
  const at = new Date().toISOString();
  if (outcome.success) {
    current.successCount += 1;
    current.lastSuccessAt = at;
  }
  if (outcome.protocolFailure) {
    current.protocolFailures += 1;
    current.lastFailureAt = at;
  }
  if (outcome.emptyFailure) {
    current.emptyFailures += 1;
    current.lastFailureAt = at;
  }
  file.models[id] = current;
  file.updatedAt = at;
  await writeStats(file);
}

export async function getModelHealth(): Promise<Record<string, ModelHealth>> {
  return (await readStats()).models;
}

const DEFAULT_HEALTH_SETTINGS: AiModelHealthSettings = {
  protocolFailureLimit: 2,
  emptyFailureLimit: 2,
  penaltyPerFailure: 10,
};

export function modelHealthPenalty(
  health: ModelHealth | undefined,
  settings: AiModelHealthSettings = DEFAULT_HEALTH_SETTINGS,
): number {
  if (!health) return 0;
  const failures =
    health.protocolFailures * settings.penaltyPerFailure +
    health.emptyFailures * Math.max(1, Math.round(settings.penaltyPerFailure / 2));
  const successOffset = Math.min(8, Math.floor(health.successCount / 2));
  const penalty = Math.max(0, failures - successOffset);
  return penalty === 0 ? 0 : -penalty;
}

export function isModelUnhealthy(
  health: ModelHealth | undefined,
  settings: AiModelHealthSettings = DEFAULT_HEALTH_SETTINGS,
): boolean {
  if (!health) return false;
  return (
    health.protocolFailures >= settings.protocolFailureLimit ||
    health.emptyFailures >= settings.emptyFailureLimit
  );
}

export async function modelHealthByProviderModel(): Promise<Map<string, ModelHealth>> {
  const models = await getModelHealth();
  return new Map(Object.entries(models));
}

export function healthKey(provider: string, model: string): string {
  return key(provider, model);
}
