export type DesktopUpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error";

export interface DesktopUpdateState {
  supported: boolean;
  status: DesktopUpdateStatus;
  currentVersion: string;
  latestVersion: string | null;
  progress: number | null;
  message: string;
  releaseUrl: string | null;
  platform: string;
  arch: string;
}

export interface DesktopUpdatesBridge {
  getState: () => Promise<DesktopUpdateState>;
  check: () => Promise<DesktopUpdateState>;
  download: () => Promise<DesktopUpdateState>;
  install: () => Promise<DesktopUpdateState>;
  onState: (callback: (state: DesktopUpdateState) => void) => () => void;
}

interface BadDesktopBridge {
  isDesktop: boolean;
  platform: string;
  updates: DesktopUpdatesBridge;
}

declare global {
  interface Window {
    badDesktop?: BadDesktopBridge;
  }
}

/** Returns the Electron update bridge, or null when running in a plain browser. */
export function desktopUpdates(): DesktopUpdatesBridge | null {
  if (typeof window === "undefined") return null;
  return window.badDesktop?.updates ?? null;
}
