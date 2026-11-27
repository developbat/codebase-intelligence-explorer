const { app, BrowserWindow, dialog, shell, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");

const UPDATE_STATE_CHANNEL = "bad:update-state";
const RELEASE_URL = "https://github.com/developbat/codebase-intelligence-explorer/releases";

let serverProcess = null;
let serverBaseUrl = "";
let mainWindow = null;
let quitting = false;

let autoUpdater = null;
let updaterLoadError = "";
try {
  ({ autoUpdater } = require("electron-updater"));
} catch (error) {
  updaterLoadError = error instanceof Error ? error.message : String(error);
  console.error("[updater] electron-updater is unavailable:", updaterLoadError);
}

const updateState = {
  supported: Boolean(autoUpdater) && app.isPackaged,
  status: "idle",
  currentVersion: app.getVersion(),
  latestVersion: null,
  progress: null,
  message: "",
  releaseUrl: RELEASE_URL,
  platform: process.platform,
  arch: process.arch,
};

function publishUpdateState(patch = {}) {
  Object.assign(updateState, patch);
  updateState.currentVersion = app.getVersion();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(UPDATE_STATE_CHANNEL, updateState);
  }
}

function setupUpdater() {
  if (!autoUpdater) return;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on("checking-for-update", () => {
    publishUpdateState({ status: "checking", progress: null, message: "Checking for updates…" });
  });
  autoUpdater.on("update-available", (info) => {
    publishUpdateState({
      status: "available",
      latestVersion: info && info.version ? info.version : null,
      progress: null,
      message: "A new version is available.",
    });
  });
  autoUpdater.on("update-not-available", (info) => {
    publishUpdateState({
      status: "not-available",
      latestVersion: info && info.version ? info.version : updateState.currentVersion,
      progress: null,
      message: "You are on the latest version.",
    });
  });
  autoUpdater.on("download-progress", (progress) => {
    publishUpdateState({
      status: "downloading",
      progress: Math.round(Number(progress && progress.percent) || 0),
      message: "Downloading update…",
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    publishUpdateState({
      status: "downloaded",
      latestVersion: info && info.version ? info.version : updateState.latestVersion,
      progress: 100,
      message: "Update downloaded. Restart to finish installing.",
    });
  });
  autoUpdater.on("error", (error) => {
    publishUpdateState({
      status: "error",
      progress: null,
      message: error instanceof Error ? error.message : String(error),
    });
  });
}

ipcMain.handle("bad:update:get-state", () => updateState);

ipcMain.handle("bad:update:check", async () => {
  if (!updateState.supported) {
    return updateState;
  }
  if (updateState.status === "checking" || updateState.status === "downloading") {
    return updateState;
  }
  publishUpdateState({ status: "checking", progress: null, message: "Checking for updates…" });
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    publishUpdateState({
      status: "error",
      progress: null,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return updateState;
});

ipcMain.handle("bad:update:download", async () => {
  if (!updateState.supported) {
    return updateState;
  }
  if (updateState.status === "downloading") {
    return updateState;
  }
  publishUpdateState({ status: "downloading", progress: 0, message: "Starting download…" });
  try {
    await autoUpdater.downloadUpdate();
  } catch (error) {
    publishUpdateState({
      status: "error",
      progress: null,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return updateState;
});

ipcMain.handle("bad:update:install", () => {
  if (!updateState.supported || updateState.status !== "downloaded") {
    return updateState;
  }
  quitting = true;
  setTimeout(() => {
    autoUpdater.quitAndInstall(false, true);
  }, 120);
  return updateState;
});

setupUpdater();

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(url, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function startServer() {
  const appRoot = app.isPackaged
    ? path.join(process.resourcesPath, "app")
    : path.resolve(__dirname, "..");
  const serverPath = app.isPackaged
    ? path.join(appRoot, "server", "index.mjs")
    : path.join(appRoot, "dist-server", "index.mjs");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, [serverPath], {
    cwd: appRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PORT: String(port),
      CIE_SERVE_WEB: "1",
      CIE_APP_ROOT: appRoot,
      CIE_BROWSER_BASE: baseUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProcess.stdout.on("data", (chunk) => process.stdout.write(`[server] ${chunk}`));
  serverProcess.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));
  serverProcess.on("exit", (code) => {
    if (!quitting) {
      dialog.showErrorBox(
        "B.A.D IDE server stopped",
        `The local server exited with code ${code ?? "unknown"}. Restart the app.`,
      );
    }
  });
  const ready = await waitForServer(baseUrl);
  if (!ready) {
    dialog.showErrorBox(
      "B.A.D IDE could not start",
      `The local server did not become ready at ${baseUrl}.`,
    );
    throw new Error("Server startup timed out.");
  }
  serverBaseUrl = baseUrl;
  return baseUrl;
}

function createWindow(baseUrl) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#070b12",
    title: "B.A.D IDE",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  mainWindow.loadURL(baseUrl);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.setName("B.A.D IDE");

app.whenReady().then(async () => {
  try {
    const baseUrl = await startServer();
    createWindow(baseUrl);
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0 && mainWindow === null) {
        if (serverBaseUrl) createWindow(serverBaseUrl);
        else void startServer().then(createWindow);
      }
    });
  } catch (error) {
    dialog.showErrorBox("B.A.D IDE", error instanceof Error ? error.message : String(error));
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  quitting = true;
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill("SIGTERM");
    setTimeout(() => serverProcess?.kill("SIGKILL"), 2_000).unref?.();
  }
});
