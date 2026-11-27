import assert from "node:assert/strict";
import test from "node:test";
import { qrOutputPath, renderQrCode } from "./qr";

test("renders PNG and SVG QR codes", async () => {
  const png = await renderQrCode("https://example.com", "png", 256);
  assert.equal(png.extension, "png");
  assert.equal(png.mime, "image/png");
  assert.deepEqual([...png.buffer.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

  const svg = await renderQrCode("https://example.com", "svg", 256);
  assert.equal(svg.extension, "svg");
  assert.match(svg.buffer.toString("utf8"), /<svg/);
});

test("qr paths are deterministic and keep the requested extension", () => {
  const first = qrOutputPath("hello", "png");
  const second = qrOutputPath("hello", "png");
  assert.equal(first, second);
  assert.match(first, /^qr\/qr-[a-f0-9]+\.png$/);
  assert.equal(qrOutputPath("hello", "svg", "assets/code"), "assets/code.svg");
});
