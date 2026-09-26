import { MCP_PROTOCOL_VERSION } from "./stdio-client.ts";
import { getOutboundProxyConfig } from "../../../lib/net/outbound-proxy.ts";
import {
  normalizeNetworkProxyConfig,
  proxyConfigFromEnvironment,
  resolveProxyForUrl,
} from "../../../shared/network-proxy.ts";
import {
  MCP_ERA_LEGACY,
  MCP_ERA_MODERN,
  MCP_META_CLIENT_CAPABILITIES,
  MCP_META_CLIENT_INFO,
  MCP_META_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION_2026_07_28,
  MCP_PROTOCOL_VERSION_HEADER,
  headersWithoutMcpProtocolVersion,
  mcpEraForProtocolVersion,
  negotiateMcpProtocolVersion,
  readDiscoverSupportedVersions,
  resolveInitialMcpProtocolVersion,
  resolvePinnedMcpProtocolVersion,
} from "./protocol-version.ts";
import {
  isJsonRpcResponse,
  isJsonRpcServerRequest,
  methodNotFoundResponse,
} from "./jsonrpc.ts";

const STREAMABLE_ACCEPT = "application/json, text/event-stream";
const SSE_ACCEPT = "text/event-stream";
const FALLBACK_STATUSES = new Set([400, 404, 405]);

const MCP_CLIENT_INFO = { name: "hana", title: "Hana", version: "0.1.0" };

// Capabilities we advertise on every stateless request. A server may only ask
// us for input of a kind we declared here, so this is what gates whether a tool
// call can ever come back asking the user a question. Form elicitation is the
// one interaction we can actually render; sampling, roots and URL-mode
// elicitation stay undeclared until they have somewhere to go.
const MODERN_CLIENT_CAPABILITIES = { elicitation: { form: {} } };

// Attach the per-request protocol fields the stateless revision requires. The
// header mirror of the protocol version must match this value exactly, so both
// are derived from the same argument.
function withModernRequestMeta(payload, protocolVersion, capabilities) {
  const source = payload?.params && typeof payload.params === "object" && !Array.isArray(payload.params)
    ? payload.params
    : {};
  return {
    ...payload,
    params: {
      ...source,
      _meta: {
        ...(source as any)._meta,
        [MCP_META_PROTOCOL_VERSION]: protocolVersion,
        [MCP_META_CLIENT_INFO]: MCP_CLIENT_INFO,
        [MCP_META_CLIENT_CAPABILITIES]: capabilities,
      },
    },
  };
}

// The stateless revision lets a list response advertise how long it stays
// fresh. We record the hint and nothing more: no polling, no expiry, no cache.
// Absent hints read as null rather than as zero, so "not offered" never
// masquerades as "expires immediately".
function readToolListFreshness(result) {
  const rawTtl = (result as any)?.ttlMs;
  const ttlMs = typeof rawTtl === "number" && Number.isFinite(rawTtl) ? rawTtl : null;
  const rawScope = (result as any)?.cacheScope;
  const cacheScope = typeof rawScope === "string" && rawScope.trim() ? rawScope.trim() : null;
  if (ttlMs === null && cacheScope === null) return null;
  return { ttlMs, cacheScope, fetchedAt: Date.now() };
}

// Header mirroring is a property of the Streamable HTTP binding, not of the
// protocol: stdio has no header layer, so none of this applies there.
const MCP_NAME_METHODS = new Set(["tools/call", "resources/read", "prompts/get"]);
const MCP_PARAM_TYPES = new Set(["string", "integer", "boolean"]);
// RFC 9110 field-name token characters.
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const BASE64_SENTINEL_PREFIX = "=?base64?";
const BASE64_SENTINEL_SUFFIX = "?=";

function isPlainHeaderValue(text) {
  if (!text.length) return false;
  if (text !== text.trim()) return false;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code > 0x7E) return false;
  }
  return true;
}

// Values that cannot travel as visible ASCII go base64 behind a sentinel. A
// plain value that merely looks like the sentinel is encoded too, so the server
// can never misread a literal as an encoding marker.
function encodeMcpHeaderValue(text) {
  const looksEncoded = text.startsWith(BASE64_SENTINEL_PREFIX) && text.endsWith(BASE64_SENTINEL_SUFFIX);
  if (isPlainHeaderValue(text) && !looksEncoded) return text;
  return `${BASE64_SENTINEL_PREFIX}${Buffer.from(text, "utf-8").toString("base64")}${BASE64_SENTINEL_SUFFIX}`;
}

function mcpParamValue(value) {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}

function readAtPath(root, path) {
  let node = root;
  for (const key of path) {
    if (!node || typeof node !== "object") return undefined;
    node = node[key];
  }
  return node;
}

// Every x-mcp-header occurrence anywhere in the schema, however it is nested.
function collectAllAnnotations(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectAllAnnotations(item, out);
    return;
  }
  if (Object.prototype.hasOwnProperty.call(node, "x-mcp-header")) out.push(node);
  for (const value of Object.values(node)) collectAllAnnotations(value, out);
}

