import fs from "node:fs/promises";
import path from "node:path";
import { runBrowserCheck } from "./browserCheck";
import type { BrowserCheckStep } from "../../shared/browserCheck";
import type { GameCheckOptions, GameCheckResult } from "../../shared/gameCheck";

async function detectEngine(rootPath: string): Promise<string> {
  try {
    const packageJson = JSON.parse(await fs.readFile(path.join(rootPath, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...(packageJson.dependencies ?? {}), ...(packageJson.devDependencies ?? {}) };
    if (deps.phaser) return "Phaser";
    if (deps.three) return "Three.js";
  } catch {
    // no package.json
  }
  try {
    await fs.access(path.join(rootPath, "project.godot"));
    return "Godot";
  } catch {
    // not Godot
  }
  try {
    const html = await fs.readFile(path.join(rootPath, "index.html"), "utf8");
    if (/<canvas/i.test(html)) return "Canvas 2D";
  } catch {
    // no static entry
  }
  return "unknown";
}

export async function runGameCheck(
  projectId: string,
  rootPath: string,
  options: GameCheckOptions = {},
): Promise<GameCheckResult> {
  const engine = options.engineHint ?? (await detectEngine(rootPath));
  if (engine === "Godot" && !options.url) {
    throw new Error(
      "Godot game checks require an exported web build URL or a running Godot web server. Export the project first, then pass its localhost URL.",
    );
  }
  const steps: BrowserCheckStep[] =
    options.steps && options.steps.length > 0
      ? options.steps
      : [{ action: "expectVisible", selector: "canvas" }];
  const check = await runBrowserCheck(projectId, rootPath, {
    ...options,
    steps,
    screenshot: options.screenshot ?? true,
    measureFps: true,
  });
  const summary = [
    `Game check · ${engine}`,
    check.summary,
    check.metrics.canvases > 0
      ? `Canvas: ${check.metrics.canvases} · ${check.metrics.canvasWidth ?? "?"}×${check.metrics.canvasHeight ?? "?"}${
          check.metrics.fps ? ` · ${check.metrics.fps} fps` : ""
        }`
      : "No canvas element detected",
  ].join("\n");
  return { engine, check, summary };
}
