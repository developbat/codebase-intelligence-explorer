export type BrowserCheckAction =
  | "click"
  | "fill"
  | "press"
  | "expectText"
  | "expectValue"
  | "expectVisible"
  | "expectCount"
  | "expectStable"
  | "waitForText"
  | "waitForSelector"
  | "reload"
  | "eval"
  | "storageGet";

export interface BrowserCheckStep {
  action: BrowserCheckAction;
  selector?: string;
  value?: string;
  text?: string;
  /** Expected substring of the page script result for an eval step. */
  expectText?: string;
  key?: string;
  count?: number;
  timeoutMs?: number;
  /** expectStable: how long to sample the element. Default 1000ms. */
  durationMs?: number;
  /** expectStable: allowed number of value changes during the sample. Default 0. */
  maxChanges?: number;
}

export interface BrowserCheckOptions {
  path?: string;
  url?: string;
  steps?: BrowserCheckStep[];
  mobile?: boolean;
  screenshot?: boolean;
  timeoutMs?: number;
  measureFps?: boolean;
  /** Open a visible local Chrome window while the check runs. */
  visible?: boolean;
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
  canvases: number;
  canvasWidth?: number;
  canvasHeight?: number;
  fps?: number;
  viewport: { width: number; height: number };
}

export interface BrowserCheckResult {
  ok: boolean;
  path: string;
  summary: string;
  steps: BrowserCheckStepResult[];
  consoleErrors: string[];
  pageErrors: string[];
  resourceErrors: string[];
  metrics: BrowserCheckMetrics;
  screenshotPath?: string;
}