// Only the annotations reachable by a chain made purely of `properties` keys.
function collectReachableAnnotations(schema, path, out) {
  const properties = schema?.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return;
  for (const [key, child] of Object.entries(properties)) {
    if (!child || typeof child !== "object") continue;
    const childPath = [...path, key];
    if (Object.prototype.hasOwnProperty.call(child, "x-mcp-header")) {
      out.push({ path: childPath, name: (child as any)["x-mcp-header"], type: (child as any).type });
    }
    collectReachableAnnotations(child, childPath, out);
  }
}

// The mirrorable annotations of one tool, or null when the definition breaks a
// constraint the spec requires clients to reject. Null means "drop this tool":
// mirroring a malformed annotation would put a malformed header on the wire.
export function collectMcpParamAnnotations(inputSchema) {
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) return [];
  const everywhere = [];
  collectAllAnnotations(inputSchema, everywhere);
  const reachable = [];
  collectReachableAnnotations(inputSchema, [], reachable);
  // An annotation that exists but is not statically reachable invalidates the
  // whole definition, rather than being quietly ignored.
  if (everywhere.length !== reachable.length) return null;

  const seen = new Set();
  for (const annotation of reachable) {
    const name = annotation.name;
    if (typeof name !== "string" || !name || !HEADER_TOKEN.test(name)) return null;
    const key = name.toLowerCase();
    if (seen.has(key)) return null;
    seen.add(key);
    if (!MCP_PARAM_TYPES.has(annotation.type)) return null;
  }
  return reachable;
}

function modernRoutingHeaders(payload, annotationsByTool) {
  const headers: any = {};
  const method = typeof payload?.method === "string" ? payload.method : "";
  if (!method) return headers;
  headers["Mcp-Method"] = method;
  if (!MCP_NAME_METHODS.has(method)) return headers;

  const params = payload?.params && typeof payload.params === "object" ? payload.params : {};
  const rawName = method === "resources/read" ? params.uri : params.name;
  if (typeof rawName === "string" && rawName) headers["Mcp-Name"] = encodeMcpHeaderValue(rawName);
  if (method !== "tools/call") return headers;

  const annotations = annotationsByTool?.get?.(params.name);
  if (!Array.isArray(annotations)) return headers;
  const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
  for (const annotation of annotations) {
    const value = readAtPath(args, annotation.path);
    // Absent or null: the header is omitted and the server must not expect it.
    if (value === undefined || value === null) continue;
    const text = mcpParamValue(value);
    if (text === null) continue;
    headers[`Mcp-Param-${annotation.name}`] = encodeMcpHeaderValue(text);
  }
  return headers;
}

export class McpHttpError extends Error {
  declare body: any;
  declare headers: any;
  declare oauthError: any;
  declare status: any;
  constructor(message, { status = null, body = "", headers = null, oauthError = "" } = {}) {
    super(message);
    this.name = "McpHttpError";
    this.status = status;
    this.body = body;
    this.headers = headers;
    // OAuth 2.0 error code (RFC 6749 §5.2) when this failure came from a token
    // endpoint, e.g. "invalid_grant" (the refresh token is dead). Empty for
    // transport-level failures (a 5xx / 404 with no OAuth error body). Used by
    // the auth-terminal classifier so a dead refresh token routes to needs-auth
    // even though its HTTP status is 400, not 401/403.
    this.oauthError = oauthError;
  }
}

// An auth-terminal failure means re-authorization is required and retrying with
// the same credentials is futile (→ needs-auth, never backoff/loop). Two
// independent signals qualify: an HTTP 401/403 on a resource request, or an
// OAuth token-endpoint error that invalidates the grant/client. invalid_grant =
// the refresh token expired/was revoked; invalid_client / unauthorized_client =
// the registered client is no longer accepted. Transient failures (network drop,
// 5xx, request-shape OAuth errors) are deliberately excluded so they keep
// reconnecting. Single source of truth shared by the runtime and the client.
const AUTH_TERMINAL_OAUTH_ERRORS = new Set(["invalid_grant", "invalid_client", "unauthorized_client"]);

export function isAuthTerminalError(err) {
  // McpHttpError carries status/oauthError directly; a non-McpHttpError transport
  // error may still surface a status field — read both uniformly via optional chain.
  if (err?.status === 401 || err?.status === 403) return true;
  return typeof err?.oauthError === "string" && AUTH_TERMINAL_OAUTH_ERRORS.has(err.oauthError);
}

export function parseSseEvents(text) {
  const events = [];
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  for (const block of normalized.split(/\n\n+/)) {
    if (!block.trim()) continue;
    const event = { event: "message", data: "", id: "" };
    const dataLines = [];
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event.event = value || "message";
      else if (field === "id") event.id = value;
      else if (field === "data") dataLines.push(value);
    }
    event.data = dataLines.join("\n");
    events.push(event);
  }
  return events;
}

function configuredAuthToken(server) {
  const authType = stringOrEmpty(server?.authType);
  if (authType === "oauth") return stringOrEmpty(server?.oauth?.accessToken);
  if (authType === "bearer") return stringOrEmpty(server?.authorizationToken);
  if (authType === "none") return "";
  return stringOrEmpty(server?.oauth?.accessToken) || stringOrEmpty(server?.authorizationToken);
}

async function requestAuthToken(server, getAuthToken) {
  const dynamicToken = getAuthToken ? stringOrEmpty(await getAuthToken()) : "";
  return dynamicToken || configuredAuthToken(server);
}

