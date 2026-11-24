import type { Response } from "express";
import type { Page } from "playwright-core";

const BOUNDARY = "cie-live-frame";
const FRAME_INTERVAL_MS = 260;
const JPEG_QUALITY = 55;
const MAX_SUBSCRIBERS = 8;

interface LiveSession {
  projectId: string;
  label: string;
  startedAt: string;
  page: Page | null;
  frame: Buffer | null;
  frameAt: string | null;
  frameCount: number;
  timer: NodeJS.Timeout | null;
  capturing: boolean;
  subscribers: Set<Response>;
}

const sessions = new Map<string, LiveSession>();

function nowIso(): string {
  return new Date().toISOString();
}

function writeFrame(response: Response, frame: Buffer): void {
  if (response.writableEnded || response.destroyed) return;
  response.write(`--${BOUNDARY}\r\n`);
  response.write("Content-Type: image/jpeg\r\n");
  response.write(`Content-Length: ${frame.length}\r\n\r\n`);
  response.write(frame);
  response.write("\r\n");
}

async function capture(session: LiveSession): Promise<void> {
  if (session.capturing || !session.page || session.page.isClosed()) return;
  session.capturing = true;
  try {
    const frame = await session.page.screenshot({
      type: "jpeg",
      quality: JPEG_QUALITY,
      animations: "disabled",
    });
    session.frame = frame;
    session.frameAt = nowIso();
    session.frameCount += 1;
    for (const response of session.subscribers) {
      writeFrame(response, frame);
    }
  } catch {
    // A closing page is expected during Stop/abort.
  } finally {
    session.capturing = false;
  }
}

export function startLiveSession(projectId: string, label: string): void {
  stopLiveSession(projectId);
  sessions.set(projectId, {
    projectId,
    label,
    startedAt: nowIso(),
    page: null,
    frame: null,
    frameAt: null,
    frameCount: 0,
    timer: null,
    capturing: false,
    subscribers: new Set(),
  });
}

export function attachLivePage(projectId: string, page: Page, label?: string): void {
  let session = sessions.get(projectId);
  if (!session) {
    startLiveSession(projectId, label ?? "Live test");
    session = sessions.get(projectId);
  }
  if (!session) return;
  session.page = page;
  if (label) session.label = label;
  if (session.timer) clearInterval(session.timer);
  session.timer = setInterval(() => {
    void capture(session);
  }, FRAME_INTERVAL_MS);
  void capture(session);
}

export function stopLiveSession(projectId: string): void {
  const session = sessions.get(projectId);
  if (!session) return;
  if (session.timer) clearInterval(session.timer);
  session.timer = null;
  session.page = null;
  for (const response of session.subscribers) {
    if (!response.writableEnded && !response.destroyed) {
      response.write(`--${BOUNDARY}--\r\n`);
      response.end();
    }
  }
  session.subscribers.clear();
  sessions.delete(projectId);
}

export function liveSessionStatus(projectId: string): {
  active: boolean;
  label: string;
  startedAt: string | null;
  frameAt: string | null;
  frameCount: number;
  hasFrame: boolean;
  subscribers: number;
} {
  const session = sessions.get(projectId);
  if (!session) {
    return {
      active: false,
      label: "",
      startedAt: null,
      frameAt: null,
      frameCount: 0,
      hasFrame: false,
      subscribers: 0,
    };
  }
  return {
    active: true,
    label: session.label,
    startedAt: session.startedAt,
    frameAt: session.frameAt,
    frameCount: session.frameCount,
    hasFrame: Boolean(session.frame),
    subscribers: session.subscribers.size,
  };
}

export function streamLiveSession(projectId: string, response: Response): void {
  const startedAt = Date.now();
  const connect = () => {
    if (response.writableEnded || response.destroyed) return;
    const session = sessions.get(projectId);
    if (!session) {
      // The UI may connect from the "Live browser opened" log just before the
      // browser page exists. Wait briefly instead of returning a broken image.
      if (Date.now() - startedAt < 12_000) {
        setTimeout(connect, 180);
        return;
      }
      response.status(204).end();
      return;
    }
    if (session.subscribers.size >= MAX_SUBSCRIBERS) {
      response.status(429).end();
      return;
    }
    response.status(200);
    response.setHeader("Content-Type", `multipart/x-mixed-replace; boundary=${BOUNDARY}`);
    response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    response.setHeader("Pragma", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders?.();
    session.subscribers.add(response);
    if (session.frame) writeFrame(response, session.frame);

    const cleanup = () => {
      session.subscribers.delete(response);
    };
    response.on("close", cleanup);
    response.on("error", cleanup);
  };
  connect();
}
