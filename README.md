# Mini T3

A small chat app that drives the Codex agent the same way [T3 Code](https://github.com/pingdotgg/t3code) does. It was built after reverse engineering T3 Code with [REA](https://github.com/morluto/rea).

```
Browser UI  --WebSocket /ws-->  Node backend  --JSON-RPC over stdio-->  codex app-server
            <-- deltas -------                <-- item/agentMessage/delta --
```

- **UI** (`public/`): plain HTML, CSS and JS. Sends `message.dispatch`, streams the reply token by token, and can stop a running turn.
- **Backend** (`server/index.js`): serves the UI on `127.0.0.1`, checks a per-run token and the `Origin` header before opening the WebSocket, and relays turns.
- **Codex driver** (`server/codex.js`): spawns `codex app-server`, then runs `initialize`, `thread/start` and `turn/start`, and forwards notifications.

Codex runs with `sandbox: "read-only"` and `approvalPolicy: "never"`, so it can read the workspace but cannot change files or run commands that need approval.

## Desktop app

`npm run desktop` opens the same UI in an Electron window, built like T3 Code's desktop shell:

```
Electron main ──spawns itself as Node (ELECTRON_RUN_AS_NODE)──▶ backend
      │            bootstrap {token, port, workspace} on fd 3
      ▼
sandboxed window ── window.desktopBridge (preload) ── IPC desktop:* ──▶ main
```

- The window runs with `contextIsolation`, `sandbox` and no `nodeIntegration`. It cannot open new windows or navigate off the app, and all permission requests are denied.
- The backend picks a random loopback port. The token is passed on a private pipe and handed to the page by the bridge, never written into the HTML.
- Every IPC handler checks that the call comes from the app's own origin.
- Quitting asks the backend to stop Codex and its helper processes, with a hard kill after 3 s.

`window.desktopBridge` (typed in `desktop/bridge.d.ts`):

| Member | What it does |
| --- | --- |
| `platform` | OS name, e.g. `win32` |
| `getAppInfo()` | App name, version, Electron and Chrome versions |
| `getBackendToken()` | Token for the backend WebSocket |
| `pickFolder()` | Native folder picker; switches the folder Codex reads |
| `onMenuAction(cb)` | File menu: New Chat (Ctrl+N), Open Folder (Ctrl+O) |

In a normal browser the bridge is absent and the UI falls back to the token in the page.

## Run

Requires Node.js 22+ and the Codex CLI or the Codex desktop app, signed in.

```bash
npm install
npm run desktop   # Electron app
npm start         # or: browser at http://localhost:3773
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `WORKSPACE` | current folder | Folder Codex can read |
| `PORT` | `3773` | Local port |
| `CODEX_BIN` | auto-detected | Path to `codex` / `codex.exe` |

On Windows, `CODEX_BIN` is found automatically from the Codex desktop app under `%LOCALAPPDATA%\OpenAI\Codex\bin`.

## Not yet

- Packaged installer (electron-builder) and code signing
- Saved threads and history
- Approvals for file edits and commands
- Markdown rendering