function stringOrEmpty(value) {
  return typeof value === "string" ? value.trim() : "";
}

function connectorHeaders(server) {
  if (!server?.headers || typeof server.headers !== "object" || Array.isArray(server.headers)) return {};
  return Object.fromEntries(
    Object.entries(server.headers).filter(([key, value]) => typeof key === "string" && typeof value === "string"),
  );
}

function responseHeader(response, name) {
  return response?.headers?.get?.(name) || response?.headers?.get?.(name.toLowerCase()) || "";
}

async function responseText(response) {
  try {
    return await response.text();
  } catch (error) {
    if (response.ok === false) return "";
    throw error;
  }
}

function methodErrorMessage(status, body) {
  if (status === 401) return "MCP connector authentication failed or token expired";
  if (status === 403) return "MCP connector authorization failed or scopes are insufficient";
  if (status === 404) return "MCP connector session expired or endpoint was not found";
  return `MCP connector HTTP request failed with status ${status}${body ? `: ${body}` : ""}`;
}

export function isSessionExpiredHttpError(err) {
  if (!(err instanceof McpHttpError)) return false;
  if (err.status === 404) return true;
  if (err.status !== 400) return false;
  return /\binvalid\s+session\s+id\b/i.test(String(err.body || err.message || ""));
}

function resolveEndpoint(endpoint, baseUrl) {
  return new URL(endpoint, baseUrl).href;
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  // The deadline must cover reading the body too, not only response headers.
  const signals = [init?.signal, timeoutMs ? AbortSignal.timeout(Math.ceil(timeoutMs)) : null].filter(Boolean);
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  signal?.throwIfAborted();
  return fetchImpl(url, { ...init, ...(signal ? { signal } : {}) });
}

function requestTimeoutMs(server) {
  const timeout = Number(server?.timeout || 0);
  return Number.isFinite(timeout) && timeout > 0 ? timeout * 1000 : 30_000;
}

export function resolveMcpHttpProxyDiagnostics(server, { proxyConfig = getOutboundProxyConfig(), env = process.env } = {}) {
  const transport = stringOrEmpty(server?.transport);
  const url = stringOrEmpty(server?.url);
  const applicable = !!url && transport !== "stdio";
  if (!applicable) {
    return {
      applicable: false,
      proxyUrl: "",
      source: "not-applicable",
      connectorEnvProxyIgnored: hasConnectorProxyEnv(server),
    };
  }

  const normalized = normalizeNetworkProxyConfig(proxyConfig);
  const effective = normalized.mode === "system" ? proxyConfigFromEnvironment(env) : normalized;
  const proxyUrl = resolveProxyForUrl(url, normalized, env);
  let source = normalized.mode;
  if (normalized.mode === "manual") source = proxyUrl ? "app" : "bypass";
  if (normalized.mode === "system") source = effective.mode === "direct" ? "system" : "system-env";
  if (normalized.mode === "direct") source = "direct";

  return {
    applicable: true,
    proxyUrl: redactProxyUrl(proxyUrl),
    source,
    connectorEnvProxyIgnored: hasConnectorProxyEnv(server),
  };
}

function hasConnectorProxyEnv(server) {
  const env = server?.env && typeof server.env === "object" && !Array.isArray(server.env) ? server.env : {};
  return ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"]
    .some((key) => typeof env[key] === "string" && env[key].trim());
}

function redactProxyUrl(proxyUrl) {
  if (!proxyUrl) return "";
  try {
    const url = new URL(proxyUrl);
    if (url.username) url.username = "********";
    if (url.password) url.password = "********";
    return url.href.replace(/\/$/, "");
  } catch {
    return "";
  }
}

export class McpStreamableHttpClient {
  declare _closed: any;
  declare _initialized: any;
  declare _nextId: any;
  declare _stopping: any;
  declare _toolParamAnnotations: any;
  declare endpoint: any;
  declare fetchImpl: any;
  declare getAuthToken: any;
  declare era: any;
  declare initialProtocolVersion: any;
  declare log: any;
  declare negotiatedProtocolVersion: any;
  declare pinnedProtocolVersion: any;
  declare onClose: any;
  declare protocolVersion: any;
  declare refreshAuthToken: any;
  declare server: any;
  declare sessionId: any;
  declare toolListFreshness: any;
  constructor(server, { fetchImpl = globalThis.fetch, log = console, onClose = null, getAuthToken = null, refreshAuthToken = null } = {}) {
    this.server = server;
    this.fetchImpl = fetchImpl;
    this.log = log;
    // onClose({ reason, expected, needsAuth }) reports an unexpected death of a
    // previously-live session so McpRuntime can decide whether to reconnect.
    // The inline 404 session refresh recovers in place and never reports here.
    this.onClose = typeof onClose === "function" ? onClose : null;
    // OAuth self-heal seams (#1286 ③a, 方案 A). The live client snapshots the
    // connector, so config refreshes never reach this.server. getAuthToken()
    // returns the freshest access token per request (runtime pre-refreshes near
    // expiry + dedups); refreshAuthToken() force-refreshes on a 401. Both are
    // optional: when absent, the client falls back to the snapshot token and a
    // 401 is not retried (pure-client unit tests keep the old behavior).
    this.getAuthToken = typeof getAuthToken === "function" ? getAuthToken : null;
    this.refreshAuthToken = typeof refreshAuthToken === "function" ? refreshAuthToken : null;
    this.endpoint = server?.url || "";
    this._nextId = 1;
    this._closed = true;
    this._initialized = false;
    this._stopping = false;
    this.sessionId = "";
    const headers = connectorHeaders(server);
    this.initialProtocolVersion = resolveInitialMcpProtocolVersion({
      headers,
      protocolVersion: server?.protocolVersion,
    });
    this.protocolVersion = this.initialProtocolVersion;
    // An operator-pinned version is an instruction, not a hint: it selects the
    // track outright and suppresses the probe.
    this.pinnedProtocolVersion = resolvePinnedMcpProtocolVersion({
      headers,
      protocolVersion: server?.protocolVersion,
    });
    // "" until proven. Determined once per client instance and then reused, so
    // one connection never re-probes.
    this.era = this.pinnedProtocolVersion ? mcpEraForProtocolVersion(this.pinnedProtocolVersion) : "";
    this.negotiatedProtocolVersion = "";
    // tool name -> mirrorable x-mcp-header annotations, learned from tools/list.
    this._toolParamAnnotations = new Map();
    this.toolListFreshness = null;
  }

