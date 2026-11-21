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
