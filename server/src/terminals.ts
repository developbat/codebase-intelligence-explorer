import crypto from "node:crypto";
import fs from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import type { TerminalSessionInfo, TerminalStreamEvent } from "../../shared/types";

const MAX_TERMINALS_PER_PROJECT = 6;
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 24;
const MAX_BUFFER = 240_000;
const MAX_INPUT_CHARS = 10_000;

const PTY_BRIDGE = String.raw`
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios

shell = sys.argv[1] if len(sys.argv) > 1 else "/bin/sh"
cols = int(sys.argv[2]) if len(sys.argv) > 2 else 100
rows = int(sys.argv[3]) if len(sys.argv) > 3 else 24
pid, master = pty.fork()
if pid == 0:
    try:
        os.execvp(shell, [shell, "-i"])
    except Exception:
        os._exit(127)

def resize(new_cols, new_rows):
    try:
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", new_rows, new_cols, 0, 0))
    except Exception:
        pass

resize(cols, rows)

def stop(signum, frame):
    try:
        os.killpg(pid, signal.SIGTERM)
    except Exception:
        pass
    try:
        os.killpg(pid, signal.SIGKILL)
    except Exception:
        pass
    os._exit(0)

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
stdin_fd = sys.stdin.fileno()
stdout_fd = sys.stdout.fileno()
control_fd = 3
control_buffer = b""

while True:
    watched = [stdin_fd, master]
    if control_fd is not None:
        watched.append(control_fd)
    try:
        ready, _, _ = select.select(watched, [], [])
    except InterruptedError:
        continue
    if control_fd is not None and control_fd in ready:
        data = os.read(control_fd, 256)
        if not data:
            control_fd = None
        else:
            control_buffer += data
            while b"\n" in control_buffer:
                line, control_buffer = control_buffer.split(b"\n", 1)
                parts = line.decode("utf-8", "replace").split()
                if len(parts) == 3 and parts[0] == "resize":
                    try:
                        resize(max(20, int(parts[1])), max(4, int(parts[2])))
                    except ValueError:
                        pass
    if stdin_fd in ready:
        data = os.read(stdin_fd, 4096)
        if not data:
            break
        os.write(master, data)
    if master in ready:
        try:
            data = os.read(master, 4096)
        except OSError:
            break
        if not data:
            break
        os.write(stdout_fd, data)

try:
    os.killpg(pid, signal.SIGHUP)
except Exception:
    pass
`;

interface InternalSession extends TerminalSessionInfo {
  child: ChildProcess;
  buffer: string;
  subscribers: Set<(event: TerminalStreamEvent) => void>;
}

const sessions = new Map<string, Map<string, InternalSession>>();
let cleanupRegistered = false;

function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  const cleanup = () => {
    for (const [projectId, map] of sessions) {
      for (const session of [...map.values()]) {
        try {
          closeTerminalSession(projectId, session.id);
        } catch {
          // best-effort shutdown cleanup
        }
      }
    }
  };
  process.once("exit", cleanup);
  process.once("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
}

function projectSessions(projectId: string): Map<string, InternalSession> {
  let map = sessions.get(projectId);
  if (!map) {
    map = new Map();
    sessions.set(projectId, map);
  }
  return map;
}

function publicInfo(session: InternalSession): TerminalSessionInfo {
  return {
    id: session.id,
    projectId: session.projectId,
    cwd: session.cwd,
    shell: session.shell,
    pid: session.pid,
    startedAt: session.startedAt,
    status: session.status,
    exitCode: session.exitCode,
  };
}

function broadcast(session: InternalSession, event: TerminalStreamEvent): void {
  for (const subscriber of [...session.subscribers]) {
    try {
      subscriber(event);
    } catch {
      session.subscribers.delete(subscriber);
    }
  }
}

function append(session: InternalSession, chunk: string): void {
  session.buffer = `${session.buffer}${chunk}`;
  if (session.buffer.length > MAX_BUFFER) {
    session.buffer = session.buffer.slice(session.buffer.length - MAX_BUFFER);
  }
  broadcast(session, { type: "output", chunk });
}