  get running() {
    return !this._closed && this._initialized;
  }

  async start() {
    if (this.running) return;
    if (!this.endpoint) throw new Error("MCP connector URL is required");
    this._closed = false;
    this._stopping = false;
    try {
      await this._establish();
      this._initialized = true;
    } catch (err) {
      this._closed = true;
      this._initialized = false;
      throw err;
    }
  }

  // Decide the era once, then connect accordingly. The stateless track has
  // nothing to establish: no handshake, no session, so a successful probe is
  // itself the whole connect.
  async _establish() {
    if (!this.era) this.era = await this._probeServerEra();
    if (this.era === MCP_ERA_MODERN) {
      this.protocolVersion = this._modernProtocolVersion();
      this.sessionId = "";
      return;
    }
    await this.initialize();
  }

  _modernProtocolVersion() {
    return this.negotiatedProtocolVersion || this.pinnedProtocolVersion || MCP_PROTOCOL_VERSION_2026_07_28;
  }

  // Ask the server what it speaks. Only a well-formed DiscoverResult naming a
  // version we implement proves a modern server; a transport failure, an odd
  // shape, or a version list we cannot satisfy all mean "assume legacy and
  // handshake". Guessing modern on a doubtful answer would strand the connector
  // with no usable fallback, so the doubt always resolves toward the old path.
  async _probeServerEra() {
    try {
      const result = await this._postJsonRpc({
        jsonrpc: "2.0",
        id: this._nextId++,
        method: "server/discover",
        params: {},
      }, { era: MCP_ERA_MODERN });
      const supported = readDiscoverSupportedVersions(result);
      const negotiated = supported ? negotiateMcpProtocolVersion(supported) : "";
      if (!negotiated) {
        this.log.debug?.(
          `[mcp:${this.server.id}] discovery did not establish a supported stateless version; using the handshake`,
        );
        return MCP_ERA_LEGACY;
      }
      this.negotiatedProtocolVersion = negotiated;
      return MCP_ERA_MODERN;
    } catch (err) {
      this.log.debug?.(`[mcp:${this.server.id}] discovery probe failed (${err.message}); using the handshake`);
      return MCP_ERA_LEGACY;
    }
  }

  async initialize() {
    this.protocolVersion = this.initialProtocolVersion;
    const result = await this._request("initialize", {
      protocolVersion: this.initialProtocolVersion,
      capabilities: {},
      clientInfo: {
        name: "hana",
        title: "Hana",
        version: "0.1.0",
      },
    }, { initializing: true, retryOnSessionExpired: false });
    if (typeof result?.protocolVersion === "string") {
      this.protocolVersion = result.protocolVersion;
    }
    await this._notify("notifications/initialized", {});
    return result;
  }

  async listTools() {
    const result = await this.request("tools/list", {});
    this.toolListFreshness = readToolListFreshness(result);
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    // Parameter mirroring only exists on the stateless track, so only there do
    // we hold tools to the annotation constraints.
    if (this.era !== MCP_ERA_MODERN) return tools;

    const usable = [];
    const annotations = new Map();
    for (const tool of tools) {
      const parsed = collectMcpParamAnnotations(tool?.inputSchema);
      if (parsed === null) {
        this.log.warn?.(
          `[mcp:${this.server.id}] dropped tool "${tool?.name}": its x-mcp-header annotations break the header-mirroring rules`,
        );
        continue;
      }
      usable.push(tool);
      if (parsed.length) annotations.set(tool?.name, parsed);
    }
    this._toolParamAnnotations = annotations;
    return usable;
  }

  // inputResponses/requestState carry a previous round's answers back to the
  // server. The server keeps no state of its own between rounds, so the retry
  // must repeat the original arguments and echo the opaque state verbatim.
  async callTool(name, args, { inputResponses = null, requestState = "", signal }: any = {}) {
    const params: any = { name, arguments: args || {} };
    if (inputResponses) params.inputResponses = inputResponses;
    if (requestState) params.requestState = requestState;
    return this.request("tools/call", params, { signal });
  }

