import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isJsonRpcResponse, isJsonRpcServerRequest, methodNotFoundResponse } from "./jsonrpc.ts";

// The handshake-based revision this client speaks. Known limitation: the
// stateless revision changes stdio substantially — no initialize, per-request
// metadata in the message body, and era detection by probing for a discovery
// reply — so supporting it here is a behavioural change rather than a version
// bump. Until that is built deliberately, stdio servers are addressed with the
// handshake, and a stateless-only stdio server will not connect. The HTTP
// transport already negotiates both eras; see the protocol-version module.
export const MCP_PROTOCOL_VERSION = "2025-11-25";

// stdio shutdown escalation windows: ask politely (stdin EOF), then SIGTERM,
// then SIGKILL. Kept here so both stop() timers read one source of truth.
const STDIO_GRACEFUL_MS = 2_000;
const STDIO_FORCE_MS = 3_000;
export const MAX_MCP_STDIO_LINE_BYTES = 8 * 1024 * 1024;

export class McpStdioClient {
  declare _closed: any;
  declare _nextId: any;
  declare _pending: any;
  declare _stdoutBuffer: any;
  private _stdoutBufferBytes = 0;
  declare _stopping: any;
  declare log: any;
  declare onClose: any;
  declare process: any;
  declare server: any;
  constructor(server, { log = console, onClose = null } = {}) {
    this.server = server;
    this.log = log;
    // onClose({ reason, expected }) lets McpRuntime distinguish a deliberate
    // stop() (expected) from an unexpected child death (expected=false) so it
    // can decide whether to reconnect. Ownership of "intent" lives in the
    // runtime; the client only reports what physically happened.
    this.onClose = typeof onClose === "function" ? onClose : null;
    this.process = null;
    this._nextId = 1;
    this._pending = new Map();
    this._stdoutBuffer = "";
    this._closed = false;
    // True only while a deliberate stop() is in flight. The exit/error
    // handlers consult this to label the close as expected vs unexpected.
    this._stopping = false;
  }

  get running() {
    return !!this.process && !this._closed && this.process.exitCode == null;
  }

