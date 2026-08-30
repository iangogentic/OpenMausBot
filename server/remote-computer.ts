// Shared provisioning and shell contract for the cloud computer's Cua Driver.
// The box command API is the transport boundary: the daemon stays loopback-only
// inside the VM and OpenMausBot never exposes another inbound port.

export const REMOTE_CUA_VERSION = "0.20.0";
export const REMOTE_CUA_EXECUTABLE = "/opt/ogb/cua-driver";
export const REMOTE_CUA_SOCKET = "/opt/ogb/run/cua.sock";
export const REMOTE_CUA_SESSION = "openmausbot";
export const REMOTE_CDP_HELPER = "/opt/ogb/openmausbot-cdp.mjs";

const REMOTE_CUA_WHEELS = {
  x86_64: {
    url: "https://files.pythonhosted.org/packages/fa/d7/a43008a328a40c85e7bc706fc20235b9abedc75e28b413817655153157ff/cua_driver-0.20.0-py3-none-manylinux_2_31_x86_64.whl",
    sha256: "f60c35696a37f37ac954935e478ae4754f220856d022036625c9400d72185961",
  },
  aarch64: {
    url: "https://files.pythonhosted.org/packages/94/9d/1c1838b69067e83266c3d2aae02d74eef353a43dc8644884ccf03fe7f933/cua_driver-0.20.0-py3-none-manylinux_2_31_aarch64.whl",
    sha256: "48833bc5e4c60e701fc9eefb57dbac36ec77ef3990f816fbbe85b4e954af2c77",
  },
} as const;

