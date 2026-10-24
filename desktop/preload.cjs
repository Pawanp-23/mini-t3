// Runs in the sandboxed renderer before the page. It exposes exactly one object,
// window.desktopBridge, whose shape is declared in bridge.d.ts.
const { contextBridge, ipcRenderer } = require("electron");

// Copy of channels.cjs (a sandboxed preload cannot require local files).
const CHANNELS = {
  GET_APP_INFO: "desktop:get-app-info",
  GET_BACKEND_TOKEN: "desktop:get-backend-token",
  PICK_FOLDER: "desktop:pick-folder",
  MENU_ACTION: "desktop:menu-action",
};

const MENU_ACTIONS = new Set(["new-chat", "open-folder"]);

contextBridge.exposeInMainWorld("desktopBridge", {
  platform: process.platform,
  getAppInfo: () => ipcRenderer.invoke(CHANNELS.GET_APP_INFO),
  getBackendToken: () => ipcRenderer.invoke(CHANNELS.GET_BACKEND_TOKEN),
  pickFolder: () => ipcRenderer.invoke(CHANNELS.PICK_FOLDER),
  onMenuAction: (callback) => {
    // Hand the page only the action name, never the raw IPC event.
    const listener = (_event, action) => {
      if (MENU_ACTIONS.has(action)) callback(action);
    };
    ipcRenderer.on(CHANNELS.MENU_ACTION, listener);
    return () => ipcRenderer.removeListener(CHANNELS.MENU_ACTION, listener);
  },
});
