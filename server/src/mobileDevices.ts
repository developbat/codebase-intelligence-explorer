import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  MobileBootResult,
  MobileInstallResult,
  MobileLaunchResult,
  MobileDevice,
  MobileCheckOptions,
  MobileCheckResult,
  MobileDeviceReport,
  MobileLogsResult,
  MobileOpenUrlResult,
  MobileScreenshotResult,
} from "../../shared/mobileDevices";

const execFileAsync = promisify(execFile);

async function run(command: string, args: string[], timeoutMs = 8_000): Promise<string | null> {
  try {
    const result = await execFileAsync(command, args, {
      timeout: timeoutMs,
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
    const boot = await run("xcrun", ["simctl", "boot", id], 30_000);
    if (boot === null) {
      const state = await run("xcrun", ["simctl", "list", "devices", "--json"]);
      if (state?.includes(id) && state?.includes("Booted")) {
        return { platform, id, state: "booted", message: "Simulator is already booted." };
      }
      throw new Error("Could not boot the iOS Simulator.");
    }
    await run("xcrun", ["simctl", "bootstatus", id, "-b"], 120_000);
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
    const result = await run("xcrun", ["simctl", "io", id, "screenshot", target.absolute], 45_000);
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

export async function openMobileUrl(
  platform: "ios" | "android",
  id: string,
  url: string,
): Promise<MobileOpenUrlResult> {
  const target = url.trim();
  if (!/^https?:\/\//i.test(target)) throw new Error("Mobile URL must start with http:// or https://.");
  if (id.startsWith("avd:")) throw new Error("Boot the Android emulator before opening a URL.");
  if (platform === "ios") {
    const result = await run("xcrun", ["simctl", "openurl", id, target], 30_000);
    if (result === null) throw new Error("Could not open the URL on the iOS Simulator.");
    return { platform, deviceId: id, url: target, message: "URL opened in iOS Simulator." };
  }
  const result = await run("adb", ["-s", id, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", target], 30_000);
  if (result === null) throw new Error("Could not open the URL on the Android device.");
  return { platform, deviceId: id, url: target, message: "URL opened on Android device." };
}

export async function readMobileLogs(
  platform: "ios" | "android",
  id: string,
  limit = 200,
): Promise<MobileLogsResult> {
  const lines = Math.max(10, Math.min(1000, Math.round(limit)));
  if (id.startsWith("avd:")) throw new Error("Boot the Android emulator before reading logs.");
  const output =
    platform === "ios"
      ? await run("xcrun", ["simctl", "spawn", id, "log", "show", "--last", "2m", "--style", "compact"], 60_000)
      : await run("adb", ["-s", id, "logcat", "-d", "-t", String(lines)], 30_000);
  if (output === null) throw new Error("Could not read mobile logs.");
  const trimmed = output.split("\n").slice(-lines).join("\n").slice(-24_000);
  return { platform, deviceId: id, lines: trimmed.split("\n").length, output: trimmed };
}

export async function installMobileApp(
  rootPath: string,
  platform: "ios" | "android",
  id: string,
  inputPath: string,
): Promise<MobileInstallResult> {
  const trimmed = inputPath.trim();
  if (!trimmed) throw new Error("An app or APK path is required.");
  const absolute = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(rootPath, trimmed);
  const realRoot = await fs.realpath(rootPath);
  const realApp = await fs.realpath(absolute).catch(() => {
    throw new Error("App/APK path does not exist.");
  });
  if (!realApp.startsWith(`${realRoot}${path.sep}`) && realApp !== realRoot) {
    throw new Error("App/APK path is outside the project.");
  }
  if (platform === "ios") {
    const stat = await fs.stat(realApp);
    if (!stat.isDirectory() || !realApp.endsWith(".app")) {
      throw new Error("iOS install expects a built .app directory.");
    }
    const result = await run("xcrun", ["simctl", "install", id, realApp], 120_000);
    if (result === null) throw new Error("Could not install the iOS app. Is the simulator booted?");
    return { platform, deviceId: id, path: path.relative(rootPath, realApp), message: "iOS app installed." };
  }
  if (!realApp.endsWith(".apk")) throw new Error("Android install expects an .apk file.");
  const result = await run("adb", ["-s", id, "install", "-r", realApp], 120_000);
  if (result === null) throw new Error("Could not install the APK. Is the emulator/device connected?");
  return { platform, deviceId: id, path: path.relative(rootPath, realApp), message: result.trim().slice(-300) || "APK installed." };
}

export async function launchMobileApp(
  platform: "ios" | "android",
  id: string,
  target: string,
): Promise<MobileLaunchResult> {
  const value = target.trim();
  if (!value) throw new Error("A package name or bundle id is required.");
  if (platform === "ios") {
    const result = await run("xcrun", ["simctl", "launch", id, value], 30_000);
    if (result === null) throw new Error("Could not launch the iOS app.");
    return { platform, deviceId: id, target: value, message: "iOS app launched." };
  }
  const result = await run(
    "adb",
    [
      "-s",
      id,
      "shell",
      "monkey",
      "-p",
      value,
      "-c",
      "android.intent.category.LAUNCHER",
      "1",
    ],
    30_000,
  );
  if (result === null) throw new Error("Could not launch the Android app.");
  return { platform, deviceId: id, target: value, message: "Android app launched." };
}

export async function runMobileCheck(
  rootPath: string,
  options: MobileCheckOptions = {},
): Promise<MobileCheckResult> {
  const report = await listMobileDevices();
  const all = [...report.ios, ...report.android];
  const platform = options.platform;
  const target =
    (options.id ? all.find((device) => device.id === options.id) : undefined) ??
    (platform ? all.find((device) => device.platform === platform && device.state !== "shutdown") : undefined) ??
    all.find((device) => device.state === "booted" || device.state === "device") ??
    all[0];
  const warnings = [...report.warnings];
  if (!target) {
    return {
      warnings,
      summary: "No simulator, emulator or physical device was found.",
    };
  }
  const result: MobileCheckResult = { device: target, warnings, summary: "" };
  let active = target;
  const needsBoot =
    options.boot === true &&
    (active.state === "shutdown" || active.state === "offline");
  if (needsBoot) {
    try {
      result.boot = await bootMobileDevice(active.platform, active.id);
      if (result.boot.state === "starting") {
        warnings.push("Android emulator is still starting; screenshot/log steps were skipped.");
      } else {
        const refreshed = await listMobileDevices();
        active =
          [...refreshed.ios, ...refreshed.android].find((device) => device.id === active.id) ??
          active;
        result.device = active;
      }
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : "Device boot failed.");
    }
  }
  const ready = active.state === "booted" || active.state === "device";
  if (options.openUrl && ready) {
    try {
      result.openUrl = await openMobileUrl(active.platform, active.id, options.openUrl);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : "Could not open URL.");
    }
  }
  if (options.screenshot !== false && ready) {
    try {
      result.screenshot = await captureMobileScreenshot(rootPath, active.platform, active.id);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : "Could not capture screenshot.");
    }
  }
  if (options.logs === true && ready) {
    try {
      result.logs = await readMobileLogs(active.platform, active.id, options.logLimit ?? 120);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : "Could not read logs.");
    }
  }
  result.summary = [
    `${active.platform} · ${active.name} · ${active.state}`,
    result.boot ? result.boot.message : "",
    result.openUrl ? result.openUrl.message : "",
    result.screenshot ? `Screenshot: ${result.screenshot.path}` : "",
    result.logs ? `Logs: ${result.logs.lines} lines` : "",
    ...warnings,
  ]
    .filter(Boolean)
    .join("\n");
  return result;
}