export const REMOTE_CDP_HELPER_SOURCE = String.raw`import net from "node:net";
import { createHash, randomBytes } from "node:crypto";

const [action, encoded = ""] = process.argv.slice(2);
const HTTP_MAX_BYTES = 1024 * 1024;
const WS_MAX_BYTES = 8 * 1024 * 1024;
const WS_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const WS_MAX_FRAMES = 10000;
const WS_MAX_FRAMES_PER_SECOND = 2000;
const WS_MAX_PENDING_WRITE_BYTES = 4 * 1024 * 1024;
const WS_HANDSHAKE_MAX_BYTES = 16 * 1024;
const INPUT_MAX_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 50000;
const MAX_PAGES = 1000;
const MAX_PENDING = 16;
const REQUEST_TIMEOUT_MS = 10000;
const AX_MAX_SCANNED_NODES = 10000;
const decodeUtf8 = (bytes, label) => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(label + " was not valid UTF-8");
  }
};
const assertShape = (root) => {
  let nodes = 0;
  const stack = [{ value: root, depth: 1 }];
  while (stack.length) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > MAX_JSON_NODES) throw new Error("DevTools JSON exceeded its node limit");
    if (current.depth > MAX_JSON_DEPTH) throw new Error("DevTools JSON exceeded its depth limit");
    if (current.value === null || typeof current.value !== "object") continue;
    const values = Array.isArray(current.value) ? current.value : Object.values(current.value);
    for (let index = values.length - 1; index >= 0; index -= 1) {
      stack.push({ value: values[index], depth: current.depth + 1 });
    }
  }
};
const parseJson = (text, label) => {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(label + " was not valid JSON");
  }
  assertShape(value);
  return value;
};
const openBoundedWebSocket = (url, onText, onFailure) => new Promise((resolve, reject) => {
  const key = randomBytes(16).toString("base64");
  const expectedAccept = createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  let socket;
  let incoming = Buffer.alloc(0);
  let readingHandshake = true;
  let opened = false;
  let failed = false;
  let closing = false;
  let payloadBytes = 0;
  let frames = 0;
  let windowStartedAt = Date.now();
  let windowFrames = 0;
  let fragmentBytes = 0;
  let fragments = [];

  const fail = (reason) => {
    if (failed) return;
    failed = true;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    try { socket?.destroy(); } catch {}
    if (opened) onFailure(error);
    else reject(error);
  };
  const sendFrame = (opcode, payload = Buffer.alloc(0)) => {
    if (failed || !socket || socket.destroyed) throw new Error("DevTools connection is unavailable");
    if (payload.length > WS_MAX_BYTES) throw new Error("DevTools request exceeded its byte limit");
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    } else if (payload.length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const mask = randomBytes(4);
    const frameBytes = header.length + mask.length + payload.length;
    if (socket.writableLength + frameBytes > WS_MAX_PENDING_WRITE_BYTES) {
      throw new Error("DevTools request queue exceeded its byte limit");
    }
    const frame = Buffer.allocUnsafe(frameBytes);
    header.copy(frame, 0);
    mask.copy(frame, header.length);
    for (let index = 0; index < payload.length; index += 1) {
      frame[header.length + 4 + index] = payload[index] ^ mask[index & 3];
    }
    socket.write(frame);
  };
  const close = () => {
    if (closing || !socket) return;
    closing = true;
    try { sendFrame(0x08); } catch {}
    socket.end();
    const failsafe = setTimeout(() => socket.destroy(), 500);
    failsafe.unref?.();
  };
  const transport = {
    sendText(text) { sendFrame(0x01, Buffer.from(text, "utf8")); },
    close,
    get closed() { return failed || closing || !socket || socket.destroyed; },
  };
  const deliverText = (payload) => {
    onText(decodeUtf8(payload, "DevTools frame"));
  };
  const consumeFrame = (opcode, fin, payload) => {
    if (opcode === 0x08) return fail(new Error("DevTools connection closed"));
    if (opcode === 0x09) {
      if (!fin || payload.length > 125) return fail(new Error("DevTools returned an invalid ping frame"));
      try { sendFrame(0x0a, payload); } catch (error) { fail(error); }
      return;
    }
    if (opcode === 0x0a) {
      if (!fin || payload.length > 125) fail(new Error("DevTools returned an invalid pong frame"));
      return;
    }
    if (opcode === 0x02) return fail(new Error("DevTools returned an unsupported binary frame"));
    if (opcode === 0x01) {
      if (fragments.length) return fail(new Error("DevTools returned overlapping fragmented frames"));
      if (fin) {
        try { deliverText(payload); } catch (error) { fail(error); }
      } else {
        fragmentBytes = payload.length;
        fragments = [Buffer.from(payload)];
      }
      return;
    }
    if (opcode === 0x00) {
      if (!fragments.length) return fail(new Error("DevTools returned an unexpected continuation frame"));
      fragmentBytes += payload.length;
      if (fragmentBytes > WS_MAX_BYTES) return fail(new Error("DevTools fragmented message exceeded its byte limit"));
      fragments.push(Buffer.from(payload));
      if (fin) {
        const complete = Buffer.concat(fragments, fragmentBytes);
        fragments = [];
        fragmentBytes = 0;
        try { deliverText(complete); } catch (error) { fail(error); }
      }
      return;
    }
    fail(new Error("DevTools returned an unsupported WebSocket opcode"));
  };
  const parseFrames = () => {
    while (!failed && incoming.length >= 2) {
      const first = incoming[0];
      const second = incoming[1];
      if ((first & 0x70) !== 0) return fail(new Error("DevTools returned a frame with unsupported extensions"));
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      if ((second & 0x80) !== 0) return fail(new Error("DevTools returned an invalid masked server frame"));
      let length = second & 0x7f;
      let headerBytes = 2;
      if (length === 126) {
        if (incoming.length < 4) return;
        length = incoming.readUInt16BE(2);
        headerBytes = 4;
      } else if (length === 127) {
        if (incoming.length < 10) return;
        if (incoming.readUInt32BE(2) !== 0) return fail(new Error("DevTools frame exceeded its byte limit"));
        length = incoming.readUInt32BE(6);
        headerBytes = 10;
      }
      if (length > WS_MAX_BYTES) return fail(new Error("DevTools frame exceeded its byte limit"));
      if (incoming.length < headerBytes + length) return;
      frames += 1;
      payloadBytes += length;
      if (frames > WS_MAX_FRAMES || payloadBytes > WS_MAX_TOTAL_BYTES) {
        return fail(new Error("DevTools stream exceeded its cumulative limit"));
      }
      const now = Date.now();
      if (now - windowStartedAt >= 1000) {
        windowStartedAt = now;
        windowFrames = 0;
      }
      windowFrames += 1;
      if (windowFrames > WS_MAX_FRAMES_PER_SECOND) {
        return fail(new Error("DevTools stream exceeded its frame-rate limit"));
      }
      const payload = incoming.subarray(headerBytes, headerBytes + length);
      incoming = Buffer.from(incoming.subarray(headerBytes + length));
      consumeFrame(opcode, fin, payload);
    }
  };
  const onData = (chunk) => {
    if (failed) return;
    const cap = readingHandshake ? WS_HANDSHAKE_MAX_BYTES : WS_MAX_BYTES + 10;
    if (chunk.length > cap - incoming.length) return fail(new Error("DevTools socket buffer exceeded its byte limit"));
    incoming = incoming.length ? Buffer.concat([incoming, chunk], incoming.length + chunk.length) : Buffer.from(chunk);
    if (readingHandshake) {
      const boundary = incoming.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      const rawHeaders = incoming.subarray(0, boundary + 4);
      for (const byte of rawHeaders) {
        if ((byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte > 0x7e) {
          return fail(new Error("DevTools returned invalid WebSocket handshake bytes"));
        }
      }
      const lines = rawHeaders.toString("ascii").split("\r\n");
      if (!/^HTTP\/1\.[01] 101(?: |$)/.test(lines.shift() ?? "")) {
        return fail(new Error("DevTools rejected the WebSocket handshake"));
      }
      const headers = new Map();
      for (const line of lines) {
        if (!line) continue;
        const separator = line.indexOf(":");
        if (separator <= 0) return fail(new Error("DevTools returned malformed WebSocket headers"));
        const name = line.slice(0, separator).trim().toLowerCase();
        const value = line.slice(separator + 1).trim();
        headers.set(name, headers.has(name) ? headers.get(name) + "," + value : value);
      }
      if (!String(headers.get("upgrade") ?? "").toLowerCase().includes("websocket") ||
          !String(headers.get("connection") ?? "").toLowerCase().split(/\s*,\s*/).includes("upgrade") ||
          headers.get("sec-websocket-accept") !== expectedAccept) {
        return fail(new Error("DevTools returned an invalid WebSocket handshake"));
      }
      incoming = Buffer.from(incoming.subarray(boundary + 4));
      readingHandshake = false;
      opened = true;
      socket.setTimeout(0);
      resolve(transport);
    }
    if (!readingHandshake) parseFrames();
  };

  socket = net.createConnection({ host: url.hostname, port: Number(url.port) });
  socket.setNoDelay(true);
  socket.setTimeout(5000, () => fail(new Error("DevTools connection timed out")));
  socket.on("error", fail);
  socket.on("close", () => {
    if (!closing && !failed) fail(new Error("DevTools connection closed"));
  });
  socket.on("data", onData);
  socket.on("connect", () => {
    socket.write([
      "GET " + (url.pathname || "/") + url.search + " HTTP/1.1",
      "Host: " + url.host,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: " + key,
      "Sec-WebSocket-Version: 13",
      "",
      "",
    ].join("\r\n"));
  });
});
const boundedJsonResponse = async (response) => {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error("DevTools page discovery failed (HTTP " + response.status + ")");
  }
  const contentLength = response.headers.get("content-length");
  const declared = contentLength === null ? null : Number(contentLength);
  if (declared !== null && (!Number.isSafeInteger(declared) || declared < 0 || declared > HTTP_MAX_BYTES)) {
    await response.body?.cancel().catch(() => {});
    throw new Error("DevTools page discovery exceeded its byte limit");
  }
  if (!response.body) throw new Error("DevTools page discovery returned no body");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > HTTP_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("DevTools page discovery exceeded its byte limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return parseJson(decodeUtf8(Buffer.concat(chunks, total), "DevTools page discovery"), "DevTools page discovery");
};
if (!/^[A-Za-z0-9_-]*$/.test(encoded)) throw new Error("browser input was not valid base64url");
const inputBytes = Buffer.from(encoded, "base64url");
if (inputBytes.byteLength > INPUT_MAX_BYTES) throw new Error("browser input exceeded its byte limit");
const input = parseJson(decodeUtf8(inputBytes, "browser input") || "{}", "browser input");
const pages = await boundedJsonResponse(await fetch("http://127.0.0.1:9222/json/list", {
  signal: AbortSignal.timeout(5000),
  redirect: "error",
}));
if (!Array.isArray(pages) || pages.length > MAX_PAGES) throw new Error("invalid or excessive DevTools page list");
const page = pages.find((item) => item && item.type === "page" && typeof item.webSocketDebuggerUrl === "string");
if (!page) throw new Error("no debuggable browser page");
if (input.url && page.url !== input.url) throw new Error("page changed; take a new browser snapshot");
const debuggerUrl = new URL(page.webSocketDebuggerUrl);
if (debuggerUrl.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(debuggerUrl.hostname) || debuggerUrl.port !== "9222" || debuggerUrl.username || debuggerUrl.password) {
  throw new Error("DevTools returned an unsafe debugger URL");
}
let nextId = 0;
const pending = new Map();
let socketFailed = false;
let socket;
const failSocket = (error) => {
  if (socketFailed) return;
  socketFailed = true;
  for (const waiter of pending.values()) waiter.reject(error);
  pending.clear();
  try { socket?.close(); } catch {}
};
const handleMessage = (text) => {
  const message = parseJson(text, "DevTools frame");
  if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("DevTools returned an invalid frame");
  if (!message.id) return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(String(message.error.message ?? "DevTools request failed").slice(0, 500)));
  else waiter.resolve(message.result ?? {});
};
socket = await openBoundedWebSocket(debuggerUrl, handleMessage, failSocket);
const send = (method, params = {}) => new Promise((resolve, reject) => {
  if (socketFailed || socket.closed) return reject(new Error("DevTools connection is unavailable"));
  if (pending.size >= MAX_PENDING) return reject(new Error("too many pending DevTools requests"));
  const id = ++nextId;
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error("DevTools request timed out"));
  }, REQUEST_TIMEOUT_MS);
  const settle = (callback) => (value) => { clearTimeout(timer); callback(value); };
  pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
  try {
    socket.sendText(JSON.stringify({ id, method, params }));
  } catch (error) {
    pending.delete(id);
    clearTimeout(timer);
    reject(error);
  }
});
const refId = (value) => {
  const match = /^b(\d+)$/.exec(String(value ?? ""));
  if (!match) throw new Error("invalid or stale browser ref; take a new snapshot");
  return Number(match[1]);
};
try {
if (action === "snapshot") {
  await send("Accessibility.enable");
  const { nodes = [] } = await send("Accessibility.getFullAXTree", { depth: 14 });
  if (!Array.isArray(nodes)) throw new Error("DevTools returned an invalid accessibility tree");
  const useful = new Set(["button", "checkbox", "combobox", "heading", "link", "menuitem", "radio", "searchbox", "slider", "spinbutton", "switch", "tab", "textbox"]);
  const elements = [];
  let scanned = 0;
  for (const node of nodes) {
    scanned += 1;
    if (scanned > AX_MAX_SCANNED_NODES) throw new Error("accessibility tree exceeded its scan limit");
    const role = String(node.role?.value ?? "").slice(0, 64).toLowerCase();
    const name = String(node.name?.value ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
    const backend = Number(node.backendDOMNodeId ?? 0);
    if (!backend || !useful.has(role) || (!name && role !== "textbox" && role !== "searchbox")) continue;
    const disabled = node.properties?.some((property) => property.name === "disabled" && property.value?.value === true) ?? false;
    elements.push({ ref: "b" + backend, role, name: name || "unnamed", disabled });
    if (elements.length >= 250) break;
  }
  process.stdout.write(JSON.stringify({ title: String(page.title ?? "").slice(0, 200), url: page.url, elements }));
} else if (action === "click") {
  const backendNodeId = refId(input.ref);
  const { model } = await send("DOM.getBoxModel", { backendNodeId });
  const quad = model?.border ?? model?.content;
  if (!Array.isArray(quad) || quad.length < 8 || !quad.slice(0, 8).every(Number.isFinite)) throw new Error("element is not visible; take a new snapshot");
  const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
  const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  process.stdout.write(JSON.stringify({ ok: true, ref: input.ref }));
} else if (action === "fill") {
  const backendNodeId = refId(input.ref);
  await send("DOM.focus", { backendNodeId });
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2 });
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace" });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace" });
  await send("Input.insertText", { text: String(input.text ?? "") });
  process.stdout.write(JSON.stringify({ ok: true, ref: input.ref }));
} else {
  throw new Error("unknown browser action");
}
} finally {
  try { socket.close(); } catch {}
}`;

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

