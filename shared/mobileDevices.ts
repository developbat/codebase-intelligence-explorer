export interface MobileDevice {
  platform: "ios" | "android";
  id: string;
  name: string;
  state: "booted" | "shutdown" | "device" | "offline" | "unauthorized" | "unknown";
  kind: "simulator" | "emulator" | "physical";
  runtime?: string;
  model?: string;
}

export interface MobileBootResult {
  platform: "ios" | "android";
  id: string;
  state: "booted" | "starting" | "device" | "unsupported";
  message: string;
}

export interface MobileScreenshotResult {
  path: string;
  bytes: number;
  platform: "ios" | "android";
  deviceId: string;
}

export interface MobileOpenUrlResult {
  platform: "ios" | "android";
  deviceId: string;
  url: string;
  message: string;
}

export interface MobileLogsResult {
  platform: "ios" | "android";
  deviceId: string;
  lines: number;
  output: string;
}

export interface MobileDeviceReport {
  ios: MobileDevice[];
  android: MobileDevice[];
  tools: {
    xcrun: boolean;
    adb: boolean;
    emulator: boolean;
  };
  warnings: string[];
}
