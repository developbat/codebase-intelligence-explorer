export interface MobileDevice {
  platform: "ios" | "android";
  id: string;
  name: string;
  state: "booted" | "shutdown" | "device" | "offline" | "unauthorized" | "unknown";
  kind: "simulator" | "emulator" | "physical";
  runtime?: string;
  model?: string;
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