  async start() {
    if (this.running) return;
    if (!this.server?.command) throw new Error("MCP server command is required");

    this._closed = false;
    this._stopping = false;
    this._stdoutBuffer = "";
    this._stdoutBufferBytes = 0;
    const spawnSpec = resolveMcpStdioSpawnSpec(this.server);
    this.process = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: this.server.cwd || undefined,
      env: spawnSpec.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });

    this.process.stdout.setEncoding("utf-8");
    this.process.stdout.on("data", (chunk) => this._onStdout(chunk));
    this.process.stderr.setEncoding("utf-8");
    this.process.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) this.log.debug?.(`[mcp:${this.server.id}] ${text}`);
    });
    this.process.on("exit", (code, signal) => {
      this._closed = true;
      const reason = signal || (code ?? "unknown");
      const err = new Error(`MCP server exited (${reason})`);
      for (const pending of this._pending.values()) pending.reject(err);
      this._pending.clear();
      this._reportClose(`exited (${reason})`);
    });
    this.process.on("error", (err) => {
      this._closed = true;
      for (const pending of this._pending.values()) pending.reject(err);
      this._pending.clear();
      this._reportClose(err.message || "process error");
    });

    await this.initialize();
  }

  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "hana",
        title: "Hana",
        version: "0.1.0",
      },
    }, { timeout: requestTimeoutMs(this.server) });
    this.notify("notifications/initialized", {});
    return result;
  }

  async listTools() {
    const result: any = await this.request("tools/list", {}, { timeout: requestTimeoutMs(this.server) });
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name, args, { signal }: { signal?: AbortSignal } = {}) {
    return this.request("tools/call", {
      name,
      arguments: args || {},
    }, { timeout: requestTimeoutMs(this.server), signal });
  }

  async readResource(uri) {
    return this.request("resources/read", { uri }, { timeout: requestTimeoutMs(this.server) });
  }

  request(method, params: any = {}, { timeout = 30_000, signal }: { timeout?: number; signal?: AbortSignal } = {}) {
    signal?.throwIfAborted();
    if (!this.running) throw new Error("MCP server is not running");
    const id = this._nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this._pending.delete(id);
      };
      const onAbort = () => {
        cleanup();
        try { this.notify("notifications/cancelled", { requestId: id, reason: "Client canceled" }); } catch {}
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`MCP request "${method}" timed out`));
      }, timeout);
      this._pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      try { this._send(payload); } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  notify(method, params: any = {}) {
    if (!this.running) return;
    this._send({ jsonrpc: "2.0", method, params });
  }

  async stop() {
    // Mark intent first so the exit handler treats this as an expected close,
    // never an unexpected disconnect that would trigger a reconnect.
    this._stopping = true;
    for (const pending of this._pending.values()) pending.reject(new Error("MCP client stopped"));
    this._pending.clear();
    if (!this.process) {
      this._closed = true;
      return;
    }
    const proc = this.process;
    this.process = null;
    this._closed = true;
    if (proc.exitCode != null) return;
    try { proc.stdin.end(); } catch {}
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(graceTimer);
        clearTimeout(forceTimer);
        resolve();
      };
      // Politely wait, then SIGTERM, then SIGKILL if it still refuses to die.
      const graceTimer = setTimeout(() => {
        try { proc.kill("SIGTERM"); } catch {}
      }, STDIO_GRACEFUL_MS);
      const forceTimer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch {}
        finish();
      }, STDIO_GRACEFUL_MS + STDIO_FORCE_MS);
      proc.once("exit", finish);
    });
  }

  _reportClose(reason) {
    if (!this.onClose) return;
    const expected = this._stopping === true;
    this.onClose({ reason, expected });
  }

  _rejectServerRequest(message) {
    this.log.debug?.(
      `[mcp:${this.server.id}] rejected unsupported server request "${message.method}" (id ${message.id})`,
    );
    if (!this.running) return;
    try {
      this._send(methodNotFoundResponse(message.id, message.method));
    } catch (err) {
      this.log.debug?.(
        `[mcp:${this.server.id}] could not deliver method-not-found for "${message.method}": ${err.message}`,
      );
    }
  }

  _send(payload) {
    const line = JSON.stringify(payload);
    this.process.stdin.write(line + "\n", "utf-8");
  }

  _onStdout(chunk) {
    if (this._closed) return;
    let rest = String(chunk);
    while (true) {
      const idx = rest.indexOf("\n");
      const part = idx === -1 ? rest : rest.slice(0, idx);
      this._stdoutBufferBytes += Buffer.byteLength(part, "utf8");
      if (this._stdoutBufferBytes > MAX_MCP_STDIO_LINE_BYTES) {
        const error = new Error(`MCP stdio line exceeds ${MAX_MCP_STDIO_LINE_BYTES} bytes`);
        this._stdoutBuffer = "";
        this._stdoutBufferBytes = 0;
        for (const pending of this._pending.values()) pending.reject(error);
        this._pending.clear();
        this.log.warn?.(`[mcp:${this.server.id}] ${error.message}; stopping connector`);
        void this.stop().catch((err) => this.log.warn?.(`[mcp:${this.server.id}] stop failed: ${err.message}`));
        return;
      }
      this._stdoutBuffer += part;
      if (idx === -1) return;
      const line = this._stdoutBuffer.trim();
      this._stdoutBuffer = "";
      this._stdoutBufferBytes = 0;
      rest = rest.slice(idx + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (err) {
        this.log.warn?.(`[mcp:${this.server.id}] ignored non-JSON stdout: ${err.message}`);
        continue;
      }
      this._handleMessage(message);
    }
  }

  _handleMessage(message) {
    // A server-initiated request carries a method alongside its id. We serve
    // none of them, so answer -32601 rather than leaving the server blocked on
    // a reply that never comes. Notifications (no id) fall through untouched.
    if (isJsonRpcServerRequest(message)) {
      this._rejectServerRequest(message);
      return;
    }
    if (!isJsonRpcResponse(message)) return;
    const pending = this._pending.get(message.id);
    if (!pending) return;
    this._pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message || "MCP request failed"));
    } else {
      pending.resolve(message.result);
    }
  }
}