/** Start the already-installed daemon after a box resume. This is cheap when
 * it is healthy and intentionally does not install anything on the hot path. */
export function ensureRemoteCuaCommand(): string {
  return [
    `if [ -x ${REMOTE_CUA_EXECUTABLE} ]; then`,
    `  mkdir -p ${REMOTE_CUA_SOCKET.slice(0, REMOTE_CUA_SOCKET.lastIndexOf("/"))}`,
    `  if ! ${REMOTE_CUA_EXECUTABLE} status --socket ${REMOTE_CUA_SOCKET} >/dev/null 2>&1; then`,
    `    rm -f ${REMOTE_CUA_SOCKET}`,
    '    display=${DISPLAY:-$(find /tmp/.X11-unix -maxdepth 1 -name "X*" -printf ":%f\\n" 2>/dev/null | sed "s/:X/:/" | head -1)}',
    '    display=${display:-:0}',
    `    nohup env HOME="$HOME" DISPLAY="$display" CUA_DRIVER_INSTALL_CHANNEL=python_package CUA_DRIVER_RS_TELEMETRY_ENABLED=0 ${REMOTE_CUA_EXECUTABLE} serve --socket ${REMOTE_CUA_SOCKET} --permission-mode standard > /tmp/ogb-cua-driver.log 2>&1 &`,
    `    for i in 1 2 3 4 5 6 7 8 9 10; do ${REMOTE_CUA_EXECUTABLE} status --socket ${REMOTE_CUA_SOCKET} >/dev/null 2>&1 && break; sleep 0.2; done`,
    "  fi",
    "fi",
  ].join("\n");
}

