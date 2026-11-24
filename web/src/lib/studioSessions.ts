import { useEffect, useMemo, useState } from "react";

export type StudioKind = "chat" | "image" | "video";

export interface StudioAssetRef {
  id?: string;
  url: string;
  kind: "image" | "video";
  title?: string;
  prompt?: string;
  provider?: string;
  model?: string;
  width?: number;
  height?: number;
  seed?: number;
  bytes?: number;
  duration?: number;
}

export interface StudioEntry {
  id: string;
  role: "user" | "assistant";
  type: "text" | "image" | "video" | "note";
  content: string;
  asset?: StudioAssetRef;
  provider?: string;
  model?: string;
  tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  costUsd?: number;
  attachment?: string;
  sources?: {
    url: string;
    title?: string;
    status?: number;
    error?: string;
    snippet?: string;
  }[];
  searchProvider?: string;
  createdAt: string;
}

export interface StudioSession {
  id: string;
  projectId: string;
  kind: StudioKind;
  title: string;
  createdAt: string;
  updatedAt: string;
  entries: StudioEntry[];
}

function storageKey(projectId: string): string {
  return `cie:studio-sessions:${projectId || "studio"}`;
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function loadStudioSessions(projectId: string, kind: StudioKind): StudioSession[] {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    const parsed = raw ? (JSON.parse(raw) as StudioSession[]) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((session) => session && session.kind === kind)
      .map((session) => ({
        ...session,
        projectId: session.projectId || projectId || "studio",
        entries: Array.isArray(session.entries) ? session.entries : [],
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

function saveAll(projectId: string, all: StudioSession[]): void {
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(all.slice(-80)));
  } catch {
    // storage may be unavailable
  }
}

export function makeStudioSession(projectId: string, kind: StudioKind, title = "New chat"): StudioSession {
  const at = new Date().toISOString();
  return {
    id: makeId(kind),
    projectId: projectId || "studio",
    kind,
    title,
    createdAt: at,
    updatedAt: at,
    entries: [],
  };
}

export function makeEntry(
  role: StudioEntry["role"],
  type: StudioEntry["type"],
  content: string,
  extra: Partial<StudioEntry> = {},
): StudioEntry {
  return {
    id: makeId("entry"),
    role,
    type,
    content,
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

export function sessionTitle(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 46 ? `${clean.slice(0, 46).trimEnd()}…` : clean || "New chat";
}

function readAll(projectId: string): StudioSession[] {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    const parsed = raw ? (JSON.parse(raw) as StudioSession[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function useStudioSessions(projectId: string, kind: StudioKind) {
  const scopedProject = projectId || "studio";
  const [sessions, setSessions] = useState<StudioSession[]>(() => loadStudioSessions(scopedProject, kind));
  const [activeId, setActiveId] = useState<string>("");

  useEffect(() => {
    const next = loadStudioSessions(scopedProject, kind);
    setSessions(next);
    setActiveId((current) =>
      current && next.some((session) => session.id === current) ? current : next[0]?.id ?? "",
    );
  }, [scopedProject, kind]);

  const active = useMemo(
    () => sessions.find((session) => session.id === activeId) ?? null,
    [sessions, activeId],
  );

  function persistWith(updater: (current: StudioSession[]) => StudioSession[]) {
    setSessions((current) => {
      const next = updater(current);
      const all = readAll(scopedProject);
      const otherKinds = all.filter((session) => session.kind !== kind);
      saveAll(scopedProject, [...otherKinds, ...next]);
      return next;
    });
  }

  function create(title = "New chat"): StudioSession {
    const session = makeStudioSession(scopedProject, kind, title);
    persistWith((current) => [session, ...current]);
    setActiveId(session.id);
    return session;
  }

  function update(next: StudioSession) {
    persistWith((current) =>
      current
        .map((session) =>
          session.id === next.id
            ? { ...next, updatedAt: new Date().toISOString() }
            : session,
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    );
  }

  function remove(id: string) {
    persistWith((current) => current.filter((session) => session.id !== id));
    if (activeId === id) {
      setActiveId(
        sessions.find((session) => session.id !== id)?.id ?? "",
      );
    }
  }

  function append(session: StudioSession, entry: StudioEntry): StudioSession {
    const firstUser = session.entries.find((item) => item.role === "user" && item.type === "text");
    const title =
      session.title === "New chat" && entry.role === "user" && entry.type === "text"
        ? sessionTitle(entry.content)
        : session.title === "New chat" && !firstUser && entry.content
          ? sessionTitle(entry.content)
          : session.title;
    const next = {
      ...session,
      title,
      entries: [...session.entries, entry],
      updatedAt: new Date().toISOString(),
    };
    update(next);
    return next;
  }

  return { sessions, active, activeId, setActiveId, create, update, remove, append };
}