  async readResource(uri) {
    return this.request("resources/read", { uri });
  }

  async request(method, params: any = {}, opts: { signal?: AbortSignal } = {}) {
    opts.signal?.throwIfAborted();
    if (!this.running) throw new Error("MCP connector is not running");
    try {
      return await this._request(method, params, opts);
    } catch (err) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      // The error we ultimately surface. A 401 refresh may replace it with a more
      // specific cause; we track that on a local instead of reassigning the catch
      // binding `err` (no-ex-assign).
      let failure = err;
      // 401 OAuth self-heal (方案 A, bounded to a single retry). A live request
      // came back 401: ask the runtime to force a token refresh, and if it
      // produced a new token, replay this one request with it. We retry AT MOST
      // once — a second 401, or no refresh available, falls through to failing
      // the session as needs-auth. No loop.
      if (this._is401(err) && this.refreshAuthToken) {
        const refreshed = await this._tryRefreshAndRetry(method, params, opts);
        if (refreshed.recovered) return refreshed.result;
        // Refresh produced a more specific failure (the refresh token itself is
        // dead → invalid_grant, or the retry hit a fresh error). Adopt it as the
        // failing context: a dead refresh token is auth-terminal, so _failLiveSession
        // routes it to needs-auth instead of leaving a bare 401 to back off blindly.
        if (refreshed.error) failure = refreshed.error;
      }
      // A live request failed in a way the inline 404 self-heal could not recover
      // (network drop, 5xx, unrecovered 401/403, or a dead refresh token's
      // invalid_grant). Tear the session down and report it so the runtime can run
      // backoff reconnect; auth-terminal failures additionally flag needsAuth for
      // the OAuth self-heal / re-auth. This never silently swallows the error.
      if (opts.signal?.aborted) throw opts.signal.reason;
      this._failLiveSession(failure);
      throw failure;
    }
  }

  _is401(err) {
    return err instanceof McpHttpError && err.status === 401;
  }

  // Force a refresh, then replay the request exactly once. Returns whether the
  // retry recovered (and its result) or carries the retry's error so the caller
  // fails the session with the most relevant context. Never recurses.
  async _tryRefreshAndRetry(method, params, opts) {
    let newToken = "";
    try {
      newToken = stringOrEmpty(await this.refreshAuthToken());
    } catch (refreshErr) {
      // Refresh itself failed. Surface that error (an invalid_grant means the
      // refresh token is dead → auth-terminal; a 5xx means transient) so the
      // caller fails the session with the more specific, correctly-classified
      // context rather than the original opaque 401.
      return { recovered: false, error: refreshErr };
    }
    // No new token but no throw (e.g. no refresh token configured): keep the
    // original 401 as the failing context — it is already auth-terminal.
    if (!newToken) return { recovered: false };
    try {
      return { recovered: true, result: await this._request(method, params, opts) };
    } catch (retryErr) {
      return { recovered: false, error: retryErr };
    }
  }

  _failLiveSession(err) {
    if (this._stopping || this._closed) return;
    // Auth-terminal (401/403, or a dead refresh token surfacing as an OAuth
    // invalid_grant from the forced refresh) → needs-auth: re-auth, never loop.
    // Everything else (network drop, 5xx, transient refresh failure) stays a
    // generic close so the runtime keeps backoff reconnect. Never swallowed.
    const needsAuth = isAuthTerminalError(err);
    this._closed = true;
    this._initialized = false;
    if (this.onClose) {
      this.onClose({
        reason: err?.message || "connection lost",
        expected: false,
        needsAuth,
      });
    }
  }

  async _request(method, params: any = {}, { initializing = false, retryOnSessionExpired = true, signal }: { initializing?: boolean; retryOnSessionExpired?: boolean; signal?: AbortSignal } = {}) {
    signal?.throwIfAborted();
    const id = this._nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    try {
      return await this._postJsonRpc(payload, { initializing, signal });
    } catch (err) {
      if (
        retryOnSessionExpired &&
        isSessionExpiredHttpError(err) &&
        this.sessionId
      ) {
        this.sessionId = "";
        this._initialized = false;
        await this.initialize();
        this._initialized = true;
        return this._request(method, params, { initializing: false, retryOnSessionExpired: false, signal });
      }
      throw err;
    }
  }

  async _notify(method, params: any = {}) {
    await this._postJsonRpc({ jsonrpc: "2.0", method, params }, { initializing: false });
  }

  async stop() {
    this._stopping = true;
    this._closed = true;
    this._initialized = false;
    if (this.sessionId) {
      const sessionId = this.sessionId;
      this.sessionId = "";
      try {
        await this.fetchImpl(this.endpoint, {
          method: "DELETE",
          headers: await this._headers({ sessionId, includeJson: false }),
        });
      } catch (err) {
        this.log.debug?.(`[mcp:${this.server.id}] remote session delete failed: ${err.message}`);
      }
    }
  }

  async _headers({
    sessionId = this.sessionId,
    includeJson = true,
    initializing = false,
    era = this.era,
    payload = null,
  }: any = {}) {
    const modern = era === MCP_ERA_MODERN;
    const headers = {
      ...headersWithoutMcpProtocolVersion(connectorHeaders(this.server)),
      Accept: STREAMABLE_ACCEPT,
      [MCP_PROTOCOL_VERSION_HEADER]: modern
        ? this._modernProtocolVersion()
        : (this.protocolVersion || this.initialProtocolVersion || MCP_PROTOCOL_VERSION),
    };
    if (includeJson) headers["Content-Type"] = "application/json";
    // Sessions exist only on the legacy track; the stateless revision removed
    // them outright, so a modern request must never carry one.
    if (!modern && sessionId && !initializing) headers["MCP-Session-Id"] = sessionId;
    if (modern && payload) Object.assign(headers, modernRoutingHeaders(payload, this._toolParamAnnotations));
    // Prefer the runtime's freshest token (handles near-expiry refresh out of
    // band); fall back to the connector snapshot when no callback is injected.
    const token = await requestAuthToken(this.server, this.getAuthToken);
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  // We implement no server-initiated methods, so answer with -32601 rather than
  // leaving the server blocked on a reply. Best effort: this is a courtesy
  // reply on a side channel, and its failure must not disturb the request whose
  // stream carried it, so a failed delivery is logged and goes no further.
  _rejectServerRequest(message) {
    this.log.debug?.(
      `[mcp:${this.server.id}] rejected unsupported server request "${message.method}" (id ${message.id})`,
    );
    const body = JSON.stringify(methodNotFoundResponse(message.id, message.method));
    (async () => {
      const headers = await this._headers();
      await fetchWithTimeout(this.fetchImpl, this.endpoint, {
        method: "POST",
        headers,
        body,
      }, requestTimeoutMs(this.server));
    })().catch((err) => {
      this.log.debug?.(
        `[mcp:${this.server.id}] could not deliver method-not-found for "${message.method}": ${err.message}`,
      );
    });
  }

  async _postJsonRpc(payload, { initializing = false, era = this.era, signal }: { initializing?: boolean; era?: any; signal?: AbortSignal } = {}) {
    // Validate what the caller handed us, so a diagnostic points at the caller's
    // own field path rather than at protocol metadata we added underneath.
    assertValidUnicodeBoundary(payload);
    const body = era === MCP_ERA_MODERN
      ? withModernRequestMeta(payload, this._modernProtocolVersion(), MODERN_CLIENT_CAPABILITIES)
      : payload;
    const response = await fetchWithTimeout(this.fetchImpl, this.endpoint, {
      method: "POST",
      headers: await this._headers({ initializing, era, payload: body }),
      body: JSON.stringify(body),
      signal,
    }, requestTimeoutMs(this.server));
    if (initializing) {
      const sessionId = responseHeader(response, "MCP-Session-Id");
      if (sessionId) this.sessionId = sessionId;
    }
    if (response.status === 202 && payload.id == null) return null;
    if (!response.ok) {
      const body = await responseText(response);
      throw new McpHttpError(methodErrorMessage(response.status, body), {
        status: response.status,
        body,
        headers: response.headers,
      });
    }
    if (payload.id == null) return null;

    const contentType = responseHeader(response, "Content-Type");
    const text = await responseText(response);
    if (contentType.includes("text/event-stream")) {
      for (const event of parseSseEvents(text)) {
        if (!event.data) continue;
        const message = JSON.parse(event.data);
        if (isJsonRpcServerRequest(message)) {
          this._rejectServerRequest(message);
          continue;
        }
        if (isJsonRpcResponse(message) && message.id === payload.id) return rpcResult(message);
      }
      throw new Error(`MCP response for "${payload.method}" was not found in SSE stream`);
    }
    const message = text ? JSON.parse(text) : null;
    if (!message) return null;
    return rpcResult(message);
  }
}

