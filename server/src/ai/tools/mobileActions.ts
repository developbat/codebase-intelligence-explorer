import {
  bootMobileDevice,
  captureMobileScreenshot,
  installMobileApp,
  launchMobileApp,
  openMobileUrl,
  readMobileLogs,
  runMobileCheck,
} from "../../mobileDevices";
import type { AgentToolHandler, AgentToolResult } from "./types";

function clampObservation(text: string, limit = 6_000): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… observation truncated …` : text;
}

const bootMobileDeviceHandler: AgentToolHandler = async (
  context,
): Promise<AgentToolResult> => {
  const platform = context.args.platform === "android" ? "android" : "ios";
  const id = String(context.args.id ?? "").trim();
  if (!id) throw new Error("A device id is required.");
  const allowed = await context.requirePermission(
    "command",
    "boot_mobile_device",
    id,
    `Boot ${platform} device ${id}.`,
  );
  if (!allowed) throw new Error("The user denied permission to boot the device.");
  const result = await bootMobileDevice(platform, id);
  context.log("info", "Mobile device boot", `${platform} ${id} · ${result.state}`);
  return {
    observation: `${result.message}\n${platform} ${result.id} · ${result.state}`,
    ok: result.state === "booted" || result.state === "device" || result.state === "starting",
  };
};

const mobileScreenshotHandler: AgentToolHandler = async (
  context,
): Promise<AgentToolResult> => {
  const platform = context.args.platform === "android" ? "android" : "ios";
  const id = String(context.args.id ?? "").trim();
  if (!id) throw new Error("A device id is required.");
  const allowed = await context.requirePermission(
    "command",
    "mobile_screenshot",
    id,
    `Capture a ${platform} screenshot from ${id}.`,
  );
  if (!allowed) throw new Error("The user denied permission to capture the screenshot.");
  const shot = await captureMobileScreenshot(context.analysis.rootPath, platform, id);
  context.evidence.push({ path: shot.path, label: "Mobile screenshot" });
  context.log("success", "Mobile screenshot captured", shot.path);
  return { observation: `Mobile screenshot saved: ${shot.path} (${shot.bytes} bytes).`, ok: true };
};

const installMobileAppHandler: AgentToolHandler = async (
  context,
): Promise<AgentToolResult> => {
  const platform = context.args.platform === "android" ? "android" : "ios";
  const id = String(context.args.id ?? "").trim();
  const appPath = String(context.args.path ?? "").trim();
  if (!id || !appPath) throw new Error("Device id and app path are required.");
  const allowed = await context.requirePermission(
    "command",
    "install_mobile_app",
    appPath,
    `Install ${appPath} on ${platform} ${id}.`,
  );
  if (!allowed) throw new Error("The user denied permission to install the app.");
  const result = await installMobileApp(context.analysis.rootPath, platform, id, appPath);
  context.log("success", "Mobile app installed", result.path);
  return { observation: result.message, ok: true };
};

const launchMobileAppHandler: AgentToolHandler = async (
  context,
): Promise<AgentToolResult> => {
  const platform = context.args.platform === "android" ? "android" : "ios";
  const id = String(context.args.id ?? "").trim();
  const target = String(context.args.target ?? "").trim();
  if (!id || !target) throw new Error("Device id and package/bundle id are required.");
  const allowed = await context.requirePermission(
    "command",
    "launch_mobile_app",
    target,
    `Launch ${target} on ${platform} ${id}.`,
  );
  if (!allowed) throw new Error("The user denied permission to launch the app.");
  const result = await launchMobileApp(platform, id, target);
  context.log("success", "Mobile app launched", target);
  return { observation: result.message, ok: true };
};

const openMobileUrlHandler: AgentToolHandler = async (
  context,
): Promise<AgentToolResult> => {
  const platform = context.args.platform === "android" ? "android" : "ios";
  const id = String(context.args.id ?? "").trim();
  const url = String(context.args.url ?? "").trim();
  if (!id || !url) throw new Error("Device id and URL are required.");
  const allowed = await context.requirePermission(
    "command",
    "open_mobile_url",
    url,
    `Open ${url} on ${platform} ${id}.`,
  );
  if (!allowed) throw new Error("The user denied permission to open the URL.");
  const result = await openMobileUrl(platform, id, url);
  context.log("info", "Mobile URL opened", `${platform} ${id} · ${url}`);
  return { observation: `${result.message}\n${url}`, ok: true };
};

const mobileLogsHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const platform = context.args.platform === "android" ? "android" : "ios";
  const id = String(context.args.id ?? "").trim();
  if (!id) throw new Error("A device id is required.");
  const allowed = await context.requirePermission(
    "command",
    "mobile_logs",
    id,
    `Read the last logs from ${platform} ${id}.`,
  );
  if (!allowed) throw new Error("The user denied permission to read mobile logs.");
  const logs = await readMobileLogs(platform, id, Number(context.args.limit) || 200);
  context.log("info", "Mobile logs read", `${platform} ${id} · ${logs.lines} lines`);
  return {
    observation: clampObservation(`Mobile logs (${logs.lines} lines):\n${logs.output}`),
    ok: true,
  };
};

const mobileCheckHandler: AgentToolHandler = async (context): Promise<AgentToolResult> => {
  const allowed = await context.requirePermission(
    "command",
    "mobile_check",
    String(context.args.id ?? context.args.platform ?? "auto"),
    "Run the unified mobile device check (boot, screenshot, logs, optional URL).",
  );
  if (!allowed) throw new Error("The user denied permission for the mobile check.");
  const check = await runMobileCheck(context.analysis.rootPath, {
    platform:
      context.args.platform === "android"
        ? "android"
        : context.args.platform === "ios"
          ? "ios"
          : undefined,
    id: typeof context.args.id === "string" ? context.args.id : undefined,
    boot: context.args.boot === true,
    screenshot: context.args.screenshot !== false,
    logs: context.args.logs === true,
    openUrl: typeof context.args.openUrl === "string" ? context.args.openUrl : undefined,
    logLimit: Number(context.args.logLimit) || undefined,
  });
  if (check.screenshot) {
    context.evidence.push({ path: check.screenshot.path, label: "Mobile check screenshot" });
  }
  const ok = Boolean(check.device) && check.warnings.length === 0;
  context.log(ok ? "success" : "warn", "Mobile check complete", check.device?.name ?? "no device");
  return { observation: check.summary, ok };
};

export const MOBILE_ACTION_HANDLERS: Record<string, AgentToolHandler> = {
  boot_mobile_device: bootMobileDeviceHandler,
  mobile_screenshot: mobileScreenshotHandler,
  install_mobile_app: installMobileAppHandler,
  launch_mobile_app: launchMobileAppHandler,
  open_mobile_url: openMobileUrlHandler,
  mobile_logs: mobileLogsHandler,
  mobile_check: mobileCheckHandler,
};