/** Idempotent setup. The exact wheel is verified before its bundled native
 * executable is installed; installation remains asynchronous so first-time
 * provisioning does not block the desktop for several minutes. */
export function remoteComputerBootstrapCommand(botName: string): string {
  const helper = Buffer.from(REMOTE_CDP_HELPER_SOURCE).toString("base64");
  const installer = [
    "set -eu",
    "trap 'rm -f /tmp/ogb-cua-installing' EXIT",
    "sudo mkdir -p /opt/ogb/run",
    'sudo chown -R "$(id -u):$(id -g)" /opt/ogb',
    'arch="$(uname -m)"',
    `case "$arch" in x86_64) url=${shellQuote(REMOTE_CUA_WHEELS.x86_64.url)}; sha=${REMOTE_CUA_WHEELS.x86_64.sha256} ;; aarch64|arm64) url=${shellQuote(REMOTE_CUA_WHEELS.aarch64.url)}; sha=${REMOTE_CUA_WHEELS.aarch64.sha256} ;; *) echo "unsupported architecture: $arch" >&2; exit 1 ;; esac`,
    'wheel="/tmp/cua-driver-${sha}.whl"',
    'curl -fsSL "$url" -o "$wheel"',
    'echo "$sha  $wheel" | sha256sum -c -',
    'python3 - "$wheel" <<\'PY\'\nimport os, sys, zipfile\nwheel = sys.argv[1]\nwith zipfile.ZipFile(wheel) as archive:\n    names = [name for name in archive.namelist() if name == "cua_driver/bin/cua-driver" or name.endswith("/cua_driver/bin/cua-driver")]\n    if len(names) != 1:\n        raise SystemExit("cua-driver executable missing from wheel")\n    with archive.open(names[0]) as source, open("/opt/ogb/cua-driver", "wb") as target:\n        target.write(source.read())\nos.chmod("/opt/ogb/cua-driver", 0o755)\nPY',
    `test "$(${REMOTE_CUA_EXECUTABLE} --version)" = "cua-driver ${REMOTE_CUA_VERSION}"`,
    `touch /opt/ogb/cua-${REMOTE_CUA_VERSION}-ready`,
    'rm -f "$wheel"',
  ].join("\n");
  const safeName = botName.replace(/["'\\]/g, "");
  return [
    "if ! command -v xdotool >/dev/null || ! command -v convert >/dev/null || ! command -v curl >/dev/null || ! command -v python3 >/dev/null; then sudo apt-get update -qq || true; sudo apt-get install -y -qq ca-certificates curl python3 gnome-screenshot xclip wmctrl xdotool imagemagick scrot >/dev/null 2>&1 || true; fi",
    "sudo mkdir -p /opt/ogb/run",
    `printf %s ${shellQuote(helper)} | base64 -d | sudo tee ${REMOTE_CDP_HELPER} >/dev/null`,
    `sudo chmod 0755 ${REMOTE_CDP_HELPER}`,
    'pkill -f "^/opt/ogb/venv/bin/python -m computer_server( |$)" >/dev/null 2>&1 || true',
    `[ -f /opt/ogb/cua-${REMOTE_CUA_VERSION}-ready ] || [ -f /tmp/ogb-cua-installing ] || { touch /tmp/ogb-cua-installing; nohup bash -c ${shellQuote(installer)} > /tmp/ogb-cua-install.log 2>&1 & }`,
    ensureRemoteCuaCommand(),
    `tmux has-session -t work 2>/dev/null || tmux new-session -d -s work 'echo; echo "  ▦ ${safeName}'"'"'s computer — OpenMausBot"; echo; exec bash -i'`,
    "echo bootstrapped",
  ].join("\n");
}

export function semanticBrowserCommand(action: "snapshot" | "click" | "fill", input: unknown): string {
  const encoded = Buffer.from(JSON.stringify(input ?? {})).toString("base64url");
  return `node ${REMOTE_CDP_HELPER} ${action} ${shellQuote(encoded)}`;
}
