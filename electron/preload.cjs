const { contextBridge, ipcRenderer } = require("electron");

const UPDATE_STATE_CHANNEL = "bad:update-state";

contextBridge.exposeInMainWorld("badDesktop", {
  isDesktop: true,
  platform: process.platform,
  updates: {
    getState: () => ipcRenderer.invoke("bad:update:get-state"),
    check: () => ipcRenderer.invoke("bad:update:check"),
    download: () => ipcRenderer.invoke("bad:update:download"),
    install: () => ipcRenderer.invoke("bad:update:install"),
    onState: (callback) => {
      const handler = (_event, state) => callback(state);
      ipcRenderer.on(UPDATE_STATE_CHANNEL, handler);
      return () => ipcRenderer.removeListener(UPDATE_STATE_CHANNEL, handler);
    },
  },
});
