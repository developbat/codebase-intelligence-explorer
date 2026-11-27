import crypto from "node:crypto";
import path from "node:path";
import QRCode from "qrcode";

export async function renderQrCode(
  content: string,
  format: "png" | "svg",
  size: number,
): Promise<{ buffer: Buffer; mime: string; extension: "png" | "svg" }> {
  const text = content.trim();
  if (!text) throw new Error("QR content is required.");
  const width = Math.max(128, Math.min(2048, Number(size) || 512));
  if (format === "svg") {
    const svg = await QRCode.toString(text, {
      type: "svg",
      width,
      margin: 2,
      errorCorrectionLevel: "M",
    });
    return { buffer: Buffer.from(svg, "utf8"), mime: "image/svg+xml", extension: "svg" };
  }
  const buffer = await QRCode.toBuffer(text, {
    type: "png",
    width,
    margin: 2,
    errorCorrectionLevel: "M",
  });
  return { buffer, mime: "image/png", extension: "png" };
}

export function qrOutputPath(
  content: string,
  format: "png" | "svg",
  requestedPath?: string,
): string {
  if (requestedPath?.trim()) {
    const clean = requestedPath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (path.posix.extname(clean)) return clean;
    return `${clean}.${format}`;
  }
  const hash = crypto.createHash("sha1").update(content).digest("hex").slice(0, 10);
  return `qr/qr-${hash}.${format}`;
}
