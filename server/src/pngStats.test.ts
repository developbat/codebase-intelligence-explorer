import assert from "node:assert/strict";
import test from "node:test";
import zlib from "node:zlib";
import { decodePng, statsFromPng } from "./pngStats";

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function tinyPng(): Buffer {
  const width = 2;
  const height = 2;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = [
    [255, 0, 0, 255, 0, 255, 0, 255],
    [0, 0, 255, 255, 255, 255, 255, 255],
  ];
  const raw = Buffer.from([0, ...rows[0], 0, ...rows[1]]);
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("decodes a tiny PNG and computes pixel statistics", () => {
  const png = tinyPng();
  const decoded = decodePng(png);
  assert.ok(decoded);
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 2);
  const stats = statsFromPng(png);
  assert.ok(stats);
  assert.ok(stats.uniqueColors >= 4);
  assert.ok(stats.nonUniformRatio > 0.5);
  assert.ok(stats.luminanceVariance > 0);
});

test("returns null for a non-PNG buffer", () => {
  assert.equal(decodePng(Buffer.from("not a png")), null);
  assert.equal(statsFromPng(Buffer.from("not a png")), null);
});
