// Electron main process. Same shape as T3 Code's desktop shell:
//   1. re-run this executable as plain Node (ELECTRON_RUN_AS_NODE) to start the backend
//   2. hand it a secret bootstrap on a private pipe (fd 3), never on the command line
//   3. open a sandboxed window on the backend's loopback URL
//   4. expose a small, typed bridge to the page through the preload script
const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, session, shell } = require("electron");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { createInterface } = require("node:readline");
const CHANNELS = require("./channels.cjs");

const SERVER_ENTRY = path.join(__dirname, "..", "server", "index.js");
const PRELOAD = path.join(__dirname, "preload.cjs");
const BACKEND_START_TIMEOUT_MS = 30_000;
const BACKEND_STOP_TIMEOUT_MS = 3_000;

const token = randomBytes(24).toString("hex");
let backend = null;
let appOrigin = null;
let mainWindow = null;

function startBackend() {
  return new Promise((resolve, reject) => {
    backend = spawn(process.execPath, [SERVER_ENTRY, "--bootstrap-fd", "3"], {
      cwd: os.homedir(),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      // stdin, stdout, stderr, fd 3 (bootstrap), ipc (so the child notices if we die)
      stdio: ["ignore", "pipe", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });

    const bootstrap = { mode: "desktop", token, port: 0, workspace: os.homedir() };
    backend.stdio[3].end(JSON.stringify(bootstrap));

    const timer = setTimeout(() => reject(new Error("The backend did not start in time.")), BACKEND_START_TIMEOUT_MS);
    createInterface({ input: backend.stdout }).on("line", (line) => {
      const match = /^MINI_T3_LISTENING (\d+)$/.exec(line);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      } else {
        console.log(`[backend] ${line}`);
      }
    });
    backend.stderr.on("data", (chunk) => process.stderr.write(`[backend] ${chunk}`));
    backend.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`The backend exited during startup (code ${code}).`));
      if (!app.isQuitting) {
        dialog.showErrorBox("Mini T3", `The backend stopped (code ${code}). Restart the app.`);
        app.quit();
      }
    });
  });
}

// Every IPC handler runs this first: only our own page may call the bridge.
function assertTrustedSender(event) {
  const frameUrl = event.senderFrame?.url;
  if (!frameUrl || new URL(frameUrl).origin !== appOrigin) {
    throw new Error(`Blocked IPC from untrusted frame: ${frameUrl ?? "unknown"}`);
  }
}

// Wraps a handler so the sender check can't be forgotten. Each channel is still
// registered with a literal ipcMain.handle call, so static audits can pair it.
const guarded =
  (fn) =>
  (event, ...args) => {
    assertTrustedSender(event);
    return fn(event, ...args);
  };

function registerIpc() {
  ipcMain.handle(
    CHANNELS.GET_APP_INFO,
    guarded(() => ({
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
    })),
  );

  ipcMain.handle(
    CHANNELS.GET_BACKEND_TOKEN,
    guarded(() => token),
  );

  ipcMain.handle(
    CHANNELS.PICK_FOLDER,
    guarded(async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showOpenDialog(win, {
        title: "Choose a folder for Codex to read",
        properties: ["openDirectory"],
      });
      return result.canceled ? null : result.filePaths[0];
    }),
  );
}

function sendMenuAction(action) {
  mainWindow?.webContents.send(CHANNELS.MENU_ACTION, action);
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  return Menu.buildFromTemplate([
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        { label: "New Chat", accelerator: "CmdOrCtrl+N", click: () => sendMenuAction("new-chat") },
        { label: "Open Folder…", accelerator: "CmdOrCtrl+O", click: () => sendMenuAction("open-folder") },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        ...(app.isPackaged ? [] : [{ role: "toggleDevTools" }]),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
      ],
    },
  ]);
}

function hardenSession() {
  // The UI needs no camera, microphone, notifications or other permissions.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
}

function createWindow(port) {
  appOrigin = `http://127.0.0.1:${port}`;
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 380,
    minHeight: 480,
    show: false,
    title: "Mini T3",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0c0a09" : "#fafaf9",
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Never let the page open new windows or navigate away from the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== appOrigin) event.preventDefault();
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.loadURL(`${appOrigin}/`);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    hardenSession();
    registerIpc();
    Menu.setApplicationMenu(buildMenu());
    try {
      const port = await startBackend();
      createWindow(port);
    } catch (err) {
      dialog.showErrorBox("Mini T3 could not start", err.message);
      app.quit();
    }
  });

  // Let the backend stop Codex and its helpers before we exit; kill it if it hangs.
  app.on("before-quit", (event) => {
    app.isQuitting = true;
    if (!backend || backend.exitCode !== null) return;
    event.preventDefault();
    const force = setTimeout(() => backend.kill(), BACKEND_STOP_TIMEOUT_MS);
    backend.once("exit", () => {
      clearTimeout(force);
      app.quit();
    });
    backend.send({ type: "shutdown" });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