export class McpLegacySseClient {
  declare _abort: any;
  declare _buffer: any;
  declare _closed: any;
  declare _endpointReject: any;
  declare _endpointResolve: any;
  declare _nextId: any;
  declare _pending: any;
  declare _queued: any;
  declare _stopping: any;
  declare fetchImpl: any;
  declare getAuthToken: any;
  declare log: any;
  declare messageEndpoint: any;
  declare onClose: any;
  declare refreshAuthToken: any;
  declare server: any;
  declare sseUrl: any;
  constructor(server, { fetchImpl = globalThis.fetch, log = console, onClose = null, getAuthToken = null, refreshAuthToken = null } = {}) {
    this.server = server;
    this.fetchImpl = fetchImpl;
    this.log = log;
    // onClose({ reason, expected }) reports an unexpected stream death so the
    // runtime can run backoff reconnect; a deliberate stop() is expected.
    this.onClose = typeof onClose === "function" ? onClose : null;
    // OAuth self-heal seams (#1286 ③a); see McpStreamableHttpClient for the
    // contract. Optional — absent callbacks preserve the snapshot-token behavior.
    this.getAuthToken = typeof getAuthToken === "function" ? getAuthToken : null;
    this.refreshAuthToken = typeof refreshAuthToken === "function" ? refreshAuthToken : null;
    this.sseUrl = server?.url || "";
    this.messageEndpoint = "";
    this._nextId = 1;
    this._pending = new Map();
    this._queued = new Map();
    this._closed = true;
    this._stopping = false;
    this._buffer = "";
    this._abort = null;
    this._endpointResolve = null;
    this._endpointReject = null;
  }

