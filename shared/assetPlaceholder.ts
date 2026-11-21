export type PlaceholderAssetKind =
  | "icon"
  | "sprite"
  | "spritesheet"
  | "background"
  | "button"
  | "splash"
  | "sound";

export type PlaceholderAssetFormat = "svg" | "png";

export interface PlaceholderAssetRequest {
  path: string;
  kind?: PlaceholderAssetKind;
  width?: number;
  height?: number;
  label?: string;
  color?: string;
  background?: string;
  format?: PlaceholderAssetFormat;
  durationMs?: number;
  frequency?: number;
}

export interface PlaceholderAssetResult {
  path: string;
  bytes: number;
  mime: "image/svg+xml" | "image/png" | "audio/wav";
  kind: PlaceholderAssetKind;
}
