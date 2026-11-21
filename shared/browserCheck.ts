export type BrowserCheckAction =
  | "click"
  | "fill"
  | "press"
  | "expectText"
  | "expectValue"
  | "expectVisible"
  | "expectCount"
  | "waitForText"
  | "reload"
  | "storageGet";

export interface BrowserCheckStep {
  action: BrowserCheckAction;
  selector?: string;
  value?: string;
  text?: string;
  key?: string;
  count?: number;
  timeoutMs?: number;
}

export interface BrowserCheckOptions {
  path?: string;
  steps?: BrowserCheckStep[];
  mobile?: boolean;
  screenshot?: boolean;
  timeoutMs?: number;
}

export interface BrowserCheckStepResult {
  index: number;
  action: string;
  ok: boolean;
  detail: string;
  durationMs: number;
}

export interface BrowserCheckMetrics {
  title: string;
  url: string;
  bodyLength: number;
  buttons: number;
  inputs: number;
  links: number;
  images: number;
  brokenImages: number;
  horizontalOverflow: boolean;
  viewport: { width: number; height: number };
}

export interface BrowserCheckResult {
  ok: boolean;
  path: string;
  summary: string;
  steps: BrowserCheckStepResult[];
  consoleErrors: string[];
  pageErrors: string[];
  metrics: BrowserCheckMetrics;
  screenshotPath?: string;
}
