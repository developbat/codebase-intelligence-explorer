import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "./store";

export interface Reminder {
  id: string;
  title: string;
  notes?: string;
  dueAt?: string;
  kind: "reminder" | "task";
  createdAt: string;
  completedAt?: string;
}

interface ReminderStore {
  version: 1;
  items: Reminder[];
}

const MAX_ITEMS = 1000;

function storePath(): string {
  return path.join(getDataDir(), "reminders.json");
}

async function loadStore(): Promise<ReminderStore> {
  try {
    const parsed = JSON.parse(await fs.readFile(storePath(), "utf8")) as Partial<ReminderStore>;
    return {
      version: 1,
      items: Array.isArray(parsed.items)
        ? parsed.items
            .filter(
              (item): item is Reminder =>
                Boolean(item && typeof item.id === "string" && typeof item.title === "string"),
            )
            .slice(-MAX_ITEMS)
        : [],
    };
  } catch {
    return { version: 1, items: [] };
  }
}

async function saveStore(store: ReminderStore): Promise<void> {
  const file = storePath();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.rename(temp, file);
}

export async function addReminder(input: {
  title: string;
  notes?: string;
  dueAt?: string;
  kind?: "reminder" | "task";
}): Promise<Reminder> {
  const title = input.title.trim().slice(0, 300);
  if (!title) throw new Error("A reminder title is required.");
  let dueAt: string | undefined;
  if (input.dueAt?.trim()) {
    const parsed = new Date(input.dueAt.trim());
    if (Number.isNaN(parsed.getTime())) {
      throw new Error("dueAt must be a valid date, for example 2026-11-30T09:00:00Z.");
    }
    dueAt = parsed.toISOString();
  }
  const reminder: Reminder = {
    id: `rem_${crypto.randomUUID().slice(0, 8)}`,
    title,
    notes: input.notes?.trim().slice(0, 2_000) || undefined,
    dueAt,
    kind: input.kind === "task" ? "task" : "reminder",
    createdAt: new Date().toISOString(),
  };
  const store = await loadStore();
  store.items.push(reminder);
  if (store.items.length > MAX_ITEMS) store.items = store.items.slice(-MAX_ITEMS);
  await saveStore(store);
  return reminder;
}

export async function listReminders(options: {
  includeCompleted?: boolean;
  kind?: "reminder" | "task";
} = {}): Promise<Reminder[]> {
  const store = await loadStore();
  return store.items
    .filter((item) => options.includeCompleted || !item.completedAt)
    .filter((item) => !options.kind || item.kind === options.kind)
    .sort((a, b) => {
      if (a.completedAt && !b.completedAt) return 1;
      if (!a.completedAt && b.completedAt) return -1;
      if (a.dueAt && b.dueAt) return a.dueAt.localeCompare(b.dueAt);
      if (a.dueAt) return -1;
      if (b.dueAt) return 1;
      return b.createdAt.localeCompare(a.createdAt);
    });
}

export async function completeReminder(input: {
  id?: string;
  title?: string;
}): Promise<{ reminder: Reminder; alreadyCompleted: boolean }> {
  const store = await loadStore();
  const byId = input.id?.trim();
  const byTitle = input.title?.trim().toLowerCase();
  const match = store.items.find((item) =>
    byId ? item.id === byId : byTitle ? item.title.toLowerCase() === byTitle : false,
  );
  if (!match) throw new Error("No matching reminder or task was found.");
  if (match.completedAt) return { reminder: match, alreadyCompleted: true };
  match.completedAt = new Date().toISOString();
  await saveStore(store);
  return { reminder: match, alreadyCompleted: false };
}
