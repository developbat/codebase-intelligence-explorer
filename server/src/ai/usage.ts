import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AiTokenUsage,
  AiUsageBucket,
  AiUsageDay,
  AiUsageEntry,
  AiUsageReport,
} from "../../../shared/ai";
import { getDataDir } from "../store";
import { findPrice, getPricingReport, priceFor, usageCost } from "./pricing";

const MAX_ENTRIES = 10_000;

interface UsageFile {
  version: 1;
  entries: AiUsageEntry[];
}

function usagePath(): string {
  return path.join(getDataDir(), "ai-usage.json");
}

function emptyUsage(): AiTokenUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function addUsage(target: AiTokenUsage, entry: AiUsageEntry): void {
  target.inputTokens += entry.inputTokens;
  target.outputTokens += entry.outputTokens;
  target.totalTokens += entry.totalTokens;
}

function costOf(entry: AiUsageEntry, prices: Awaited<ReturnType<typeof getPricingReport>>["prices"]): number | undefined {
  return entry.costUsd ?? usageCost(entry, findPrice(prices, entry.provider, entry.model));
}

let writeQueue: Promise<void> = Promise.resolve();

async function readUsage(): Promise<UsageFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(usagePath(), "utf8")) as Partial<UsageFile>;
    return {
      version: 1,
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    };
  } catch {
    return { version: 1, entries: [] };
  }
}

async function writeUsage(file: UsageFile): Promise<void> {
  const target = usagePath();
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const trimmed = file.entries.slice(-MAX_ENTRIES);
  await fs.writeFile(temp, JSON.stringify({ version: 1, entries: trimmed }), {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(temp, target);
}

export async function recordUsage(
  input: Omit<AiUsageEntry, "id" | "createdAt">,
): Promise<void> {
  const entry: AiUsageEntry = {
    ...input,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  const price = await priceFor(input.provider, input.model).catch(() => undefined);
  const cost = usageCost(input, price);
  if (cost !== undefined) entry.costUsd = cost;
  writeQueue = writeQueue
    .then(async () => {
      const file = await readUsage();
      file.entries.push(entry);
      await writeUsage(file);
    })
    .catch(() => {
      // Usage tracking must never break an AI request.
    });
  return writeQueue;
}

function isToday(iso: string): boolean {
  const date = new Date(iso);
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

function withinDays(iso: string, days: number): boolean {
  const time = new Date(iso).getTime();
  return Number.isFinite(time) && Date.now() - time <= days * 24 * 60 * 60 * 1000;
}

export async function getProjectUsage(projectId: string): Promise<AiUsageReport> {
  const file = await readUsage();
  const pricing = await getPricingReport().catch(() => ({
    prices: [],
    sources: [],
    updatedAt: undefined,
  }));
  const entries = file.entries
    .filter((entry) => entry.projectId === projectId)
    .map((entry) => {
      const costUsd = costOf(entry, pricing.prices);
      return costUsd === undefined ? entry : { ...entry, costUsd };
    });
  const total = emptyUsage();
  const today = emptyUsage();
  const last7Days = emptyUsage();
  let totalCostUsd = 0;
  let todayCostUsd = 0;
  let last7DaysCostUsd = 0;
  let unpricedRequests = 0;
  const byModel = new Map<string, AiUsageBucket>();
  const byDay = new Map<string, AiUsageDay>();

  for (const entry of entries) {
    addUsage(total, entry);
    const cost = entry.costUsd;
    if (cost === undefined) unpricedRequests += 1;
    else totalCostUsd += cost;
    if (isToday(entry.createdAt)) {
      addUsage(today, entry);
      if (cost !== undefined) todayCostUsd += cost;
    }
    if (withinDays(entry.createdAt, 7)) {
      addUsage(last7Days, entry);
      if (cost !== undefined) last7DaysCostUsd += cost;
    }

    const modelKey = `${entry.provider}::${entry.model}`;
    const model = byModel.get(modelKey) ?? {
      provider: entry.provider,
      model: entry.model,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    };
    model.requests += 1;
    model.inputTokens += entry.inputTokens;
    model.outputTokens += entry.outputTokens;
    model.totalTokens += entry.totalTokens;
    if (cost !== undefined) model.costUsd = (model.costUsd ?? 0) + cost;
    byModel.set(modelKey, model);

    const day = entry.createdAt.slice(0, 10);
    const bucket = byDay.get(day) ?? {
      day,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    };
    bucket.requests += 1;
    bucket.inputTokens += entry.inputTokens;
    bucket.outputTokens += entry.outputTokens;
    bucket.totalTokens += entry.totalTokens;
    if (cost !== undefined) bucket.costUsd = (bucket.costUsd ?? 0) + cost;
    byDay.set(day, bucket);
  }

  return {
    projectId,
    total,
    today,
    last7Days,
    byModel: [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    byDay: [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, 30),
    recent: [...entries].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 40),
    totalCostUsd: Number(totalCostUsd.toFixed(6)),
    todayCostUsd: Number(todayCostUsd.toFixed(6)),
    last7DaysCostUsd: Number(last7DaysCostUsd.toFixed(6)),
    unpricedRequests,
    pricingUpdatedAt: pricing.updatedAt,
  };
}
