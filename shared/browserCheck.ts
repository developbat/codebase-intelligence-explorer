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
  /** Accepted aliases for eval code; normalized before execution. */
  expression?: string;
  code?: string;
  script?: string;
  /** Accepted aliases for expected text; normalized before execution. */
  contains?: string;
  expected?: string;
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
  /** Stream the test page into the in-app Live test panel. */
  live?: boolean;
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

const BROWSER_ACTIONS: BrowserCheckAction[] = [
  "click",
  "fill",
  "press",
  "expectText",
  "expectValue",
  "expectVisible",
  "expectCount",
  "expectStable",
  "waitForText",
  "waitForSelector",
  "reload",
  "eval",
  "storageGet",
];

const CANONICAL_ACTION: Record<string, BrowserCheckAction> = {
  click: "click",
  fill: "fill",
  press: "press",
  expecttext: "expectText",
  expectvalue: "expectValue",
  expectvisible: "expectVisible",
  expectcount: "expectCount",
  expectstable: "expectStable",
  waitfortext: "waitForText",
  waitforselector: "waitForSelector",
  reload: "reload",
  eval: "eval",
  storageget: "storageGet",
};

function stepText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Accept the aliases models commonly invent (`expression`/`code` for eval,
 * `wait` for a selector/text wait) and validate every step before a browser is
 * launched. The returned steps are safe to run as-is.
 */
export function normalizeBrowserSteps(raw: unknown): BrowserCheckStep[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error('Browser check "steps" must be an array.');
  }
  const errors: string[] = [];
  const steps: BrowserCheckStep[] = [];
  raw.forEach((item, index) => {
    const label = `Step ${index + 1}`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push(`${label}: expected an object like {"action":"click","selector":"#play"}.`);
      return;
    }
    const input = item as Record<string, unknown>;
    const rawAction = stepText(input.action ?? input.type) ?? "";
    if (!rawAction) {
      errors.push(`${label}: "action" is required. Valid actions: ${BROWSER_ACTIONS.join(", ")}.`);
      return;
    }
    const lower = rawAction.toLowerCase();
    let action: BrowserCheckAction | undefined = CANONICAL_ACTION[lower];
    if (!action && lower === "wait") {
      action = stepText(input.selector)
        ? "waitForSelector"
        : stepText(input.text ?? input.value ?? input.contains)
          ? "waitForText"
          : undefined;
      if (!action) {
        errors.push(
          `${label}: "wait" needs "selector" (wait for an element) or "text" (wait for page text).`,
        );
        return;
      }
    }
    if (!action) {
      errors.push(
        `${label}: unknown action "${rawAction}". Valid actions: ${BROWSER_ACTIONS.join(", ")}.`,
      );
      return;
    }

    const step: BrowserCheckStep = { action };
    const selector = stepText(input.selector);
    if (selector) step.selector = selector;
    const timeout = Number(input.timeoutMs);
    if (Number.isFinite(timeout) && timeout > 0) step.timeoutMs = timeout;

    const needsSelector = new Set<BrowserCheckAction>([
      "click",
      "fill",
      "expectText",
      "expectValue",
      "expectVisible",
      "expectCount",
      "expectStable",
      "waitForSelector",
    ]);
    if (needsSelector.has(action) && !step.selector) {
      errors.push(
        `${label} (${action}): "selector" is required. Use a real project selector such as "#play" or "body".`,
      );
      return;
    }

    if (action === "fill") {
      const value = stepText(input.value ?? input.text);
      if (value === undefined) {
        errors.push(`${label} (fill): "value" is required.`);
        return;
      }
      step.value = value;
    } else if (action === "press") {
      step.selector = step.selector ?? "body";
      step.value = stepText(input.value ?? input.text ?? input.key) ?? "Enter";
    } else if (action === "expectText") {
      const expected = stepText(input.text ?? input.value ?? input.contains ?? input.expected);
      if (expected === undefined) {
        errors.push(`${label} (expectText): "text" is required.`);
        return;
      }
      step.text = expected;
    } else if (action === "expectValue") {
      const expected = stepText(input.value ?? input.text ?? input.expected);
      if (expected === undefined) {
        errors.push(`${label} (expectValue): "value" is required.`);
        return;
      }
      step.value = expected;
    } else if (action === "expectCount") {
      const count = Number(input.count);
      if (!Number.isFinite(count) || count < 0) {
        errors.push(`${label} (expectCount): "count" must be a non-negative number.`);
        return;
      }
      step.count = count;
    } else if (action === "expectStable") {
      const duration = Number(input.durationMs);
      if (Number.isFinite(duration) && duration > 0) step.durationMs = duration;
      const maxChanges = Number(input.maxChanges);
      if (Number.isFinite(maxChanges) && maxChanges >= 0) step.maxChanges = maxChanges;
    } else if (action === "waitForText") {
      const expected = stepText(input.text ?? input.value ?? input.contains ?? input.expected);
      if (expected === undefined) {
        errors.push(`${label} (waitForText): "text" is required.`);
        return;
      }
      step.text = expected;
    } else if (action === "eval") {
      const code = stepText(input.value ?? input.expression ?? input.code ?? input.script ?? input.text);
      if (code === undefined) {
        const received = Object.keys(input).join(", ") || "none";
        errors.push(
          `${label} (eval): "value" with the JavaScript expression is required (received keys: ${received}). Example: {"action":"eval","value":"document.title"}.`,
        );
        return;
      }
      step.value = code;
      const expected = stepText(input.expectText ?? input.contains ?? input.expected);
      if (expected !== undefined) step.expectText = expected;
    } else if (action === "storageGet") {
      const key = stepText(input.key ?? input.selector);
      if (!key) {
        errors.push(`${label} (storageGet): "key" is required.`);
        return;
      }
      step.key = key;
      const expected = stepText(input.value ?? input.text ?? input.expected);
      if (expected !== undefined) step.value = expected;
    }

    steps.push(step);
  });

  if (errors.length > 0) {
    throw new Error(
      `Invalid browser check steps:\n- ${errors.join("\n- ")}\nFix these steps before the browser is opened.`,
    );
  }
  return steps;
}
