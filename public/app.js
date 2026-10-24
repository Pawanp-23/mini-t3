// @ts-check
/// <reference path="../desktop/bridge.d.ts" />
// Browser side: one WebSocket to the local backend, one chat thread.
// Inside the Electron app, window.desktopBridge supplies the token and native actions.
const bridge = window.desktopBridge;
const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const thread = $("thread");
const input = /** @type {HTMLTextAreaElement} */ ($("input"));
const send = /** @type {HTMLButtonElement} */ ($("send"));
const statusEl = $("status");

/** @type {WebSocket} */
let ws;
let token = "";
let connected = false;
let busy = false;
/** @type {HTMLElement | null} the assistant message being streamed into */
let current = null;
/** @type {HTMLElement | null} the "Thinking" / "Running …" line for the current turn */
let activity = null;

function setStatus(/** @type {string} */ state, /** @type {string} */ text) {
  statusEl.dataset.state = state;
  $("status-text").textContent = text;
  statusEl.title = text;
}

function refreshComposer() {
  send.disabled = !connected || (!busy && !input.value.trim());
  send.textContent = busy ? "Stop" : "Send";
  send.classList.toggle("stop", busy);
}

function add(/** @type {string} */ kind, /** @type {string} */ text) {
  $("empty")?.remove();
  const el = document.createElement("div");
  el.className = `msg ${kind}`;
  el.textContent = text;
  thread.append(el);
  thread.scrollTop = thread.scrollHeight;
  return el;
}

function clearThread() {
  thread.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.id = "empty";
  empty.innerHTML = "<h2>Ask Codex about your code</h2><p>Codex can read the workspace above but cannot change files.</p>";
  thread.append(empty);
}

function endTurn() {
  busy = false;
  current?.classList.remove("streaming");
  current = null;
  activity?.remove();
  activity = null;
  refreshComposer();
}

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(token)}`);
  ws.addEventListener("open", () => {
    connected = true;
    setStatus("ready", "Connected");
    refreshComposer();
  });
  ws.addEventListener("close", () => {
    connected = false;
    endTurn();
    setStatus("offline", "Offline");
    refreshComposer();
    setTimeout(connect, 2000);
  });
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case "ready":
        $("workspace").textContent = msg.workspace;
        $("workspace").title = msg.workspace;
        if (msg.switched) {
          clearThread();
          setStatus("ready", "Connected");
        }
        break;
      case "thread.started":
        setStatus("ready", msg.model);
        break;
      case "activity":
        // A tool call or reasoning step ends the message being streamed.
        current?.classList.remove("streaming");
        current = null;
        activity ??= add("notice", "");
        activity.textContent = msg.text + "…";
        break;
      case "delta":
        activity?.remove();
        activity = null;
        // Codex can send several agent messages per turn; give each its own bubble.
        if (current && current.dataset.item !== msg.itemId) {
          current.classList.remove("streaming");
          current = null;
        }
        if (!current) {
          current = add("assistant streaming", "");
          current.dataset.item = msg.itemId;
        }
        current.textContent += msg.delta;
        thread.scrollTop = thread.scrollHeight;
        break;
      case "turn.completed":
        if (msg.status === "interrupted") add("notice", "Stopped.");
        if (msg.status === "failed") add("error", msg.error ?? "Codex could not finish this reply.");
        endTurn();
        break;
      case "error":
        if (!msg.willRetry) {
          add("error", msg.message);
          if (!current) endTurn();
        }
        break;
    }
  });
}

function dispatch() {
  const text = input.value.trim();
  if (!text || !connected) return;
  add("user", text);
  input.value = "";
  input.style.height = "";
  busy = true;
  activity = add("notice", "Thinking…");
  refreshComposer();
  ws.send(JSON.stringify({ type: "message.dispatch", text }));
}

function newChat() {
  if (connected && !busy) ws.send(JSON.stringify({ type: "thread.new" }));
}

async function openFolder() {
  if (!bridge || !connected || busy) return;
  const path = await bridge.pickFolder();
  if (path) ws.send(JSON.stringify({ type: "workspace.set", path }));
}

$("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  if (busy) ws.send(JSON.stringify({ type: "turn.interrupt" }));
  else dispatch();
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!busy) dispatch();
  }
});

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
  refreshComposer();
});

async function main() {
  if (bridge) {
    // Desktop: the token comes from the main process, never from the HTML.
    token = await bridge.getBackendToken();
    $("desktop-actions").hidden = false;
    $("new-chat").addEventListener("click", newChat);
    $("open-folder").addEventListener("click", openFolder);
    bridge.onMenuAction((action) => (action === "new-chat" ? newChat() : openFolder()));
  } else {
    token = /** @type {HTMLMetaElement} */ (document.querySelector('meta[name="mini-t3-token"]')).content;
  }
  connect();
}

main();
