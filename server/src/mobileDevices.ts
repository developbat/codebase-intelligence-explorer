import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MobileDevice, MobileDeviceReport } from "../../shared/mobileDevices";

const execFileAsync = promisify(execFile);

async function run(command: string, args: string[]): Promise<string | null> {
  try {
    const result = await execFileAsync(command, args, {
      timeout: 8_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return result.stdout;
  } catch {
    return null;
  }
}

export function parseIosDevices(raw: string): MobileDevice[] {
  try {
    const parsed = JSON.parse(raw) as {
      devices?: Record<string, { name?: string; udid?: string; state?: string; isAvailable?: boolean; deviceTypeIdentifier?: string }[]>;
    };
    const devices: MobileDevice[] = [];
    for (const [runtime, list] of Object.entries(parsed.devices ?? {})) {
      for (const device of list) {
        if (!device.udid || !device.name || device.isAvailable === false) continue;
        const state = device.state?.toLowerCase() === "booted" ? "booted" : "shutdown";
        devices.push({
          platform: "ios",
          id: device.udid,
          name: device.name,
          state,
          kind: "simulator",
          runtime: runtime.split(".").pop()?.replace(/-/g, "."),
          model: device.deviceTypeIdentifier,
        });
      }
    }
    return devices;
  } catch {
    return [];
  }
}

export function parseAdbDevices(raw: string): MobileDevice[] {
  const devices: MobileDevice[] = [];
  for (const line of raw.split("\n").slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [id, state] = trimmed.split(/\s+/);
    if (!id || !state) continue;
    const model = /model:(\S+)/.exec(trimmed)?.[1]?.replace(/_/g, " ");
    devices.push({
      platform: "android",
      id,
      name: model ? `${model} (${id})` : id,
      state:
        state === "device"
          ? "device"
          : state === "offline"
            ? "offline"
            : state === "unauthorized"
              ? "unauthorized"
              : "unknown",
      kind: id.startsWith("emulator-") ? "emulator" : "physical",
      model,
    });
  }
  return devices;
}

export function parseAvds(raw: string): MobileDevice[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((name) => ({
      platform: "android" as const,
      id: `avd:${name}`,
      name,
      state: "shutdown" as const,
      kind: "emulator" as const,
    }));
}

export async function listMobileDevices(): Promise<MobileDeviceReport> {
  const warnings: string[] = [];
  const iosRaw = await run("xcrun", ["simctl", "list", "devices", "available", "--json"]);
  const adbRaw = await run("adb", ["devices", "-l"]);
  const avdRaw = await run("emulator", ["-list-avds"]);
  const ios = iosRaw ? parseIosDevices(iosRaw) : [];
  const runningAndroid = adbRaw ? parseAdbDevices(adbRaw) : [];
  const avds = avdRaw ? parseAvds(avdRaw) : [];
  const runningNames = new Set(runningAndroid.map((device) => device.name));
  const android = [
    ...runningAndroid,
    ...avds.filter((device) => !runningNames.has(device.name)),
  ];
  if (!iosRaw) warnings.push("iOS Simulator tools (xcrun simctl) are not available.");
  if (!adbRaw) warnings.push("Android adb is not available.");
  if (!avdRaw) warnings.push("Android emulator command is not available.");
  return {
    ios,
    android,
    tools: {
      xcrun: Boolean(iosRaw),
      adb: Boolean(adbRaw),
      emulator: Boolean(avdRaw),
    },
    warnings,
  };
}
