import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { attachLivePage, startLiveSession, stopLiveSession } from "./liveBrowser";
import type {
  BrowserCheckMetrics,
  BrowserCheckOptions,
  BrowserCheckResult,
  BrowserCheckStep,
  BrowserCheckStepResult,
} from "../../shared/browserCheck";

const MAX_STEPS = 30;
const DEFAULT_TIMEOUT = 8_000;

export interface BrowserCheckRunOptions extends BrowserCheckOptions {
  /** Stop the check and close the browser when the agent run is aborted. */
  signal?: AbortSignal;
  /** Stream JPEG frames to the in-app Live test panel. */
  live?: boolean;
}

const CHROME_CANDIDATES = [
  process.env.CIE_CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].filter((value): value is string => Boolean(value));

export async function browserExecutable(): Promise<string> {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  throw new Error(
    "No Chrome/Chromium executable found. Install Chrome or set CIE_CHROME_PATH for the preview inspector.",
  );
}

function previewUrl(projectId: string, requestedPath: string): string {
  const base = (process.env.CIE_BROWSER_BASE || `http://127.0.0.1:${process.env.PORT || 4317}`).replace(
    /\/+$/,
    "",
  );
  const relative = (requestedPath || "index.html").replace(/^\/+/, "");
  const encoded = relative.split("/").map(encodeURIComponent).join("/");
  return `${base}/api/projects/${encodeURIComponent(projectId)}/preview/${encoded}`;
}

/**
 * Resolve a browser-check target. Agents often put a running dev-server URL in
 * `path` instead of `url`; an absolute/localhost value must be used as-is, not
 * encoded into the static preview route.
 */
export function browserCheckTarget(
  projectId: string,
  requestedPath: string,
  explicitUrl?: string,
): string {
  const candidate = (explicitUrl ?? requestedPath ?? "").trim();
  const looksLikeUrl =
    /^(?:https?:)?\/\//i.test(candidate) ||
    /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|$)/i.test(candidate);
  if (looksLikeUrl) {
    const withScheme = /^https?:\/\//i.test(candidate) ? candidate : `http://${candidate}`;
    return localUrl(withScheme);
  }
  return previewUrl(projectId, requestedPath || "index.html");
}

function stepTimeout(step: BrowserCheckStep): number {
  return Math.max(500, Math.min(30_000, Number(step.timeoutMs) || DEFAULT_TIMEOUT));
}

function isSelectorStep(step: BrowserCheckStep): boolean {
  return [
    "click",
    "fill",
    "press",
    "expectText",
    "expectValue",
    "expectVisible",
    "expectCount",
    "expectStable",
  ].includes(step.action);
}

async function availableSelectors(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const selectors = new Set<string>();
    const add = (value: string) => {
      if (value && selectors.size < 40) selectors.add(value);
    };
    for (const element of [...document.querySelectorAll("button, input, textarea, select, a[href]")]) {
      const tag = element.tagName.toLowerCase();
      if (element.id) add(`#${element.id}`);
      for (const className of [...element.classList]) {
        if (className.length <= 50) add(`.${className}`);
      }
      if (element.getAttribute("name")) add(`${tag}[name="${element.getAttribute("name")}"]`);
    }
    for (const element of [...document.querySelectorAll("[data-testid], [aria-label]")]) {
      const testId = element.getAttribute("data-testid");
      if (testId) add(`[data-testid="${testId}"]`);
      const label = element.getAttribute("aria-label");
      if (label && label.length <= 60) add(`[aria-label="${label}"]`);
    }
    return [...selectors];
  });
}

