import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  MobileBootResult,
  MobileDevice,
  MobileDeviceReport,
  MobileScreenshotResult,
} from "../../shared/mobileDevices";

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

function screenshotPath(rootPath: string, platform: string): { absolute: string; relative: string } {
  const relative = `.cie/agent/screenshots/mobile-${platform}-${Date.now()}.png`;
  return { relative, absolute: path.join(rootPath, relative) };
}

export async function bootMobileDevice(
  platform: "ios" | "android",
  id: string,
): Promise<MobileBootResult> {
  if (platform === "ios") {
    if (id.startsWith("avd:")) throw new Error("This is not an iOS Simulator.");
    const boot = await run("xcrun", ["simctl", "boot", id]);
    if (boot === null) {
      const state = await run("xcrun", ["simctl", "list", "devices", "--json"]);
      if (state?.includes(id) && state?.includes("Booted")) {
        return { platform, id, state: "booted", message: "Simulator is already booted." };
      }
      throw new Error("Could not boot the iOS Simulator.");
    }
    await run("xcrun", ["simctl", "bootstatus", id, "-b"]);
    return { platform, id, state: "booted", message: "iOS Simulator booted." };
  }
  if (id.startsWith("avd:")) {
    const name = id.slice(4);
    const child = spawn("emulator", ["-avd", name, "-no-snapshot-load"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return {
      platform,
      id,
      state: "starting",
      message: `Android emulator "${name}" is starting. Refresh device status in a few seconds.`,
    };
  }
  if (id.startsWith("emulator-") || /^[A-Za-z0-9]+$/.test(id)) {
    return { platform, id, state: "device", message: "Android device is already connected." };
  }
  throw new Error("Unknown Android device id.");
}

export async function captureMobileScreenshot(
  rootPath: string,
  platform: "ios" | "android",
  id: string,
): Promise<MobileScreenshotResult> {
  const target = screenshotPath(rootPath, platform);
  await fs.mkdir(path.dirname(target.absolute), { recursive: true });
  if (platform === "ios") {
    const result = await run("xcrun", ["simctl", "io", id, "screenshot", target.absolute]);
    if (result === null) throw new Error("Could not capture the iOS Simulator screenshot. Is it booted?");
    const stat = await fs.stat(target.absolute);
    return { path: target.relative, bytes: stat.size, platform, deviceId: id };
  }
  const buffer = await new Promise<Buffer>((resolve, reject) => {
    execFile(
      "adb",
      ["-s", id, "exec-out", "screencap", "-p"],
      { encoding: "buffer", timeout: 20_000, maxBuffer: 20 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout as Buffer);
      },
    );
  }).catch(() => {
    throw new Error("Could not capture the Android screenshot. Is the device connected?");
  });
  await fs.writeFile(target.absolute, buffer);
  return { path: target.relative, bytes: buffer.length, platform, deviceId: id };
}
