// Contract for window.desktopBridge, implemented in preload.cjs and main.cjs.
// public/app.js references this file so editors type-check bridge calls.

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
  electron: string;
  chrome: string;
}

export type MenuAction = "new-chat" | "open-folder";

export interface DesktopBridge {
  /** Operating system the desktop app runs on, e.g. "win32". */
  readonly platform: string;
  /** App name and runtime versions. */
  getAppInfo(): Promise<AppInfo>;
  /** Per-launch token the backend WebSocket requires. */
  getBackendToken(): Promise<string>;
  /** Native folder picker. Resolves to an absolute path, or null if cancelled. */
  pickFolder(): Promise<string | null>;
  /** Subscribe to File menu actions. Returns an unsubscribe function. */
  onMenuAction(callback: (action: MenuAction) => void): () => void;
}

declare global {
  interface Window {
    /** Present only inside the Electron app; undefined in a normal browser. */
    desktopBridge?: DesktopBridge;
  }
}
