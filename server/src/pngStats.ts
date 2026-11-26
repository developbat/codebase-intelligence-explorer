import fs from "node:fs/promises";
import zlib from "node:zlib";

export interface PngStats {
  width: number;
  height: number;
  uniqueColors: number;
  sampled: number;
  nonUniformRatio: number;
  luminanceVariance: number;
}

function readChunks(buffer: Buffer): { type: string; data: Buffer }[] {
  const chunks: { type: string; data: Buffer }[] = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) break;
    chunks.push({ type, data: buffer.subarray(dataStart, dataEnd) });
    offset = dataEnd + 4;
    if (type === "IEND") break;
  }
  return chunks;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Minimal PNG decoder for Chrome/Playwright screenshots:
 * 8-bit RGB/RGBA, non-interlaced. Returns null for unsupported files.
 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function decodePng(buffer: Buffer): { width: number; height: number; pixels: Buffer } | null {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const chunks = readChunks(buffer);
  const ihdr = chunks.find((chunk) => chunk.type === "IHDR")?.data;
  if (!ihdr || ihdr.length < 13) return null;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const interlace = ihdr[12];
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) return null;
  if (width <= 0 || height <= 0 || width * height > 40_000_000) return null;
  const idat = Buffer.concat(chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data));
  if (idat.length === 0) return null;
  let raw: Buffer;
  try {
    raw = zlib.inflateSync(idat);
  } catch {
    return null;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) return null;
  const pixels = Buffer.alloc(height * stride);
  let src = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[src];
    src += 1;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[src];
      src += 1;
      const left = x >= bpp ? pixels[y * stride + x - bpp] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= bpp ? pixels[(y - 1) * stride + x - bpp] : 0;
      let decoded = value;
      if (filter === 1) decoded = value + left;
      else if (filter === 2) decoded = value + up;
      else if (filter === 3) decoded = value + Math.floor((left + up) / 2);
      else if (filter === 4) decoded = value + paeth(left, up, upLeft);
      pixels[y * stride + x] = decoded & 0xff;
    }
  }
  return { width, height, pixels };
}

export function statsFromPng(buffer: Buffer): PngStats | null {
  const decoded = decodePng(buffer);
  if (!decoded) return null;
  const { width, height, pixels } = decoded;
  const bpp = pixels.length / (width * height);
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 12_000)));
  const colors = new Map<number, number>();
  let sampled = 0;
  let sum = 0;
  let sumSquares = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const offset = (y * width + x) * bpp;
      const r = pixels[offset];
      const g = pixels[offset + 1];
      const b = pixels[offset + 2];
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      colors.set(key, (colors.get(key) ?? 0) + 1);
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += luminance;
      sumSquares += luminance * luminance;
      sampled += 1;
    }
  }
  if (sampled === 0) return null;
  const mean = sum / sampled;
  const variance = Math.max(0, sumSquares / sampled - mean * mean);
  let maxCount = 0;
  for (const count of colors.values()) maxCount = Math.max(maxCount, count);
  return {
    width,
    height,
    uniqueColors: colors.size,
    sampled,
    nonUniformRatio: 1 - maxCount / sampled,
    luminanceVariance: Math.round(variance * 100) / 100,
  };
}

export async function pngStats(filePath: string): Promise<PngStats | null> {
  try {
    return statsFromPng(await fs.readFile(filePath));
  } catch {
    return null;
  }
}