export function resolveMcpStdioSpawnSpec(server, {
  platform = process.platform,
  baseEnv = process.env,
  existsSync = fs.existsSync,
} = {}) {
  const command = String(server?.command || "").trim();
  const args = Array.isArray(server?.args) ? server.args : [];
  const env = { ...baseEnv, ...registryEnv(server), ...(server?.env || {}) };
  if (platform !== "win32") return { command, args, env };

  const win32Command = resolveWin32Command(command, { env, existsSync });
  if (!win32Command.needsCmd) {
    return { command: win32Command.command, args, env };
  }

  return {
    command: win32Comspec(env),
    args: ["/d", "/s", "/c", buildWin32CmdLine(win32Command.command, args)],
    env,
  };
}

function registryEnv(server) {
  const registryUrl = typeof server?.registryUrl === "string" ? server.registryUrl.trim() : "";
  if (!registryUrl) return {};
  const command = commandName(server.command);
  if (command === "npx" || command === "bun" || command === "bunx") {
    return { NPM_CONFIG_REGISTRY: registryUrl };
  }
  if (command === "uv" || command === "uvx") {
    return {
      UV_DEFAULT_INDEX: registryUrl,
      PIP_INDEX_URL: registryUrl,
    };
  }
  return {};
}

function commandName(command) {
  const raw = typeof command === "string" ? command.trim() : "";
  const name = raw.split(/[\\/]/).pop() || raw;
  return name.replace(/\.(?:cmd|bat|exe)$/i, "").toLowerCase();
}

function requestTimeoutMs(server) {
  const timeout = Number(server?.timeout || 0);
  return Number.isFinite(timeout) && timeout > 0 ? timeout * 1000 : 30_000;
}

function resolveWin32Command(command, { env, existsSync }) {
  const resolved = resolveWin32PathCommand(command, { env, existsSync });
  const effective = resolved || command;
  if (isWin32CmdShim(effective)) return { command: effective, needsCmd: true };
  if (isWin32Executable(effective)) return { command: effective, needsCmd: false };
  if (isBareWin32Command(command)) {
    return { command: effective, needsCmd: true };
  }
  return { command: effective, needsCmd: false };
}

function resolveWin32PathCommand(command, { env, existsSync }) {
  const raw = String(command || "").trim();
  if (!raw) return "";
  const hasPath = /[\\/]/.test(raw) || /^[A-Za-z]:/.test(raw);
  const ext = path.win32.extname(raw);
  const pathext = win32PathExts(env);
  const candidates = ext
    ? [raw]
    : [raw, ...pathext.map((suffix) => `${raw}${suffix}`)];

  if (hasPath) {
    return candidates.find((candidate) => existsSync(candidate)) || "";
  }

  for (const dir of win32PathDirs(env)) {
    for (const candidate of candidates) {
      const fullPath = path.win32.join(dir, candidate);
      if (existsSync(fullPath)) return fullPath;
    }
  }
  return "";
}

function win32PathDirs(env) {
  const pathKey = Object.keys(env || {}).find((key) => key.toLowerCase() === "path");
  const rawPath = pathKey ? String(env[pathKey] || "") : "";
  return rawPath.split(";").map((entry) => entry.trim()).filter(Boolean);
}

function win32PathExts(env) {
  const pathextKey = Object.keys(env || {}).find((key) => key.toLowerCase() === "pathext");
  const raw = pathextKey ? String(env[pathextKey] || "") : ".COM;.EXE;.BAT;.CMD";
  const values = raw.split(";").map((entry) => entry.trim()).filter(Boolean);
  return values.length ? values : [".COM", ".EXE", ".BAT", ".CMD"];
}

function win32Comspec(env) {
  const key = Object.keys(env || {}).find((item) => item.toLowerCase() === "comspec");
  return key && env[key] ? String(env[key]) : "cmd.exe";
}

function isBareWin32Command(command) {
  const raw = String(command || "").trim();
  return !!raw && !/[\\/]/.test(raw) && !/^[A-Za-z]:/.test(raw);
}

function isWin32CmdShim(command) {
  return /\.(?:cmd|bat)$/i.test(String(command || ""));
}

function isWin32Executable(command) {
  return /\.exe$/i.test(String(command || ""));
}

function buildWin32CmdLine(command, args) {
  return [command, ...args].map(quoteWin32CmdArg).join(" ");
}

function quoteWin32CmdArg(value) {
  const text = String(value ?? "");
  if (text.length === 0) return "\"\"";
  if (!/[\s"&|<>^()%]/.test(text)) return text;
  return `"${text.replace(/"/g, "\\\"").replace(/%/g, "%%")}"`;
}
