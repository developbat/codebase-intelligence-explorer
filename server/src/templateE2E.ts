import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { analyzeProject } from "./analyzer";
import { isBrowserCheckAvailable, runBrowserCheck } from "./browserCheck";
import { runProjectCommand } from "./editor";
import { planPythonEnvironment } from "./pythonRuntime";
import { listProjectTemplates, scaffoldProject } from "./scaffold";
import type { BrowserCheckStep } from "../../shared/browserCheck";
import type { AnalysisResult, ProjectTemplateId } from "../../shared/types";

type CaseCategory =
  | "static"
  | "node-build"
  | "node-server"
  | "python"
  | "php"
  | "expo"
  | "flutter"
  | "godot"
  | "blank";

interface TemplateE2ECase {
  id: ProjectTemplateId;
  category: CaseCategory;
  expected: string[];
  /** npm/pip/other install command. */
  install?: string;
  /** Commands that must exit 0. */
  verify?: string[];
  /** Static build directory to serve (React/Phaser/Three/Vite). */
  buildOutput?: string;
  /** Server command, health path and extra env. */
  server?: {
    command: string;
    health: string;
    env?: Record<string, string>;
  };
  /** Browser assertions against the static server or server base URL. */
  browser?: {
    steps: BrowserCheckStep[];
  };
}

const TEMPLATE_IDS: ProjectTemplateId[] = [
  "static",
  "react-vite",
  "node-express",
  "python-fastapi",
  "php-web",
  "blank",
  "canvas-game",
  "pwa-mobile",
  "expo-mobile",
  "flutter-mobile",
  "phaser-game",
  "three-scene",
  "godot-game",
];

const PARTIAL_CASES: Record<
  ProjectTemplateId,
  Omit<TemplateE2ECase, "id" | "expected">
> = {
  static: {
    category: "static",
    browser: {
      steps: [{ action: "expectVisible", selector: "body" }],
    },
  },
  "react-vite": {
    category: "node-build",
    install: "npm install --no-audit --no-fund",
    verify: ["npm run typecheck", "npm run build"],
    buildOutput: "dist",
    browser: { steps: [{ action: "expectVisible", selector: "body" }] },
  },
  "node-express": {
    category: "node-server",
    install: "npm install --no-audit --no-fund",
    verify: ["npm run typecheck", "npm run build"],
    server: { command: "npm start", health: "/api/health" },
  },
  "python-fastapi": {
    category: "python",
    verify: ["./.venv/bin/python -m pytest -q"],
    server: {
      command: "./.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1",
      health: "/api/health",
    },
  },
  "php-web": {
    category: "php",
    server: { command: "php -S 127.0.0.1", health: "/" },
  },
  blank: { category: "blank" },
  "canvas-game": {
    category: "static",
    browser: {
      steps: [
        { action: "expectVisible", selector: "canvas" },
        {
          action: "eval",
          value: `(() => {
            const canvas = document.querySelector('canvas');
            const rect = canvas.getBoundingClientRect();
            canvas.dispatchEvent(new PointerEvent('pointerdown', {
              clientX: rect.left + rect.width / 2,
              clientY: rect.top + rect.height / 2,
              bubbles: true,
              pointerId: 1,
            }));
            return JSON.stringify({
              canvas: document.querySelectorAll('canvas').length,
              score: document.querySelector('#score')?.textContent ?? null,
            });
          })()`,
          expectText: '"canvas":1',
        },
      ],
    },
  },
  "pwa-mobile": {
    category: "static",
    browser: {
      steps: [
        { action: "expectVisible", selector: "body" },
        {
          action: "eval",
          value:
            "JSON.stringify({manifest: Boolean(document.querySelector('link[rel=\"manifest\"]')), serviceWorker: 'serviceWorker' in navigator})",
          expectText: '"manifest":true',
        },
      ],
    },
  },
  "expo-mobile": {
    category: "expo",
    install: "npm install --no-audit --no-fund",
    verify: ["npm run typecheck"],
  },
  "flutter-mobile": {
    category: "flutter",
    verify: ["flutter pub get", "flutter test"],
  },
  "phaser-game": {
    category: "node-build",
    install: "npm install --no-audit --no-fund",
    verify: ["npm run typecheck", "npm run build"],
    buildOutput: "dist",
    browser: { steps: [{ action: "expectVisible", selector: "canvas" }] },
  },
  "three-scene": {
    category: "node-build",
    install: "npm install --no-audit --no-fund",
    verify: ["npm run typecheck", "npm run build"],
    buildOutput: "dist",
    browser: { steps: [{ action: "expectVisible", selector: "canvas" }] },
  },
  "godot-game": {
    category: "godot",
    verify: ["godot --headless --path . --quit"],
  },
};