  get running() {
    return !this._closed && !!this.messageEndpoint;
  }

  async start() {
    if (this.running) return;
    if (!this.sseUrl) throw new Error("MCP connector URL is required");
    this._closed = false;
    this._stopping = false;
    try {
      await this._connectSse();
      await this.initialize();
    } catch (err) {
      await this.stop().catch(() => {});
      throw err;
    }
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
    });
    await this.notify("notifications/initialized", {});
    return result;
  }

  async listTools() {
    const result = await this.request("tools/list", {});
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name, args, { signal }: { signal?: AbortSignal } = {}) {
    return this.request("tools/call", {
      name,
      arguments: args || {},
    }, { signal });
  }

  async readResource(uri) {
    return this.request("resources/read", { uri });
  }

  async request(method, params: any = {}, { timeout = 30_000, signal }: { timeout?: number; signal?: AbortSignal } = {}) {
    signal?.throwIfAborted();
    if (!this.running) throw new Error("MCP connector is not running");
    try {
      return await this._sendRequest(method, params, timeout, signal);
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      // 401 OAuth self-heal (方案 A, single retry). Force a token refresh and, if
      // it yields a new token, replay the request once with a fresh id. A second
      // 401 or no refresh rethrows. No loop.
      if (err instanceof McpHttpError && err.status === 401 && this.refreshAuthToken) {
        const newToken = stringOrEmpty(await this.refreshAuthToken());
        if (newToken) return this._sendRequest(method, params, timeout, signal);
      }
      if (isSessionExpiredHttpError(err)) {
        this._failLiveSession(err);
      }
      throw err;
    }
  }

  _sendRequest(method, params, timeout, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const id = this._nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    const queued = this._queued.get(id);
    if (queued) {
      this._queued.delete(id);
      return Promise.resolve(rpcResult(queued));
    }
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this._pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => { cleanup(); reject(signal.reason); };
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
      this._postMessage(payload, signal).catch((err) => {
        cleanup();
        reject(err);
      });
    });
  }

  async notify(method, params: any = {}) {
    if (!this.running) return;
    await this._postMessage({ jsonrpc: "2.0", method, params });
  }

  async stop() {
    this._stopping = true;
    this._closed = true;
    this.messageEndpoint = "";
    try { this._abort?.abort(); } catch {}
    this._abort = null;
    for (const pending of this._pending.values()) {
      pending.reject(new Error("MCP connector stopped"));
    }
    this._pending.clear();
  }

  _failLiveSession(err) {
    if (this._stopping || this._closed) return;
    this.messageEndpoint = "";
    this._closed = true;
    for (const pending of this._pending.values()) {
      pending.reject(err);
    }
    this._pending.clear();
    this.onClose?.({
      reason: err?.message || "connection lost",
      expected: false,
      needsAuth: isAuthTerminalError(err),
    });
  }

  async _connectSse() {
    this._abort = new AbortController();
    const endpointPromise = new Promise((resolve, reject) => {
      this._endpointResolve = resolve;
      this._endpointReject = reject;
    });
    const response = await this.fetchImpl(this.sseUrl, {
      method: "GET",
      headers: await this._headers({ accept: SSE_ACCEPT, includeJson: false }),
      signal: this._abort.signal,
    });
    if (!response.ok) {
      const body = await responseText(response);
      throw new McpHttpError(methodErrorMessage(response.status, body), {
        status: response.status,
        body,
        headers: response.headers,
      });
    }
    this._readSse(response.body).catch((err) => {
      if (!this._closed) {
        this._endpointReject?.(err);
        for (const pending of this._pending.values()) pending.reject(err);
        this._pending.clear();
      }
    });
    await withTimeout(endpointPromise, requestTimeoutMs(this.server), "MCP legacy SSE endpoint event timed out");
  }

  async _readSse(body) {
    if (!body?.getReader) {
      const text = await responseText({ text: async () => "" });
      this._consumeSse(text);
      this._handleStreamClosed("SSE stream produced no readable body");
      return;
    }
    const decoder = new TextDecoder();
    const reader = body.getReader();
    while (!this._closed) {
      const { value, done } = await reader.read();
      if (done) break;
      this._consumeSse(decoder.decode(value, { stream: true }));
    }
    this._consumeSse(decoder.decode());
    // The stream ended. Whether the remote closed it or stop() aborted it, the
    // live session is gone — clear messageEndpoint so running() stops lying
    // (the :288 stale-positive), reject any in-flight requests, and report an
    // unexpected close unless this was a deliberate stop().
    this._handleStreamClosed("SSE stream closed by remote");
  }

  _handleStreamClosed(reason) {
    const wasLive = !this._closed && !!this.messageEndpoint;
    this.messageEndpoint = "";
    if (this._stopping) return;
    if (!wasLive) return;
    this._closed = true;
    for (const pending of this._pending.values()) {
      pending.reject(new Error(reason));
    }
    this._pending.clear();
    this.onClose?.({ reason, expected: false });
  }

  _consumeSse(chunk) {
    this._buffer += chunk;
    let index;
    while ((index = this._buffer.search(/\r?\n\r?\n/)) !== -1) {
      const block = this._buffer.slice(0, index);
      this._buffer = this._buffer.slice(this._buffer[index] === "\r" ? index + 4 : index + 2);
      const [event] = parseSseEvents(block + "\n\n");
      if (event) this._handleSseEvent(event);
    }
  }

  _handleSseEvent(event) {
    if (event.event === "endpoint") {
      this.messageEndpoint = resolveEndpoint(event.data, this.sseUrl);
      this._endpointResolve?.(this.messageEndpoint);
      return;
    }
    if (!event.data) return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (err) {
      this.log.warn?.(`[mcp:${this.server.id}] ignored invalid SSE JSON: ${err.message}`);
      return;
    }
    if (isJsonRpcServerRequest(message)) {
      this._rejectServerRequest(message);
      return;
    }
    if (!isJsonRpcResponse(message)) return;
    const pending = this._pending.get(message.id);
    if (!pending) {
      this._queued.set(message.id, message);
      return;
    }
    this._pending.delete(message.id);
    try {
      pending.resolve(rpcResult(message));
    } catch (err) {
      pending.reject(err);
    }
  }

  // See McpStreamableHttpClient._rejectServerRequest: answer -32601 instead of
  // dropping the request, and never let the courtesy reply's failure escape.
  _rejectServerRequest(message) {
    this.log.debug?.(
      `[mcp:${this.server.id}] rejected unsupported server request "${message.method}" (id ${message.id})`,
    );
    this._postMessage(methodNotFoundResponse(message.id, message.method)).catch((err) => {
      this.log.debug?.(
        `[mcp:${this.server.id}] could not deliver method-not-found for "${message.method}": ${err.message}`,
      );
    });
  }

  async _postMessage(payload, signal?: AbortSignal) {
    assertValidUnicodeBoundary(payload);
    const response = await fetchWithTimeout(this.fetchImpl, this.messageEndpoint, {
      method: "POST",
      headers: await this._headers({ accept: "application/json", includeJson: true }),
      body: JSON.stringify(payload),
      signal,
    }, requestTimeoutMs(this.server));
    if (!response.ok) {
      const body = await responseText(response);
      throw new McpHttpError(methodErrorMessage(response.status, body), {
        status: response.status,
        body,
        headers: response.headers,
      });
    }
  }

  async _headers({ accept, includeJson }) {
    const headers: any = { ...connectorHeaders(this.server), Accept: accept };
    if (includeJson) headers["Content-Type"] = "application/json";
    const token = await requestAuthToken(this.server, this.getAuthToken);
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }
}

