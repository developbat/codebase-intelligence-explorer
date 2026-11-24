import type { BrowserCheckOptions, BrowserCheckResult } from "./browserCheck";

export interface GameCheckOptions extends BrowserCheckOptions {
  engineHint?: string;
  /** Stop the check and close the browser when the agent run is aborted. */
  signal?: AbortSignal;
}

export interface GameCheckResult {
  engine: string;
  check: BrowserCheckResult;
  summary: string;
}
