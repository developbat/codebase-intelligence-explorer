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

function readGlobal(): StudioPrefs {
  return {
    agentAllowWrite: localStorage.getItem("cie:agent-write") !== "off",
    agentAllowCommands: localStorage.getItem("cie:agent-commands") === "on",
    autoFormat: localStorage.getItem("cie:auto-format") === "on",
    autoSyntax: localStorage.getItem("cie:auto-syntax") !== "off",
    autoCheck: localStorage.getItem("cie:auto-check") === "on",
    testTimeout: Number(localStorage.getItem("cie:test-timeout")) || 300,
  };
}

function read(projectId?: string): StudioPrefs {
  const prefs = readGlobal();
  if (!projectId) return prefs;
  const write = localStorage.getItem(`cie:agent-write:${projectId}`);
  const commands = localStorage.getItem(`cie:agent-commands:${projectId}`);
  if (write === "on" || write === "off") prefs.agentAllowWrite = write === "on";
  if (commands === "on" || commands === "off") {
    prefs.agentAllowCommands = commands === "on";
  }
  return prefs;
}

function writeGlobal(next: StudioPrefs): void {
  localStorage.setItem("cie:agent-write", next.agentAllowWrite ? "on" : "off");
  localStorage.setItem("cie:agent-commands", next.agentAllowCommands ? "on" : "off");
  localStorage.setItem("cie:auto-format", next.autoFormat ? "on" : "off");
  localStorage.setItem("cie:auto-syntax", next.autoSyntax ? "on" : "off");
  localStorage.setItem("cie:auto-check", next.autoCheck ? "on" : "off");
  localStorage.setItem("cie:test-timeout", String(next.testTimeout));
}

/**
 * Write a preference patch. When `projectId` is set and the patch contains an
 * agent permission, the override is stored per project; the global value stays
 * the default for projects without an override.
 */
export function updateStudioPrefs(
  patch: Partial<StudioPrefs>,
  projectId?: string,
): void {
  const scopedPermissions =
    Boolean(projectId) &&
    (patch.agentAllowWrite !== undefined || patch.agentAllowCommands !== undefined);

  if (scopedPermissions && projectId) {
    if (patch.agentAllowWrite !== undefined) {
      localStorage.setItem(
        `cie:agent-write:${projectId}`,
        patch.agentAllowWrite ? "on" : "off",
      );
    }
    if (patch.agentAllowCommands !== undefined) {
      localStorage.setItem(
        `cie:agent-commands:${projectId}`,
        patch.agentAllowCommands ? "on" : "off",
      );
    }
  }

  const globalPatch: Partial<StudioPrefs> = { ...patch };
  if (scopedPermissions) {
    delete globalPatch.agentAllowWrite;
    delete globalPatch.agentAllowCommands;
  }
  const nextGlobal = { ...readGlobal(), ...globalPatch };
  writeGlobal(nextGlobal);

  window.dispatchEvent(new CustomEvent(EVENT));
}

export function useStudioPrefs(projectId?: string): StudioPrefs {
  const [prefs, setPrefs] = useState<StudioPrefs>(() => read(projectId));

  useEffect(() => {
    const sync = () => setPrefs(read(projectId));
    sync();
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, [projectId]);

  return prefs;
}
