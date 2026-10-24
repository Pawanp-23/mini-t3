// Minimal client for `codex app-server`: newline-delimited JSON-RPC over stdio.
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

// Prefer an explicit CODEX_BIN, then the Codex desktop app's bundled CLI, then `codex` on PATH.
export function findCodexBinary() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  const root = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
  if (root && existsSync(root)) {
    for (const dir of readdirSync(root)) {
      const candidate = join(root, dir, "codex.exe");
      if (existsSync(candidate)) return candidate;
    }
  }
  return "codex";
}

export class CodexAppServer extends EventEmitter {
  #child;
  #nextId = 1;
  #pending = new Map();

  constructor({ binary = findCodexBinary(), cwd = process.cwd() } = {}) {
    super();
    this.binary = binary;
    this.cwd = cwd;
  }

  async start() {
    this.#child = spawn(this.binary, ["app-server"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child.on("error", (err) => this.emit("exit", err));
    this.#child.on("exit", (code) => {
      for (const { reject } of this.#pending.values()) reject(new Error(`codex app-server exited (${code})`));
      this.#pending.clear();
      this.emit("exit", code);
    });
    this.#child.stderr.on("data", (chunk) => this.emit("log", chunk.toString()));
    createInterface({ input: this.#child.stdout }).on("line", (line) => this.#onLine(line));

    const info = await this.request("initialize", {
      clientInfo: { name: "mini-t3", title: "Mini T3", version: "0.1.0" },
      capabilities: null,
    });
    this.notify("initialized");
    return info;
  }

  request(method, params) {
    const id = this.#nextId++;
    this.#send({ id, method, params });
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject, method }));
  }

  notify(method, params) {
    this.#send(params === undefined ? { method } : { method, params });
  }

  stop() {
    const child = this.#child;
    if (!child || child.exitCode !== null) return;
    // Codex starts its own helpers (MCP servers, sandbox runners). On Windows,
    // kill() ends only the top process, so end the whole tree.
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    else child.kill();
  }

  #send(message) {
    this.#child.stdin.write(JSON.stringify(message) + "\n");
  }

  #onLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.emit("log", `unparsed: ${line}\n`);
      return;
    }

    // Response to one of our requests.
    if (msg.id !== undefined && msg.method === undefined) {
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      this.#pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(`${pending.method}: ${msg.error.message ?? JSON.stringify(msg.error)}`));
      else pending.resolve(msg.result);
      return;
    }

    // Request from the server (approvals, tool calls). We run read-only with
    // approvals off, so anything that still arrives is declined.
    if (msg.id !== undefined && msg.method !== undefined) {
      this.emit("serverRequest", msg);
      this.#send({ id: msg.id, error: { code: -32601, message: `mini-t3 does not handle ${msg.method}` } });
      return;
    }

    this.emit("notification", msg.method, msg.params);
  }
}