async function runStep(page: Page, step: BrowserCheckStep): Promise<string> {
  const selector = step.selector?.trim();
  const value = step.value ?? "";
  if (
    ["click", "fill", "press", "expectText", "expectValue", "expectVisible", "expectCount", "expectStable"].includes(
      step.action,
    )
  ) {
    if (!selector) throw new Error("selector is required for this step.");
  }
  if (step.action === "click") {
    await page.locator(selector!).first().click({ timeout: stepTimeout(step) });
    return `Clicked ${selector}`;
  }
  if (step.action === "fill") {
    await page.locator(selector!).first().fill(value, { timeout: stepTimeout(step) });
    return `Filled ${selector}`;
  }
  if (step.action === "press") {
    await page.locator(selector!).first().press(value || "Enter", { timeout: stepTimeout(step) });
    return `Pressed ${value || "Enter"} on ${selector}`;
  }
  if (step.action === "expectText") {
    const expected = step.text ?? value;
    const text = (await page.locator(selector!).first().textContent({ timeout: stepTimeout(step) })) ?? "";
    if (!text.includes(expected)) {
      throw new Error(`Expected ${selector} to contain "${expected}", got "${text.slice(0, 180)}".`);
    }
    return `Found "${expected}" in ${selector}`;
  }
  if (step.action === "expectValue") {
    const expected = step.value ?? step.text ?? "";
    const actual = await page.locator(selector!).first().inputValue({ timeout: stepTimeout(step) });
    if (actual !== expected) {
      throw new Error(`Expected value "${expected}" in ${selector}, got "${actual.slice(0, 160)}".`);
    }
    return `Value matched in ${selector}`;
  }
  if (step.action === "expectVisible") {
    // SPAs and Streamlit dashboards render after the initial load event; wait
    // for visibility instead of failing on the first frame.
    const locator = page.locator(selector!).first();
    await locator.waitFor({ state: "visible", timeout: stepTimeout(step) });
    return `${selector} is visible`;
  }
  if (step.action === "expectCount") {
    const expected = Math.max(0, Number(step.count) || 0);
    const actual = await page.locator(selector!).count();
    if (actual !== expected) {
      throw new Error(`Expected ${expected} elements for ${selector}, got ${actual}.`);
    }
    return `${selector} count is ${actual}`;
  }
  if (step.action === "expectStable") {
    const duration = Math.max(300, Math.min(10_000, Number(step.durationMs) || 1_000));
    const maxChanges = Math.max(0, Math.min(50, Number(step.maxChanges ?? 0) || 0));
    const values: string[] = [];
    const startedAt = Date.now();
    while (Date.now() - startedAt < duration) {
      const text = ((await page.locator(selector!).first().textContent()) ?? "").trim();
      if (values.length === 0 || values[values.length - 1] !== text) values.push(text);
      await page.waitForTimeout(100);
    }
    const changes = Math.max(0, values.length - 1);
    if (changes > maxChanges) {
      throw new Error(
        `${selector} changed ${changes} times in ${duration}ms (allowed ${maxChanges}). Values: ${values
          .slice(0, 6)
          .map((item) => `"${item.slice(0, 80)}"`)
          .join(" → ")}`,
      );
    }
    return `${selector} stayed stable for ${duration}ms${maxChanges > 0 ? ` (${changes} changes)` : ""}`;
  }
  if (step.action === "waitForText") {
    const text = step.text ?? value;
    if (!text) throw new Error("text is required for waitForText.");
    await page.waitForFunction(
      (needle) => document.body?.innerText.includes(needle),
      text,
      { timeout: stepTimeout(step) },
    );
    return `Saw text "${text}"`;
  }
  if (step.action === "waitForSelector") {
    if (!selector) throw new Error("selector is required for waitForSelector.");
    await page.locator(selector).first().waitFor({ state: "visible", timeout: stepTimeout(step) });
    return `${selector} appeared`;
  }
  if (step.action === "reload") {
    await page.reload({ waitUntil: "load", timeout: stepTimeout(step) });
    return "Reloaded page";
  }
  if (step.action === "eval") {
    const code = (step.value ?? step.text ?? "").trim();
    if (!code) throw new Error("value is required for eval.");
    if (code.length > 8_000) throw new Error("eval code is limited to 8000 characters.");
    const result = await page.evaluate(code).catch((error: unknown) => {
      throw new Error(`Page script failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    const text =
      typeof result === "string" ? result : result === undefined ? "" : JSON.stringify(result);
    const expected = step.expectText ?? step.text;
    if (expected && !text.includes(expected)) {
      throw new Error(
        `Eval expected "${expected}" but got: ${text.slice(0, 400) || "(empty)"}`,
      );
    }
    return `Page script result: ${text.slice(0, 600) || "(empty)"}`;
  }
  if (step.action === "storageGet") {
    const key = step.key ?? step.selector ?? "";
    if (!key) throw new Error("key is required for storageGet.");
    const actual = await page.evaluate((storageKey) => window.localStorage.getItem(storageKey), key);
    const expected = step.value ?? step.text;
    if (expected !== undefined && expected !== "" && !(actual ?? "").includes(expected)) {
      throw new Error(`localStorage "${key}" does not contain "${expected}".`);
    }
    return `localStorage "${key}" = ${String(actual).slice(0, 200)}`;
  }
  throw new Error(`Unknown browser check action "${step.action}".`);
}

async function collectMetrics(page: Page, viewport: { width: number; height: number }): Promise<BrowserCheckMetrics> {
  const metrics = await page.evaluate(() => {
    const images = [...document.querySelectorAll("img")] as HTMLImageElement[];
    return {
      title: document.title,
      bodyLength: document.body?.innerText.length ?? 0,
      buttons: document.querySelectorAll("button").length,
      inputs: document.querySelectorAll("input, textarea, select").length,
      links: document.querySelectorAll("a[href]").length,
      images: images.length,
      brokenImages: images.filter((image) => image.complete && image.naturalWidth === 0).length,
      horizontalOverflow:
        document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
      canvases: document.querySelectorAll("canvas").length,
      canvasWidth: document.querySelector("canvas")?.width,
      canvasHeight: document.querySelector("canvas")?.height,
    };
  });
  return {
    ...metrics,
    url: page.url(),
    viewport,
  };
}

function localUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Browser check URL is invalid.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Browser check URL must start with http:// or https://.");
  }
  if (!["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"].includes(parsed.hostname)) {
    throw new Error("Browser check URL must point to localhost.");
  }
  return parsed.toString();
}

export async function runBrowserCheck(
  projectId: string,
  rootPath: string,
  options: BrowserCheckRunOptions = {},
): Promise<BrowserCheckResult> {
  const aborted = () => new Error("Browser check stopped by the user.");
  if (options.signal?.aborted) throw aborted();
  const executablePath = await browserExecutable();
  const timeoutMs = Math.max(5_000, Math.min(120_000, options.timeoutMs ?? 30_000));
  const steps = (options.steps ?? []).slice(0, MAX_STEPS);
  let requestedPath = options.path?.trim() || "index.html";
  if (path.isAbsolute(requestedPath)) {
    const relative = path.relative(rootPath, requestedPath).replace(/\\/g, "/");
    if (relative.startsWith("..")) {
      throw new Error("Browser check path is outside the project.");
    }
    requestedPath = relative || "index.html";
  }
  requestedPath = requestedPath.replace(/^\/+/, "");
  const viewport = options.mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 };
  let browser: Browser | null = null;
  let consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const resourceErrors: string[] = [];
  const stepResults: BrowserCheckStepResult[] = [];
  let page: Page | null = null;
  let showingWindow = options.visible === true && process.env.CIE_BROWSER_HEADLESS !== "1";
  if (options.live) startLiveSession(projectId, requestedPath);
  const closeOnAbort = () => {
    void browser?.close().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", closeOnAbort, { once: true });
  try {
    const launch = (headless: boolean) =>
      chromium.launch({
        headless,
        executablePath,
        timeout: timeoutMs,
        slowMo: headless ? 0 : 120,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      });
    try {
      browser = await launch(!showingWindow);
    } catch (error) {
      if (!showingWindow) throw error;
      // A server without a display can still verify headlessly.
      showingWindow = false;
      browser = await launch(true);
    }
    const context = await browser.newContext({ viewport });
    page = await context.newPage();
    if (options.live) attachLivePage(projectId, page, requestedPath);
    if (showingWindow) await page.bringToFront().catch(() => undefined);
    page.setDefaultTimeout(Math.min(10_000, timeoutMs));
    page.on("console", (message) => {
      if (message.type() === "error" && consoleErrors.length < 40) consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => {
      if (pageErrors.length < 20) pageErrors.push(error.message);
    });
    page.on("response", (response) => {
      if (response.status() >= 400 && resourceErrors.length < 40) {
        resourceErrors.push(`${response.status()} ${response.url()}`);
      }
    });
    const url = browserCheckTarget(projectId, requestedPath, options.url);
    const response = await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
    if (response && !response.ok()) {
      throw new Error(`Preview page returned HTTP ${response.status()}.`);
    }
    await page.waitForTimeout(250);

    for (let index = 0; index < steps.length; index += 1) {
      if (options.signal?.aborted) throw aborted();
      const step = steps[index];
      const started = Date.now();
      try {
        const detail = await runStep(page, step);
        stepResults.push({
          index: index + 1,
          action: step.action,
          ok: true,
          detail,
          durationMs: Date.now() - started,
        });
        if (showingWindow) await page.waitForTimeout(220);
      } catch (error) {
        let detail = error instanceof Error ? error.message : "Step failed.";
        if (isSelectorStep(step)) {
          const hints = await availableSelectors(page).catch(() => []);
          if (hints.length > 0) {
            detail += `\nAvailable selectors: ${hints.slice(0, 30).join(", ")}`;
          }
        }
        stepResults.push({
          index: index + 1,
          action: step.action,
          ok: false,
          detail,
          durationMs: Date.now() - started,
        });
      }
      if (options.signal?.aborted) throw aborted();
    }

    const metrics = await collectMetrics(page, viewport);
    if (options.measureFps && metrics.canvases > 0) {
      metrics.fps = (await page.evaluate(`new Promise((resolve) => {
        let frames = 0;
        const started = performance.now();
        const tick = (now) => {
          frames += 1;
          if (now - started >= 1000) {
            resolve(Math.round((frames * 1000) / Math.max(1, now - started)));
          } else {
            requestAnimationFrame(tick);
          }
        };
        requestAnimationFrame(tick);
      })`)) as number;
    }
    let screenshotPath: string | undefined;
    if (options.screenshot) {
      const relative = `.cie/agent/screenshots/check-${Date.now()}.png`;
      const absolute = path.join(rootPath, relative);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await page.screenshot({ path: absolute, fullPage: true });
      screenshotPath = relative;
    }
    const failedSteps = stepResults.filter((step) => !step.ok);
    const meaningfulResourceErrors = resourceErrors.filter(
      (entry) => !/favicon\.ico/i.test(entry),
    );
    if (meaningfulResourceErrors.length === 0) {
      consoleErrors = consoleErrors.filter(
        (message) => !/^Failed to load resource/i.test(message),
      );
    }
    const ok =
      failedSteps.length === 0 &&
      consoleErrors.length === 0 &&
      pageErrors.length === 0 &&
      meaningfulResourceErrors.length === 0 &&
      metrics.brokenImages === 0 &&
      !metrics.horizontalOverflow;
    const summary = [
      ok ? "Browser check passed." : "Browser check found problems.",
      `${metrics.title || "(no title)"} · ${metrics.buttons} buttons · ${metrics.inputs} inputs${
        metrics.canvases > 0 ? ` · ${metrics.canvases} canvas` : ""
      }${metrics.fps ? ` · ${metrics.fps} fps` : ""}`,
      failedSteps.length > 0 ? `Failed steps: ${failedSteps.map((step) => step.index).join(", ")}` : "",
      consoleErrors.length > 0 ? `Console errors: ${consoleErrors.length}` : "",
      pageErrors.length > 0 ? `Page errors: ${pageErrors.length}` : "",
      meaningfulResourceErrors.length > 0
        ? `Resource errors: ${meaningfulResourceErrors.slice(0, 5).join(", ")}`
        : "",
      metrics.brokenImages > 0 ? `Broken images: ${metrics.brokenImages}` : "",
      metrics.horizontalOverflow ? "Horizontal overflow detected." : "",
      screenshotPath ? `Screenshot: ${screenshotPath}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return {
      ok,
      path: options.url ?? requestedPath,
      summary,
      steps: stepResults,
      consoleErrors,
      pageErrors,
      resourceErrors: meaningfulResourceErrors,
      metrics,
      screenshotPath,
    };
  } finally {
    options.signal?.removeEventListener("abort", closeOnAbort);
    if (options.live) stopLiveSession(projectId);
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}

export function isBrowserCheckAvailable(): Promise<boolean> {
  return browserExecutable()
    .then(() => true)
    .catch(() => false);
}