export const TEMPLATE_E2E_CASES: TemplateE2ECase[] = (() => {
  const templates = listProjectTemplates();
  const byId = new Map(templates.map((template) => [template.id, template]));
  return TEMPLATE_IDS.map((id) => {
    const template = byId.get(id);
    if (!template) throw new Error(`Template matrix is missing ${id}.`);
    return {
      id,
      expected: template.files,
      ...PARTIAL_CASES[id],
    };
  });
})();

interface CaseResult {
  id: string;
  name: string;
  category: CaseCategory;
  status: "pass" | "fail" | "skip";
  durationMs: number;
  checks: string[];
  failures: string[];
  skipReason?: string;
}

const DEFAULT_TIMEOUT_MS = 300_000;

async function commandAvailable(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], { stdio: "ignore", shell: false });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function run(
  root: string,
  command: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ ok: boolean; output: string; durationMs: number }> {
  const result = await runProjectCommand(root, command, undefined, { timeoutMs });
  return {
    ok: result.exitCode === 0,
    output: `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim(),
    durationMs: result.durationMs,
  };
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a local port."));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

async function startStaticServer(
  root: string,
  port: number,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(async (request, response) => {
    const raw = (request.url ?? "/").split("?")[0];
    const relative = decodeURIComponent(raw === "/" ? "/index.html" : raw).replace(/^\/+/, "");
    const target = path.resolve(root, relative);
    if (!target.startsWith(path.resolve(root) + path.sep) && target !== path.resolve(root)) {
      response.statusCode = 403;
      response.end("Forbidden");
      return;
    }
    try {
      const content = await fs.readFile(target);
      response.setHeader("Content-Type", MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream");
      response.end(content);
    } catch {
      response.statusCode = 404;
      response.end("Not found");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function waitForHealth(
  url: string,
  timeoutMs = 30_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return true;
    } catch {
      // server is still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return false;
}

async function startProcess(
  root: string,
  command: string,
  port: number,
  health: string,
  env: Record<string, string> = {},
): Promise<{ url: string; output: () => string; close: () => Promise<void> }> {
  let output = "";
  const child: ChildProcess = spawn(command, {
    cwd: root,
    shell: true,
    detached: process.platform !== "win32",
    windowsHide: true,
    env: { ...process.env, ...env, PORT: String(port) },
  });
  const append = (chunk: Buffer) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-20_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const url = `http://127.0.0.1:${port}`;
  const ready = await waitForHealth(`${url}${health || "/"}`, 30_000);
  if (child.exitCode !== null && !ready) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const close = async () => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {
      // already gone
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      // already gone
    }
  };
  if (!ready) {
    await close();
    throw new Error(`Server did not become ready at ${url}${health}.\n${output.slice(-2_000)}`);
  }
  return { url, output: () => output, close };
}

async function runBrowser(
  analysis: AnalysisResult,
  baseUrl: string,
  steps: BrowserCheckStep[],
): Promise<void> {
  if (!(await isBrowserCheckAvailable())) {
    throw new Error("Chrome/Chromium is not available for browser checks.");
  }
  const result = await runBrowserCheck(analysis.id, analysis.rootPath, {
    url: baseUrl,
    steps,
    screenshot: false,
  });
  if (!result.ok) throw new Error(result.summary);
}

