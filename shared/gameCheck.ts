import type { BrowserCheckOptions, BrowserCheckResult } from "./browserCheck";

export interface GameCheckOptions extends BrowserCheckOptions {
  engineHint?: string;
}

export interface GameCheckResult {
  engine: string;
  check: BrowserCheckResult;
  summary: string;
}
