import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { browserExecutable } from "./browserCheck";
import { isWithin } from "./scanner";
import type { GraphicCheckResult } from "../../shared/graphics";

function decodeText(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseSvg(svg: string, expectText?: string): GraphicCheckResult {
  const viewBox = /viewBox="([^"]+)"/i.exec(svg)?.[1]?.trim().split(/\s+/).map(Number);
  const width = Number(/<svg[^>]*\bwidth="([\d.]+)"/i.exec(svg)?.[1]) || viewBox?.[2];
  const height = Number(/<svg[^>]*\bheight="([\d.]+)"/i.exec(svg)?.[1]) || viewBox?.[3];
  const texts = [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi)]
    .map((match) => decodeText(match[1]))
    .filter(Boolean)
    .slice(0, 80);
  const colors = [
    ...new Set(
      [...svg.matchAll(/(?:fill|stroke)="([^"]+)"/gi)]
        .map((match) => match[1].trim())
        .filter(
          (value) =>
            value &&
            value !== "none" &&
            value !== "currentColor" &&
            !value.startsWith("url("),
        ),
    ),
  ].slice(0, 30);
  const shapes = {
    rects: (svg.match(/<rect\b/gi) ?? []).length,
    circles: (svg.match(/<circle\b/gi) ?? []).length,
    paths: (svg.match(/<path\b/gi) ?? []).length,
    texts: texts.length,
  };
  const warnings: string[] = [];
  if (!width || !height) warnings.push("SVG width/height or viewBox is missing.");
  if (shapes.rects + shapes.circles + shapes.paths === 0) warnings.push("SVG has no shape elements.");
  if (expectText && !texts.some((text) => text.includes(expectText))) {
    warnings.push(`Expected text "${expectText}" was not found.`);
  }
  const ok = warnings.length === 0;
  return {
    path: "",
    format: "svg",
    ok,
    width,
    height,
    texts,
    colors,
    shapes,
    warnings,
    summary: [
      `SVG ${width ?? "?"}×${height ?? "?"}`,
      `${shapes.rects} rect · ${shapes.circles} circle · ${shapes.paths} path`,
      `${texts.length} text · ${colors.length} colors`,
      ...warnings,
    ].join("\n"),
  };
}

async function parsePng(buffer: Buffer, expectText?: string): Promise<GraphicCheckResult> {
  const executablePath = await browserExecutable();
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath, args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const dataUrl = `data:image/png;base64,${buffer.toString("base64")}`;
    const result = (await page.evaluate(`(async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) return { width: img.naturalWidth, height: img.naturalHeight, colors: [], pixels: 0, transparent: 0 };
      context.drawImage(img, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const counts = new Map();
      let transparent = 0;
      const step = Math.max(1, Math.floor(data.length / 4 / 50000));
      let sampled = 0;
      for (let p = 0; p < data.length; p += 4 * step) {
        sampled += 1;
        const alpha = data[p + 3];
        if (alpha < 10) {
          transparent += 1;
          continue;
        }
        const key = "#" + [data[p], data[p + 1], data[p + 2]].map((v) => v.toString(16).padStart(2, "0")).join("");
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      const colors = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([color]) => color);
      return { width: canvas.width, height: canvas.height, colors, pixels: sampled, transparent };
    })` + `(${JSON.stringify(dataUrl)})`)) as {
      width: number;
      height: number;
      colors: string[];
      pixels: number;
      transparent: number;
    };
    const warnings: string[] = [];
    if (!result.width || !result.height) warnings.push("PNG dimensions could not be read.");
    if (result.pixels === 0) warnings.push("PNG has no opaque pixels.");
    if (expectText) warnings.push("PNG text cannot be verified; use an SVG or inspect the screenshot.");
    return {
      path: "",
      format: "png",
      ok: warnings.length === 0,
      width: result.width,
      height: result.height,
      texts: [],
      colors: result.colors,
      shapes: { rects: 0, circles: 0, paths: 0, texts: 0 },
      sampledPixels: result.pixels,
      transparentPixels: result.transparent,
      warnings,
      summary: [
        `PNG ${result.width}×${result.height}`,
        `${result.pixels} sampled px · ${result.colors.length} colors`,
        ...warnings,
      ].join("\n"),
    };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

export async function checkGraphic(
  rootPath: string,
  requestedPath: string,
  expectText?: string,
): Promise<GraphicCheckResult> {
  const relative = requestedPath.trim().replace(/^\/+/, "");
  if (!relative) throw new Error("A graphic path is required.");
  const absolute = path.resolve(rootPath, relative);
  if (!isWithin(rootPath, absolute)) throw new Error("Graphic path is outside the project.");
  const realRoot = await fs.realpath(rootPath);
  const realFile = await fs.realpath(absolute).catch(() => {
    throw new Error("Graphic file does not exist.");
  });
  if (!isWithin(realRoot, realFile)) throw new Error("Graphic path is outside the project.");
  const stat = await fs.stat(realFile);
  if (!stat.isFile()) throw new Error("Graphic path is not a file.");
  if (stat.size > 10_000_000) throw new Error("Graphic file is too large.");
  const extension = path.extname(realFile).toLowerCase();
  const buffer = await fs.readFile(realFile);
  const result =
    extension === ".svg"
      ? parseSvg(buffer.toString("utf8"), expectText)
      : extension === ".png"
        ? await parsePng(buffer, expectText)
        : (() => {
            throw new Error("graphic_check supports .svg and .png only.");
          })();
  return { ...result, path: path.relative(rootPath, realFile) };
}