async function checkCase(
  testCase: TemplateE2ECase,
  full: boolean,
): Promise<CaseResult> {
  const started = Date.now();
  const checks: string[] = [];
  const failures: string[] = [];
  let status: CaseResult["status"] = "pass";
  let skipReason: string | undefined;
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cie-template-e2e-"));
  let server: { close: () => Promise<void> } | null = null;
  try {
    const created = await scaffoldProject({
      parentPath: parent,
      name: `e2e-${testCase.id}`,
      template: testCase.id,
    });
    const root = created.rootPath;
    for (const expected of testCase.expected) {
      // eslint-disable-next-line no-await-in-loop
      await fs.access(path.join(root, expected)).catch(() => {
        failures.push(`missing scaffold file: ${expected}`);
      });
    }
    if (failures.length === 0) checks.push(`${testCase.expected.length} scaffold files`);
    const analysis = await analyzeProject(root);
    checks.push(`${analysis.stats.files} indexed files`);

    if (!full && testCase.category !== "static" && testCase.category !== "blank") {
      return {
        id: testCase.id,
        name: testCase.id,
        category: testCase.category,
        status: "skip",
        durationMs: Date.now() - started,
        checks,
        failures,
        skipReason: "quick mode; run with --full for install/build/server checks",
      };
    }

    if (testCase.install) {
      const installed = await run(root, testCase.install);
      checks.push(`install ${installed.durationMs}ms`);
      if (!installed.ok) failures.push(`install failed: ${installed.output.slice(-1_000)}`);
    }

    if (testCase.category === "python") {
      const plan = await planPythonEnvironment(root);
      if (!plan) throw new Error("No stable Python interpreter/requirements detected.");
      const installed = await run(root, plan.command);
      checks.push(`python env ${installed.durationMs}ms`);
      if (!installed.ok) failures.push(`python env failed: ${installed.output.slice(-1_000)}`);
    }

    for (const verify of testCase.verify ?? []) {
      if (testCase.category === "flutter" && !(await commandAvailable("flutter"))) {
        status = "skip";
        skipReason = "flutter is not installed";
        break;
      }
      if (testCase.category === "godot" && !(await commandAvailable("godot"))) {
        status = "skip";
        skipReason = "godot is not installed";
        break;
      }
      if (testCase.category === "php" && !(await commandAvailable("php"))) {
        status = "skip";
        skipReason = "php is not installed";
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      const result = await run(root, verify);
      checks.push(`${verify} ${result.durationMs}ms`);
      if (!result.ok) failures.push(`${verify} failed: ${result.output.slice(-1_200)}`);
    }

    if (status !== "skip" && testCase.category === "static" && !testCase.buildOutput) {
      const port = await findFreePort();
      server = await startStaticServer(root, port);
      checks.push(`static server ${port}`);
    }

    if (status !== "skip" && testCase.buildOutput) {
      const dist = path.join(root, testCase.buildOutput);
      await fs.access(path.join(dist, "index.html")).catch(() => {
        failures.push(`build output missing: ${testCase.buildOutput}/index.html`);
      });
      if (failures.length === 0) {
        const port = await findFreePort();
        server = await startStaticServer(dist, port);
        checks.push(`static server ${port}`);
      }
    }

    if (status !== "skip" && testCase.server) {
      const port = await findFreePort();
      let command = testCase.server.command;
      if (testCase.category === "php") command = `php -S 127.0.0.1:${port} -t public`;
      if (testCase.category === "python") command = `${command} --port ${port}`;
      const startedServer = await startProcess(
        root,
        command,
        port,
        testCase.server.health,
        testCase.server.env,
      );
      server = startedServer;
      checks.push(`server ${port}`);
    }

    if (status !== "skip" && testCase.browser) {
      const baseUrl =
        server && "url" in server
          ? (server as { url: string }).url
          : null;
      if (!baseUrl) throw new Error("Browser check needs a static or HTTP server.");
      if (!(await isBrowserCheckAvailable())) {
        status = "skip";
        skipReason = "Chrome/Chromium is not available";
      } else {
        await runBrowser(analysis, baseUrl, testCase.browser.steps);
        checks.push(`browser ${testCase.browser.steps.length} steps`);
      }
    }

    if (status !== "skip" && failures.length > 0) status = "fail";
  } catch (error) {
    status = "fail";
    failures.push(error instanceof Error ? error.message : "template check failed");
  } finally {
    await server?.close().catch(() => undefined);
    await fs.rm(parent, { recursive: true, force: true }).catch(() => undefined);
  }
  return {
    id: testCase.id,
    name: testCase.id,
    category: testCase.category,
    status,
    durationMs: Date.now() - started,
    checks,
    failures,
    skipReason,
  };
}

function reportPath(): string {
  return path.join(
    process.cwd(),
    "fixtures",
    "template-e2e",
    "reports",
    `template-e2e-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const full = args.includes("--full");
  const onlyArg = args.find((arg) => arg.startsWith("--only="))?.slice("--only=".length);
  const only = onlyArg ? new Set(onlyArg.split(",").map((item) => item.trim())) : null;
  const cases = TEMPLATE_E2E_CASES.filter((item) => !only || only.has(item.id));
  if (cases.length === 0) {
    console.error("No matching template cases.");
    process.exitCode = 2;
    return;
  }
  console.log(
    `Template E2E matrix — ${cases.length} case(s) · ${full ? "full" : "quick"} mode`,
  );
  const results: CaseResult[] = [];
  for (const testCase of cases) {
    const result = await checkCase(testCase, full);
    results.push(result);
    const icon = result.status === "pass" ? "PASS" : result.status === "skip" ? "SKIP" : "FAIL";
    console.log(
      `${icon.padEnd(4)} ${result.id.padEnd(15)} ${String(result.durationMs).padStart(6)}ms  ${
        result.status === "skip"
          ? result.skipReason
          : result.status === "fail"
            ? result.failures[0]?.slice(0, 120)
            : result.checks.slice(-2).join(" · ")
      }`,
    );
  }
  const pass = results.filter((item) => item.status === "pass").length;
  const fail = results.filter((item) => item.status === "fail").length;
  const skip = results.filter((item) => item.status === "skip").length;
  const file = reportPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), full, results }, null, 2)}\n`,
    "utf8",
  );
  console.log(`\nSummary: ${pass} pass · ${fail} fail · ${skip} skip`);
  console.log(`Report: ${file}`);
  if (fail > 0) process.exitCode = 1;
}

const direct =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (direct) void main();
