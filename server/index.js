// HTTP + WebSocket backend: serves the UI, authenticates the socket, and relays
// chat turns between the browser and one shared `codex app-server` process.
//
// Two ways to start it:
//   browser mode  `npm start`                 token is embedded in the page
//   desktop mode  `bin --bootstrap-fd 3`      Electron sends {token, port, workspace}
//                                             on fd 3; the page gets the token from
//                                             window.desktopBridge instead
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { CodexAppServer } from "./codex.js";

async function readBootstrap() {
  const flag = process.argv.indexOf("--bootstrap-fd");
  if (flag === -1) return null;
  const fd = Number(process.argv[flag + 1]);
  let raw = "";
  for await (const chunk of createReadStream(null, { fd, encoding: "utf8" })) raw += chunk;
  return JSON.parse(raw);
}

const bootstrap = await readBootstrap();
const DESKTOP = bootstrap?.mode === "desktop";
const HOST = "127.0.0.1";
const TOKEN = bootstrap?.token ?? randomBytes(24).toString("hex");
const DEFAULT_WORKSPACE = resolve(bootstrap?.workspace ?? process.env.WORKSPACE ?? process.cwd());
const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));

let port = bootstrap?.port ?? Number(process.env.PORT ?? 3773);
const origins = () => new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

const codex = new CodexAppServer({ cwd: DEFAULT_WORKSPACE });
codex.on("log", (line) => process.stderr.write(`[codex] ${line}`));
codex.on("exit", (code) => {
  console.error(`codex app-server stopped (${code}). Restart mini-t3 to reconnect.`);
  for (const conn of connections) conn.send({ type: "error", message: "Codex stopped. Restart the app." });
});

const connections = new Set();
const connectionByThread = new Map();

codex.on("notification", (method, params) => {
  const conn = params?.threadId && connectionByThread.get(params.threadId);
  if (!conn) return;
  switch (method) {
    case "turn/started":
      conn.turnId = params.turn.id;
      conn.send({ type: "turn.started", turnId: params.turn.id });
      break;
    case "item/agentMessage/delta":
      conn.send({ type: "delta", itemId: params.itemId, delta: params.delta });
      break;
    case "item/started":
      if (params.item.type === "commandExecution") conn.send({ type: "activity", text: `Running ${params.item.command}` });
      else if (params.item.type === "reasoning") conn.send({ type: "activity", text: "Thinking" });
      break;
    case "error":
      conn.send({ type: "error", message: params.error.message, willRetry: params.willRetry });
      break;
    case "turn/completed":
      conn.turnId = null;
      conn.send({ type: "turn.completed", status: params.turn.status, error: params.turn.error?.message ?? null });
      break;
  }
});

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${HOST}`);
  const path = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = normalize(join(PUBLIC_DIR, path));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  try {
    let body = await readFile(file);
    // In desktop mode the token never touches the HTML; the preload bridge hands it over.
    if (path === "/index.html") body = body.toString().replace("__MINI_T3_TOKEN__", DESKTOP ? "" : TOKEN);
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": `default-src 'self'; connect-src 'self' ws://localhost:${port} ws://127.0.0.1:${port}`,
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

const server = createServer((req, res) => {
  if (req.method !== "GET") return res.writeHead(405).end();
  serveStatic(req, res);
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${HOST}`);
  const originOk = origins().has(req.headers.origin);
  if (url.pathname !== "/ws" || !originOk || !safeEqual(url.searchParams.get("token"), TOKEN)) {
    socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
});

wss.on("connection", (ws) => {
  const conn = {
    workspace: DEFAULT_WORKSPACE,
    threadId: null,
    turnId: null,
    send: (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg)),
  };
  connections.add(conn);
  conn.send({ type: "ready", workspace: conn.workspace });

  const resetThread = () => {
    if (conn.threadId) connectionByThread.delete(conn.threadId);
    conn.threadId = null;
  };

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    try {
      if (msg.type === "message.dispatch" && typeof msg.text === "string" && msg.text.trim()) {
        if (conn.turnId) return conn.send({ type: "error", message: "Wait for the current reply to finish." });
        if (!conn.threadId) {
          const started = await codex.request("thread/start", {
            cwd: conn.workspace,
            sandbox: "read-only",
            approvalPolicy: "never",
            ephemeral: true,
          });
          conn.threadId = started.thread.id;
          connectionByThread.set(conn.threadId, conn);
          conn.send({ type: "thread.started", model: started.model });
        }
        conn.send({ type: "ack" });
        await codex.request("turn/start", {
          threadId: conn.threadId,
          input: [{ type: "text", text: msg.text, text_elements: [] }],
        });
      } else if (msg.type === "turn.interrupt" && conn.threadId && conn.turnId) {
        await codex.request("turn/interrupt", { threadId: conn.threadId, turnId: conn.turnId });
      } else if (msg.type === "thread.new") {
        if (conn.turnId) return conn.send({ type: "error", message: "Stop the current reply before starting a new chat." });
        resetThread();
        conn.send({ type: "ready", workspace: conn.workspace, switched: true });
      } else if (msg.type === "workspace.set" && typeof msg.path === "string") {
        if (conn.turnId) return conn.send({ type: "error", message: "Stop the current reply before switching folders." });
        if (!isAbsolute(msg.path) || !(await isDirectory(msg.path))) {
          return conn.send({ type: "error", message: "That folder does not exist." });
        }
        conn.workspace = resolve(msg.path);
        resetThread();
        conn.send({ type: "ready", workspace: conn.workspace, switched: true });
      }
    } catch (err) {
      conn.send({ type: "error", message: err.message });
    }
  });

  ws.on("close", () => {
    connections.delete(conn);
    resetThread();
  });
});

await codex.start();
server.listen(port, HOST, () => {
  port = server.address().port;
  if (DESKTOP) {
    // The Electron main process waits for this line to know where to point the window.
    console.log(`MINI_T3_LISTENING ${port}`);
  } else {
    console.log(`mini-t3 running at http://localhost:${port}`);
  }
  console.log(`Codex workspace (read-only): ${DEFAULT_WORKSPACE}`);
});

function shutdown() {
  codex.stop();
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, shutdown);

if (DESKTOP) {
  // The main process asks for a clean stop on quit (signals don't reach us on Windows),
  // and if it dies without asking, the IPC channel disconnects.
  process.on("message", (msg) => msg?.type === "shutdown" && shutdown());
  process.on("disconnect", shutdown);
}
