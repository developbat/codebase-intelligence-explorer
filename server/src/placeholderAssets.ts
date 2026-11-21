import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { isWithin } from "./scanner";
import { browserExecutable } from "./browserCheck";
import type {
  PlaceholderAssetKind,
  PlaceholderAssetRequest,
  PlaceholderAssetResult,
} from "../../shared/assetPlaceholder";

function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function color(value: string | undefined, fallback: string): string {
  const trimmed = (value ?? "").trim();
  return /^#[0-9a-f]{3,8}$/i.test(trimmed) || /^[a-z]+$/i.test(trimmed) ? trimmed : fallback;
}

function svgFor(
  kind: PlaceholderAssetKind,
  width: number,
  height: number,
  label: string,
  accent: string,
  background: string,
): string {
  const safeLabel = xml(label.slice(0, 40));
  const common = `xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"`;
  if (kind === "spritesheet") {
    const cols = 4;
    const rows = 4;
    const cellW = width / cols;
    const cellH = height / rows;
    const frames = Array.from({ length: cols * rows }, (_, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      const cx = col * cellW + cellW / 2;
      const cy = row * cellH + cellH / 2;
      const radius = Math.min(cellW, cellH) * (0.22 + (index % 3) * 0.03);
      return `<g transform="translate(${cx} ${cy})"><circle r="${radius}" fill="${accent}" opacity="${0.55 + (index % 4) * 0.1}"/><circle cx="${-radius * 0.25}" cy="${-radius * 0.15}" r="${Math.max(1, radius * 0.08)}" fill="${background}"/><circle cx="${radius * 0.25}" cy="${-radius * 0.15}" r="${Math.max(1, radius * 0.08)}" fill="${background}"/></g>`;
    }).join("");
    return `<svg ${common}>
  <rect width="${width}" height="${height}" fill="${background}" opacity="0.35"/>
  ${frames}
</svg>
`;
  }
  if (kind === "sprite") {
    return `<svg ${common}>
  <g fill="none" stroke="${accent}" stroke-width="${Math.max(2, width / 48)}" stroke-linecap="round">
    <circle cx="${width / 2}" cy="${height * 0.42}" r="${Math.min(width, height) * 0.22}" fill="${background}" />
    <path d="M ${width * 0.38} ${height * 0.68} L ${width * 0.34} ${height * 0.9} M ${width * 0.62} ${height * 0.68} L ${width * 0.66} ${height * 0.9}" />
    <path d="M ${width * 0.28} ${height * 0.4} L ${width * 0.08} ${height * 0.52} M ${width * 0.72} ${height * 0.4} L ${width * 0.92} ${height * 0.52}" />
    <circle cx="${width * 0.43}" cy="${height * 0.38}" r="${width / 60}" fill="${accent}" stroke="none" />
    <circle cx="${width * 0.57}" cy="${height * 0.38}" r="${width / 60}" fill="${accent}" stroke="none" />
  </g>
  ${safeLabel ? `<text x="${width / 2}" y="${height * 0.97}" text-anchor="middle" fill="${accent}" font-family="monospace" font-size="${Math.max(8, width / 18)}">${safeLabel}</text>` : ""}
</svg>
`;
  }
  if (kind === "background") {
    return `<svg ${common}>
  <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${background}"/><stop offset="1" stop-color="${accent}" stop-opacity="0.35"/></linearGradient></defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <path d="M0 ${height * 0.72} Q ${width * 0.25} ${height * 0.55} ${width * 0.5} ${height * 0.74} T ${width} ${height * 0.7} V ${height} H0Z" fill="${accent}" opacity="0.22"/>
  <circle cx="${width * 0.78}" cy="${height * 0.22}" r="${width * 0.08}" fill="${accent}" opacity="0.55"/>
</svg>
`;
  }
  if (kind === "button") {
    return `<svg ${common}>
  <rect x="${width * 0.04}" y="${height * 0.12}" width="${width * 0.92}" height="${height * 0.76}" rx="${height * 0.24}" fill="${background}"/>
  <text x="${width / 2}" y="${height * 0.57}" text-anchor="middle" fill="${accent}" font-family="ui-sans-serif, system-ui, sans-serif" font-weight="700" font-size="${Math.max(10, height * 0.3)}">${safeLabel || "Button"}</text>
</svg>
`;
  }
  if (kind === "splash") {
    return `<svg ${common}>
  <defs><radialGradient id="s" cx="0.5" cy="0.35" r="0.7"><stop offset="0" stop-color="${accent}" stop-opacity="0.35"/><stop offset="1" stop-color="${background}"/></radialGradient></defs>
  <rect width="${width}" height="${height}" fill="url(#s)"/>
  <rect x="${width * 0.35}" y="${height * 0.32}" width="${width * 0.3}" height="${width * 0.3}" rx="${width * 0.08}" fill="${accent}"/>
  <circle cx="${width * 0.43}" cy="${height * 0.32 + width * 0.15}" r="${width * 0.02}" fill="${background}"/>
  <circle cx="${width * 0.57}" cy="${height * 0.32 + width * 0.15}" r="${width * 0.02}" fill="${background}"/>
  <text x="${width / 2}" y="${height * 0.78}" text-anchor="middle" fill="${accent}" font-family="ui-sans-serif, system-ui, sans-serif" font-weight="700" font-size="${Math.max(12, width * 0.06)}">${safeLabel || "App"}</text>
</svg>
`;
  }
  return `<svg ${common}>
  <defs><linearGradient id="i" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${accent}"/><stop offset="1" stop-color="${background}"/></linearGradient></defs>
  <rect width="${width}" height="${height}" rx="${width * 0.22}" fill="${background}"/>
  <circle cx="${width / 2}" cy="${height / 2}" r="${width * 0.32}" fill="url(#i)" opacity="0.9"/>
  <text x="${width / 2}" y="${height * 0.62}" text-anchor="middle" fill="${background}" font-family="ui-sans-serif, system-ui, sans-serif" font-weight="800" font-size="${width * 0.28}">${safeLabel.slice(0, 2).toUpperCase() || "A"}</text>
</svg>
`;
}

