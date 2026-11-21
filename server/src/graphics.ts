import fs from "node:fs/promises";
import path from "node:path";
import { isWithin } from "./scanner";
import { renderSvgPng } from "./placeholderAssets";
import type {
  GraphicDatum,
  GraphicKind,
  GraphicRequest,
  GraphicResult,
} from "../../shared/graphics";

const PALETTE = ["#5eead4", "#6ea8fe", "#c8b8f5", "#e6c284", "#e59aa6", "#8ed3b6", "#7dd3fc"];
const MAX_POINTS = 24;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function cleanColors(input: string[] | undefined): string[] {
  const colors = (input ?? []).filter((color) => /^#[0-9a-f]{3,8}$/i.test(color.trim()));
  return colors.length > 0 ? colors : PALETTE;
}

function cleanData(input: GraphicDatum[] | undefined): GraphicDatum[] {
  return (input ?? [])
    .filter((item) => item && typeof item.label === "string")
    .map((item) => ({ label: item.label.slice(0, 80), value: Number(item.value) }))
    .filter((item) => Number.isFinite(item.value))
    .slice(0, MAX_POINTS);
}

function frame(width: number, height: number, title: string, subtitle: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0b1420"/>
      <stop offset="1" stop-color="#070b12"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <text x="36" y="44" fill="#e9f2ff" font-family="ui-sans-serif, system-ui, sans-serif" font-size="24" font-weight="700">${escapeXml(title)}</text>
  ${subtitle ? `<text x="36" y="68" fill="#7f9bbd" font-family="ui-sans-serif, system-ui, sans-serif" font-size="12">${escapeXml(subtitle)}</text>` : ""}
`;
}

function barChart(width: number, height: number, data: GraphicDatum[], colors: string[], title: string, subtitle: string): string {
  const left = 58;
  const right = 28;
  const top = 92;
  const bottom = 54;
  const chartW = width - left - right;
  const chartH = height - top - bottom;
  const max = Math.max(1, ...data.map((item) => item.value));
  const slot = chartW / Math.max(1, data.length);
  const bars = data
    .map((item, index) => {
      const barH = Math.max(1, (item.value / max) * chartH);
      const x = left + index * slot + slot * 0.16;
      const y = top + chartH - barH;
      const color = colors[index % colors.length];
      return `<rect x="${x}" y="${y}" width="${slot * 0.68}" height="${barH}" rx="4" fill="${color}" opacity="0.9"/>
  <text x="${x + slot * 0.34}" y="${top + chartH + 18}" text-anchor="middle" fill="#8fa9c9" font-family="ui-sans-serif, system-ui, sans-serif" font-size="10">${escapeXml(item.label.slice(0, 18))}</text>
  <text x="${x + slot * 0.34}" y="${Math.max(top + 12, y - 6)}" text-anchor="middle" fill="#e9f2ff" font-family="ui-monospace, monospace" font-size="10">${item.value}</text>`;
    })
    .join("\n");
  return `${frame(width, height, title, subtitle)}
  <line x1="${left}" y1="${top + chartH}" x2="${width - right}" y2="${top + chartH}" stroke="#334155"/>
  <line x1="${left}" y1="${top}" x2="${left}" y2="${top + chartH}" stroke="#334155"/>
  ${bars}
</svg>
`;
}

function lineChart(width: number, height: number, data: GraphicDatum[], colors: string[], title: string, subtitle: string): string {
  const left = 58;
  const right = 28;
  const top = 92;
  const bottom = 54;
  const chartW = width - left - right;
  const chartH = height - top - bottom;
  const max = Math.max(1, ...data.map((item) => item.value));
  const points = data.map((item, index) => {
    const x = left + (index / Math.max(1, data.length - 1)) * chartW;
    const y = top + chartH - (item.value / max) * chartH;
    return { x, y, item };
  });
  const polyline = points.map((point) => `${point.x},${point.y}`).join(" ");
  const dots = points
    .map(
      (point) =>
        `<circle cx="${point.x}" cy="${point.y}" r="4" fill="${colors[0]}"/>
  <text x="${point.x}" y="${top + chartH + 18}" text-anchor="middle" fill="#8fa9c9" font-family="ui-sans-serif, system-ui, sans-serif" font-size="10">${escapeXml(point.item.label.slice(0, 16))}</text>`,
    )
    .join("\n");
  return `${frame(width, height, title, subtitle)}
  <line x1="${left}" y1="${top + chartH}" x2="${width - right}" y2="${top + chartH}" stroke="#334155"/>
  <line x1="${left}" y1="${top}" x2="${left}" y2="${top + chartH}" stroke="#334155"/>
  <polyline points="${polyline}" fill="none" stroke="${colors[0]}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  ${dots}
</svg>
`;
}

function pieChart(width: number, height: number, data: GraphicDatum[], colors: string[], title: string, subtitle: string): string {
  const total = data.reduce((sum, item) => sum + Math.max(0, item.value), 0) || 1;
  const cx = width * 0.36;
  const cy = height * 0.56;
  const radius = Math.min(width, height) * 0.26;
  let angle = -Math.PI / 2;
  const slices = data.map((item, index) => {
    const next = angle + (Math.max(0, item.value) / total) * Math.PI * 2;
    const large = next - angle > Math.PI ? 1 : 0;
    const x1 = cx + radius * Math.cos(angle);
    const y1 = cy + radius * Math.sin(angle);
    const x2 = cx + radius * Math.cos(next);
    const y2 = cy + radius * Math.sin(next);
    const pathData = `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2} Z`;
    angle = next;
    return `<path d="${pathData}" fill="${colors[index % colors.length]}" opacity="0.92"/>`;
  });
  const legend = data
    .map(
      (item, index) =>
        `<rect x="${width * 0.68}" y="${112 + index * 30}" width="12" height="12" rx="3" fill="${colors[index % colors.length]}"/>
  <text x="${width * 0.68 + 20}" y="${122 + index * 30}" fill="#c5dcff" font-family="ui-sans-serif, system-ui, sans-serif" font-size="12">${escapeXml(item.label.slice(0, 22))} · ${item.value}</text>`,
    )
    .join("\n");
  return `${frame(width, height, title, subtitle)}
  ${slices.join("\n")}
  ${legend}
</svg>
`;
}

function flowChart(width: number, height: number, steps: string[], colors: string[], title: string, subtitle: string): string {
  const list = (steps.length > 0 ? steps : ["Start", "Process", "Done"]).slice(0, 8);
  const top = 96;
  const gap = 18;
  const boxH = Math.max(36, (height - top - 36 - gap * (list.length - 1)) / list.length);
  const boxes = list
    .map((step, index) => {
      const y = top + index * (boxH + gap);
      const arrow =
        index < list.length - 1
          ? `<path d="M ${width / 2} ${y + boxH + 2} L ${width / 2} ${y + boxH + gap - 5}" stroke="#64748b" stroke-width="2" marker-end="url(#arrow)"/>`
          : "";
      return `<rect x="${width * 0.2}" y="${y}" width="${width * 0.6}" height="${boxH}" rx="10" fill="${colors[index % colors.length]}" opacity="0.16" stroke="${colors[index % colors.length]}" stroke-width="1.5"/>
  <text x="${width / 2}" y="${y + boxH / 2 + 4}" text-anchor="middle" fill="#e9f2ff" font-family="ui-sans-serif, system-ui, sans-serif" font-size="13">${escapeXml(step.slice(0, 52))}</text>
  ${arrow}`;
    })
    .join("\n");
  return `${frame(width, height, title, subtitle)}
  <defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#64748b"/></marker></defs>
  ${boxes}
</svg>
`;
}

function illustration(width: number, height: number, colors: string[], title: string, subtitle: string): string {
  const seed = [...`${title}${subtitle}`].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const shapes = Array.from({ length: 12 }, (_, index) => {
    const x = ((seed * (index + 3) * 37) % 1000) / 1000;
    const y = ((seed * (index + 7) * 53) % 1000) / 1000;
    const size = 30 + ((seed * (index + 11)) % 140);
    const color = colors[index % colors.length];
    return index % 2 === 0
      ? `<circle cx="${x * width}" cy="${y * height}" r="${size}" fill="${color}" opacity="0.2"/>`
      : `<rect x="${x * width}" y="${y * height}" width="${size}" height="${size}" rx="${size * 0.2}" fill="none" stroke="${color}" stroke-width="2" opacity="0.35" transform="rotate(${(seed + index * 17) % 45} ${x * width} ${y * height})"/>`;
  });
  return `${frame(width, height, title, subtitle)}
  ${shapes.join("\n")}
</svg>
`;
}

export async function createGraphic(
  rootPath: string,
  request: GraphicRequest,
): Promise<GraphicResult> {
  const inputPath = (request.path ?? "").trim().replace(/^\/+/, "");
  if (!inputPath) throw new Error("A graphic path is required.");
  const kind = (request.kind ?? "bar") as GraphicKind;
  if (!["bar", "line", "pie", "flow", "illustration"].includes(kind)) {
    throw new Error("Unknown graphic kind.");
  }
  const format = request.format === "png" ? "png" : "svg";
  const relative = `${inputPath.replace(/\.(svg|png)$/i, "")}.${format}`;
  if (relative.split("/").some((segment) => segment === ".." || segment === ".git")) {
    throw new Error("Graphic path is outside the project.");
  }
  const absolute = path.resolve(rootPath, relative);
  if (!isWithin(rootPath, absolute)) throw new Error("Graphic path is outside the project.");
  const width = Math.max(240, Math.min(2400, Math.round(request.width ?? 900)));
  const height = Math.max(180, Math.min(1800, Math.round(request.height ?? 560)));
  const title = request.title?.trim().slice(0, 90) || "Graphic";
  const subtitle = request.subtitle?.trim().slice(0, 140) || "";
  const data = cleanData(request.data);
  const colors = cleanColors(request.colors);
  if (["bar", "line", "pie"].includes(kind) && data.length === 0) {
    throw new Error(`${kind} charts need a non-empty data array.`);
  }
  const steps = (request.steps ?? []).filter((step) => typeof step === "string" && step.trim());
  const svg =
    kind === "bar"
      ? barChart(width, height, data, colors, title, subtitle)
      : kind === "line"
        ? lineChart(width, height, data, colors, title, subtitle)
        : kind === "pie"
          ? pieChart(width, height, data, colors, title, subtitle)
          : kind === "flow"
            ? flowChart(width, height, steps, colors, title, subtitle)
            : illustration(width, height, colors, title, subtitle);

  await fs.mkdir(path.dirname(absolute), { recursive: true });
  if (format === "png") {
    const png = await renderSvgPng(svg, width, height);
    await fs.writeFile(absolute, png);
    return { path: relative, bytes: png.length, mime: "image/png", kind };
  }
  await fs.writeFile(absolute, svg, "utf8");
  return { path: relative, bytes: Buffer.byteLength(svg, "utf8"), mime: "image/svg+xml", kind };
}