export class McpAutoHttpClient {
  declare client: any;
  declare opts: any;
  declare server: any;
  constructor(server, opts: any = {}) {
    this.server = server;
    this.opts = opts;
    this.client = null;
  }

  get running() {
    return this.client?.running === true;
  }

  get toolListFreshness() {
    return this.client?.toolListFreshness ?? null;
  }

  async start() {
    const streamable = new McpStreamableHttpClient(this.server, this.opts);
    try {
      await streamable.start();
      this.client = streamable;
      return;
    } catch (err) {
      await streamable.stop().catch(() => {});
      if (!(err instanceof McpHttpError) || !FALLBACK_STATUSES.has(err.status)) throw err;
    }
    const legacy = new McpLegacySseClient(this.server, this.opts);
    await legacy.start();
    this.client = legacy;
  }

  async listTools() {
    return this.client.listTools();
  }

  async callTool(name, args, opts: any = {}) {
    return this.client.callTool(name, args, opts);
  }

  async readResource(uri) {
    return this.client.readResource(uri);
  }

  async stop() {
    await this.client?.stop?.();
    this.client = null;
  }
}

function rpcResult(message) {
  if (message?.error) {
    throw new Error(message.error.message || "MCP request failed");
  }
  return message?.result;
}

function withTimeout(promise, timeout, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeout);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function assertValidUnicodeBoundary(payload) {
  const invalid = findInvalidUnicode(payload);
  if (!invalid) return;
  throw new Error(
    `MCP connector payload contains invalid Unicode at ${invalid.path}: lone UTF-16 surrogate at index ${invalid.index}. `
    + "The original input was not modified; remove or replace the invalid character before retrying.",
  );
}

function findInvalidUnicode(value, path = "", seen = new Set()) {
  if (typeof value === "string") {
    const index = loneSurrogateIndex(value);
    return index === -1 ? null : { path: path || "value", index };
  }
  if (!value || typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const invalid = findInvalidUnicode(value[i], `${path}[${i}]`, seen);
      if (invalid) return invalid;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    const keyIndex = loneSurrogateIndex(key);
    const childPath = appendPath(path, key);
    if (keyIndex !== -1) return { path: childPath, index: keyIndex };
    const invalid = findInvalidUnicode(child, childPath, seen);
    if (invalid) return invalid;
  }
  return null;
}

function appendPath(base, key) {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) return base ? `${base}.${key}` : key;
  return `${base || "value"}[${JSON.stringify(key)}]`;
}

function loneSurrogateIndex(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        i += 1;
        continue;
      }
      return i;
    }
    if (code >= 0xDC00 && code <= 0xDFFF) return i;
  }
  return -1;
}