export async function createPlaceholderAsset(
  rootPath: string,
  request: PlaceholderAssetRequest,
): Promise<PlaceholderAssetResult> {
  const relativeInput = (request.path ?? "").trim().replace(/^\/+/, "");
  if (!relativeInput) throw new Error("An asset path is required.");
  const kindHint = request.kind ?? "icon";
  const defaultExt = kindHint === "sound" ? ".wav" : request.format === "png" ? ".png" : ".svg";
  const base = relativeInput.replace(/\.(svg|png|wav)$/i, "");
  const relative = `${base}${defaultExt}`;
  if (relative.split("/").some((segment) => segment === ".." || segment === ".git")) {
    throw new Error("Asset path is outside the project.");
  }
  const absolute = path.resolve(rootPath, relative);
  if (!isWithin(rootPath, absolute)) throw new Error("Asset path is outside the project.");
  const kind = (request.kind ?? "icon") as PlaceholderAssetKind;
  if (!["icon", "sprite", "spritesheet", "background", "button", "splash", "sound"].includes(kind)) {
    throw new Error("Unknown placeholder asset kind.");
  }
  const width = Math.max(32, Math.min(2048, Math.round(request.width ?? 256)));
  const height = Math.max(32, Math.min(2048, Math.round(request.height ?? width)));
  const colorValue = color(request.color, "#5eead4");
  const background = color(request.background, "#0b1220");
  const label = request.label ?? "";

  if (kind === "sound") {
    const wav = makeWav(
      Math.max(100, Math.min(5_000, Math.round(request.durationMs ?? 600))),
      Math.max(80, Math.min(4_000, Math.round(request.frequency ?? 440))),
    );
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, wav);
    return {
      path: relative,
      bytes: wav.length,
      mime: "audio/wav",
      kind,
    };
  }

  const svg = svgFor(kind, width, height, label, colorValue, background);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const wantsPng = request.format === "png" || /\.png$/i.test(relative);
  if (!wantsPng) {
    await fs.writeFile(absolute, svg, "utf8");
    return {
      path: relative,
      bytes: Buffer.byteLength(svg, "utf8"),
      mime: "image/svg+xml",
      kind,
    };
  }
  const png = await renderSvgPng(svg, width, height);
  await fs.writeFile(absolute, png);
  return {
    path: relative,
    bytes: png.length,
    mime: "image/png",
    kind,
  };
}

async function renderSvgPng(svg: string, width: number, height: number): Promise<Buffer> {
  const executablePath = await browserExecutable();
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath, args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width, height } });
    await page.setContent(
      `<html><body style="margin:0;padding:0;background:transparent;overflow:hidden">${svg}</body></html>`,
      { waitUntil: "load" },
    );
    return await page.screenshot({
      type: "png",
      omitBackground: true,
      clip: { x: 0, y: 0, width, height },
    });
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

function makeWav(durationMs: number, frequency: number): Buffer {
  const sampleRate = 22_050;
  const samples = Math.floor((sampleRate * durationMs) / 1000);
  const data = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const t = index / sampleRate;
    const fadeIn = Math.min(1, index / 220);
    const fadeOut = Math.min(1, (samples - index) / 550);
    const envelope = fadeIn * fadeOut * 0.35;
    const value = Math.sin(2 * Math.PI * frequency * t) * envelope;
    data.writeInt16LE(Math.round(value * 32767), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
