export type PlaceholderAssetKind = "icon" | "sprite" | "background" | "button" | "splash";

export interface PlaceholderAssetRequest {
  path: string;
  kind?: PlaceholderAssetKind;
  width?: number;
  height?: number;
  label?: string;
  color?: string;
  background?: string;
}

export interface PlaceholderAssetResult {
  path: string;
  bytes: number;
  mime: "image/svg+xml";
  kind: PlaceholderAssetKind;
}
