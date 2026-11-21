import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { TerminalSessionInfo } from "../../../shared/types";
import { api } from "../api";

interface ShellTerminalViewProps {
  projectId: string;
  sessionId: string;
  onExit: (session: TerminalSessionInfo) => void;
  onError: (message: string) => void;
}

export function ShellTerminalView({
  projectId,
  sessionId,
  onExit,
  onError,
}: ShellTerminalViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onExitRef = useRef(onExit);
  const onErrorRef = useRef(onError);
  onExitRef.current = onExit;
  onErrorRef.current = onError;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 11,
      lineHeight: 1.35,
      scrollback: 5000,
      theme: {
        background: "#04070b",
        foreground: "#c5dcff",
        cursor: "#5eead4",
        selectionBackground: "rgba(110, 168, 254, 0.3)",
        black: "#0b111a",
        red: "#e59aa6",
        green: "#8ed3b6",
        yellow: "#e6c284",
        blue: "#8fbfff",
        magenta: "#c8b8f5",
        cyan: "#7dd3fc",
        white: "#d6e8ff",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    let disposed = false;
    let resizeTimer: number | null = null;
    const sendSize = () => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        if (disposed) return;
        void api.terminals
          .resize(projectId, sessionId, terminal.cols, terminal.rows)
          .catch(() => {
            // resizing is best-effort; the shell still works at the old size
          });
      }, 140);
    };
    const fitSoon = () => {
      try {
        fit.fit();
        sendSize();
      } catch {
        // container may be hidden while switching tabs
      }
    };
    requestAnimationFrame(fitSoon);
    terminal.focus();

    const input = terminal.onData((data) => {
      void api.terminals.input(projectId, sessionId, data).catch((error: unknown) => {
        onErrorRef.current(error instanceof Error ? error.message : "Terminal input failed.");
      });
    });
    const controller = new AbortController();
    const observer = new ResizeObserver(fitSoon);
    observer.observe(container);

    void api.terminals
      .stream(
        projectId,
        sessionId,
        (event) => {
          if (disposed) return;
          if (event.type === "start") {
            if (event.buffer) terminal.write(event.buffer);
          } else if (event.type === "output") {
            terminal.write(event.chunk);
          } else if (event.type === "exit") {
            terminal.write(`\\r\\n\\x1b[2m[terminal exited${event.session.exitCode === null ? "" : ` · ${event.session.exitCode}`}]\\x1b[0m\\r\\n`);
            onExitRef.current(event.session);
          } else if (event.type === "error") {
            terminal.write(`\\r\\n\\x1b[31m${event.message}\\x1b[0m\\r\\n`);
            onErrorRef.current(event.message);
          }
        },
        controller.signal,
      )
      .catch((error: unknown) => {
        if (disposed) return;
        onErrorRef.current(error instanceof Error ? error.message : "Terminal stream failed.");
      });

    return () => {
      disposed = true;
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      controller.abort();
      observer.disconnect();
      input.dispose();
      terminal.dispose();
    };
  }, [projectId, sessionId]);

  return <div className="studio-shell-term" ref={containerRef} />;
}
