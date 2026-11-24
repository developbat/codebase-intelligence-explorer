import { listMobileDevices } from "../../mobileDevices";
import type { AgentToolHandler, AgentToolResult } from "./types";

const listMobileDevicesHandler: AgentToolHandler = async (): Promise<AgentToolResult> => {
  const report = await listMobileDevices();
  const ios = report.ios
    .map(
      (device) =>
        `- ${device.state} · ${device.name} · ${device.id}${
          device.runtime ? ` · ${device.runtime}` : ""
        }`,
    )
    .join("\n");
  const android = report.android
    .map((device) => `- ${device.state} · ${device.name} · ${device.id}`)
    .join("\n");
  return {
    observation: [
      `iOS Simulators: ${report.tools.xcrun ? report.ios.length : "unavailable"}`,
      ios,
      `Android devices/emulators: ${
        report.tools.adb || report.tools.emulator ? report.android.length : "unavailable"
      }`,
      android,
      ...report.warnings,
    ]
      .filter(Boolean)
      .join("\n"),
    ok: true,
  };
};

export const MOBILE_TOOL_HANDLERS: Record<string, AgentToolHandler> = {
  list_mobile_devices: listMobileDevicesHandler,
};
