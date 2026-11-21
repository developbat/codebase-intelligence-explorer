export type GraphicKind = "bar" | "line" | "pie" | "flow" | "illustration";

export interface GraphicDatum {
  label: string;
  value: number;
}

export interface GraphicRequest {
  path: string;
  kind?: GraphicKind;
  title?: string;
  subtitle?: string;
  data?: GraphicDatum[];
  steps?: string[];
  width?: number;
  height?: number;
  colors?: string[];
  format?: "svg" | "png";
}

export interface GraphicResult {
  path: string;
  bytes: number;
  mime: "image/svg+xml" | "image/png";
  kind: GraphicKind;
}

export interface GraphicCheckResult {
  path: string;
  format: "svg" | "png";
  ok: boolean;
  width?: number;
  height?: number;
  texts: string[];
  colors: string[];
  shapes: {
    rects: number;
    circles: number;
    paths: number;
    texts: number;
  };
  sampledPixels?: number;
  transparentPixels?: number;
  warnings: string[];
  summary: string;
}
