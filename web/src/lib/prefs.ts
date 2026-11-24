import { useEffect, useState } from "react";

export interface StudioPrefs {
  agentAllowWrite: boolean;
  agentAllowCommands: boolean;
  autoFormat: boolean;
  autoSyntax: boolean;
  autoCheck: boolean;
  testTimeout: number;
}

const EVENT = "cie:prefs-change";

function read(): StudioPrefs {
  return {
    agentAllowWrite: localStorage.getItem("cie:agent-write") !== "off",
    agentAllowCommands: localStorage.getItem("cie:agent-commands") === "on",
    autoFormat: localStorage.getItem("cie:auto-format") === "on",
    autoSyntax: localStorage.getItem("cie:auto-syntax") !== "off",
    autoCheck: localStorage.getItem("cie:auto-check") === "on",
    testTimeout: Number(localStorage.getItem("cie:test-timeout")) || 300,
  };
}

function write(next: StudioPrefs): void {
  localStorage.setItem("cie:agent-write", next.agentAllowWrite ? "on" : "off");
  localStorage.setItem("cie:agent-commands", next.agentAllowCommands ? "on" : "off");
  localStorage.setItem("cie:auto-format", next.autoFormat ? "on" : "off");
  localStorage.setItem("cie:auto-syntax", next.autoSyntax ? "on" : "off");
  localStorage.setItem("cie:auto-check", next.autoCheck ? "on" : "off");
  localStorage.setItem("cie:test-timeout", String(next.testTimeout));
  window.dispatchEvent(new CustomEvent(EVENT));
}

let shared: StudioPrefs | null = null;

function current(): StudioPrefs {
  if (!shared) shared = read();
  return shared;
}

export function updateStudioPrefs(patch: Partial<StudioPrefs>): void {
  shared = { ...current(), ...patch };
  write(shared);
}

export function useStudioPrefs(): StudioPrefs {
  const [prefs, setPrefs] = useState<StudioPrefs>(() => current());

  useEffect(() => {
    const sync = () => setPrefs({ ...current() });
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  return prefs;
}