function killSession(session: InternalSession): void {
  if (!session.child.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-session.child.pid, "SIGTERM");
    else session.child.kill("SIGTERM");
  } catch {
    try {
      session.child.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
  setTimeout(() => {
    if (session.status !== "running" || !session.child.pid) return;
    try {
      if (process.platform !== "win32") process.kill(-session.child.pid, "SIGKILL");
      else session.child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }, 1_500).unref();
}

export async function createTerminalSession(
  rootPath: string,
  projectId: string,
  size?: { cols?: number; rows?: number },
): Promise<TerminalSessionInfo> {
  if (process.platform === "win32") {
    throw new Error("Interactive PTY terminals require macOS or Linux with python3.");
  }
  registerCleanup();
  const map = projectSessions(projectId);
  if (map.size >= MAX_TERMINALS_PER_PROJECT) {
    throw new Error(`Too many interactive terminals (max ${MAX_TERMINALS_PER_PROJECT}).`);
  }
  const realRoot = await fs.realpath(rootPath);
  const stat = await fs.stat(realRoot);
  if (!stat.isDirectory()) throw new Error("The project root is not a folder.");
  const shell = process.env.SHELL || "/bin/bash";
  const cols = Math.max(20, Math.min(400, Math.round(size?.cols ?? DEFAULT_COLS)));
  const rows = Math.max(4, Math.min(200, Math.round(size?.rows ?? DEFAULT_ROWS)));
  const id = crypto.randomUUID();
  const child = spawn("python3", ["-u", "-c", PTY_BRIDGE, shell, String(cols), String(rows)], {
    cwd: realRoot,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      FORCE_COLOR: "1",
    },
    detached: true,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });

  const session: InternalSession = {
    id,
    projectId,
    cwd: realRoot,
    shell,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    status: "running",
    exitCode: null,
    child,
    buffer: "",
    subscribers: new Set(),
  };
  map.set(id, session);

  child.stdout?.on("data", (chunk: Buffer) => append(session, chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => append(session, chunk.toString("utf8")));
  child.on("error", (error) => {
    session.status = "exited";
    session.exitCode = -1;
    append(session, `\n[terminal error] ${error.message}\n`);
    broadcast(session, { type: "exit", session: publicInfo(session) });
  });
  child.on("close", (code) => {
    if (session.status === "running") session.status = "exited";
    session.exitCode = code;
    broadcast(session, { type: "exit", session: publicInfo(session) });
  });
  return publicInfo(session);
}

export function listTerminalSessions(projectId: string): TerminalSessionInfo[] {
  return [...projectSessions(projectId).values()].map(publicInfo);
}

export function subscribeTerminal(
  projectId: string,
  sessionId: string,
  listener: (event: TerminalStreamEvent) => void,
): () => void {
  const session = projectSessions(projectId).get(sessionId);
  if (!session) throw new Error("Terminal session not found.");
  listener({ type: "start", session: publicInfo(session), buffer: session.buffer });
  if (session.status === "exited") {
    listener({ type: "exit", session: publicInfo(session) });
    return () => undefined;
  }
  session.subscribers.add(listener);
  return () => session.subscribers.delete(listener);
}

export function writeTerminalInput(projectId: string, sessionId: string, data: string): void {
  const session = projectSessions(projectId).get(sessionId);
  if (!session) throw new Error("Terminal session not found.");
  if (session.status !== "running") throw new Error("Terminal session has exited.");
  if (data.length > MAX_INPUT_CHARS) throw new Error("Terminal input is too long.");
  if (!session.child.stdin?.writable) throw new Error("Terminal input is not available.");
  session.child.stdin.write(data);
}

export function resizeTerminal(
  projectId: string,
  sessionId: string,
  cols: number,
  rows: number,
): void {
  const session = projectSessions(projectId).get(sessionId);
  if (!session) throw new Error("Terminal session not found.");
  if (session.status !== "running") return;
  const safeCols = Math.max(20, Math.min(400, Math.round(cols)));
  const safeRows = Math.max(4, Math.min(200, Math.round(rows)));
  const control = session.child.stdio[3];
  if (!control || !("write" in control) || !control.writable) return;
  control.write(`resize ${safeCols} ${safeRows}\n`);
}

export function interruptTerminal(projectId: string, sessionId: string): void {
  writeTerminalInput(projectId, sessionId, "\u0003");
}

export function closeTerminalSession(projectId: string, sessionId: string): TerminalSessionInfo {
  const map = projectSessions(projectId);
  const session = map.get(sessionId);
  if (!session) throw new Error("Terminal session not found.");
  if (session.status === "running") {
    session.status = "exited";
    session.exitCode = null;
    killSession(session);
  }
  map.delete(sessionId);
  broadcast(session, { type: "exit", session: publicInfo(session) });
  session.subscribers.clear();
  return publicInfo(session);
}

export function closeProjectTerminals(projectId: string): void {
  const map = projectSessions(projectId);
  for (const session of [...map.values()]) {
    try {
      closeTerminalSession(projectId, session.id);
    } catch {
      // best-effort cleanup
    }
  }
  sessions.delete(projectId);
}
